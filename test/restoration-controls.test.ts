import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import type { BridgeClient, PhotoState } from '../src/controller.ts';
import { hashFile, scanCorpus, stageAsset } from '../src/evaluation/corpus.ts';
import { runCheckpointControls } from '../src/restoration/controls.ts';
import { acquireRestorationLock } from '../src/restoration/runner.ts';

const settings = { Exposure2012: 0.15, MaskGroupBasedCorrections: [] };
function state(photoId: string, values: Record<string, unknown> = settings): PhotoState {
  return { photoId, stateToken: JSON.stringify([photoId, values]), settings: structuredClone(values) };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rpa-controls-')); const source = join(root, 'RAW'); await mkdir(source);
  await writeFile(join(source, 'one.CR3'), 'one RAW'); await writeFile(join(source, 'one.xmp'), '<xmp>prior edits</xmp>');
  const corpus = await scanCorpus(source); const asset = corpus.assets[0]!;
  const uploads = join(root, '.runtime', 'uploads'); const staged = await stageAsset(corpus, asset, join(uploads, randomUUID()), uploads);
  const renders = join(root, '.runtime', 'renders'); await mkdir(renders);
  const reference = join(renders, `${randomUUID()}-${randomUUID()}.tif`); const restored = join(renders, `${randomUUID()}-${randomUUID()}.tif`);
  await sharp({ create: { width: 16, height: 12, channels: 3, background: { r: 100, g: 100, b: 100 } } }).withIccProfile('srgb').toColourspace('rgb16').tiff({ compression: 'none' }).toFile(reference);
  await copyFile(reference, restored);
  const id = `restoration-${randomUUID()}`; const priorRoot = join(root, '.runtime', 'restoration', id); await mkdir(priorRoot, { recursive: true });
  const resultPath = join(priorRoot, 'results.json'); const sourceState = state('prior-copy'); const baselineId = randomUUID(); const runId = randomUUID();
  const recipe = { format: 'TIFF', bitDepth: 16, colorSpace: 'sRGB', outputSharpening: false, maxEdge: 2048 };
  const render = { id: randomUUID(), ordinal: 1, photoId: sourceState.photoId, runId, candidateId: baselineId, stateToken: sourceState.stateToken, settings,
    sourceSha256: asset.raw.sha256, recipe };
  const prior = { version: 1, id, status: 'complete', source: corpus.source, sourceUnchanged: true, lockRetained: false, corpusFingerprint: corpus.fingerprint, maxEdge: 2048,
    cases: [{ assetId: asset.id, name: asset.name, status: 'complete', runId, workingPhotoId: sourceState.photoId, baselineId, stagedPath: staged.path,
      sourceSha256: asset.raw.sha256, sourceSidecars: asset.sidecars.map(file => ({ path: file.path, sha256: file.sha256 })), stagedRawUnchanged: true,
      settingsRestorations: [{ phase: 'precreation', exact: true, actualStateToken: sourceState.stateToken, expectedStateToken: sourceState.stateToken }],
      renders: [{ ...render, phase: 'baseline-control', path: reference, sha256: await hashFile(reference) }, { ...render, id: randomUUID(), phase: 'restored-precreation', path: restored, sha256: await hashFile(restored) }] }] };
  // Native artifacts use canonical absolute paths, including on macOS /var aliases.
  const { realpath } = await import('node:fs/promises');
  for (const item of prior.cases[0]!.renders) item.path = await realpath(item.path);
  await writeFile(resultPath, JSON.stringify(prior));
  return { root, corpus, asset, staged, resultPath, prior, sourceState, close: () => rm(root, { recursive: true, force: true }) };
}
function fakeBridge(f: Awaited<ReturnType<typeof fixture>>, options: { sourceSettings?: Record<string, unknown>; driftBeforeCopy?: boolean; uncertainCopy?: boolean; uncertainCheckpoint?: boolean; uncertainRestore?: boolean; tamperAtEnd?: 'staged' | 'parent'; changedCopy?: boolean; changedCheckpoint?: boolean; changedRestore?: boolean; drift?: boolean; invalidTiff?: boolean; wrongRenderPhoto?: boolean; manualBeforeRestore?: boolean; wrongSelection?: boolean } = {}) {
  let selected = options.wrongSelection ? 'another-copy' : f.sourceState.photoId; let current = structuredClone(options.sourceSettings ?? settings) as Record<string, unknown>;
  let checkpoints = 0; let tiffs = 0; let sourceReads = 0; const operations: Array<{ operation: string; params: Record<string, unknown> }> = [];
  const snapshots = new Map<string, Record<string, unknown>>(); const observed = () => state(selected, current);
  const bridge: BridgeClient = { async call<T>(operation: string, params: Record<string, unknown> = {}): Promise<T> {
    operations.push({ operation, params }); let result: unknown;
    if (operation === 'capabilities') result = { operations: { create_working_copy: true, checkpoint: true, restore: true, render: true }, renderFormats: { TIFF: { bitDepth: 16, lossless: true } } };
    else if (operation === 'selected') result = { count: 1, photos: [{ photoId: selected, name: f.asset.name, path: f.staged.path, isVirtualCopy: true, fileFormat: 'RAW' }] };
    else if (operation === 'read_state') {
      assert.equal(params.photoId, selected);
      if (selected === f.sourceState.photoId && ++sourceReads > 1 && options.driftBeforeCopy) current.Exposure2012 = 0.7;
      if (options.manualBeforeRestore && tiffs === 6) current.Exposure2012 = 0.3;
      result = observed();
    } else if (operation === 'create_working_copy') {
      assert.equal(params.photoId, selected); assert.equal(selected, f.sourceState.photoId);
      if (options.uncertainCopy) throw Object.assign(new Error('Working copy outcome uncertain'), { outcomeUncertain: true });
      selected = 'new-diagnostic-copy'; if (options.changedCopy) current.Exposure2012 = 1;
      result = { photoId: selected, state: observed() };
    } else if (operation === 'checkpoint') {
      assert.equal(params.photoId, selected); checkpoints++; const snapshotId = `checkpoint-${checkpoints}`; snapshots.set(snapshotId, structuredClone(current));
      if (options.uncertainCheckpoint && checkpoints === 2) throw Object.assign(new Error('Checkpoint outcome uncertain'), { outcomeUncertain: true });
      if (options.changedCheckpoint && checkpoints === 2) current.Exposure2012 = 1;
      result = { snapshotId, state: observed() };
    } else if (operation === 'restore') {
      assert.equal(params.photoId, selected); assert.equal(params.expectedStateToken, observed().stateToken);
      if (options.uncertainRestore) throw Object.assign(new Error('Restore outcome uncertain'), { outcomeUncertain: true });
      assert.equal(params.snapshotId, 'checkpoint-1'); current = structuredClone(snapshots.get(String(params.snapshotId))!);
      if (options.changedRestore) current.Exposure2012 = 1;
      result = { state: observed() };
    } else if (operation === 'render') {
      assert.equal(params.photoId, selected); assert.equal(params.expectedStateToken, observed().stateToken);
      if (params.format === 'TIFF') tiffs++;
      const value = 100 + (options.drift ? tiffs : 0); const image = sharp({ create: { width: 16, height: 12, channels: 3, background: { r: value, g: value, b: value } } });
      if (params.format === 'TIFF') {
        if (options.invalidTiff) await image.tiff().toFile(String(params.outputPath));
        else await image.withIccProfile('srgb').toColourspace('rgb16').tiff({ compression: 'none' }).toFile(String(params.outputPath));
      } else await image.jpeg().toFile(String(params.outputPath));
      if (tiffs === 9 && options.tamperAtEnd === 'staged') await writeFile(f.staged.path, 'externally changed staged RAW');
      if (tiffs === 9 && options.tamperAtEnd === 'parent') await writeFile(f.resultPath, `${await readFile(f.resultPath, 'utf8')}\n`);
      result = { photoId: options.wrongRenderPhoto && params.format === 'TIFF' ? 'wrong-copy' : selected, stateToken: observed().stateToken, outputPath: params.outputPath };
    } else throw new Error(`Unexpected operation: ${operation}`);
    return result as T;
  } };
  return { bridge, operations };
}
const runOptions = (f: Awaited<ReturnType<typeof fixture>>, bridge: BridgeClient) => ({ root: f.root, corpus: f.corpus, resultPath: f.resultPath, assetId: f.asset.id, bridge });

