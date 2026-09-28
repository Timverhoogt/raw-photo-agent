import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { FileBridge } from '../bridge.ts';
import { getPaths } from '../config.ts';
import { PhotoController } from '../controller.ts';
import type { BridgeClient, Photo, PhotoState } from '../controller.ts';
import { hashFile, scanCorpus, stageAsset } from '../evaluation/corpus.ts';
import type { Corpus, CorpusAsset } from '../evaluation/corpus.ts';
import { RunStore } from '../store.ts';
import type { Candidate } from '../store.ts';
import { compareLosslessTiff } from './images.ts';

type Comparison = Awaited<ReturnType<typeof compareLosslessTiff>>;
type MaskKind = 'subject' | 'background';
type Phase = 'baseline-control' | 'masked-control' | 'edited' | 'restored-mask' | 'restored-mask-control' | 'restored-precreation';
interface MaskContext { selectedMaskId: string; parameters: Record<string, { value: number; min: number; max: number }> }
interface MaskResult { state: PhotoState; maskContext: MaskContext; maskId: string; maskKind: MaskKind; completion: string }
export interface RestorationRender {
  id: string; phase: Phase; ordinal: number; path: string; sha256: string;
  startedAt: string; finishedAt: string; durationMs: number; photoId: string; runId: string; candidateId: string;
  stateToken: string; settings: Record<string, unknown>; sourceSha256: string;
  recipe: { format: 'TIFF'; bitDepth: 16; colorSpace: 'sRGB'; outputSharpening: false; maxEdge: number };
}
export interface RestorationComparison {
  id: string; kind: 'unchanged-baseline' | 'unchanged-masked' | 'local-effect' | 'local-restoration' | 'unchanged-restored' | 'precreation-restoration';
  beforeId: string; afterId: string; measuredAt: string; result: Comparison;
}
export interface RestorationCase {
  assetId: string; name: string; status: 'pending' | 'running' | 'complete' | 'interrupted';
  startedAt?: string; finishedAt?: string; runId?: string; sourcePhotoId?: string; workingPhotoId?: string;
  stagedPath?: string; sourceSha256: string; sourceSidecars: Array<{ path: string; sha256: string }>;
  baselineId?: string; maskedId?: string; editedId?: string; maskId?: string; maskCompletion?: string;
  exposure?: { before: number; requested: number; observed: number; min: number; max: number };
  settingsRestorations: Array<{ phase: 'local' | 'precreation'; at: string; expectedStateToken: string; actualStateToken: string; exact: boolean }>;
  renders: RestorationRender[]; comparisons: RestorationComparison[];
  importedOriginalSettingsUnchanged?: boolean; stagedRawUnchanged?: boolean; error?: string; summary?: ReturnType<typeof summarizeRestorationCase>;
  sourceEndVerification?: 'native-settings-and-staged-raw' | 'staged-raw-only-no-import-retry';
}
export interface RestorationBatch {
  version: 1; id: string; status: 'running' | 'complete' | 'interrupted'; startedAt: string; finishedAt?: string;
  source: string; corpusFingerprint: string; sourceUnchanged?: boolean; sourceVerificationError?: string;
  baseline: 'as-imported-with-matching-xmp'; controls: number; maskKind: MaskKind; exposureDelta: number; maxEdge: number;
  autonomousMaskingEnabled: false; environment: Record<string, unknown>; capabilities?: Record<string, unknown>;
  cases: RestorationCase[]; operations: Array<{ at: string; operation: string; phase: 'started' | 'completed' | 'failed'; params?: Record<string, unknown>; result?: unknown; error?: string; errorCode?: string; requestId?: string; outcomeUncertain?: boolean }>;
  error?: string; lockRetained: boolean;
  resumedImport?: { parentResultPath: string; parentResultSha256: string; parentExperimentId: string; stagedPath: string;
    expectedSourceStateToken: string; observedSourceStateToken?: string; observedSourcePhotoId?: string; verifiedAt?: string; nativeBridgeIdleVerifiedAt?: string };
}
const canonical = (value: unknown): string => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const mutating = new Set(['import_photo', 'create_working_copy', 'checkpoint', 'create_subject_mask', 'create_background_mask', 'adjust_mask', 'restore']);

