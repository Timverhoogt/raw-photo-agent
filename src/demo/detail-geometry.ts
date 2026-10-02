import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DetailImage, DetailPoint, DetailSource } from './details.ts';
import { DETAIL_EDGE, extractDetail, validDetailPoints, verifyDetailSource } from './details.ts';

/** A crop rectangle normalized to Lightroom's uncropped frame: 0..1 from the top-left. */
export interface CropFrame { left: number; top: number; right: number; bottom: number }
/** One candidate export with the crop recorded in its develop settings. */
export interface FramedExport { id: string; width: number; height: number; frame: CropFrame }
/** An export-pixel window; width and height are equal and never exceed the export. */
export interface DetailWindow { left: number; top: number; width: number; height: number }
export interface MappedDetail {
  /** The point's position in this candidate's own frame, normalized from its top-left. */
  x: number; y: number;
  window: DetailWindow;
  /** Export pixels per pixel of the highest-resolution export; 1 for that export. */
  scale: number;
}
export type DetailRegionPlan =
  | { point: DetailPoint; available: true; scene: CropFrame; candidates: Record<string, MappedDetail> }
  | { point: DetailPoint; available: false; reason: string };

const CROP_KEYS = ['CropLeft', 'CropTop', 'CropRight', 'CropBottom'] as const;
const FULL_FRAME: CropFrame = { left: 0, top: 0, right: 1, bottom: 1 };

/**
 * Read the crop rectangle from Lightroom develop settings. Straightened crops are
 * refused: their rotated sampling grid cannot be matched by an axis-aligned window.
 */
export function cropFrame(settings: unknown): CropFrame {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Crop geometry requires recorded develop settings.');
  const values = settings as Record<string, unknown>;
  const angle = values.CropAngle;
  if (angle !== undefined && (typeof angle !== 'number' || !Number.isFinite(angle))) throw new Error('The recorded crop angle is invalid.');
  if (typeof angle === 'number' && Math.abs(angle) > 1e-9) throw new Error('Straightened crops are not supported for matched detail regions.');
  const present = CROP_KEYS.filter(key => values[key] !== undefined);
  if (values.HasCrop === false || present.length === 0 && values.HasCrop !== true) return { ...FULL_FRAME };
  if (present.length !== CROP_KEYS.length) throw new Error('The recorded crop rectangle is incomplete.');
  const [left, top, right, bottom] = CROP_KEYS.map(key => values[key]);
  return validFrame({ left, top, right, bottom });
}

function validFrame(frame: Record<keyof CropFrame, unknown>): CropFrame {
  const { left, top, right, bottom } = frame;
  if (![left, top, right, bottom].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
    || !(left as number < (right as number)) || !(top as number < (bottom as number))) {
    throw new Error('The crop rectangle must lie within the frame and have a positive size.');
  }
  return { left, top, right, bottom } as CropFrame;
}

/**
 * Plan detail windows that cover the SAME scene region in every candidate, even
 * when candidates use different crops and therefore different export dimensions.
 *
 * Points are normalized to the anchor candidate's frame, as the agent sees its overview.
 * Every export's dimensions must agree with its crop rectangle and a single uncropped
 * frame; otherwise the geometry is unverified and the plan is refused. Windows stay
 * inside the region all candidates share, so edge clamping cannot shift one
 * candidate's evidence relative to another. Pixels are never enlarged: a lower-resolution
 * export receives a proportionally smaller window of the same scene region.
 *
 * Dimension agreement does not prove positional agreement: a crop recorded in a
 * different orientation space with the full frame's aspect ratio would still pass.
 * Live validation must confirm the scene content before these plans gate any edit.
 */
