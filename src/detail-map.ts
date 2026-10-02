import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate, RunStore } from './store.ts';
import { cropFrame, cropMatchedDetails, planMatchedDetails } from './demo/detail-geometry.ts';
import type { FramedDetailSource, MatchedDetails } from './demo/detail-geometry.ts';
import { readDetailSource, validDetailPoints } from './demo/details.ts';
import type { DetailPoint } from './demo/details.ts';

export interface JournalExport { path: string; maxEdge: number; operationId: string }

/**
 * The largest completed JPEG render recorded for this exact candidate state.
 * Only the journal establishes which settings produced an export file.
 */
export function journalExport(store: RunStore, runId: string, candidate: Candidate): JournalExport | undefined {
  const started = new Map<string, Record<string, unknown>>();
  let best: JournalExport | undefined;
  for (const event of store.listEvents(runId)) {
    const payload = event.payload as { operationId?: string; operation?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
    if (payload?.operation !== 'render' || typeof payload.operationId !== 'string') continue;
    if (event.type === 'operation_started' && payload.params) started.set(payload.operationId, payload.params);
    if (event.type !== 'operation_completed' || !payload.result) continue;
    const params = started.get(payload.operationId);
    const path = payload.result.outputPath;
    if (!params || params.format !== 'JPEG' || params.expectedStateToken !== candidate.stateToken
      || payload.result.stateToken !== candidate.stateToken || typeof path !== 'string' || path !== params.outputPath
      || typeof params.maxEdge !== 'number' || !existsSync(path)) continue;
    // Prefer the largest export; among equal sizes, the most recent one.
    if (!best || params.maxEdge >= best.maxEdge) best = { path, maxEdge: params.maxEdge, operationId: payload.operationId };
  }
  return best;
}

export function parseDetailPoints(input: string): DetailPoint[] {
  const points: unknown = JSON.parse(input);
  if (!validDetailPoints(points)) throw new Error('--points must be a JSON array of one or two {id,label,x,y} points with x and y from 0 to 1.');
  return points;
}

/**
 * Crop matching scene regions from recorded exports of differently cropped candidates.
 * Reads the run journal and saved files only; Lightroom is not contacted.
 */
export async function mapRunDetails(store: RunStore, runId: string, candidateIds: string[], anchorId: string, points: DetailPoint[], output: string) {
  if (candidateIds.length < 2 || new Set(candidateIds).size !== candidateIds.length) throw new Error('Compare at least two distinct candidates.');
  if (!candidateIds.includes(anchorId)) throw new Error('--anchor must be one of the compared candidates.');
  if (existsSync(output)) throw new Error('The detail output directory already exists. Choose a fresh path.');
  const candidates = store.listCandidates(runId);
  const sources: (FramedDetailSource & { maxEdge: number; operationId: string })[] = [];
  for (const id of candidateIds) {
    const candidate = candidates.find(item => item.id === id);
    if (!candidate) throw new Error(`Candidate ${id} does not belong to run ${runId}.`);
    const recorded = journalExport(store, runId, candidate);
    if (!recorded) throw new Error(`Candidate ${id} has no recorded JPEG export. Render it first, e.g. render --run ${runId} --candidate ${id} --size 8192.`);
    const source = await readDetailSource(recorded.path, candidate.stateToken);
    sources.push({ id, frame: cropFrame(candidate.settings), ...source, maxEdge: recorded.maxEdge, operationId: recorded.operationId });
  }
  // Refuse unverifiable geometry before creating any output.
  planMatchedDetails(sources, anchorId, points);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const matched = await cropMatchedDetails(sources, anchorId, points, output);
  const sheets = await contactSheets(matched, candidateIds, output);
  return {
    runId, anchorId, output,
    candidates: sources.map(({ id, path, width, height, frame, maxEdge, operationId }) => ({ id, export: path, width, height, maxEdge, operationId, frame })),
    regions: matched.plans.map(plan => plan.available
      ? { point: plan.point, available: true as const, scene: plan.scene, sheet: sheets[plan.point.id],
        candidates: candidateIds.map(id => {
          const detail = matched.details[id].find(item => item.id === plan.point.id)!;
          return { id, path: detail.path, window: plan.candidates[id].window, frameX: detail.frameX, frameY: detail.frameY, scale: detail.scale };
        }) }
      : { point: plan.point, available: false as const, reason: plan.reason }),
    note: 'Matched windows rely on crop settings and export dimensions. Confirm by eye that every crop shows the same scene content before relying on this mapping.',
  };
}

/** A side-by-side visual aid. Lower-resolution crops are enlarged only here, never in the evidence files. */
async function contactSheets(matched: MatchedDetails, order: string[], output: string) {
  const { default: sharp } = await import('sharp');
  const sheets: Record<string, string> = {};
  for (const plan of matched.plans) {
    if (!plan.available) continue;
    const details = order.map(id => matched.details[id].find(item => item.id === plan.point.id)!);
    const edge = Math.max(...details.map(detail => detail.width)), gap = 8;
    const tiles = await Promise.all(details.map(detail => sharp(detail.path).resize(edge, edge, { kernel: 'nearest' }).toBuffer()));
    const path = join(output, `${plan.point.id}-comparison.jpg`);
    await sharp({ create: { width: edge * tiles.length + gap * (tiles.length - 1), height: edge, channels: 3, background: '#000' } })
      .composite(tiles.map((input, index) => ({ input, left: index * (edge + gap), top: 0 })))
      .jpeg({ quality: 92 }).toFile(path);
    sheets[plan.point.id] = path;
  }
  return sheets;
}
