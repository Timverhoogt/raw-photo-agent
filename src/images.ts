import sharp from 'sharp';
import { compareLosslessTiff } from './restoration/images.ts';

export async function compareImages(beforePath: string, afterPath: string) {
  const metadata = await Promise.all([sharp(beforePath).metadata(), sharp(afterPath).metadata()]);
  // Profiled lossless references must compare the stored sample codes. Sharp's
  // normal ICC conversion can hide or introduce low-order channel differences.
  if (metadata.some(item => item.format === 'tiff' && item.depth === 'ushort')
    && metadata.some(item => item.icc?.length)) {
    const result = await compareLosslessTiff(beforePath, afterPath);
    return {
      sameDimensions: metadata[0]!.width === metadata[1]!.width && metadata[0]!.height === metadata[1]!.height,
      pixelsIdentical: result.pixelsIdentical, comparable: result.comparable, issues: result.issues,
      width: result.metrics?.width, height: result.metrics?.height, bitDepth: 16,
      meanAbsoluteDifference: result.metrics?.meanAbsoluteDifference,
      maximumChannelDifference: result.metrics?.maximumChannelDifference,
      changedChannelFraction: result.metrics?.changedChannelFraction,
    };
  }
  // ICC-less synthetic fixtures still preserve unsigned 16-bit samples. JPEGs
  // keep the existing displayed-sRGB comparison used by the demo.
  const bitDepth = metadata.some(item => item.depth === 'ushort') ? 16 : 8;
  const decode = (path: string) => sharp(path, { ignoreIcc: bitDepth === 16 }).rotate().toColourspace(bitDepth === 16 ? 'rgb16' : 'srgb')
    .removeAlpha().raw({ depth: bitDepth === 16 ? 'ushort' : 'uchar' }).toBuffer({ resolveWithObject: true });
  const [before, after] = await Promise.all([
    decode(beforePath), decode(afterPath),
  ]);
  if (before.info.width !== after.info.width || before.info.height !== after.info.height || before.info.channels !== after.info.channels) {
    return { sameDimensions: false, pixelsIdentical: false, before: before.info, after: after.info };
  }
  const channels = (data: Buffer): Uint8Array | Uint16Array => bitDepth === 16
    ? new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2) : data;
  const beforeValues = channels(before.data); const afterValues = channels(after.data);
  let totalDifference = 0; let maxDifference = 0; let changedChannels = 0;
  for (let i = 0; i < beforeValues.length; i++) {
    const difference = Math.abs(beforeValues[i]! - afterValues[i]!);
    totalDifference += difference;
    maxDifference = Math.max(maxDifference, difference);
    if (difference !== 0) changedChannels++;
  }
  return {
    sameDimensions: true, pixelsIdentical: changedChannels === 0,
    width: before.info.width, height: before.info.height, bitDepth,
    meanAbsoluteDifference: totalDifference / beforeValues.length,
    maximumChannelDifference: maxDifference,
    changedChannelFraction: changedChannels / beforeValues.length,
  };
}

/** Repeat only the read-only export once when the first restored image differs.
 * Preserve both comparisons; do not assume variation is settling or relax exactness. */
export async function verifyRestoredRendering<T extends { previewPath: string }>(
  referencePath: string,
  render: () => Promise<T>,
) {
  const attempts: Array<{
    previewPath: string;
    difference: Awaited<ReturnType<typeof compareImages>>;
  }> = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const preview = await render();
    const difference = await compareImages(referencePath, preview.previewPath);
    attempts.push({ previewPath: preview.previewPath, difference });
    if (difference.pixelsIdentical || attempt === 1) {
      return { preview, difference, attempts };
    }
  }
  throw new Error('Restored-render verification did not execute.');
}

export async function detailCrop(input: string, output: string, region: { left: number; top: number; width: number; height: number }) {
  for (const [name, value] of Object.entries(region)) {
    if (!Number.isInteger(value) || value < (name === 'width' || name === 'height' ? 1 : 0)) throw new Error('Crop coordinates must be nonnegative integers and dimensions positive.');
  }
  await sharp(input).rotate().extract(region).png().toFile(output);
  return { path: output, ...region, note: 'Native pixels from the supplied render; export full resolution before interpreting this as sensor-level 100% detail.' };
}