export function selectRestorationAssets(corpus: Corpus, ids: string[], controls = 3) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 10 || new Set(ids).size !== ids.length) throw new Error('Choose 1–10 distinct explicit indexed asset IDs.');
  if (!Number.isInteger(controls) || controls < 3 || controls > 10) throw new Error('controls must be an integer from 3 to 10.');
  return ids.map(id => { const asset = corpus.assets.find(item => item.id === id); if (!asset) throw new Error(`Unknown asset: ${id}`); return asset; });
}
/** The shared lock serializes this experiment with both the demo and ordinary CLI. */
export function acquireRestorationLock(runtime: string, details: Record<string, unknown>) {
  const path = join(runtime, 'session.lock'); const owner = randomUUID(); let fd: number;
  try { fd = openSync(path, 'wx', 0o600); } catch { throw new Error('Another editing session owns session.lock. Finish or reconcile it before restoration experiments.'); }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, owner, command: 'restoration', createdAt: new Date().toISOString(), ...details })); }
  catch (error) { closeSync(fd); throw error; }
  let closed = false;
  return (preserve: boolean) => {
    if (closed) return; closed = true; closeSync(fd);
    if (!preserve) { try { if (JSON.parse(readFileSync(path, 'utf8')).owner === owner) unlinkSync(path); } catch { /* Preserve damaged/replaced locks. */ } }
  };
}
function assertState(actual: PhotoState, expected: { photoId: string; stateToken: string; settings: unknown }) {
  if (actual.photoId !== expected.photoId || actual.stateToken !== expected.stateToken || canonical(actual.settings) !== canonical(expected.settings))
    throw new Error('Native photo identity or saved settings changed. Stop and inspect the working copy; no mutation was retried.');
}
interface ResumeImportRequest { resultPath: string; expectedStateToken: string; parentSha256?: string }
interface ResumeImportPlan { batch: RestorationBatch; item: RestorationCase; asset: CorpusAsset; resultPath: string; sha256: string; expectedStateToken: string }
/** Only a single, terminal import failure may be reused. No existing editing run is resumed. */
async function inspectImportOnlyFailure(root: string, corpus: Corpus, request: ResumeImportRequest): Promise<ResumeImportPlan> {
  if (!request.expectedStateToken?.trim() || request.expectedStateToken.length > 2000) throw new Error('An explicit current source state token is required for resume-import.');
  if (!isAbsolute(request.resultPath)) throw new Error('resume-import requires an absolute result path.');
  const paths = getPaths(root); const resultPath = await realpath(request.resultPath);
  const restorationRoot = await realpath(join(paths.runtime, 'restoration'));
  const reportBytes = await readFile(resultPath); const sha256 = createHash('sha256').update(reportBytes).digest('hex');
  if (request.parentSha256 && request.parentSha256 !== sha256) throw new Error('The failed import report changed before continuation.');
  const batch = JSON.parse(reportBytes.toString('utf8')) as RestorationBatch;
  if (batch.version !== 1 || !/^restoration-[a-f0-9-]{36}$/.test(batch.id) || resultPath !== join(restorationRoot, batch.id, 'results.json')
    || !(await lstat(resultPath)).isFile() || batch.status !== 'interrupted' || batch.resumedImport
    || !Array.isArray(batch.cases) || batch.cases.length !== 1 || batch.baseline !== 'as-imported-with-matching-xmp'
    || batch.corpusFingerprint !== corpus.fingerprint || await realpath(batch.source) !== corpus.source)
    throw new Error('resume-import requires an unchanged one-case interrupted report from this indexed corpus.');
  const item = batch.cases[0]!; const asset = corpus.assets.find(value => value.id === item.assetId);
  if (!asset || item.name !== asset.name || item.sourceSha256 !== asset.raw.sha256 || canonical(item.sourceSidecars) !== canonical(asset.sidecars.map(file => ({ path: file.path, sha256: file.sha256 })))
    || item.status !== 'interrupted' || item.runId || item.workingPhotoId || item.baselineId || item.maskedId || item.editedId || item.maskId || item.maskCompletion || item.exposure
    || !Array.isArray(item.renders) || item.renders.length || !Array.isArray(item.comparisons) || item.comparisons.length
    || !Array.isArray(item.settingsRestorations) || item.settingsRestorations.length)
    throw new Error('Only an import-only case with no working copy, checkpoint, mask or render may continue.');
  const operations = batch.operations;
  if (!Array.isArray(operations) || operations.length !== 4
    || operations[0]?.operation !== 'capabilities' || operations[0].phase !== 'started'
    || operations[1]?.operation !== 'capabilities' || operations[1].phase !== 'completed'
    || operations[2]?.operation !== 'import_photo' || operations[2].phase !== 'started'
    || operations[3]?.operation !== 'import_photo' || operations[3].phase !== 'failed')
    throw new Error('The prior journal must contain exactly one completed capabilities call and one terminal failed import, with no pending or other native calls.');
  const failed = operations[3]!;
  if (failed.errorCode !== 'STALE_STATE' && !(failed.errorCode === undefined && failed.error === 'Develop settings changed; read_state and review before submitting another edit.'))
    throw new Error('Only a terminal native STALE_STATE import failure may continue; timeouts and unknown outcomes require separate recovery.');
  const staged = item.stagedPath;
  if (!staged || !isAbsolute(staged) || staged !== resolve(staged) || await realpath(staged) !== staged
    || operations[2].params?.path !== staged || operations[2].params?.filename !== asset.name)
    throw new Error('The staged path does not match the prior import request or resolves through a link.');
  const uploads = await realpath(paths.uploadRoot); const local = relative(uploads, staged);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[^/]+$/i.test(local) || basename(staged) !== asset.name)
    throw new Error('The staged source must use the native uploads/UUID/filename layout.');
  const files = [asset.raw, ...asset.sidecars]; const expectedNames = files.map(file => basename(file.path)).sort();
  if (canonical((await readdir(dirname(staged))).sort()) !== canonical(expectedNames)) throw new Error('The staged source directory contains missing or additional files.');
  for (const file of files) {
    const path = join(dirname(staged), basename(file.path)); const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path || stat.size !== file.bytes || await hashFile(path) !== file.sha256)
      throw new Error(`The staged RAW or XMP differs from the indexed source: ${basename(path)}`);
  }
  return { batch, item, asset, resultPath, sha256, expectedStateToken: request.expectedStateToken };
}
function maskGroups(settings: Record<string, unknown>) {
  const groups = settings.MaskGroupBasedCorrections;
  if (groups === undefined) return [];
  if (!Array.isArray(groups) || groups.some(group => !group || typeof group.CorrectionID !== 'string')) throw new Error('Native mask identities are unavailable.');
  return groups as Array<Record<string, unknown> & { CorrectionID: string }>;
}
function validateCreatedMask(created: MaskResult, baseline: Candidate, photoId: string, kind: MaskKind) {
  if (created.state.photoId !== photoId || !created.state.stateToken || created.state.stateToken === baseline.stateToken || !created.maskId
    || created.maskKind !== kind || created.maskContext.selectedMaskId !== created.maskId || created.completion !== 'stored-and-selected')
    throw new Error('Native mask creation identity or completion could not be verified.');
  const before = maskGroups(baseline.settings as Record<string, unknown>); const after = maskGroups(created.state.settings);
  const old = new Map(before.map(group => [group.CorrectionID, group]));
  if (after.length !== before.length + 1 || old.has(created.maskId) || new Set(after.map(group => group.CorrectionID)).size !== after.length
    || !after.some(group => group.CorrectionID === created.maskId)
    || before.some(group => canonical(after.find(item => item.CorrectionID === group.CorrectionID)) !== canonical(group)))
    throw new Error('Mask creation did not preserve existing masks and create exactly one identified group.');
  const protectedSettings = (settings: Record<string, unknown>) => Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'MaskGroupBasedCorrections' && (before.length !== 0 || key !== 'EnableMaskGroupBasedCorrections')));
  if (canonical(protectedSettings(baseline.settings as Record<string, unknown>)) !== canonical(protectedSettings(created.state.settings)))
    throw new Error('An unrelated setting changed while creating the mask.');
}
export function summarizeRestorationCase(item: RestorationCase) {
  const controls = item.comparisons.filter(value => ['unchanged-baseline', 'unchanged-masked', 'unchanged-restored'].includes(value.kind));
  const restorations = item.comparisons.filter(value => value.kind === 'local-restoration' || value.kind === 'precreation-restoration');
  const effect = item.comparisons.find(value => value.kind === 'local-effect');
  const maxima = controls.filter(value => value.result.comparable).map(value => value.result.metrics!.maximumChannelDifference);
  const invalidComparisonCount = item.comparisons.filter(value => !value.result.comparable).length;
  const comparisonInputsValid = item.comparisons.length > 0 && invalidComparisonCount === 0;
  const restoredPairsExact = restorations.length >= 3 && restorations.every(value => value.result.comparable && value.result.pixelsIdentical);
  return {
    comparisonInputsValid, invalidComparisonCount,
    exactSettingsRestored: item.settingsRestorations.length === 2 && item.settingsRestorations.every(value => value.exact),
    unchangedPairCount: controls.length, unchangedPairsExact: controls.length > 0 && controls.every(value => value.result.comparable && value.result.pixelsIdentical),
    observedControlMaximum: maxima.length ? Math.max(...maxima) : null,
    localAdjustmentVerified: !!item.exposure && item.exposure.requested === item.exposure.observed,
    effectPixelsChanged: !!effect?.result.comparable && !effect.result.pixelsIdentical,
    effectMaximumExceedsObservedControls: comparisonInputsValid && !!effect?.result.comparable && maxima.length > 0 && effect.result.metrics!.maximumChannelDifference > Math.max(...maxima),
    restoredPairsExact,
    pixelRestoration: comparisonInputsValid && restoredPairsExact ? 'exact-on-recorded-pairs' : 'unverified',
    excludedMeasurements: ['Edited-state repeatability', 'Checkpoint-only controls', 'Lightroom restart controls', 'Multiple edit/restore cycles'],
    interpretation: 'Descriptive measurements only. Observed control variation is not an acceptance threshold; stored mask identity does not prove AI coverage completion.',
  };
}

