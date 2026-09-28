import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { endianness } from 'node:os';
import { resolve } from 'node:path';
import sharp, { type Metadata } from 'sharp';

export interface LosslessComparisonOptions {
  expectedBeforeSha256?: string;
  expectedAfterSha256?: string;
  /** A new analysis artifact. Existing files are never overwritten. */
  differenceMap?: { path: string; amplification: number };
}

interface ImageMetadata {
  format: string | null;
  width: number | null;
  height: number | null;
  channels: number | null;
  space: string | null;
  depth: string | null;
  bitsPerSample: number | null;
  orientation: number | null;
  pages: number;
  hasAlpha: boolean;
  iccSha256: string | null;
  iccColourSpace: string | null;
}

interface ImageEvidence {
  path: string;
  sha256: string;
  metadata: ImageMetadata;
  /** SHA-256 of JSON.stringify(metadata), using the field order defined here. */
  metadataSha256: string;
  /** Interleaved RGB unsigned 16-bit samples, canonical little-endian order. */
  decodedSha256?: string;
}

interface TileMetrics {
  column: number; row: number;
  left: number; top: number; width: number; height: number;
  changedPixels: number; changedChannels: number;
  absoluteDifferenceSum: number; maximumChannelDifference: number;
  meanAbsoluteDifference: number;
}

export interface LosslessComparison {
  comparable: boolean;
  sameDimensions: boolean;
  pixelsIdentical: boolean;
  width?: number; height?: number; bitDepth?: 16;
  meanAbsoluteDifference?: number; maximumChannelDifference?: number; changedChannelFraction?: number;
  issues: string[];
  before: ImageEvidence;
  after: ImageEvidence;
  decoder: {
    sharp: string; libvips: string;
    colourTransform: 'none'; orientationTransform: 'none';
    sampleEncoding: 'unsigned-16-bit RGB, canonical little-endian';
  };
  metrics?: {
    width: number; height: number; bitDepth: 16;
    totalPixels: number; totalChannels: number;
    changedPixels: number; changedChannels: number;
    absoluteDifferenceSum: number;
    meanAbsoluteDifference: number; maximumChannelDifference: number;
    changedChannelFraction: number; changedPixelFraction: number;
  };
  /** Exact absolute channel-code differences; includes zero, omits empty bins. */
  histogram?: Array<{ difference: number; channels: number }>;
  spatial?: {
    tileSize: 64; columns: number; rows: number; changedTiles: number;
    /** Row-major; unchanged tiles are omitted. Means include unchanged channels. */
    tiles: TileMetrics[];
    boundingBox: { left: number; top: number; width: number; height: number } | null;
    longestHorizontalRun: number; longestVerticalRun: number;
    horizontalAdjacentPairs: number; verticalAdjacentPairs: number;
  };
  differenceMap?: {
    path: string; sha256: string; amplification: number;
    encoding: '8-bit grayscale PNG';
    formula: 'round(min(255, max(abs(R), abs(G), abs(B)) * amplification * 255 / 65535))';
    filtered: false;
  };
}

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

function metadataRecord(metadata: Metadata): ImageMetadata {
  return {
    format: metadata.format ?? null, width: metadata.width ?? null, height: metadata.height ?? null,
    channels: metadata.channels ?? null, space: metadata.space ?? null, depth: metadata.depth ?? null,
    bitsPerSample: metadata.bitsPerSample ?? null, orientation: metadata.orientation ?? null,
    pages: metadata.pages ?? 1, hasAlpha: metadata.hasAlpha ?? false,
    iccSha256: metadata.icc?.length ? sha256(metadata.icc) : null,
    iccColourSpace: metadata.icc && metadata.icc.length >= 20 ? metadata.icc.toString('ascii', 16, 20) : null,
  };
}

function validateMetadata(label: string, metadata: Metadata): string[] {
  const issues: string[] = [];
  if (metadata.format !== 'tiff') issues.push(`${label}: format must be TIFF`);
  if (metadata.depth !== 'ushort' || metadata.bitsPerSample !== 16) issues.push(`${label}: samples must be unsigned 16-bit`);
  if (metadata.space !== 'rgb16' || metadata.channels !== 3 || metadata.hasAlpha) issues.push(`${label}: samples must be RGB without alpha`);
  if (metadata.orientation !== undefined && metadata.orientation !== 1) issues.push(`${label}: TIFF must already be upright (orientation 1 or absent)`);
  if ((metadata.pages ?? 1) !== 1) issues.push(`${label}: TIFF must contain exactly one page`);
  if (!metadata.width || !metadata.height) issues.push(`${label}: dimensions must be positive`);
  const icc = metadata.icc;
  if (!icc || icc.length < 128 || icc.toString('ascii', 36, 40) !== 'acsp'
    || icc.toString('ascii', 16, 20) !== 'RGB ' || icc.readUInt32BE(0) !== icc.length) {
    issues.push(`${label}: a complete embedded RGB ICC profile is required`);
  }
  return issues;
}

