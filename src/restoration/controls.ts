import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import sharp from 'sharp';
import { FileBridge } from '../bridge.ts';
import { getPaths } from '../config.ts';
import { PhotoController } from '../controller.ts';
import type { BridgeClient, Photo, PhotoState } from '../controller.ts';
import { hashFile, scanCorpus } from '../evaluation/corpus.ts';
import type { Corpus, CorpusAsset } from '../evaluation/corpus.ts';
import { RunStore } from '../store.ts';
import type { Candidate } from '../store.ts';
import { compareLosslessTiff } from './images.ts';
import type { LosslessComparison } from './images.ts';
import { acquireRestorationLock } from './runner.ts';
import type { RestorationBatch } from './runner.ts';

type Block = 'unchanged' | 'checkpoint-only' | 'noop-restore';
interface Recipe { format: 'TIFF'; bitDepth: 16; colorSpace: 'sRGB'; outputSharpening: false; maxEdge: number }
interface ControlRender {
  id: string; block: Block; ordinal: number; path: string; sha256: string; startedAt: string; finishedAt: string;
  photoId: string; candidateId: string; stateToken: string; settings: Record<string, unknown>; recipe: Recipe;
}
interface ControlTransition {
  id: string; operation: string; startedAt: string; completedAt?: string; before: PhotoState; after?: PhotoState;
  settingsIdentical?: boolean; tokenIdentical?: boolean; photoIdentityChanged?: boolean;
}
export interface CheckpointControlReport {
  version: 1; id: string; status: 'running' | 'complete' | 'interrupted'; startedAt: string; finishedAt?: string;
  parent: { resultPath: string; resultSha256: string; experimentId: string; assetId: string; priorRunId: string; priorWorkingPhotoId: string; baselineCandidateId: string; baselineStateToken: string };
  sourceBaseline: { mode: 'historical' | 'explicit-new-experiment'; historicalState: PhotoState; expectedState: PhotoState; reason: string | null;
    historicalSettingsIdentical: boolean; historicalTokenIdentical: boolean; equivalenceClaimed: false; restorationClaimed: false };
  source: { name: string; stagedPath: string; rawSha256: string; sidecars: Array<{ path: string; sha256: string }>; corpusFingerprint: string; corpusPath: string };
  recipe: Recipe; exportsPerBlock: 3; blockOrder: Block[]; environment: Record<string, unknown>; capabilities?: Record<string, unknown>;
  scope: { parentNativeSettingsVerification: 'preflight-and-native-copy-creation-only'; freshDiagnosticCopy: true; changesApplied: false; noOpRestoreCount: 1; gpuRestartControls: false; autonomousMaskingEnabled: false;
    initialJpegExportCount: 1; tiffExportCondition: 'after-controller-baseline-jpeg-not-cold' };
  runId?: string; workingPhotoId?: string; baselineId?: string; checkpointOnlyId?: string; preflightState?: PhotoState; finalState?: PhotoState;
  transitions: ControlTransition[]; renders: ControlRender[];
  comparisons: Array<{ id: string; kind: 'within-block' | 'baseline-to-later'; block: Block; beforeId: string; afterId: string; measuredAt: string; result: LosslessComparison }>;
  operations: Array<{ at: string; operation: string; phase: 'started' | 'completed' | 'failed'; params?: Record<string, unknown>; result?: unknown; error?: string; code?: string; outcomeUncertain?: boolean }>;
  sourceUnchanged?: boolean; stagedFilesUnchanged?: boolean; parentReportUnchanged?: boolean; lockRetained: boolean; error?: string;
  summary?: { settingsIdentical: boolean; comparisons: number; comparisonInputsValid: boolean; pixelsIdentical: boolean; pixelResult: 'exact-on-recorded-pairs' | 'unverified'; note: string };
}
const canonical = (value: unknown): string => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function assertExactState(actual: PhotoState, expected: PhotoState) {
  if (actual.photoId !== expected.photoId || actual.stateToken !== expected.stateToken || canonical(actual.settings) !== canonical(expected.settings))
    throw new Error('Native photo identity, state token or settings differ from the recorded control state. No mutation was retried.');
}
function copyExplicitBaseline(value: { state: PhotoState; reason: string } | undefined) {
  if (value === undefined) return undefined;
  const jsonValue = (item: unknown, ancestors = new Set<object>()): boolean => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (!item || typeof item !== 'object' || ancestors.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    const next = new Set(ancestors).add(item);
    return Object.values(item).every(child => jsonValue(child, next));
  };
  if (!value || typeof value !== 'object' || typeof value.reason !== 'string' || !value.reason.trim()
    || !value.state || typeof value.state !== 'object' || Array.isArray(value.state)
    || typeof value.state.photoId !== 'string' || !value.state.photoId.trim()
    || typeof value.state.stateToken !== 'string' || !value.state.stateToken.trim()
    || !value.state.settings || typeof value.state.settings !== 'object' || Array.isArray(value.state.settings) || !jsonValue(value.state))
    throw new Error('An explicit source baseline requires a photo ID, nonempty state token, complete JSON settings, and a nonempty reason.');
  return { state: structuredClone(value.state), reason: value.reason.trim() };
}
async function verifyStagedFiles(root: string, asset: CorpusAsset, stagedPath: string) {
  const uploads = await realpath(getPaths(root).uploadRoot);
  if (!isAbsolute(stagedPath) || await realpath(stagedPath) !== stagedPath || basename(stagedPath) !== asset.name
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[^/]+$/i.test(relative(uploads, stagedPath)))
    throw new Error('Prior staged RAW must be a physical uploads/UUID/filename source.');
  const files = [asset.raw, ...asset.sidecars];
  if (canonical((await readdir(dirname(stagedPath))).sort()) !== canonical(files.map(file => basename(file.path)).sort())) throw new Error('Staged RAW/XMP inventory differs from the indexed source.');
  for (const file of files) {
    const path = join(dirname(stagedPath), basename(file.path)); const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path || stat.size !== file.bytes || await hashFile(path) !== file.sha256)
      throw new Error(`Staged source bytes changed: ${basename(path)}`);
  }
}
async function inspectPrior(options: { root: string; corpus: Corpus; resultPath: string; assetId: string }) {
  if (!isAbsolute(options.resultPath) || !options.assetId?.trim()) throw new Error('An absolute completed result path and explicit asset ID are required.');
  const resultPath = await realpath(options.resultPath); const bytes = await readFile(resultPath); const sha256 = createHash('sha256').update(bytes).digest('hex');
  const batch = JSON.parse(bytes.toString('utf8')) as RestorationBatch;
  const restorationRoot = await realpath(join(getPaths(options.root).runtime, 'restoration'));
  if (batch.version !== 1 || !/^restoration-[a-f0-9-]{36}$/.test(batch.id) || resultPath !== join(restorationRoot, batch.id, 'results.json')
    || batch.status !== 'complete' || batch.sourceUnchanged !== true || batch.lockRetained || batch.corpusFingerprint !== options.corpus.fingerprint
    || await realpath(batch.source) !== options.corpus.source || !Array.isArray(batch.cases)) throw new Error('Controls require a completed restoration report from the unchanged indexed corpus.');
  const matches = batch.cases.filter(item => item.assetId === options.assetId); const asset = options.corpus.assets.find(item => item.id === options.assetId);
  const item = matches[0];
  if (matches.length !== 1 || !asset || !item || item.status !== 'complete' || !item.runId || !item.workingPhotoId || !item.baselineId || !item.stagedPath
    || item.name !== asset.name || item.sourceSha256 !== asset.raw.sha256 || item.stagedRawUnchanged !== true
    || canonical(item.sourceSidecars) !== canonical(asset.sidecars.map(file => ({ path: file.path, sha256: file.sha256 }))) || !Array.isArray(item.renders))
    throw new Error('The explicit case lacks a completed, preserved working-copy baseline.');
  const baseline = item.renders.find(render => render.phase === 'baseline-control' && render.ordinal === 1);
  const restored = item.renders.filter(render => render.phase === 'restored-precreation');
  if (!baseline || restored.length !== 1 || !item.settingsRestorations.some(value => value.phase === 'precreation' && value.exact
    && value.actualStateToken === baseline.stateToken && value.expectedStateToken === baseline.stateToken)) throw new Error('The prior pre-creation baseline restoration is not recorded exactly.');
  const renderRoot = await realpath(getPaths(options.root).exportRoot);
  for (const render of [baseline, restored[0]!]) {
    if (render.photoId !== item.workingPhotoId || render.runId !== item.runId || render.candidateId !== item.baselineId || render.sourceSha256 !== asset.raw.sha256
      || render.stateToken !== baseline.stateToken || canonical(render.settings) !== canonical(baseline.settings) || !render.stateToken
      || render.recipe?.format !== 'TIFF' || render.recipe.bitDepth !== 16 || render.recipe.colorSpace !== 'sRGB' || render.recipe.outputSharpening !== false
      || render.recipe.maxEdge !== batch.maxEdge || !isAbsolute(render.path) || dirname(await realpath(render.path)) !== renderRoot
      || await realpath(render.path) !== render.path || !/^[a-f0-9-]+\.tif$/i.test(basename(render.path)) || await hashFile(render.path) !== render.sha256)
      throw new Error('Prior baseline/restored render provenance or file hash does not match the selected case.');
  }
  if ((await scanCorpus(options.corpus.source)).fingerprint !== options.corpus.fingerprint) throw new Error('Source corpus changed since the prior experiment.');
  await verifyStagedFiles(options.root, asset, item.stagedPath);
  return { resultPath, sha256, batch, item, asset, baseline };
}

