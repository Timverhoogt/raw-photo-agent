import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { arch, platform, release } from 'node:os';
import { FileBridge } from '../bridge.ts';
import { getPaths } from '../config.ts';
import type { Photo, PhotoState } from '../controller.ts';
import { hashFile, scanCorpus, stageAsset } from '../evaluation/corpus.ts';
import type { Corpus } from '../evaluation/corpus.ts';
import { acquireRestorationLock } from '../restoration/runner.ts';

const OFFSETS = [0, 1000, 3000] as const;
const UUID_FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const canonical = (value: unknown): string => JSON.stringify(value, (_, item) => record(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const clockDefault = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>(done => setTimeout(done, ms)) };

export interface SettingsDifference { path: string; beforePresent: boolean; afterPresent: boolean; before?: unknown; after?: unknown }
/** JSON pointers retain presence, types and array identity; absent, null, [] and {} differ. */
export function diffNativeSettings(before: unknown, after: unknown): SettingsDifference[] {
  const differences: SettingsDifference[] = [];
  const walk = (left: unknown, right: unknown, path: string, beforePresent: boolean, afterPresent: boolean) => {
    if (beforePresent && afterPresent && record(left) && record(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        walk(left[key], right[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, Object.hasOwn(left, key), Object.hasOwn(right, key));
      }
    } else if (beforePresent && afterPresent && Array.isArray(left) && Array.isArray(right)) {
      for (let index = 0; index < Math.max(left.length, right.length); index++) {
        walk(left[index], right[index], `${path}/${index}`, index < left.length, index < right.length);
      }
    } else if (beforePresent !== afterPresent || canonical(left) !== canonical(right)) {
      differences.push({ path, beforePresent, afterPresent, ...(beforePresent ? { before: left } : {}), ...(afterPresent ? { after: right } : {}) });
    }
  };
  walk(before, after, '', true, true);
  return differences;
}
interface Evidence { source: string; copy: string; sha256: string }
interface CallEvidence {
  sequence: number; operation: string; params: Record<string, unknown>; startedAt: string; finishedAt?: string; durationMs?: number;
  requestId?: string; result?: unknown; error?: { message: string; code?: string; outcomeUncertain?: boolean };
  files: Evidence[]; evidenceError?: string;
}
interface Trace { requestId: string; sequence: number; phase: string; photo: Photo; photoId: string; state: PhotoState; capturedAt: number; [key: string]: unknown }
interface Selection { count: number; photos: Photo[]; photoId?: string }
export interface ImportDiagnosticReport {
  version: 1; id: string; status: 'running' | 'complete' | 'interrupted'; startedAt: string; finishedAt?: string;
  assetId: string; source: string; corpusFingerprint: string; sourceFiles: Corpus['files']; stagedPath?: string;
  environment: Record<string, unknown>; capabilities?: Record<string, unknown>; preflight?: { selection: Selection; state?: PhotoState };
  calls: CallEvidence[]; idleChecks: Array<{ at: string; phase: string; online: boolean; heartbeat: unknown; callLock: boolean; pending: string[] }>;
  import?: { status: 'completed' | 'failed'; requestId?: string; result?: unknown; error?: CallEvidence['error']; completedAt: string };
  traces: Array<{ file: Evidence; record: Trace }>; traceError?: string;
  followupOffsetsMs: readonly number[]; observations: Array<{ offsetMs: number; targetAt: string; startedAt: string; finishedAt?: string;
    elapsedMs: number; selection?: Selection; state?: PhotoState; comparisons?: Array<{ baseline: string; exactToken: boolean; differences: SettingsDifference[] }>; error?: string }>;
  sourceUnchanged?: boolean; stagedFiles?: Array<{ path: string; sha256: string; matches: boolean }>; stagedUnchanged?: boolean;
  error?: string; lockRetained: boolean; autonomousMaskingEnabled: false;
}

async function names(path: string): Promise<string[]> {
  try { return await readdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function assertState(state: unknown, photoId: string): asserts state is PhotoState {
  if (!record(state) || state.photoId !== photoId || typeof state.stateToken !== 'string' || !state.stateToken || !record(state.settings)) {
    throw new Error('Native readback does not identify the exact requested photo and complete settings.');
  }
}
function assertSelection(value: unknown): asserts value is Selection {
  if (!record(value) || !Number.isInteger(value.count) || !Array.isArray(value.photos) || value.count !== value.photos.length
    || value.photos.some(photo => !record(photo) || typeof photo.photoId !== 'string' || !photo.photoId)) throw new Error('Native selection is malformed.');
}
function assertOriginal(photo: Photo | undefined, path: string, filename: string) {
  if (!photo || photo.isVirtualCopy !== false || photo.path !== path || photo.name !== filename
    || typeof photo.photoId !== 'string' || !photo.photoId || !['RAW', 'DNG'].includes(String(photo.fileFormat).toUpperCase())) {
    throw new Error('Select exactly the physical original matching the staged path and filename; no selection was changed.');
  }
}

/** One import, then observations only. Delays never replace a failed native baseline. */
export async function runImportDiagnostic(options: { root: string; corpus: Corpus; assetId: string; environmentNotes: string;
  bridge?: FileBridge; clock?: typeof clockDefault }) {
  if (!options.assetId?.trim() || options.assetId.includes(',')) throw new Error('Choose exactly one explicit indexed asset ID.');
  const asset = options.corpus.assets.find(item => item.id === options.assetId);
  if (!asset) throw new Error(`Unknown indexed asset: ${options.assetId}`);
  if (!options.environmentNotes?.trim() || options.environmentNotes.length > 4000) throw new Error('environment-notes must contain 1–4000 characters.');
  if ((await scanCorpus(options.corpus.source)).fingerprint !== options.corpus.fingerprint) throw new Error('Corpus changed; re-index before diagnosis.');
  const paths = getPaths(resolve(options.root)); const id = `import-${randomUUID()}`;
  const directory = join(paths.runtime, 'diagnostics', id); const resultPath = join(directory, 'results.json');
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const releaseLock = acquireRestorationLock(paths.runtime, { command: 'import-diagnostic', experimentId: id, resultPath });
  const lockPath = join(paths.runtime, 'session.lock'); const owner = JSON.parse(await readFile(lockPath, 'utf8')).owner;
  const clock = options.clock ?? clockDefault; const at = () => new Date(clock.now()).toISOString();
  const bridge = options.bridge ?? new FileBridge(paths.bridgeDir, { timeoutMs: 60_000 });
  let importAttempted = false; let retain = false;
  const report: ImportDiagnosticReport = { version: 1, id, status: 'running', startedAt: at(), assetId: asset.id,
    source: options.corpus.source, corpusFingerprint: options.corpus.fingerprint, sourceFiles: [asset.raw, ...asset.sidecars],
    environment: { platform: platform(), osRelease: release(), architecture: arch(), node: process.version, notes: options.environmentNotes,
      gpuConfiguration: 'not-established', lightroomRestartState: 'not-established' },
    calls: [], idleChecks: [], traces: [], observations: [], followupOffsetsMs: OFFSETS, lockRetained: true, autonomousMaskingEnabled: false };
  const persist = async () => { await writeFile(`${resultPath}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); await rename(`${resultPath}.tmp`, resultPath); };
  const assertOwner = async () => {
    if (JSON.parse(await readFile(lockPath, 'utf8')).owner !== owner) throw new Error('The diagnostic no longer owns session.lock.');
  };
  const copyEvidence = async (source: string, destination: string): Promise<Evidence> => {
    if (!(await lstat(source)).isFile() || await realpath(source) !== source) throw new Error('Native evidence must be a regular file without symlinks.');
    const bytes = await readFile(source); await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    return { source, copy: destination, sha256: sha256(bytes) };
  };
  const idle = async (phase: string) => {
    const deadline = clock.now() + 5000;
    do {
      await assertOwner();
      const status = await bridge.status();
      const pending: string[] = [];
      for (const name of (await names(join(paths.bridgeDir, 'requests'))).filter(name => UUID_FILE.test(name))) {
        const response = join(paths.bridgeDir, 'responses', name);
        if (!existsSync(response)) { pending.push(name); continue; }
        const value: unknown = JSON.parse(await readFile(response, 'utf8'));
        if (!record(value) || value.protocolVersion !== 1 || value.id !== name.slice(0, -5) || typeof value.ok !== 'boolean') pending.push(name);
      }
      const callLock = existsSync(join(paths.bridgeDir, 'call.lock'));
      report.idleChecks.push({ at: at(), phase, online: status.online, heartbeat: status.heartbeat ?? null, callLock, pending }); await persist();
      if (status.online && record(status.heartbeat) && status.heartbeat.status === 'idle' && !callLock && !pending.length) return;
      if (clock.now() >= deadline) throw new Error('The bridge is not confirmed idle with no pending calls; observations were not submitted.');
      await clock.sleep(250);
    } while (true);
  };
  const call = async <T>(operation: string, params: Record<string, unknown> = {}): Promise<T> => {
    await assertOwner();
    const before = new Set(await names(join(paths.bridgeDir, 'requests')));
    const started = clock.now();
    const evidence: CallEvidence = { sequence: report.calls.length + 1, operation, params, startedAt: at(), files: [] };
    report.calls.push(evidence); await persist();
    let result: T | undefined; let failure: unknown;
    try { result = await bridge.call<T>(operation, params); evidence.result = result; }
    catch (error) {
      failure = error; const native = error as { code?: string; requestId?: string; outcomeUncertain?: boolean };
      evidence.requestId = native?.requestId;
      evidence.error = { message: message(error), code: native?.code, outcomeUncertain: native?.outcomeUncertain };
    }
    evidence.finishedAt = at(); evidence.durationMs = clock.now() - started;
    try {
      const added = (await names(join(paths.bridgeDir, 'requests'))).filter(name => UUID_FILE.test(name) && !before.has(name));
      if (added.length !== 1 || evidence.requestId && evidence.requestId !== added[0]!.slice(0, -5)) throw new Error('Cannot bind this call to exactly one native request.');
      evidence.requestId = added[0]!.slice(0, -5);
      const rawRequest = JSON.parse(await readFile(join(paths.bridgeDir, 'requests', added[0]!), 'utf8'));
      if (rawRequest.operation !== operation || canonical(rawRequest.params) !== canonical(params)) throw new Error('Native request does not match the recorded operation.');
      for (const kind of ['requests', 'responses', 'receipts']) {
        const source = join(paths.bridgeDir, kind, added[0]!);
        if (existsSync(source)) evidence.files.push(await copyEvidence(source, join(directory, `${evidence.sequence}-${kind}-${added[0]}`)));
      }
    } catch (error) { evidence.evidenceError = message(error); failure ??= error; }
    await persist();
    if (failure) throw failure;
    return result as T;
  };
  const collectTraces = async (requestId: string) => {
    const traceDirectory = join(paths.bridgeDir, 'diagnostics', 'import-photo', requestId);
    const traceNames = (await names(traceDirectory)).sort();
    if (!traceNames.length || traceNames.length > 64 || traceNames.some(name => !/^\d{4}\.json$/.test(name))) throw new Error('Import trace files are missing or malformed.');
    for (const [index, name] of traceNames.entries()) {
      const file = await copyEvidence(join(traceDirectory, name), join(directory, `trace-${name}`));
      const trace = JSON.parse(await readFile(file.copy, 'utf8')) as Trace;
      report.traces.push({ file, record: trace });
      if (trace.requestId !== requestId || trace.sequence !== index + 1 || trace.operation !== 'import_photo') throw new Error('Import trace identity or sequence does not match the native call.');
    }
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 }); await persist();
    if (bridge.bridgeDir !== paths.bridgeDir) throw new Error('Diagnostic bridge must use this workspace bridge directory.');
    report.environment.installedOperationsSha256 = await hashFile(join(paths.pluginInstall, 'Operations.lua'));
    await idle('preflight');
    report.capabilities = await call<Record<string, unknown>>('capabilities');
    const capabilities = report.capabilities;
    const operations = capabilities.operations;
    if (!record(operations) || !['import_photo', 'selected', 'read_state'].every(operation => operations[operation] === true)
      || !record(capabilities.importDiagnostics) || capabilities.importDiagnostics.enabled !== true || capabilities.importDiagnostics.immutable !== true
      || capabilities.importDiagnostics.directory !== join(paths.bridgeDir, 'diagnostics', 'import-photo')) {
      throw new Error('Installed bridge does not advertise the required import diagnostics and read operations.');
    }
    await idle('preflight-selection');
    const selection = await call<Selection>('selected'); assertSelection(selection);
    report.preflight = { selection }; await persist();
    if (selection.count === 1) {
      await idle('preflight-state');
      const state = await call<PhotoState>('read_state', { photoId: selection.photos[0]!.photoId }); assertState(state, selection.photos[0]!.photoId);
      report.preflight.state = state; await persist();
    }
    const staged = await stageAsset(options.corpus, asset, join(paths.uploadRoot, randomUUID()), paths.uploadRoot);
    report.stagedPath = staged.path; await persist();
    await idle('before-import'); importAttempted = true;
    try {
      const result = await call<Photo>('import_photo', { path: staged.path, filename: staged.name });
      report.import = { status: 'completed', requestId: report.calls.at(-1)!.requestId, result, completedAt: at() };
      assertOriginal(result, staged.path, staged.name);
    } catch (error) {
      retain = true; report.error = message(error);
      const evidence = report.calls.at(-1)!;
      report.import = { status: 'failed', requestId: evidence.requestId, error: evidence.error ?? { message: message(error) }, completedAt: at() };
    }
    // Offsets start when the native call returned, before copying its evidence.
    const finished = Date.parse(report.calls.at(-1)!.finishedAt!); await persist();
    try {
      if (!report.import.requestId) throw new Error('Import request identity is unavailable.');
      await collectTraces(report.import.requestId);
    } catch (error) { report.traceError = message(error); retain = true; report.error ??= message(error); }
    const baselines = ['before-selection', 'completion-guard'].flatMap(phase => {
      const matches = report.traces.filter(item => item.record.phase === phase);
      if (matches.length !== 1) return [];
      const state = matches[0]!.record.state;
      assertOriginal(matches[0]!.record.photo, staged.path, staged.name); assertState(state, matches[0]!.record.photo.photoId);
      return [{ phase, state }];
    });
    if (report.import.status === 'completed' && baselines.length !== 2) throw new Error('Successful import lacks both immutable native baseline guards.');
    if (report.import.status === 'completed') {
      const original = baselines[0]!.state;
      for (const { record: trace } of report.traces) {
        assertOriginal(trace.photo, staged.path, staged.name); assertState(trace.state, original.photoId);
        if (trace.state.stateToken !== original.stateToken || diffNativeSettings(original.settings, trace.state.settings).length) {
          retain = true; report.error ??= 'Native import trace records settings drift; later agreement does not erase it.';
        }
      }
    }
    if (baselines.length === 2 && (baselines[0]!.state.photoId !== baselines[1]!.state.photoId || baselines[0]!.state.stateToken !== baselines[1]!.state.stateToken
      || diffNativeSettings(baselines[0]!.state.settings, baselines[1]!.state.settings).length)) {
      retain = true; report.error ??= 'Native import completion differs from the original before-selection baseline.';
    }
    for (const offsetMs of OFFSETS) {
      await clock.sleep(Math.max(0, finished + offsetMs - clock.now()));
      const observation: ImportDiagnosticReport['observations'][number] = { offsetMs, targetAt: new Date(finished + offsetMs).toISOString(), startedAt: at(), elapsedMs: clock.now() - finished };
      report.observations.push(observation); await persist();
      try {
        await idle(`followup-${offsetMs}-selection`);
        const selected = await call<Selection>('selected'); observation.selection = selected; assertSelection(selected);
        if (selected.count !== 1) throw new Error('Import followup requires exactly one selected staged original.');
        const photo = selected.photos[0]!; assertOriginal(photo, staged.path, staged.name);
        for (const baseline of baselines) if (baseline.state.photoId !== photo.photoId) throw new Error('The selected original differs from the import trace identity.');
        await idle(`followup-${offsetMs}-state`);
        const state = await call<PhotoState>('read_state', { photoId: photo.photoId }); observation.state = state; assertState(state, photo.photoId);
        observation.comparisons = baselines.map(baseline => ({ baseline: baseline.phase, exactToken: state.stateToken === baseline.state.stateToken,
          differences: diffNativeSettings(baseline.state.settings, state.settings) }));
        if (observation.comparisons.some(comparison => !comparison.exactToken || comparison.differences.length)) {
          retain = true; report.error ??= 'Read-only followup differs from a native import baseline; no baseline was replaced.';
        }
      } catch (error) { observation.error = message(error); retain = true; report.error ??= message(error); }
      observation.finishedAt = at(); await persist();
      if (observation.error) break;
    }
    await idle('final');
  } catch (error) { report.error ??= message(error); retain ||= importAttempted; }
  finally {
    try {
      report.sourceUnchanged = (await scanCorpus(options.corpus.source)).fingerprint === options.corpus.fingerprint;
      if (!report.sourceUnchanged) throw new Error('Source corpus changed during diagnosis.');
      if (report.stagedPath) {
        const folder = dirname(report.stagedPath); const expected = [asset.raw, ...asset.sidecars];
        if (canonical((await readdir(folder)).sort()) !== canonical(expected.map(file => basename(file.path)).sort())) throw new Error('Staged directory contents changed.');
        report.stagedFiles = [];
        for (const file of expected) {
          const path = join(folder, basename(file.path));
          if (!(await lstat(path)).isFile() || await realpath(path) !== path) throw new Error('Staged input changed identity.');
          const sha256 = await hashFile(path); report.stagedFiles.push({ path, sha256, matches: sha256 === file.sha256 });
        }
        report.stagedUnchanged = report.stagedFiles.every(file => file.matches);
        if (!report.stagedUnchanged) throw new Error('Staged RAW or XMP changed during diagnosis.');
      }
      for (const file of [...report.calls.flatMap(call => call.files), ...report.traces.map(trace => trace.file)]) {
        if (await hashFile(file.source) !== file.sha256 || await hashFile(file.copy) !== file.sha256) throw new Error('Recorded native evidence changed during diagnosis.');
      }
      if (report.environment.installedOperationsSha256 && await hashFile(join(paths.pluginInstall, 'Operations.lua')) !== report.environment.installedOperationsSha256) {
        throw new Error('Installed native plug-in changed during diagnosis.');
      }
      await assertOwner();
    } catch (error) { report.error ??= message(error); retain ||= importAttempted; }
    report.status = !report.error && report.import?.status === 'completed' && report.observations.length === OFFSETS.length ? 'complete' : 'interrupted';
    retain ||= importAttempted && report.status !== 'complete';
    report.finishedAt = at(); report.lockRetained = retain;
    try { await persist(); } catch (error) { releaseLock(true); throw error; }
    releaseLock(retain);
  }
  return { report, path: resultPath };
}
