import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileBridge } from '../bridge.ts';
import { getPaths } from '../config.ts';
import { PhotoController } from '../controller.ts';
import type { BridgeClient, Photo } from '../controller.ts';
import { RunStore } from '../store.ts';
import type { Candidate } from '../store.ts';
import { CodexPhotoAgent, parseDecision, selectDecisionImages } from '../demo/agent.ts';
import type { Decision, DecisionInput } from '../demo/agent.ts';
import { cropDetails, readDetailSource } from '../demo/details.ts';
import type { DetailImage, DetailPoint, DetailSource } from '../demo/details.ts';
import { verifyRestoredRendering } from '../images.ts';
import { hashFile, scanCorpus, stageAsset } from './corpus.ts';
import type { Corpus } from './corpus.ts';

export interface EvaluationRender {
  role: 'starting' | 'fixed' | 'agent'; path: string; sha256: string; runId: string; candidateId: string;
  stateToken: string; settings: unknown;
}
export interface EvaluationCase {
  assetId: string; name: string; status: 'pending' | 'running' | 'complete' | 'needs_answer' | 'interrupted';
  elapsedMs?: number; renders: EvaluationRender[]; decisions: Decision[]; error?: string;
  fixedAdjustments?: Record<string, number>; question?: { text: string; options: string[] };
  runIds: string[];
}
export interface EvaluationBatch {
  version: 1; id: string; corpusFingerprint: string; source: string; startedAt: string; finishedAt?: string;
  status: 'running' | 'complete' | 'interrupted'; model: string; intent: string; maxEdits: number;
  baseline: 'as-imported-with-matching-xmp'; comparator: 'fixed-gentle-v1';
  modelUsage: null; error?: string; cases: EvaluationCase[];
  operations: Array<{ at: string; operation: string; phase: 'started' | 'completed' | 'failed'; params?: Record<string, unknown>; error?: string }>;
}
export interface EvaluationAgent { decide(input: DecisionInput, signal?: AbortSignal): Promise<Decision> }
const canonical = (value: unknown) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export function selectAssets(corpus: Corpus, options: { limit?: number; ids?: string[] }) {
  if (options.limit === undefined && !options.ids?.length) throw new Error('Native runs require explicit --limit or --id.');
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10)) throw new Error('--limit must be an integer from 1 to 10.');
  const ids = options.ids?.length ? options.ids : corpus.assets.map(asset => asset.id);
  if (new Set(ids).size !== ids.length) throw new Error('Asset IDs must be distinct.');
  const assets = ids.map(id => { const asset = corpus.assets.find(item => item.id === id); if (!asset) throw new Error(`Unknown asset: ${id}`); return asset; });
  const chosen = assets.slice(0, options.limit ?? assets.length);
  if (!chosen.length || chosen.length > 10) throw new Error('Choose 1–10 indexed RAW assets per run.');
  return chosen;
}
/** Fixed supported slider deltas, deliberately distinct from Lightroom Auto. */
export function fixedAdjustments(settings: Record<string, unknown>) {
  const result: Record<string, number> = {};
  for (const [key, delta] of Object.entries({ Highlights2012: -20, Shadows2012: 15, Vibrance: 5 })) {
    const current = settings[key];
    if (typeof current !== 'number' || !Number.isFinite(current)) throw new Error(`Fixed comparator requires numeric ${key}.`);
    const next = Math.max(-100, Math.min(100, current + delta)); if (next !== current) result[key] = next;
  }
  return result;
}
/** Never removes someone else's lock, and intentionally retains interrupted ownership. */
export function acquireEvaluationLock(runtime: string, details: Record<string, unknown>) {
  const path = join(runtime, 'session.lock'); const owner = randomUUID(); let fd: number;
  try { fd = openSync(path, 'wx', 0o600); } catch { throw new Error('Another editing session owns session.lock. Finish or reconcile it before evaluation.'); }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, owner, command: 'evaluation', createdAt: new Date().toISOString(), ...details }));
  let closed = false;
  return (preserve: boolean) => {
    if (closed) return; closed = true; closeSync(fd);
    if (!preserve) { try { if (JSON.parse(readFileSync(path, 'utf8')).owner === owner) unlinkSync(path); } catch { /* Preserve damaged or replaced locks. */ } }
  };
}
export async function runEvaluation(options: {
  root: string; corpus: Corpus; limit?: number; ids?: string[]; maxEdits?: number; intent?: string; model?: string;
  bridge?: BridgeClient; agent?: EvaluationAgent; onProgress?: (message: string) => void;
}) {
  const assets = selectAssets(options.corpus, options); const maxEdits = options.maxEdits ?? 2;
  if (!Number.isInteger(maxEdits) || maxEdits < 1 || maxEdits > 10) throw new Error('maxEdits must be 1–10.');
  const intent = options.intent ?? 'Natural, restrained editing that improves the visible subject while preserving the atmosphere. Avoid unnecessary changes.';
  if (!intent.trim() || intent.length > 2000) throw new Error('Intent must contain 1–2000 characters.');
  if ((await scanCorpus(options.corpus.source)).fingerprint !== options.corpus.fingerprint) throw new Error('Corpus changed; re-index before running.');
  const paths = getPaths(options.root); const id = `eval-${randomUUID()}`;
  const directory = join(paths.runtime, 'evaluation', 'runs', id); const database = join(directory, 'runs.sqlite');
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const release = acquireEvaluationLock(paths.runtime, { batchId: id, database });
  let preserve = false; let nativeStarted = false; let store: RunStore | undefined;
  const batch: EvaluationBatch = {
    version: 1, id, corpusFingerprint: options.corpus.fingerprint, source: options.corpus.source,
    startedAt: new Date().toISOString(), status: 'running', model: options.model ?? process.env.RPA_MODEL ?? 'gpt-6-astra', intent, maxEdits,
    baseline: 'as-imported-with-matching-xmp', comparator: 'fixed-gentle-v1', modelUsage: null,
    cases: assets.map(asset => ({ assetId: asset.id, name: asset.name, status: 'pending', renders: [], decisions: [], runIds: [] })), operations: [],
  };
  const resultPath = join(directory, 'results.json');
  const persist = async () => { await writeFile(`${resultPath}.tmp`, JSON.stringify(batch, null, 2), { mode: 0o600 }); await rename(`${resultPath}.tmp`, resultPath); };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 }); await persist();
    const underlying = options.bridge ?? new FileBridge(paths.bridgeDir, { timeoutMs: 60000 });
    const bridge: BridgeClient = { async call<T>(operation: string, params?: Record<string, unknown>): Promise<T> {
      nativeStarted = true; batch.operations.push({ at: new Date().toISOString(), operation, phase: 'started', params }); await persist();
      try {
        const result = await underlying.call<T>(operation, params);
        batch.operations.push({ at: new Date().toISOString(), operation, phase: 'completed' }); await persist(); return result;
      } catch (error) { batch.operations.push({ at: new Date().toISOString(), operation, phase: 'failed', error: String(error) }); await persist(); throw error; }
    } };
    store = new RunStore(database);
    // Native import/render allowlists require UUID upload directories and flat render filenames.
    // The separate SQLite journal and result manifest own these globally stored immutable exports.
    const controller = new PhotoController(bridge, store, paths.exportRoot);
    const agent = options.agent ?? new CodexPhotoAgent({ model: batch.model });
    for (const [index, asset] of assets.entries()) {
      const item = batch.cases[index]!; item.status = 'running'; const started = Date.now(); await persist();
      options.onProgress?.(`${index + 1}/${assets.length}: ${asset.name} — staging verified RAW and XMP copies`);
      try {
        const staged = await stageAsset(options.corpus, asset, join(paths.uploadRoot, randomUUID()), paths.uploadRoot);
        const photo = await bridge.call<Photo>('import_photo', { path: staged.path, filename: staged.name });
        if (photo.name !== asset.name || photo.isVirtualCopy) throw new Error('Import did not return the requested original.');
        const originalState = await controller.state(photo.photoId);
        const fixed = await controller.start(photo.photoId, 'Evaluation fixed-gentle-v1 comparator', asset.name); item.runIds.push(fixed.run.id); await persist();
        const fixedValues = fixedAdjustments(fixed.baseline.settings as Record<string, unknown>); item.fixedAdjustments = fixedValues;
        const fixedCandidate = Object.keys(fixedValues).length ? await controller.edit(fixed.run.id, fixed.baseline.id, fixedValues, 'Fixed gentle comparator (not Lightroom Auto)', 'fixed-gentle-v1') : fixed.baseline;
        item.renders.push(await renderRecord('fixed', fixedCandidate));
        store.setRunStatus(fixed.run.id, 'completed'); store.addEvent(fixed.run.id, 'evaluation_comparator_complete', { formula: 'fixed-gentle-v1', adjustments: fixedValues, photographerPreference: null });
        const reselected = await bridge.call<Photo>('import_photo', { path: staged.path, filename: staged.name });
        if (reselected.photoId !== photo.photoId || reselected.name !== photo.name || reselected.isVirtualCopy) throw new Error('Re-import did not reselect the recorded source original.');
        if (canonical((await controller.state(photo.photoId)).settings) !== canonical(originalState.settings)) throw new Error('Imported original settings changed during comparator preparation.');
        const begun = await controller.start(photo.photoId, intent, asset.name); item.runIds.push(begun.run.id);
        if (canonical(begun.baseline.settings) !== canonical(fixed.baseline.settings)) throw new Error('Agent and fixed comparator did not start from the same native settings.');
        item.renders.push(await renderRecord('starting', begun.baseline)); await persist();
        const outcome = await editWithAgent(controller, agent, begun.baseline, maxEdits, intent, join(directory, asset.id), async decision => {
          item.decisions.push(decision); options.onProgress?.(`${asset.name}: ${decision.action} — ${decision.title}`); await persist();
        });
        if (outcome.question) {
          item.status = 'needs_answer'; item.question = outcome.question;
          throw new Error('The model asked a creative question. No answer or final photographer preference was invented.');
        }
        item.renders.push(await renderRecord('agent', outcome.candidate));
        store.addEvent(begun.run.id, 'evaluation_agent_complete', { candidateId: outcome.candidate.id, photographerPreference: null, finalSelection: 'agent-current-checkpoint' });
        store.setRunStatus(begun.run.id, 'completed'); item.status = 'complete';
      } catch (error) {
        if (item.status !== 'needs_answer') item.status = 'interrupted'; item.error = error instanceof Error ? error.message : String(error);
        for (const runId of item.runIds) if (store.getRun(runId)?.status !== 'completed') store.setRunStatus(runId, 'interrupted');
        throw error;
      } finally { item.elapsedMs = Date.now() - started; await persist(); }
    }
    if ((await scanCorpus(options.corpus.source)).fingerprint !== options.corpus.fingerprint) throw new Error('Corpus changed during evaluation; inspect the source before trusting comparisons.');
    batch.status = 'complete'; batch.finishedAt = new Date().toISOString(); await persist();
  } catch (error) {
    preserve = nativeStarted; batch.status = 'interrupted'; batch.error = error instanceof Error ? error.message : String(error); batch.finishedAt = new Date().toISOString(); await persist();
    options.onProgress?.(`Evaluation stopped: ${String(error)}${preserve ? ' session.lock was retained; inspect saved operations before recovery.' : ''}`);
  } finally { store?.close(); release(preserve); }
  return { path: resultPath, batch };
}
async function renderRecord(role: EvaluationRender['role'], candidate: Candidate): Promise<EvaluationRender> {
  if (!candidate.previewPath) throw new Error('Evaluation candidate lacks a saved render.');
  return { role, path: candidate.previewPath, sha256: await hashFile(candidate.previewPath), runId: candidate.runId, candidateId: candidate.id, stateToken: candidate.stateToken, settings: candidate.settings };
}
async function editWithAgent(controller: PhotoController, agent: EvaluationAgent, baseline: Candidate, maxEdits: number, intent: string,
  directory: string, record: (decision: Decision) => Promise<void>) {
  let current = baseline; let edits = 0; let points: DetailPoint[] = [];
  const sources = new Map<string, DetailSource>(); const details = new Map<string, DetailImage[]>();
  const candidates: Candidate[] = [baseline]; const history: DecisionInput['history'] = [];
  const capture = async (candidate: Candidate) => {
    const rendered = await controller.render(candidate.runId, candidate.id, 8192);
    const source = await readDetailSource(rendered.previewPath!, candidate.stateToken); const first = sources.values().next().value;
    if (first && (first.width !== source.width || first.height !== source.height)) throw new Error('Detail export dimensions changed.');
    sources.set(candidate.id, source);
    if (points.length) details.set(candidate.id, await cropDetails(source, points, join(directory, candidate.id)));
  };
  await capture(current);
  for (let round = 0; round < 12; round++) {
    const parent = candidates.find(candidate => candidate.id === current.parentId);
    const references = [...new Set([baseline, parent, ...candidates.slice().reverse()].filter((value): value is Candidate => !!value))];
    const input: DecisionInput = { intent, currentCandidateId: current.id, remainingEdits: Math.max(0, maxEdits - edits), history, feedback: [], detailPoints: points,
      candidates: references.map(candidate => ({ id: candidate.id, description: candidate.description ?? '', previewPath: candidate.previewPath!,
        settings: candidate.settings as Record<string, unknown>, sourceWidth: sources.get(candidate.id)?.width, sourceHeight: sources.get(candidate.id)?.height, details: details.get(candidate.id) ?? [] })) };
    const decision = parseDecision(await agent.decide(input), { ...input, candidates: selectDecisionImages(input) });
    const actual = await controller.state(controller.run(current.runId).workingPhotoId);
    if (actual.stateToken !== current.stateToken) throw new Error('Lightroom changed during model review. Manual edits are preserved.');
    await record(decision); history.push({ title: decision.title, text: `${decision.observation}\n${decision.reason}` });
    if (decision.action === 'ask') return { candidate: current, question: { text: decision.question!, options: decision.options } };
    if (decision.action === 'finish') return { candidate: current };
    if (decision.action === 'edit') {
      if (edits >= maxEdits) throw new Error('The agent exceeded its editing budget.');
      current = await controller.edit(current.runId, current.id, decision.adjustments, decision.title); edits++; candidates.push(current); await capture(current);
    } else if (decision.action === 'inspect') {
      points = decision.detailPoints;
      for (const candidate of candidates) details.set(candidate.id, await cropDetails(sources.get(candidate.id)!, points, join(directory, candidate.id)));
    } else if (decision.action === 'restore') {
      const target = candidates.find(candidate => candidate.id === decision.candidateId)!;
      await controller.restore(current.runId, target.id, false, current.stateToken);
      const verification = await verifyRestoredRendering(target.previewPath!, async () => {
        const render = await controller.render(current.runId, target.id); return { ...render, previewPath: render.previewPath! };
      });
      controller.store.addEvent(current.runId, 'evaluation_restore_checked', { candidateId: target.id, ...verification });
      if (!verification.difference.pixelsIdentical) throw new Error('Restored settings match, but rendered pixels differ; inspect before continuing.');
      current = target;
    } else throw new Error(`Unsupported evaluation action: ${decision.action}. The current harness measures global edits only.`);
  }
  throw new Error('Decision limit reached without a final model assessment; case remains incomplete.');
}