export function planMatchedDetails(exports: FramedExport[], anchorId: string, points: DetailPoint[], edge = DETAIL_EDGE): DetailRegionPlan[] {
  if (!validDetailPoints(points)) throw new Error('Choose one or two valid detail points.');
  if (!Number.isInteger(edge) || edge < 1) throw new Error('The detail edge must be a positive integer.');
  if (!exports.length || new Set(exports.map(item => item.id)).size !== exports.length) throw new Error('Matched details require uniquely identified exports.');
  for (const item of exports) {
    if (!Number.isInteger(item.width) || !Number.isInteger(item.height) || item.width < 1 || item.height < 1) throw new Error(`Export ${item.id} has invalid dimensions.`);
    validFrame(item.frame);
  }
  const anchor = exports.find(item => item.id === anchorId);
  if (!anchor) throw new Error('The detail points must belong to one of the compared exports.');

  // Express everything in pixels of an uncropped frame at the highest export resolution.
  const span = (item: FramedExport) => ({ x: item.frame.right - item.frame.left, y: item.frame.bottom - item.frame.top });
  const reference = exports.reduce((best, item) => item.width / span(item).x > best.width / span(best).x ? item : best);
  const fullWidth = reference.width / span(reference).x, fullHeight = reference.height / span(reference).y;
  const scales = new Map<string, number>();
  for (const item of exports) {
    const scale = item.width / span(item).x / fullWidth;
    const expectedHeight = scale * span(item).y * fullHeight;
    // Lightroom rounds each export edge; allow that rounding in both this export and the reference.
    const tolerance = 1 + expectedHeight * (1 / item.width + 1 / item.height + 1 / reference.width + 1 / reference.height);
    if (Math.abs(expectedHeight - item.height) > tolerance) {
      throw new Error(`Export ${item.id} is ${item.width}×${item.height}, which does not match its recorded crop. Matched detail geometry cannot be verified.`);
    }
    scales.set(item.id, scale);
  }

  const shared = exports.reduce<CropFrame>((region, item) => ({
    left: Math.max(region.left, item.frame.left), top: Math.max(region.top, item.frame.top),
    right: Math.min(region.right, item.frame.right), bottom: Math.min(region.bottom, item.frame.bottom),
  }), { ...FULL_FRAME });
  if (!(shared.left < shared.right && shared.top < shared.bottom)) throw new Error('The compared crops share no visible region.');

  return points.map(point => {
    const u = anchor.frame.left + point.x * span(anchor).x, v = anchor.frame.top + point.y * span(anchor).y;
    const outside = exports.find(item => u < item.frame.left || u > item.frame.right || v < item.frame.top || v > item.frame.bottom);
    if (outside) return { point, available: false as const, reason: `The region is outside the crop of candidate ${outside.id}.` };
    // A square window in reference pixels, as large as the edge allows and kept inside the shared region.
    const sharedWidth = (shared.right - shared.left) * fullWidth, sharedHeight = (shared.bottom - shared.top) * fullHeight;
    const side = Math.min(edge, sharedWidth, sharedHeight);
    const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
    const left = clamp(u * fullWidth - side / 2, shared.left * fullWidth, shared.right * fullWidth - side);
    const top = clamp(v * fullHeight - side / 2, shared.top * fullHeight, shared.bottom * fullHeight - side);
    const candidates: Record<string, MappedDetail> = {};
    for (const item of exports) {
      const scale = scales.get(item.id)!;
      const size = Math.max(1, Math.min(item.width, item.height, Math.round(side * scale)));
      candidates[item.id] = {
        x: (u - item.frame.left) / span(item).x, y: (v - item.frame.top) / span(item).y, scale,
        window: {
          left: clamp(Math.round((left - item.frame.left * fullWidth) * scale), 0, item.width - size),
          top: clamp(Math.round((top - item.frame.top * fullHeight) * scale), 0, item.height - size),
          width: size, height: size,
        },
      };
    }
    const scene = { left: left / fullWidth, top: top / fullHeight, right: (left + side) / fullWidth, bottom: (top + side) / fullHeight };
    return { point, available: true as const, scene, candidates };
  });
}

export interface FramedDetailSource extends DetailSource { id: string; frame: CropFrame }
export interface MatchedDetailImage extends DetailImage {
  /** The point in this candidate's own frame; x and y remain the anchor's chosen point. */
  frameX: number; frameY: number; scale: number;
}
export interface MatchedDetails {
  plans: DetailRegionPlan[];
  /** Only regions visible in every candidate are extracted. */
  details: Record<string, MatchedDetailImage[]>;
}

/** Extract the planned windows so every candidate shows the same scene region. */
export async function cropMatchedDetails(sources: FramedDetailSource[], anchorId: string, points: DetailPoint[], directory: string): Promise<MatchedDetails> {
  const plans = planMatchedDetails(sources.map(({ id, width, height, frame }) => ({ id, width, height, frame })), anchorId, points);
  for (const source of sources) await verifyDetailSource(source);
  const details: Record<string, MatchedDetailImage[]> = Object.fromEntries(sources.map(source => [source.id, []]));
  for (const source of sources) {
    const target = join(directory, source.id);
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const plan of plans) {
      if (!plan.available) continue;
      const mapped = plan.candidates[source.id];
      const image = await extractDetail(source, plan.point, mapped.window, target, [plan.point, source.frame, mapped.window]);
      details[source.id].push({ ...image, frameX: mapped.x, frameY: mapped.y, scale: mapped.scale });
    }
  }
  return { plans, details };
}
