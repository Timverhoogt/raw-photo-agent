import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

export const LUMINANCE_BINS = 16;
export type TonalSourceKind = 'full-size-export' | 'overview';
export interface ClippingPercent { anyChannel: number; allChannels: number; red: number; green: number; blue: number }
/** Measurements of one rendered 8-bit sRGB image. They describe the export, not the RAW. */
export interface TonalEvidence {
  source: TonalSourceKind;
  width: number;
  height: number;
  highlightClippingPercent: ClippingPercent;
  shadowClippingPercent: ClippingPercent;
  /** Share of pixels in equal Rec. 709 luma bins of the sRGB codes, dark to bright. */
  luminanceHistogramPercent: number[];
}

const percent = (count: number, total: number) => Math.round(count / total * 10_000) / 100;
const clippingPercent = (counts: number[], total: number): ClippingPercent => {
  const [anyChannel, allChannels, red, green, blue] = counts.map(count => percent(count, total));
  return { anyChannel: anyChannel!, allChannels: allChannels!, red: red!, green: green!, blue: blue! };
};

export async function measureTonalEvidence(input: string | Buffer, source: TonalSourceKind): Promise<TonalEvidence> {
  // Exports are written as sRGB. Read the stored codes, because ICC conversion could move them on or off the limits.
  const { data, info } = await sharp(input, { ignoreIcc: true }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 || !info.width || !info.height) throw new Error('Tonal measurement requires a three-channel image.');
  const total = info.width * info.height;
  const bins = new Array<number>(LUMINANCE_BINS).fill(0);
  const high = [0, 0, 0, 0, 0]; const low = [0, 0, 0, 0, 0];
  const count = (counts: number[], red: boolean, green: boolean, blue: boolean) => {
    if (red || green || blue) counts[0]!++;
    if (red && green && blue) counts[1]!++;
    if (red) counts[2]!++;
    if (green) counts[3]!++;
    if (blue) counts[4]!++;
  };
  for (let i = 0; i < data.length; i += 3) {
    const red = data[i]!; const green = data[i + 1]!; const blue = data[i + 2]!;
    count(high, red === 255, green === 255, blue === 255);
    count(low, red === 0, green === 0, blue === 0);
    bins[Math.min(LUMINANCE_BINS - 1, Math.floor((0.2126 * red + 0.7152 * green + 0.0722 * blue) * LUMINANCE_BINS / 256))]!++;
  }
  return { source, width: info.width, height: info.height,
    highlightClippingPercent: clippingPercent(high, total), shadowClippingPercent: clippingPercent(low, total),
    luminanceHistogramPercent: bins.map(bin => percent(bin, total)) };
}

/** Saved exports are immutable, so each is decoded once. Missing evidence must not stop an edit. */
export class TonalEvidenceCache {
  private known = new Map<string, TonalEvidence | null>();
  async measure(file: { path: string; sha256?: string }, source: TonalSourceKind, onFailure?: (error: Error) => void): Promise<TonalEvidence | null> {
    const key = JSON.stringify([file.path, file.sha256 ?? null, source]);
    const known = this.known.get(key);
    if (known !== undefined) return known;
    let evidence: TonalEvidence | null = null;
    try {
      // Hash and decode the same bytes so the numbers cannot describe a replaced file.
      const bytes = await readFile(file.path);
      if (file.sha256 && createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('The saved export changed since its checkpoint.');
      evidence = await measureTonalEvidence(bytes, source);
    } catch (error) {
      onFailure?.(error instanceof Error ? error : new Error(String(error)));
    }
    this.known.set(key, evidence);
    return evidence;
  }
}