/** Compare the stored RGB sample codes, without ICC conversion, rotation,
 * resampling, filtering, or an acceptance tolerance. This establishes file/pixel
 * evidence only; the caller must validate photo, state, and export provenance. */
export async function compareLosslessTiff(
  beforePath: string,
  afterPath: string,
  options: LosslessComparisonOptions = {},
): Promise<LosslessComparison> {
  if (options.differenceMap) {
    if (!Number.isFinite(options.differenceMap.amplification) || options.differenceMap.amplification <= 0) {
      throw new Error('Difference-map amplification must be finite and positive.');
    }
    if (!options.differenceMap.path.toLowerCase().endsWith('.png')) throw new Error('Difference map must be a PNG path.');
    if ([resolve(beforePath), resolve(afterPath)].includes(resolve(options.differenceMap.path))) throw new Error('Difference map cannot replace an input.');
  }
  // Decode and hash the same immutable byte buffers, avoiding a path reread race.
  const buffers = await Promise.all([readFile(beforePath), readFile(afterPath)]);
  const metadata = await Promise.all(buffers.map(buffer => sharp(buffer, { ignoreIcc: true }).metadata()));
  const evidence = (path: string, bytes: Buffer, meta: Metadata): ImageEvidence => {
    const record = metadataRecord(meta);
    return { path, sha256: sha256(bytes), metadata: record, metadataSha256: sha256(JSON.stringify(record)) };
  };
  const result: LosslessComparison = {
    comparable: false, sameDimensions: metadata[0]!.width === metadata[1]!.width && metadata[0]!.height === metadata[1]!.height, pixelsIdentical: false,
    issues: [...validateMetadata('before', metadata[0]!), ...validateMetadata('after', metadata[1]!)],
    before: evidence(beforePath, buffers[0]!, metadata[0]!), after: evidence(afterPath, buffers[1]!, metadata[1]!),
    decoder: {
      sharp: sharp.versions.sharp, libvips: sharp.versions.vips,
      colourTransform: 'none', orientationTransform: 'none',
      sampleEncoding: 'unsigned-16-bit RGB, canonical little-endian',
    },
  };
  if (options.expectedBeforeSha256 !== undefined && options.expectedBeforeSha256 !== result.before.sha256) result.issues.push('before: file SHA-256 does not match expected provenance');
  if (options.expectedAfterSha256 !== undefined && options.expectedAfterSha256 !== result.after.sha256) result.issues.push('after: file SHA-256 does not match expected provenance');
  if (metadata[0]!.width !== metadata[1]!.width || metadata[0]!.height !== metadata[1]!.height) result.issues.push('TIFF dimensions differ');
  if (result.before.metadata.iccSha256 !== result.after.metadata.iccSha256) result.issues.push('Embedded ICC profiles differ');
  if (result.issues.length) return result;

  // Sharp can apply an ICC transform before raw output. ignoreIcc prevents that;
  // rgb16 is an identity output interpretation because it was required above.
  // Keeping raw() alone would default to sRGB and quantize low-order samples.
  const decoded = await Promise.all(buffers.map(buffer => sharp(buffer, { ignoreIcc: true })
    .toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true })));
  const width = metadata[0]!.width!; const height = metadata[0]!.height!;
  for (let i = 0; i < decoded.length; i++) {
    const image = decoded[i]!;
    // Sharp returns depth for raw output, although OutputInfo omits this field.
    const rawInfo = image.info as typeof image.info & { depth?: string };
    if (image.info.width !== width || image.info.height !== height || image.info.channels !== 3
      || rawInfo.depth !== 'ushort' || image.data.length !== width * height * 3 * 2) {
      result.issues.push(`${i === 0 ? 'before' : 'after'}: decoded layout does not match validated native metadata`);
    }
  }
  if (result.issues.length) return result;
  // libvips raw uses host byte order. Canonicalize hashes without altering values.
  const sampleBuffers = decoded.map(item => endianness() === 'LE' ? item.data : Buffer.from(item.data).swap16());
  result.before.decodedSha256 = sha256(sampleBuffers[0]!); result.after.decodedSha256 = sha256(sampleBuffers[1]!);
  const first = sampleBuffers[0]!; const second = sampleBuffers[1]!;
  const histogram = new Uint32Array(65536);
  const tileSize = 64 as const; const columns = Math.ceil(width / tileSize); const rows = Math.ceil(height / tileSize);
  const tiles = new Map<number, TileMetrics>();
  const previousRow = new Uint8Array(width); const verticalRuns = new Uint32Array(width);
  const mapPixels = options.differenceMap ? Buffer.alloc(width * height) : undefined;
  let changedPixels = 0; let changedChannels = 0; let absoluteDifferenceSum = 0; let maximumChannelDifference = 0;
  let left = width; let top = height; let right = -1; let bottom = -1;
  let longestHorizontalRun = 0; let longestVerticalRun = 0;
  let horizontalAdjacentPairs = 0; let verticalAdjacentPairs = 0;
  for (let y = 0; y < height; y++) {
    let horizontalRun = 0;
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      let pixelChanges = 0; let pixelSum = 0; let pixelMaximum = 0;
      for (let channel = 0; channel < 3; channel++) {
        const offset = (pixel * 3 + channel) * 2;
        const difference = Math.abs(first.readUInt16LE(offset) - second.readUInt16LE(offset));
        histogram[difference]!++;
        pixelSum += difference; pixelMaximum = Math.max(pixelMaximum, difference);
        if (difference) pixelChanges++;
      }
      if (pixelChanges) {
        changedPixels++; changedChannels += pixelChanges; absoluteDifferenceSum += pixelSum;
        maximumChannelDifference = Math.max(maximumChannelDifference, pixelMaximum);
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        if (horizontalRun) horizontalAdjacentPairs++;
        if (previousRow[x]) verticalAdjacentPairs++;
        horizontalRun++; verticalRuns[x]!++;
        longestHorizontalRun = Math.max(longestHorizontalRun, horizontalRun);
        longestVerticalRun = Math.max(longestVerticalRun, verticalRuns[x]!);
        const column = Math.floor(x / tileSize); const row = Math.floor(y / tileSize); const index = row * columns + column;
        let tile = tiles.get(index);
        if (!tile) {
          tile = { column, row, left: column * tileSize, top: row * tileSize,
            width: Math.min(tileSize, width - column * tileSize), height: Math.min(tileSize, height - row * tileSize),
            changedPixels: 0, changedChannels: 0, absoluteDifferenceSum: 0, maximumChannelDifference: 0, meanAbsoluteDifference: 0 };
          tiles.set(index, tile);
        }
        tile.changedPixels++; tile.changedChannels += pixelChanges; tile.absoluteDifferenceSum += pixelSum;
        tile.maximumChannelDifference = Math.max(tile.maximumChannelDifference, pixelMaximum);
      } else { horizontalRun = 0; verticalRuns[x] = 0; }
      previousRow[x] = pixelChanges ? 1 : 0;
      if (mapPixels) mapPixels[pixel] = Math.round(Math.min(255, pixelMaximum * options.differenceMap!.amplification * 255 / 65535));
    }
  }
  const totalPixels = width * height; const totalChannels = totalPixels * 3;
  result.comparable = true; result.pixelsIdentical = changedChannels === 0;
  result.metrics = { width, height, bitDepth: 16, totalPixels, totalChannels, changedPixels, changedChannels,
    absoluteDifferenceSum, meanAbsoluteDifference: absoluteDifferenceSum / totalChannels,
    maximumChannelDifference, changedChannelFraction: changedChannels / totalChannels, changedPixelFraction: changedPixels / totalPixels };
  Object.assign(result, { width, height, bitDepth: 16, meanAbsoluteDifference: result.metrics.meanAbsoluteDifference,
    maximumChannelDifference, changedChannelFraction: result.metrics.changedChannelFraction });
  result.histogram = Array.from(histogram, (channels, difference) => ({ difference, channels })).filter(item => item.channels !== 0);
  result.spatial = {
    tileSize, columns, rows, changedTiles: tiles.size,
    tiles: [...tiles.entries()].sort(([a], [b]) => a - b).map(([, tile]) => ({ ...tile, meanAbsoluteDifference: tile.absoluteDifferenceSum / (tile.width * tile.height * 3) })),
    boundingBox: changedPixels ? { left, top, width: right - left + 1, height: bottom - top + 1 } : null,
    longestHorizontalRun, longestVerticalRun, horizontalAdjacentPairs, verticalAdjacentPairs,
  };
  if (mapPixels) {
    const png = await sharp(mapPixels, { raw: { width, height, channels: 1 } }).toColourspace('b-w').png().toBuffer();
    await writeFile(options.differenceMap!.path, png, { flag: 'wx' });
    result.differenceMap = { path: options.differenceMap!.path, sha256: sha256(png), amplification: options.differenceMap!.amplification,
      encoding: '8-bit grayscale PNG', formula: 'round(min(255, max(abs(R), abs(G), abs(B)) * amplification * 255 / 65535))', filtered: false };
  }
  return result;
}
