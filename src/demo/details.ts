import { createHash } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const DETAIL_EDGE = 896;
export interface DetailPoint { id: string; label: string; x: number; y: number }
export interface DetailSource { path: string; width: number; height: number; stateToken: string }
export interface DetailImage extends DetailPoint {
  path: string; width: number; height: number; sourceWidth: number; sourceHeight: number;
}

export function validDetailPoints(value: unknown): value is DetailPoint[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 2
    && value.every(point => point && typeof point === 'object' && !Array.isArray(point)
      && Object.keys(point).length === 4 && ['id', 'label', 'x', 'y'].every(key => Object.hasOwn(point, key))
      && typeof point.id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(point.id)
      && typeof point.label === 'string' && !!point.label.trim() && point.label.length <= 80
      && [point.x, point.y].every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1))
    && new Set(value.map(point => point.id)).size === value.length;
}

export async function readDetailSource(path: string, stateToken: string): Promise<DetailSource> {
  // Point validation also serves the dependency-free Codex CLI compatibility check.
  const { default: sharp } = await import('sharp');
  const metadata = await sharp(path).metadata();
  if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height || metadata.orientation && metadata.orientation !== 1) {
    throw new Error('Detail inspection requires an upright Lightroom JPEG export.');
  }
  return { path, width: metadata.width, height: metadata.height, stateToken };
}

/** Extract export pixels directly: never resize the overview, upscale, or infer sensor resolution. */
export async function cropDetails(source: DetailSource, points: DetailPoint[], directory: string): Promise<DetailImage[]> {
  if (!validDetailPoints(points)) throw new Error('Choose one or two valid detail points.');
  const { default: sharp } = await import('sharp');
  const actual = await readDetailSource(source.path, source.stateToken);
  if (actual.width !== source.width || actual.height !== source.height) throw new Error('The saved detail export changed dimensions.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const edge = Math.min(DETAIL_EDGE, source.width, source.height);
  const details: DetailImage[] = [];
  for (const point of points) {
    const left = Math.max(0, Math.min(source.width - edge, Math.round(point.x * (source.width - 1) - (edge - 1) / 2)));
    const top = Math.max(0, Math.min(source.height - edge, Math.round(point.y * (source.height - 1) - (edge - 1) / 2)));
    // Include all crop identity in the filename so old browser evidence cannot become another region.
    const key = createHash('sha256').update(JSON.stringify([source.path, source.stateToken, point])).digest('hex').slice(0, 20);
    const path = join(directory, `${point.id}-${key}.jpg`);
    await sharp(source.path).extract({ left, top, width: edge, height: edge }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(path);
    await chmod(path, 0o600);
    details.push({ ...point, path, width: edge, height: edge, sourceWidth: source.width, sourceHeight: source.height });
  }
  return details;
}