test('checkpoint controls use one fresh copy, three fixed blocks and one no-op restore without imports or adjustments', async () => {
  const f = await fixture(); const native = fakeBridge(f);
  try {
    const priorText = await readFile(f.resultPath, 'utf8'); const result = await runCheckpointControls(runOptions(f, native.bridge)); const r = result.report;
    assert.equal(r.status, 'complete', r.error ?? 'Expected completed controls'); assert.equal(r.sourceUnchanged, true); assert.equal(r.stagedFilesUnchanged, true); assert.equal(r.parentReportUnchanged, true);
    assert.equal(r.renders.length, 9); assert.equal(r.comparisons.length, 15); assert.equal(r.summary?.settingsIdentical, true); assert.equal(r.summary?.pixelsIdentical, true);
    assert.deepEqual(r.renders.map(item => item.block), ['unchanged', 'unchanged', 'unchanged', 'checkpoint-only', 'checkpoint-only', 'checkpoint-only', 'noop-restore', 'noop-restore', 'noop-restore']);
    assert.equal(r.scope.initialJpegExportCount, 1); assert.equal(r.scope.tiffExportCondition, 'after-controller-baseline-jpeg-not-cold');
    assert.equal(native.operations.filter(item => item.operation === 'create_working_copy').length, 1);
    assert.equal(native.operations.filter(item => item.operation === 'checkpoint').length, 2); assert.equal(native.operations.filter(item => item.operation === 'restore').length, 1);
    assert.equal(native.operations.filter(item => item.operation === 'render' && item.params.format === 'JPEG').length, 1);
    assert.equal(native.operations.filter(item => item.operation === 'render' && item.params.format === 'TIFF').length, 9);
    assert.equal(native.operations.some(item => ['import_photo', 'apply', 'adjust_mask'].includes(item.operation)), false);
    assert.equal(r.transitions.length, 14); assert.ok(r.transitions.every(item => item.before && item.after && item.settingsIdentical));
    assert.equal(r.transitions.filter(item => item.photoIdentityChanged).length, 1);
    const started = r.operations.filter(item => item.phase === 'started'); const completed = r.operations.filter(item => item.phase === 'completed');
    assert.equal(started.length, completed.length); assert.equal(existsSync(join(f.root, '.runtime', 'session.lock')), false);
    assert.equal(await readFile(f.resultPath, 'utf8'), priorText); assert.deepEqual(JSON.parse(await readFile(result.path, 'utf8')), JSON.parse(JSON.stringify(r)));
  } finally { await f.close(); }
});
test('pixel drift is recorded without resampling, repeated restore or changing the nine-export protocol', async () => {
  const f = await fixture(); const native = fakeBridge(f, { drift: true });
  try {
    const { report } = await runCheckpointControls(runOptions(f, native.bridge));
    assert.equal(report.status, 'complete', report.error ?? 'Expected measurements'); assert.equal(report.summary?.pixelResult, 'unverified'); assert.equal(report.summary?.settingsIdentical, true);
    assert.equal(report.renders.length, 9); assert.equal(report.comparisons.length, 15); assert.equal(report.lockRetained, false);
    assert.equal(native.operations.filter(item => item.operation === 'restore').length, 1);
  } finally { await f.close(); }
});
test('prior report, source hashes and shared ownership fail closed before native mutation', async () => {
  const f = await fixture(); const native = fakeBridge(f);
  try {
    const release = acquireRestorationLock(join(f.root, '.runtime'), {});
    await assert.rejects(runCheckpointControls(runOptions(f, native.bridge)), /Another editing session/); release(false);
    await assert.rejects(runCheckpointControls({ ...runOptions(f, native.bridge), assetId: 'missing' }), /explicit case/);
    await assert.rejects(runCheckpointControls({ ...runOptions(f, native.bridge), maxEdge: 123 }), /256 to 8192/);
    const original = await readFile(f.resultPath, 'utf8'); const report = JSON.parse(original); report.status = 'interrupted'; await writeFile(f.resultPath, JSON.stringify(report));
    await assert.rejects(runCheckpointControls(runOptions(f, native.bridge)), /completed restoration report/); await writeFile(f.resultPath, original);
    await writeFile(f.staged.sidecars[0]!, 'changed staged XMP'); await assert.rejects(runCheckpointControls(runOptions(f, native.bridge)), /source bytes changed/);
    assert.equal(native.operations.length, 0);
  } finally { await f.close(); }
});
test('wrong selected copy is rejected read-only; an uncertain copy retains the lock with no cleanup or retry', async () => {
  for (const uncertainCopy of [false, true]) {
    const f = await fixture(); const native = fakeBridge(f, uncertainCopy ? { uncertainCopy: true } : { wrongSelection: true });
    try {
      const { report } = await runCheckpointControls(runOptions(f, native.bridge));
      assert.equal(report.status, 'interrupted'); assert.equal(report.lockRetained, uncertainCopy); assert.equal(report.renders.length, 0);
      assert.equal(native.operations.filter(item => item.operation === 'create_working_copy').length, uncertainCopy ? 1 : 0);
      assert.equal(native.operations.filter(item => item.operation === 'restore').length, 0); assert.equal(native.operations.filter(item => item.operation === 'checkpoint').length, 0);
    } finally { await f.close(); }
  }
});
test('changed copy/checkpoint/restore and manual state changes stop at the guard without corrective writes', async () => {
  for (const failure of ['changedCopy', 'changedCheckpoint', 'changedRestore', 'manualBeforeRestore'] as const) {
    const f = await fixture(); const native = fakeBridge(f, { [failure]: true });
    try {
      const { report } = await runCheckpointControls(runOptions(f, native.bridge));
      assert.equal(report.status, 'interrupted'); assert.equal(report.lockRetained, true); assert.equal(report.summary, undefined);
      assert.equal(native.operations.filter(item => item.operation === 'restore').length, failure === 'changedRestore' ? 1 : 0);
      assert.equal(native.operations.filter(item => item.operation === 'create_working_copy').length, 1);
    } finally { await f.close(); }
  }
});
test('invalid TIFF metadata and wrong-photo exports stop before checkpoint-only and no-op restoration', async () => {
  for (const failure of ['invalidTiff', 'wrongRenderPhoto'] as const) {
    const f = await fixture(); const native = fakeBridge(f, { [failure]: true });
    try {
      const { report } = await runCheckpointControls(runOptions(f, native.bridge));
      assert.equal(report.status, 'interrupted'); assert.equal(report.lockRetained, true);
      assert.equal(native.operations.filter(item => item.operation === 'checkpoint').length, 1);
      assert.equal(native.operations.filter(item => item.operation === 'restore').length, 0);
      assert.equal(native.operations.filter(item => item.operation === 'render' && item.params.format === 'TIFF').length, 1);
    } finally { await f.close(); }
  }
});
test('uncertain checkpoint or restore attempts retain ownership without repeating either mutation', async () => {
  for (const failure of ['uncertainCheckpoint', 'uncertainRestore'] as const) {
    const f = await fixture(); const native = fakeBridge(f, { [failure]: true });
    try {
      const { report } = await runCheckpointControls(runOptions(f, native.bridge));
      assert.equal(report.status, 'interrupted'); assert.equal(report.lockRetained, true); assert.ok(report.operations.some(item => item.outcomeUncertain));
      assert.equal(native.operations.filter(item => item.operation === 'checkpoint').length, 2);
      assert.equal(native.operations.filter(item => item.operation === 'restore').length, failure === 'uncertainRestore' ? 1 : 0);
      assert.equal(report.renders.length, failure === 'uncertainRestore' ? 6 : 3);
    } finally { await f.close(); }
  }
});
test('post-run source or parent-report changes invalidate completion and retain the session lock', async () => {
  for (const tamperAtEnd of ['staged', 'parent'] as const) {
    const f = await fixture(); const native = fakeBridge(f, { tamperAtEnd });
    try {
      const { report } = await runCheckpointControls(runOptions(f, native.bridge));
      assert.equal(report.status, 'interrupted'); assert.equal(report.lockRetained, true); assert.equal(report.renders.length, 9);
      assert.ok(report.error); assert.equal(report.sourceUnchanged, true); assert.equal(native.operations.filter(item => item.operation === 'restore').length, 1);
      if (tamperAtEnd === 'parent') assert.equal(report.parentReportUnchanged, false);
      assert.ok(existsSync(join(f.root, '.runtime', 'session.lock')));
    } finally { await f.close(); }
  }
});
test('an explicit changed source baseline creates a new diagnostic experiment without rewriting or equating the historical state', async () => {
  const f = await fixture(); const values = { ...settings, Look: { Parameters: { PointColors: {} } } };
  const native = fakeBridge(f, { sourceSettings: values }); const expected = state(f.sourceState.photoId, values);
  try {
    const priorBytes = await readFile(f.resultPath); const reason = 'Restart added an empty PointColors object; use this observed state for a new experiment.';
    const { report } = await runCheckpointControls({ ...runOptions(f, native.bridge), sourceBaseline: { state: expected, reason } });
    assert.equal(report.status, 'complete', report.error ?? 'Expected completed rebased controls'); assert.equal(report.summary?.settingsIdentical, true);
    assert.deepEqual(report.sourceBaseline, { mode: 'explicit-new-experiment', historicalState: f.sourceState, expectedState: expected, reason,
      historicalSettingsIdentical: false, historicalTokenIdentical: false, equivalenceClaimed: false, restorationClaimed: false });
    assert.deepEqual(report.preflightState, expected); assert.equal(report.renders.length, 9);
    assert.ok(report.renders.every(render => JSON.stringify(render.settings) === JSON.stringify(values)));
    assert.ok(report.summary?.note.includes('not an equivalence or restoration claim'));
    assert.deepEqual(await readFile(f.resultPath), priorBytes); assert.equal(report.parentReportUnchanged, true); assert.equal(report.lockRetained, false);
  } finally { await f.close(); }
});
test('historical defaults reject absent-versus-empty source changes before mutation', async () => {
  const f = await fixture(); const native = fakeBridge(f, { sourceSettings: { ...settings, Look: { Parameters: { PointColors: {} } } } });
  try {
    const { report } = await runCheckpointControls(runOptions(f, native.bridge));
    assert.equal(report.status, 'interrupted'); assert.equal(report.sourceBaseline.mode, 'historical'); assert.equal(report.lockRetained, false);
    assert.ok(report.error?.includes('state token or settings differ'));
    assert.equal(native.operations.some(item => ['create_working_copy', 'checkpoint', 'restore', 'render'].includes(item.operation)), false);
  } finally { await f.close(); }
});
test('explicit baseline checks both full settings and token, and detects a pre-copy state race without any mutation', async () => {
  for (const failure of ['settings', 'token', 'race'] as const) {
    const f = await fixture(); const native = fakeBridge(f, { driftBeforeCopy: failure === 'race' }); const expected = structuredClone(f.sourceState);
    if (failure === 'settings') expected.settings = { ...settings, Look: { Parameters: { PointColors: {} } } }; // Preserve the token to exercise the independent settings check.
    if (failure === 'token') expected.stateToken = 'wrong-token';
    try {
      const { report } = await runCheckpointControls({ ...runOptions(f, native.bridge), sourceBaseline: { state: expected, reason: 'Explicit diagnostic observation' } });
      assert.equal(report.status, 'interrupted'); assert.equal(report.lockRetained, false); assert.ok(report.error?.includes('state token or settings differ'));
      assert.equal(native.operations.some(item => ['create_working_copy', 'checkpoint', 'restore', 'render'].includes(item.operation)), false);
      if (failure === 'race') assert.deepEqual(report.preflightState, expected);
    } finally { await f.close(); }
  }
});
test('malformed and wrong-photo explicit baselines fail before native calls', async () => {
  const f = await fixture(); const native = fakeBridge(f);
  try {
    for (const sourceBaseline of [null, {}, { state: f.sourceState, reason: ' ' }, { state: { ...f.sourceState, stateToken: '' }, reason: 'Observation' },
      { state: { ...f.sourceState, settings: [] }, reason: 'Observation' }, { state: { ...f.sourceState, settings: { Exposure2012: undefined } }, reason: 'Observation' },
      { state: { ...f.sourceState, settings: { Exposure2012: NaN } }, reason: 'Observation' }, { state: { ...f.sourceState, photoId: 'another-copy' }, reason: 'Observation' }]) {
      await assert.rejects(runCheckpointControls({ ...runOptions(f, native.bridge), sourceBaseline: sourceBaseline as never }), /explicit source baseline/);
    }
    assert.equal(native.operations.length, 0); assert.equal(existsSync(join(f.root, '.runtime', 'session.lock')), false);
  } finally { await f.close(); }
});