/** Nine fixed exports on a new diagnostic virtual copy. No import, applied adjustment, mutation retry or cleanup restore. */
export async function runCheckpointControls(options: {
  root: string; corpus: Corpus; resultPath: string; assetId: string; maxEdge?: number;
  sourceBaseline?: { state: PhotoState; reason: string };
  bridge?: BridgeClient; environmentNotes?: string; onProgress?: (message: string) => void;
}) {
  // Copy the caller's explicit observation before awaiting anything. It establishes a new
  // diagnostic baseline; it never normalizes or overwrites the historical evidence.
  const explicitBaseline = copyExplicitBaseline(options.sourceBaseline);
  const prior = await inspectPrior(options); const maxEdge = options.maxEdge ?? prior.batch.maxEdge;
  if (!Number.isInteger(maxEdge) || maxEdge < 256 || maxEdge > 8192) throw new Error('maxEdge must be an integer from 256 to 8192.');
  const historicalState: PhotoState = { photoId: prior.item.workingPhotoId!, stateToken: prior.baseline.stateToken, settings: structuredClone(prior.baseline.settings) };
  if (explicitBaseline && explicitBaseline.state.photoId !== historicalState.photoId) throw new Error('The explicit source baseline must identify the same prior working photo.');
  const sourceState = explicitBaseline?.state ?? historicalState;
  const paths = getPaths(options.root); const id = `controls-${randomUUID()}`; const directory = join(paths.runtime, 'restoration-controls', id);
  const resultPath = join(directory, 'results.json'); const database = join(directory, 'runs.sqlite');
  const releaseLock = acquireRestorationLock(paths.runtime, { command: 'checkpoint-controls', experimentId: id, database });
  let store: RunStore | undefined; let mutationStarted = false; let preserve = false; let pendingCopyId: string | undefined;
  let expected: PhotoState = structuredClone(sourceState);
  const report: CheckpointControlReport = {
    version: 1, id, status: 'running', startedAt: new Date().toISOString(),
    parent: { resultPath: prior.resultPath, resultSha256: prior.sha256, experimentId: prior.batch.id, assetId: prior.asset.id, priorRunId: prior.item.runId!,
      priorWorkingPhotoId: prior.item.workingPhotoId!, baselineCandidateId: prior.item.baselineId!, baselineStateToken: prior.baseline.stateToken },
    sourceBaseline: { mode: explicitBaseline ? 'explicit-new-experiment' : 'historical', historicalState, expectedState: structuredClone(sourceState), reason: explicitBaseline?.reason ?? null,
      historicalSettingsIdentical: canonical(historicalState.settings) === canonical(sourceState.settings), historicalTokenIdentical: historicalState.stateToken === sourceState.stateToken,
      equivalenceClaimed: false, restorationClaimed: false },
    source: { name: prior.asset.name, stagedPath: prior.item.stagedPath!, rawSha256: prior.asset.raw.sha256, sidecars: prior.item.sourceSidecars,
      corpusFingerprint: options.corpus.fingerprint, corpusPath: options.corpus.source },
    recipe: { format: 'TIFF', bitDepth: 16, colorSpace: 'sRGB', outputSharpening: false, maxEdge }, exportsPerBlock: 3,
    blockOrder: ['unchanged', 'checkpoint-only', 'noop-restore'], environment: { platform: platform(), osRelease: release(), architecture: arch(), node: process.version,
      decoder: sharp.versions, gpuConfiguration: null, lightroomRestartState: 'not-established', notes: options.environmentNotes ?? null },
    scope: { parentNativeSettingsVerification: 'preflight-and-native-copy-creation-only', freshDiagnosticCopy: true, changesApplied: false,
      noOpRestoreCount: 1, gpuRestartControls: false, autonomousMaskingEnabled: false, initialJpegExportCount: 1, tiffExportCondition: 'after-controller-baseline-jpeg-not-cold' }, transitions: [], renders: [], comparisons: [], operations: [], lockRetained: false,
  };
  const persist = async () => { await writeFile(`${resultPath}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); await rename(`${resultPath}.tmp`, resultPath); };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 }); await persist();
    if (await hashFile(prior.resultPath) !== prior.sha256) throw new Error('The prior restoration report changed before acquiring ownership.');
    await verifyStagedFiles(options.root, prior.asset, prior.item.stagedPath!);
    try { report.environment.installedOperationsSha256 = await hashFile(join(paths.pluginInstall, 'Operations.lua')); }
    catch (error) { report.environment.installedOperationsSha256 = null; report.environment.installedOperationsHashError = errorText(error); }
    const underlying = options.bridge ?? new FileBridge(paths.bridgeDir, { timeoutMs: 60000 });
    if (underlying instanceof FileBridge) {
      const status = await underlying.status(); let pending: string[] = [];
      try { pending = (await readdir(join(paths.bridgeDir, 'requests'))).filter(name => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/i.test(name) && !existsSync(join(paths.bridgeDir, 'responses', name))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!status.online || (status.heartbeat as { status?: string })?.status !== 'idle' || existsSync(join(paths.bridgeDir, 'call.lock')) || pending.length) throw new Error('The native bridge must be online and idle with no pending calls.');
      report.environment.nativeBridgeIdleVerifiedAt = new Date().toISOString();
    }
    const bridge: BridgeClient = { async call<T>(operation: string, params?: Record<string, unknown>): Promise<T> {
      if (!['capabilities', 'selected', 'read_state', 'create_working_copy', 'checkpoint', 'restore', 'render'].includes(operation)) throw new Error(`Control operation is not permitted: ${operation}`);
      let transition: ControlTransition | undefined;
      if (['create_working_copy', 'checkpoint', 'restore', 'render'].includes(operation)) {
        if (params?.photoId !== expected.photoId || (operation === 'create_working_copy' && report.workingPhotoId)) throw new Error('Control operation targets the wrong photo or repeats copy creation.');
        const before = await bridge.call<PhotoState>('read_state', { photoId: expected.photoId }); assertExactState(before, expected);
        transition = { id: randomUUID(), operation, startedAt: new Date().toISOString(), before }; report.transitions.push(transition); await persist();
      }
      report.operations.push({ at: new Date().toISOString(), operation, phase: 'started', params }); await persist();
      if (['create_working_copy', 'checkpoint', 'restore'].includes(operation)) mutationStarted = true;
      try {
        const result = await underlying.call<T>(operation, params);
        report.operations.push({ at: new Date().toISOString(), operation, phase: 'completed', result }); await persist();
        if (operation === 'read_state') {
          const actual = result as PhotoState;
          if (pendingCopyId) {
            if (params?.photoId !== pendingCopyId || actual.photoId !== pendingCopyId || !actual.stateToken || canonical(actual.settings) !== canonical(expected.settings)) throw new Error('New diagnostic copy settings differ from the protected source.');
          } else assertExactState(actual, expected);
        }
        if (transition) {
          if (operation === 'create_working_copy') {
            const copy = result as { photoId: string; state?: PhotoState };
            if (!copy.photoId || copy.photoId === expected.photoId) throw new Error('A distinct diagnostic working copy was not created.');
            const selection = await bridge.call<{ count: number; photos: Photo[] }>('selected'); const selected = selection.photos[0];
            if (selection.count !== 1 || selection.photos.length !== 1 || !selected?.isVirtualCopy || selected.photoId !== copy.photoId || selected.path !== prior.item.stagedPath || selected.name !== prior.asset.name)
              throw new Error('New diagnostic virtual-copy identity did not verify.');
            // The new identity has its own token; compare exact settings before accepting it.
            pendingCopyId = copy.photoId;
            const after = await bridge.call<PhotoState>('read_state', { photoId: copy.photoId });
            if (copy.state) assertExactState(copy.state, after);
            expected = after; pendingCopyId = undefined; report.workingPhotoId = copy.photoId;
          } else if (operation === 'render') {
            const render = result as { photoId: string; stateToken: string; outputPath: string };
            if (render.photoId !== expected.photoId || render.stateToken !== expected.stateToken || render.outputPath !== params?.outputPath) throw new Error('Export provenance does not match the current control state.');
          } else {
            const returned = (result as { state: PhotoState }).state; assertExactState(returned, expected);
          }
          const after = await bridge.call<PhotoState>('read_state', { photoId: expected.photoId }); assertExactState(after, expected);
          Object.assign(transition, { after, completedAt: new Date().toISOString(), settingsIdentical: canonical(after.settings) === canonical(transition.before.settings),
            tokenIdentical: after.stateToken === transition.before.stateToken, photoIdentityChanged: after.photoId !== transition.before.photoId }); await persist();
        }
        return result;
      } catch (error) {
        const native = error as { code?: string; outcomeUncertain?: boolean };
        report.operations.push({ at: new Date().toISOString(), operation, phase: 'failed', error: errorText(error), code: native?.code, outcomeUncertain: native?.outcomeUncertain }); await persist(); throw error;
      }
    } };
    report.capabilities = await bridge.call<Record<string, unknown>>('capabilities');
    const capabilities = report.capabilities as { operations?: Record<string, boolean>; renderFormats?: { TIFF?: { bitDepth?: number; lossless?: boolean } } };
    if (!['create_working_copy', 'checkpoint', 'restore', 'render'].every(operation => capabilities.operations?.[operation]) || capabilities.renderFormats?.TIFF?.bitDepth !== 16 || capabilities.renderFormats.TIFF.lossless !== true)
      throw new Error('Native capabilities do not support guarded checkpoint controls and lossless TIFF export.');
    const selection = await bridge.call<{ count: number; photos: Photo[] }>('selected'); const selected = selection.photos[0];
    if (selection.count !== 1 || selection.photos.length !== 1 || !selected?.isVirtualCopy || selected.photoId !== prior.item.workingPhotoId || selected.path !== prior.item.stagedPath || selected.name !== prior.asset.name
      || !['RAW', 'DNG'].includes(selected.fileFormat.toUpperCase())) throw new Error('Select the exact completed diagnostic virtual copy at the required source baseline.');
    report.preflightState = await bridge.call<PhotoState>('read_state', { photoId: expected.photoId }); await persist();
    store = new RunStore(database); const controller = new PhotoController(bridge, store, paths.exportRoot);
    options.onProgress?.(`${prior.asset.name}: creating a new diagnostic virtual copy for nine fixed TIFF controls`);
    const begun = await controller.start(expected.photoId, 'Checkpoint-only and no-op restoration controls; no develop adjustments', prior.asset.name);
    report.runId = begun.run.id; report.baselineId = begun.baseline.id;
    if (canonical(begun.baseline.settings) !== canonical(sourceState.settings) || begun.baseline.stateToken !== expected.stateToken) throw new Error('Diagnostic baseline differs from the selected saved source settings.');
    const compare = async (before: ControlRender, after: ControlRender, kind: 'within-block' | 'baseline-to-later') => {
      const result = await compareLosslessTiff(before.path, after.path, { expectedBeforeSha256: before.sha256, expectedAfterSha256: after.sha256 });
      report.comparisons.push({ id: randomUUID(), kind, block: after.block, beforeId: before.id, afterId: after.id, measuredAt: new Date().toISOString(), result }); await persist();
      if (!result.comparable) throw new Error(`Control TIFFs are not comparable: ${result.issues.join('; ')}`);
    };
    const block = async (name: Block, candidate: Candidate) => {
      options.onProgress?.(`${prior.asset.name}: ${name} — three unchanged TIFF exports`); const renders: ControlRender[] = [];
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        const startedAt = new Date().toISOString(); const rendered = await controller.render(begun.run.id, candidate.id, maxEdge, 'TIFF');
        const record: ControlRender = { id: randomUUID(), block: name, ordinal, path: rendered.previewPath!, sha256: await hashFile(rendered.previewPath!), startedAt,
          finishedAt: new Date().toISOString(), photoId: expected.photoId, candidateId: candidate.id, stateToken: expected.stateToken, settings: expected.settings, recipe: report.recipe };
        report.renders.push(record); await persist();
        const metadataCheck = await compareLosslessTiff(record.path, record.path, { expectedBeforeSha256: record.sha256, expectedAfterSha256: record.sha256 });
        if (!metadataCheck.comparable) throw new Error(`Control export is not a valid lossless TIFF: ${metadataCheck.issues.join('; ')}`);
        for (const previous of renders) await compare(previous, record, 'within-block');
        if (name !== 'unchanged') await compare(report.renders[0]!, record, 'baseline-to-later');
        renders.push(record);
      }
    };
    await block('unchanged', begun.baseline);
    const checkpoint = await controller.checkpoint(begun.run.id, 'Checkpoint-only control', begun.baseline.id, 'diagnostic'); report.checkpointOnlyId = checkpoint.id; await persist();
    await block('checkpoint-only', checkpoint);
    await controller.restore(begun.run.id, begun.baseline.id, false, expected.stateToken);
    await block('noop-restore', begun.baseline);
    report.finalState = await controller.state(expected.photoId); assertExactState(report.finalState, expected);
    const valid = report.comparisons.length === 15 && report.comparisons.every(pair => pair.result.comparable);
    const pixelsIdentical = valid && report.comparisons.every(pair => pair.result.pixelsIdentical);
    report.summary = { settingsIdentical: report.transitions.every(item => item.settingsIdentical === true), comparisons: report.comparisons.length, comparisonInputsValid: valid,
      pixelsIdentical, pixelResult: pixelsIdentical ? 'exact-on-recorded-pairs' : 'unverified', note: `One selected scene, fixed ordering, three exports per block. Settings checks are against this diagnostic experiment's baseline. ${explicitBaseline ? 'The explicit new baseline is not an equivalence or restoration claim about the historical state. ' : ''}Descriptive controls only; no tolerance, GPU or restart conclusion, or autonomous enablement.` };
    store.addEvent(begun.run.id, 'checkpoint_controls_complete', { experimentId: id, summary: report.summary }); store.setRunStatus(begun.run.id, 'completed'); report.status = 'complete';
  } catch (error) {
    preserve = mutationStarted; report.status = 'interrupted'; report.error = errorText(error); if (report.runId) store?.setRunStatus(report.runId, 'interrupted');
  } finally {
    try {
      report.sourceUnchanged = (await scanCorpus(options.corpus.source)).fingerprint === options.corpus.fingerprint;
      await verifyStagedFiles(options.root, prior.asset, prior.item.stagedPath!); report.stagedFilesUnchanged = true;
      report.parentReportUnchanged = await hashFile(prior.resultPath) === prior.sha256;
      if (!report.sourceUnchanged || !report.parentReportUnchanged) throw new Error('Original corpus or prior experiment report changed during controls.');
    } catch (error) { report.status = 'interrupted'; report.error = report.error ? `${report.error} Source verification: ${errorText(error)}` : errorText(error); preserve ||= mutationStarted; if (report.runId) store?.setRunStatus(report.runId, 'interrupted'); }
    report.lockRetained = preserve; report.finishedAt = new Date().toISOString();
    try { await persist(); } finally { store?.close(); releaseLock(preserve); }
  }
  options.onProgress?.(report.status === 'complete' ? `${prior.asset.name}: exact settings throughout; pixels ${report.summary!.pixelResult}`
    : `Controls stopped: ${report.error}${preserve ? ' Shared session.lock retained for inspection.' : ''}`);
  return { path: resultPath, report };
}