export async function runRestoration(options: {
  root: string; corpus: Corpus; ids: string[]; controls?: number; maskKind: MaskKind; exposureDelta?: number; maxEdge?: number;
  bridge?: BridgeClient; environmentNotes?: string; onProgress?: (message: string) => void;
  resumeImport?: ResumeImportRequest;
}) {
  const controls = options.controls ?? 3; const assets = selectRestorationAssets(options.corpus, options.ids, controls);
  const delta = options.exposureDelta ?? 0.25; const maxEdge = options.maxEdge ?? 2048;
  if (!['subject', 'background'].includes(options.maskKind)) throw new Error('maskKind must be subject or background.');
  if (!Number.isFinite(delta) || delta <= 0 || delta > 0.5) throw new Error('exposureDelta must be positive and at most 0.5 native exposure units.');
  if (!Number.isInteger(maxEdge) || maxEdge < 256 || maxEdge > 8192) throw new Error('maxEdge must be an integer from 256 to 8192.');
  if ((await scanCorpus(options.corpus.source)).fingerprint !== options.corpus.fingerprint) throw new Error('Corpus changed; re-index before running.');
  const paths = getPaths(options.root); const id = `restoration-${randomUUID()}`;
  const directory = join(paths.runtime, 'restoration', id); const database = join(directory, 'runs.sqlite'); const resultPath = join(directory, 'results.json');
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const releaseLock = acquireRestorationLock(paths.runtime, { experimentId: id, database });
  let store: RunStore | undefined; let mutationStarted = false; let preserve = false;
  let resume: ResumeImportPlan | undefined; let resumedSourceId: string | undefined; let resumedCopyCreated = false;
  const batch: RestorationBatch = {
    version: 1, id, status: 'running', startedAt: new Date().toISOString(), source: options.corpus.source, corpusFingerprint: options.corpus.fingerprint,
    baseline: 'as-imported-with-matching-xmp', controls, maskKind: options.maskKind, exposureDelta: delta, maxEdge, autonomousMaskingEnabled: false, lockRetained: false,
    environment: { platform: platform(), osRelease: release(), architecture: arch(), node: process.version, decoder: sharp.versions,
      gpuConfiguration: null, lightroomRestartState: 'not-established', notes: options.environmentNotes ?? null },
    cases: assets.map(asset => ({ assetId: asset.id, name: asset.name, status: 'pending', sourceSha256: asset.raw.sha256,
      sourceSidecars: asset.sidecars.map(file => ({ path: file.path, sha256: file.sha256 })), settingsRestorations: [], renders: [], comparisons: [] })), operations: [],
  };
  const persist = async () => { await writeFile(`${resultPath}.tmp`, `${JSON.stringify(batch, null, 2)}\n`, { mode: 0o600 }); await rename(`${resultPath}.tmp`, resultPath); };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 }); await persist();
    if (options.resumeImport) {
      resume = await inspectImportOnlyFailure(options.root, options.corpus, options.resumeImport);
      if (assets.length !== 1 || assets[0]!.id !== resume.asset.id || controls !== resume.batch.controls || options.maskKind !== resume.batch.maskKind
        || delta !== resume.batch.exposureDelta || maxEdge !== resume.batch.maxEdge) throw new Error('resume-import must keep the single failed case and its recorded experiment recipe.');
      batch.resumedImport = { parentResultPath: resume.resultPath, parentResultSha256: resume.sha256, parentExperimentId: resume.batch.id,
        stagedPath: resume.item.stagedPath!, expectedSourceStateToken: resume.expectedStateToken }; await persist();
    }
    try { batch.environment.installedOperationsSha256 = await hashFile(join(paths.pluginInstall, 'Operations.lua')); }
    catch (error) { batch.environment.installedOperationsSha256 = null; batch.environment.installedOperationsHashError = message(error); }
    const underlying = options.bridge ?? new FileBridge(paths.bridgeDir, { timeoutMs: 60000 });
    if (resume && underlying instanceof FileBridge) {
      const status = await underlying.status();
      let pending: string[] = [];
      try {
        // The worker keeps completed requests as history. Only a valid request
        // without its response can still execute; mirror Bridge.lua's queue.
        pending = (await readdir(join(paths.bridgeDir, 'requests'))).filter(name =>
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/i.test(name)
          && !existsSync(join(paths.bridgeDir, 'responses', name)));
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!status.online || (status.heartbeat as { status?: string })?.status !== 'idle' || existsSync(join(paths.bridgeDir, 'call.lock')) || pending.length)
        throw new Error('The native bridge is offline, busy or has a pending call. Reconcile it before resume-import; no retry was attempted.');
      batch.resumedImport!.nativeBridgeIdleVerifiedAt = new Date().toISOString(); await persist();
    }
    const bridge: BridgeClient = { async call<T>(operation: string, params?: Record<string, unknown>): Promise<T> {
      batch.operations.push({ at: new Date().toISOString(), operation, phase: 'started', params }); await persist();
      if (mutating.has(operation)) mutationStarted = true;
      try {
        const result = await underlying.call<T>(operation, params);
        batch.operations.push({ at: new Date().toISOString(), operation, phase: 'completed', result }); await persist();
        if (operation === 'render' && (result as { photoId?: string }).photoId !== params?.photoId) throw new Error('Export returned another photo identity.');
        if (resume && resumedSourceId && !resumedCopyCreated && operation === 'read_state') {
          const state = result as PhotoState;
          if (state.photoId !== resumedSourceId || state.stateToken !== resume.expectedStateToken) throw new Error('The reconciled source changed before working-copy creation.');
        }
        if (resume && operation === 'create_working_copy') resumedCopyCreated = true;
        return result;
      } catch (error) {
        const native = error as { code?: string; requestId?: string; outcomeUncertain?: boolean };
        batch.operations.push({ at: new Date().toISOString(), operation, phase: 'failed', error: message(error), errorCode: native?.code, requestId: native?.requestId, outcomeUncertain: native?.outcomeUncertain }); await persist(); throw error;
      }
    } };
    batch.capabilities = await bridge.call<Record<string, unknown>>('capabilities'); await persist();
    const capabilities = batch.capabilities as { operations?: Record<string, boolean>; renderFormats?: { TIFF?: { bitDepth?: number; lossless?: boolean } } };
    if (!capabilities.operations?.[`create_${options.maskKind}_mask`] || !capabilities.operations.adjust_mask || !capabilities.operations.restore
      || capabilities.renderFormats?.TIFF?.bitDepth !== 16 || capabilities.renderFormats.TIFF.lossless !== true)
      throw new Error('Native bridge does not advertise the required guarded mask operations and lossless 16-bit TIFF export.');
    store = new RunStore(database); const controller = new PhotoController(bridge, store, paths.exportRoot);
    for (const [index, asset] of assets.entries()) {
      const item = batch.cases[index]!; item.status = 'running'; item.startedAt = new Date().toISOString(); await persist();
      options.onProgress?.(`${index + 1}/${assets.length}: ${asset.name} — ${resume ? 'verifying explicitly reconciled imported source' : 'staging fresh RAW and XMP copies'}`);
      try {
        const staged = resume ? { path: resume.item.stagedPath!, name: asset.name }
          : await stageAsset(options.corpus, asset, join(paths.uploadRoot, randomUUID()), paths.uploadRoot);
        item.stagedPath = staged.path; await persist();
        let photo: Photo;
        if (resume) {
          const selection = await controller.selected(); const selected = selection.photos[0];
          if (selection.count !== 1 || selection.photos.length !== 1 || !selected || selected.isVirtualCopy || selected.name !== asset.name || selected.path !== staged.path
            || !['RAW', 'DNG'].includes(selected.fileFormat.toUpperCase()) || (resume.item.sourcePhotoId && selected.photoId !== resume.item.sourcePhotoId))
            throw new Error('Select exactly the reconciled staged source original matching the failed import; no import retry was attempted.');
          photo = selected; resumedSourceId = photo.photoId;
        } else photo = await bridge.call<Photo>('import_photo', { path: staged.path, filename: staged.name });
        if (photo.name !== asset.name || photo.isVirtualCopy || photo.path !== staged.path) throw new Error('Import did not identify the staged source original.');
        item.sourcePhotoId = photo.photoId; const original = await controller.state(photo.photoId);
        if (resume) {
          if (original.stateToken !== resume.expectedStateToken) throw new Error('The selected source does not match the explicitly reconciled state token.');
          Object.assign(batch.resumedImport!, { observedSourceStateToken: original.stateToken, observedSourcePhotoId: original.photoId, verifiedAt: new Date().toISOString() }); await persist();
        }
        const begun = await controller.start(photo.photoId, `Diagnostic ${options.maskKind} mask restoration; no autonomous enablement`, asset.name);
        item.runId = begun.run.id; item.workingPhotoId = begun.run.workingPhotoId; item.baselineId = begun.baseline.id;
        if (canonical(begun.baseline.settings) !== canonical(original.settings)) throw new Error('Working copy settings differ from the imported original baseline.');
        await persist();
        const capture = async (phase: Phase, candidate: Candidate) => {
          const expected = { photoId: begun.run.workingPhotoId, stateToken: candidate.stateToken, settings: candidate.settings };
          const before = await controller.state(expected.photoId); assertState(before, expected);
          const start = Date.now(); const startedAt = new Date(start).toISOString();
          const rendered = await controller.render(begun.run.id, candidate.id, maxEdge, 'TIFF');
          const after = await controller.state(expected.photoId); assertState(after, expected);
          const record: RestorationRender = { id: randomUUID(), phase, ordinal: item.renders.filter(value => value.phase === phase).length + 1,
            path: rendered.previewPath!, sha256: await hashFile(rendered.previewPath!), startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - start,
            photoId: expected.photoId, runId: begun.run.id, candidateId: candidate.id, stateToken: candidate.stateToken, settings: after.settings, sourceSha256: asset.raw.sha256,
            recipe: { format: 'TIFF', bitDepth: 16, colorSpace: 'sRGB', outputSharpening: false, maxEdge } };
          item.renders.push(record); await persist(); return record;
        };
        const compare = async (kind: RestorationComparison['kind'], before: RestorationRender, after: RestorationRender) => {
          if (before.photoId !== after.photoId || before.sourceSha256 !== after.sourceSha256 || canonical(before.recipe) !== canonical(after.recipe)) throw new Error('Comparison provenance differs.');
          const result = await compareLosslessTiff(before.path, after.path, { expectedBeforeSha256: before.sha256, expectedAfterSha256: after.sha256,
            ...(['local-restoration', 'precreation-restoration'].includes(kind) ? { differenceMap: { path: join(directory, `difference-${randomUUID()}.png`), amplification: 4096 } } : {}) });
          item.comparisons.push({ id: randomUUID(), kind, beforeId: before.id, afterId: after.id, measuredAt: new Date().toISOString(), result }); await persist();
          if (!result.comparable) throw new Error(`Lossless export inputs are not comparable: ${result.issues.join('; ')}`);
          return result;
        };
        const unchanged = async (phase: 'baseline-control' | 'masked-control', candidate: Candidate) => {
          const records: RestorationRender[] = [];
          for (let i = 0; i < controls; i++) { const current = await capture(phase, candidate); for (const previous of records) await compare(phase === 'baseline-control' ? 'unchanged-baseline' : 'unchanged-masked', previous, current); records.push(current); }
          return records;
        };
        options.onProgress?.(`${asset.name}: ${controls} unchanged pre-mask TIFF controls`);
        const baselines = await unchanged('baseline-control', begun.baseline);
        const current = await controller.state(begun.run.workingPhotoId); assertState(current, { photoId: begun.run.workingPhotoId, stateToken: begun.baseline.stateToken, settings: begun.baseline.settings });
        const created = await bridge.call<MaskResult>(`create_${options.maskKind}_mask`, { photoId: begun.run.workingPhotoId, expectedStateToken: begun.baseline.stateToken });
        validateCreatedMask(created, begun.baseline, begun.run.workingPhotoId, options.maskKind); item.maskId = created.maskId; item.maskCompletion = created.completion; await persist();
        const masked = await controller.checkpoint(begun.run.id, `${options.maskKind} diagnostic mask`, begun.baseline.id, 'diagnostic'); item.maskedId = masked.id;
        assertState(created.state, { photoId: begun.run.workingPhotoId, stateToken: masked.stateToken, settings: masked.settings });
        options.onProgress?.(`${asset.name}: ${controls} unchanged ${options.maskKind}-mask TIFF controls`);
        const maskedRenders = await unchanged('masked-control', masked);
        const selected = await bridge.call<{ state: PhotoState; maskContext: MaskContext }>('selected_mask', { photoId: begun.run.workingPhotoId, maskId: created.maskId });
        assertState(selected.state, { photoId: begun.run.workingPhotoId, stateToken: masked.stateToken, settings: masked.settings });
        const exposure = selected.maskContext.parameters.local_Exposure;
        if (selected.maskContext.selectedMaskId !== created.maskId || !exposure || ![exposure.value, exposure.min, exposure.max].every(Number.isFinite)
          || exposure.min >= exposure.max || exposure.value < exposure.min || exposure.value + delta > exposure.max) throw new Error('Requested positive exposure delta is outside the selected mask native range.');
        const requested = exposure.value + delta;
        const edited = await controller.editMask(begun.run.id, masked.id, created.maskId, { local_Exposure: requested }, 'Diagnostic local exposure change', 'diagnostic'); item.editedId = edited.id;
        const readback = await bridge.call<{ state: PhotoState; maskContext: MaskContext }>('selected_mask', { photoId: begun.run.workingPhotoId, maskId: created.maskId });
        assertState(readback.state, { photoId: begun.run.workingPhotoId, stateToken: edited.stateToken, settings: edited.settings });
        const observed = readback.maskContext.parameters.local_Exposure?.value;
        if (readback.maskContext.selectedMaskId !== created.maskId || observed !== requested || edited.stateToken === masked.stateToken) throw new Error('Local exposure change did not verify in native units.');
        item.exposure = { before: exposure.value, requested, observed, min: exposure.min, max: exposure.max }; await persist();
        const changedRender = await capture('edited', edited); await compare('local-effect', maskedRenders[0]!, changedRender);
        options.onProgress?.(`${asset.name}: one local restore, unchanged control, then one pre-creation restore`);
        const restore = async (target: Candidate, expectedCurrent: Candidate, phase: 'local' | 'precreation') => {
          const restored = await controller.restore(begun.run.id, target.id, false, expectedCurrent.stateToken);
          const exact = restored.photoId === begun.run.workingPhotoId && restored.stateToken === target.stateToken && canonical(restored.settings) === canonical(target.settings);
          item.settingsRestorations.push({ phase, at: new Date().toISOString(), expectedStateToken: target.stateToken, actualStateToken: restored.stateToken, exact }); await persist();
          if (!exact) throw new Error('Restored settings or photo identity differ from the saved snapshot.');
        };
        await restore(masked, edited, 'local'); const restored = await capture('restored-mask', masked);
        await compare('local-restoration', maskedRenders[0]!, restored);
        const afterRestore = await capture('restored-mask-control', masked); await compare('unchanged-restored', restored, afterRestore); await compare('local-restoration', maskedRenders[0]!, afterRestore);
        await restore(begun.baseline, masked, 'precreation'); const precreation = await capture('restored-precreation', begun.baseline);
        await compare('precreation-restoration', baselines[0]!, precreation);
        if (resume) item.sourceEndVerification = 'staged-raw-only-no-import-retry';
        else {
          const source = await bridge.call<Photo>('import_photo', { path: staged.path, filename: staged.name });
          if (source.photoId !== photo.photoId || source.isVirtualCopy || source.path !== staged.path) throw new Error('Source original could not be reselected for verification.');
          assertState(await controller.state(source.photoId), original); item.importedOriginalSettingsUnchanged = true;
          item.sourceEndVerification = 'native-settings-and-staged-raw';
        }
        item.stagedRawUnchanged = await hashFile(staged.path) === asset.raw.sha256;
        if (!item.stagedRawUnchanged) throw new Error('The staged RAW bytes changed during the native experiment.');
        item.summary = summarizeRestorationCase(item); item.status = 'complete';
        store.addEvent(begun.run.id, 'restoration_experiment_completed', { experimentId: id, summary: item.summary, autonomousMaskingEnabled: false }); store.setRunStatus(begun.run.id, 'completed');
        options.onProgress?.(`${asset.name}: settings restored exactly; pixel restoration ${item.summary.pixelRestoration}`);
      } catch (error) { item.status = 'interrupted'; item.error = message(error); if (item.runId) store.setRunStatus(item.runId, 'interrupted'); throw error; }
      finally { item.finishedAt = new Date().toISOString(); await persist(); }
    }
    batch.status = 'complete';
  } catch (error) { preserve = mutationStarted; batch.status = 'interrupted'; batch.error = message(error); }
  finally {
    try { batch.sourceUnchanged = (await scanCorpus(options.corpus.source)).fingerprint === options.corpus.fingerprint; if (!batch.sourceUnchanged) throw new Error('Corpus changed during the experiment.'); }
    catch (error) { batch.sourceUnchanged = false; batch.sourceVerificationError = message(error); batch.status = 'interrupted'; preserve ||= mutationStarted; }
    batch.lockRetained = preserve; batch.finishedAt = new Date().toISOString();
    try { await persist(); } finally { store?.close(); releaseLock(preserve); }
  }
  if (batch.status !== 'complete') options.onProgress?.(`Restoration experiment stopped: ${batch.error ?? batch.sourceVerificationError}${preserve ? ' Shared session.lock retained; inspect operations before recovery.' : ''}`);
  return { path: resultPath, batch };
}

/** Explicit continuation after the caller reconciles a terminal import-only failure and releases its lock. */
export async function resumeImportedRestoration(options: {
  root: string; corpus: Corpus; resultPath: string; expectedStateToken: string; bridge?: BridgeClient;
  environmentNotes?: string; onProgress?: (message: string) => void;
}) {
  const resume = await inspectImportOnlyFailure(options.root, options.corpus, options);
  return runRestoration({ root: options.root, corpus: options.corpus, ids: [resume.asset.id], controls: resume.batch.controls,
    maskKind: resume.batch.maskKind, exposureDelta: resume.batch.exposureDelta, maxEdge: resume.batch.maxEdge,
    bridge: options.bridge, environmentNotes: options.environmentNotes, onProgress: options.onProgress,
    resumeImport: { resultPath: resume.resultPath, expectedStateToken: resume.expectedStateToken, parentSha256: resume.sha256 } });
}

/** Recomputes measurements from saved TIFFs only. Does not call Lightroom or replace the native record. */
export async function analyzeRestoration(path: string) {
  const batch = JSON.parse(await readFile(path, 'utf8')) as RestorationBatch;
  if (batch.version !== 1 || !/^restoration-[a-f0-9-]{36}$/.test(batch.id) || !Array.isArray(batch.cases)) throw new Error('Invalid restoration result.');
  for (const item of batch.cases) {
    for (const pair of item.comparisons) {
      const before = item.renders.find(render => render.id === pair.beforeId); const after = item.renders.find(render => render.id === pair.afterId);
      if (!before || !after || before.photoId !== after.photoId || before.sourceSha256 !== after.sourceSha256 || canonical(before.recipe) !== canonical(after.recipe)) throw new Error('Saved comparison provenance is invalid.');
      pair.result = await compareLosslessTiff(before.path, after.path, { expectedBeforeSha256: before.sha256, expectedAfterSha256: after.sha256 });
      pair.measuredAt = new Date().toISOString();
    }
    item.summary = summarizeRestorationCase(item);
  }
  return { sourceResult: path, analyzedAt: new Date().toISOString(), nativeCalls: 0, cases: batch.cases.map(item => ({ assetId: item.assetId, name: item.name, summary: item.summary, comparisons: item.comparisons })) };
}
