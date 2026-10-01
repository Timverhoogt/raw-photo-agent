import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { FileBridge } from '../src/bridge.ts';
import type { BridgeClient } from '../src/controller.ts';
import { scanCorpus } from '../src/evaluation/corpus.ts';
import { acquireRestorationLock, analyzeRestoration, resumeImportedRestoration, runRestoration, selectRestorationAssets } from '../src/restoration/runner.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rpa-restoration-')); const source = join(root, 'RAW'); await mkdir(source);
  await writeFile(join(source, 'one.CR3'), 'first RAW'); await writeFile(join(source, 'one.xmp'), '<xmp>existing photographer adjustments</xmp>');
  await writeFile(join(source, 'two.CR3'), 'second RAW');
  const corpus = await scanCorpus(source);
  return { root, source, corpus, ids: corpus.assets.map(asset => asset.id), close: () => rm(root, { force: true, recursive: true }) };
}
function fakeBridge(options: { drift?: boolean; uncertainCreate?: boolean; wrongRestore?: boolean; wrongRenderPhoto?: boolean; invalidTiff?: boolean; missingCapability?: boolean; changedCreationSetting?: boolean; staleImport?: boolean; sourceReadRace?: boolean;
  onRestore?: (settings: Record<string, unknown>, count: number) => void; spoofRestoredToken?: boolean; pixelResidualCycle?: number; changedRangeCycle?: number;
  missingSelectionCapability?: boolean; selectionFault?: 'mask' | 'photo' | 'token' | 'settings' } = {}) {
  type Photo = { photoId: string; path: string; settings: Record<string, unknown>; isVirtualCopy: boolean };
  const photos = new Map<string, Photo>(); const imports = new Map<string, string>(); const snapshots = new Map<string, Record<string, unknown>>();
  const operations: Array<{ operation: string; params: Record<string, unknown> }> = []; let selected = ''; let maskId = ''; let selectedMaskId = ''; let tiffCount = 0; let importFailed = false; let sourceReads = 0; let restores = 0;
  const photo = () => photos.get(selected)!;
  const state = () => ({ photoId: selected, stateToken: JSON.stringify([selected, photo().settings]), settings: structuredClone(photo().settings) });
  const context = () => ({ selectedMaskId, parameters: { local_Exposure: { value: ((photo().settings.MaskGroupBasedCorrections as Array<Record<string, unknown>>).find(group => group.CorrectionID === maskId)!.LocalExposure2012 as number) * 4, min: -4, max: options.changedRangeCycle === restores + 1 ? 3 : 4 } } });
  const bridge: BridgeClient = { async call<T>(operation: string, params: Record<string, unknown> = {}): Promise<T> {
    operations.push({ operation, params }); let result: unknown;
    if (operation === 'capabilities') result = { lightroomVersion: 'fixture', operations: { create_subject_mask: !options.missingCapability, create_background_mask: true, select_mask: !options.missingSelectionCapability, adjust_mask: true, restore: true }, renderFormats: { TIFF: { bitDepth: 16, lossless: true } } };
    else if (operation === 'import_photo') {
      const path = String(params.path); assert.match(path, /\/uploads\/[a-f0-9-]{36}\/[^/]+$/);
      if (!imports.has(path)) { const id = `source-${imports.size}`; imports.set(path, id); photos.set(id, { photoId: id, path, settings: { Exposure2012: 0.15, MaskGroupBasedCorrections: [] }, isVirtualCopy: false }); }
      selected = imports.get(path)!; result = { ...photo(), settings: undefined, name: basename(path), fileFormat: 'RAW' };
      if (options.staleImport && !importFailed) { importFailed = true; throw Object.assign(new Error('Develop settings changed; read_state and review before submitting another edit.'), { code: 'STALE_STATE', requestId: 'fixture-import-request', outcomeUncertain: true }); }
    } else if (operation === 'selected') result = { count: 1, photos: [{ ...photo(), settings: undefined, name: basename(photo().path), fileFormat: 'RAW' }] };
    else if (operation === 'read_state') { assert.equal(params.photoId, selected); if (!photo().isVirtualCopy && options.sourceReadRace && ++sourceReads === 2) photo().settings.Exposure2012 = 0.3; result = state(); }
    else if (operation === 'create_working_copy') {
      assert.equal(params.photoId, selected); const copy = structuredClone(photo()); selected = `copy-${photos.size}`;
      photos.set(selected, { ...copy, photoId: selected, isVirtualCopy: true }); result = { photoId: selected };
    } else if (operation === 'checkpoint') {
      assert.ok(photo().isVirtualCopy); const snapshotId = `snapshot-${snapshots.size}`; snapshots.set(snapshotId, structuredClone(photo().settings)); result = { snapshotId, state: state() };
    } else if (operation === 'create_subject_mask' || operation === 'create_background_mask') {
      assert.equal(params.expectedStateToken, state().stateToken); assert.ok(photo().isVirtualCopy);
      if (options.uncertainCreate) throw Object.assign(new Error('Native mask creation outcome uncertain'), { outcomeUncertain: true });
      maskId = `mask-${photos.size}`; selectedMaskId = maskId; (photo().settings.MaskGroupBasedCorrections as unknown[]).push({ CorrectionID: maskId, LocalExposure2012: 0, CorrectionMasks: [{ MaskID: 'component' }] });
      if (options.changedCreationSetting) photo().settings.Exposure2012 = 1;
      result = { state: state(), maskContext: context(), maskId, maskKind: operation === 'create_subject_mask' ? 'subject' : 'background', completion: 'stored-and-selected' };
    } else if (operation === 'select_mask') {
      assert.equal(params.photoId, selected); assert.equal(params.expectedStateToken, state().stateToken); assert.equal(params.maskId, maskId);
      selectedMaskId = maskId; const selectedState = state(); const maskContext = context();
      if (restores === 1) {
        if (options.selectionFault === 'mask') maskContext.selectedMaskId = 'another-mask';
        if (options.selectionFault === 'photo') selectedState.photoId = 'another-photo';
        if (options.selectionFault === 'token') selectedState.stateToken = 'changed-token';
        if (options.selectionFault === 'settings') selectedState.settings.Exposure2012 = 0.150001;
      }
      result = { state: selectedState, maskContext };
    } else if (operation === 'selected_mask') {
      if (!selectedMaskId) throw Object.assign(new Error('Native restore cleared mask selection.'), { code: 'MASK_SELECTION_REQUIRED' });
      assert.equal(params.maskId, selectedMaskId); result = { state: state(), maskContext: context() };
    }
    else if (operation === 'adjust_mask') {
      assert.equal(params.expectedStateToken, state().stateToken); assert.equal(params.maskId, selectedMaskId); assert.ok(photo().isVirtualCopy);
      const group = (photo().settings.MaskGroupBasedCorrections as Array<Record<string, unknown>>).find(group => group.CorrectionID === maskId)!;
      group.LocalExposure2012 = (params.adjustments as { local_Exposure: number }).local_Exposure / 4; result = { state: state() };
    } else if (operation === 'restore') {
      assert.equal(params.expectedStateToken, state().stateToken); assert.ok(photo().isVirtualCopy);
      photo().settings = structuredClone(snapshots.get(String(params.snapshotId))!); if (options.wrongRestore) photo().settings.Exposure2012 = 2;
      selectedMaskId = ''; // Lightroom can clear selection while restoring an otherwise exact mask snapshot.
      const savedToken = state().stateToken; restores++; options.onRestore?.(photo().settings, restores);
      result = { state: { ...state(), ...(options.spoofRestoredToken ? { stateToken: savedToken } : {}) } };
    } else if (operation === 'render') {
      assert.equal(params.expectedStateToken, state().stateToken); assert.equal(params.photoId, selected);
      assert.match(String(params.outputPath), /\/renders\/[^/]+\.(jpg|tif)$/);
      const local = ((photo().settings.MaskGroupBasedCorrections as Array<Record<string, unknown>>)[0]?.LocalExposure2012 as number) ?? 0;
      const value = 100 + Math.round(local * 400) + (params.format === 'TIFF' && options.drift ? ++tiffCount : 0)
        + (params.format === 'TIFF' && options.pixelResidualCycle === restores && local === 0 ? 1 : 0);
      const image = sharp({ create: { width: 16, height: 12, channels: 3, background: { r: value, g: value, b: value } } });
      if (params.format === 'TIFF') {
        if (options.invalidTiff) await image.tiff().toFile(String(params.outputPath));
        else await image.withIccProfile('srgb').toColourspace('rgb16').tiff({ compression: 'none' }).toFile(String(params.outputPath));
      } else await image.jpeg().toFile(String(params.outputPath));
      result = { outputPath: params.outputPath, photoId: options.wrongRenderPhoto && params.format === 'TIFF' ? 'different-photo' : selected, stateToken: state().stateToken };
    } else throw new Error(`Unexpected native call ${operation}`);
    return result as T;
  } };
  return { bridge, operations, photos, selectedState: state };
}
test('restoration inputs require distinct explicit assets, bounded controls and a shared owned lock', async () => {
  const f = await fixture();
  try {
    assert.throws(() => selectRestorationAssets(f.corpus, []), /explicit/);
    assert.throws(() => selectRestorationAssets(f.corpus, [f.ids[0]!, f.ids[0]!]), /distinct/);
    assert.throws(() => selectRestorationAssets(f.corpus, ['unknown']), /Unknown/);
    for (const controls of [2, 11, 3.5]) assert.throws(() => selectRestorationAssets(f.corpus, [f.ids[0]!], controls), /3 to 10/);
    const runtime = join(f.root, '.runtime'); await mkdir(runtime);
    const release = acquireRestorationLock(runtime, {}); assert.throws(() => acquireRestorationLock(runtime, {}), /Another editing session/);
    await writeFile(join(runtime, 'session.lock'), '{"owner":"replacement"}'); release(false);
    assert.equal(JSON.parse(await readFile(join(runtime, 'session.lock'), 'utf8')).owner, 'replacement');
  } finally { await f.close(); }
});
test('runner serializes exact-count controls and one cycle on isolated copies, retains native evidence and verifies originals', async () => {
  const f = await fixture(); const native = fakeBridge();
  try {
    const result = await runRestoration({ root: f.root, corpus: f.corpus, ids: f.ids, controls: 3, maskKind: 'subject', bridge: native.bridge });
    assert.equal(result.batch.status, 'complete', result.batch.error ?? 'Expected completed experiment'); assert.equal(result.batch.sourceUnchanged, true); assert.equal(result.batch.lockRetained, false);
    assert.equal(result.batch.autonomousMaskingEnabled, false); assert.equal(result.batch.environment.gpuConfiguration, null);
    assert.equal(existsSync(join(f.root, '.runtime', 'session.lock')), false);
    for (const item of result.batch.cases) {
      assert.equal(item.status, 'complete'); assert.equal(item.importedOriginalSettingsUnchanged, true);
      assert.deepEqual(item.renders.map(render => render.phase), ['baseline-control', 'baseline-control', 'baseline-control', 'masked-control', 'masked-control', 'masked-control', 'edited', 'restored-mask', 'restored-mask-control', 'restored-precreation']);
      assert.equal(item.comparisons.length, 11); assert.equal(item.summary?.exactSettingsRestored, true); assert.equal(item.summary?.restoredPairsExact, true);
      assert.equal(item.summary?.effectPixelsChanged, true); assert.equal(item.summary?.effectMaximumExceedsObservedControls, true);
      for (const render of item.renders) { assert.equal(render.recipe.format, 'TIFF'); assert.equal(render.recipe.bitDepth, 16); assert.ok(render.settings); assert.match(render.sha256, /^[a-f0-9]{64}$/); }
    }
    assert.equal(native.operations.filter(value => value.operation === 'restore').length, 4);
    assert.equal(native.operations.filter(value => value.operation === 'adjust_mask').length, 2);
    for (const photo of native.photos.values()) assert.deepEqual(photo.settings, { Exposure2012: 0.15, MaskGroupBasedCorrections: [] });
    assert.equal((await scanCorpus(f.source)).fingerprint, f.corpus.fingerprint);
    const calls = native.operations.length; const analysis = await analyzeRestoration(result.path);
    assert.equal(analysis.nativeCalls, 0); assert.equal(native.operations.length, calls); assert.equal(analysis.cases[0]!.summary?.restoredPairsExact, true);
    assert.deepEqual(JSON.parse(await readFile(result.path, 'utf8')), JSON.parse(JSON.stringify(result.batch)));
  } finally { await f.close(); }
});
test('unchanged and restored pixel drift stays unresolved without retrying or interrupting measurement', async () => {
  const f = await fixture(); const native = fakeBridge({ drift: true });
  try {
    const result = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], maskKind: 'background', bridge: native.bridge });
    assert.equal(result.batch.status, 'complete', result.batch.error ?? 'Expected completed experiment');
    const item = result.batch.cases[0]!; assert.equal(item.renders.length, 10); assert.equal(item.summary?.pixelRestoration, 'unverified');
    assert.equal(item.summary?.exactSettingsRestored, true); assert.equal(item.summary?.unchangedPairsExact, false); assert.equal(result.batch.lockRetained, false);
    assert.equal(native.operations.filter(value => value.operation === 'restore').length, 2);
    assert.equal(native.operations.filter(value => value.operation === 'create_background_mask').length, 1);
  } finally { await f.close(); }
});
test('three predetermined cycles reselect the exact saved mask after restore clears selection', async () => {
  const f = await fixture(); const native = fakeBridge();
  try {
    const result = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], controls: 3, cycles: 3, maskKind: 'subject', bridge: native.bridge });
    assert.equal(result.batch.status, 'complete', result.batch.error ?? 'Expected completed experiment'); assert.equal(result.batch.cycles, 3);
    const item = result.batch.cases[0]!;
    assert.equal(item.renders.length, 16); assert.equal(item.comparisons.length, 19);
    assert.deepEqual(item.cycles?.map(cycle => [cycle.cycle, cycle.status, cycle.exposure?.before, cycle.exposure?.requested]),
      [[1, 'complete', 0, 0.25], [2, 'complete', 0, 0.25], [3, 'complete', 0, 0.25]]);
    assert.equal(new Set(item.cycles?.map(cycle => cycle.editedId)).size, 3);
    assert.deepEqual(item.renders.filter(render => render.cycle).map(render => [render.cycle, render.phase]),
      [1, 2, 3].flatMap(cycle => ['edited', 'restored-mask', 'restored-mask-control'].map(phase => [cycle, phase])));
    const mutations = native.operations.filter(value => ['create_subject_mask', 'adjust_mask', 'restore'].includes(value.operation));
    assert.deepEqual(mutations.map(value => value.operation), ['create_subject_mask', 'adjust_mask', 'restore', 'adjust_mask', 'restore', 'adjust_mask', 'restore', 'restore']);
    const restores = mutations.filter(value => value.operation === 'restore');
    assert.equal(new Set(restores.slice(0, 3).map(value => value.params.snapshotId)).size, 1);
    assert.notEqual(restores[3]!.params.snapshotId, restores[0]!.params.snapshotId);
    const selections = native.operations.filter(value => value.operation === 'select_mask');
    assert.equal(selections.length, 3);
    for (const selection of selections) {
      assert.equal(selection.params.photoId, item.workingPhotoId); assert.equal(selection.params.maskId, item.maskId);
      assert.equal(selection.params.expectedStateToken, item.renders.find(render => render.phase === 'masked-control')!.stateToken);
      assert.equal(native.operations[native.operations.indexOf(selection) + 1]!.operation, 'selected_mask');
    }
    assert.equal(item.summary?.completedCycles, 3); assert.equal(item.summary?.exactSettingsRestored, true);
    assert.equal(item.summary?.pixelRestoration, 'exact-on-recorded-pairs'); assert.equal(result.batch.sourceUnchanged, true);
    assert.equal(item.importedOriginalSettingsUnchanged, true); assert.equal(item.stagedRawUnchanged, true);
    const calls = native.operations.length; const analysis = await analyzeRestoration(result.path);
    assert.deepEqual(analysis.cases[0]!.summary, item.summary); assert.equal(native.operations.length, calls);
  } finally { await f.close(); }
});
test('cycle limits are rejected before native calls or a session lock', async () => {
  const f = await fixture(); const native = fakeBridge();
  try {
    for (const cycles of [0, 4, 1.5, NaN, Infinity]) {
      await assert.rejects(runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], cycles, maskKind: 'subject', bridge: native.bridge }), /cycles must be an integer from 1 to 3/);
    }
    assert.equal(native.operations.length, 0); assert.equal(existsSync(join(f.root, '.runtime', 'session.lock')), false);
  } finally { await f.close(); }
});
test('a native range change between cycles stops before a second edit', async () => {
  const f = await fixture(); const native = fakeBridge({ changedRangeCycle: 2 });
  try {
    const result = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], cycles: 3, maskKind: 'subject', bridge: native.bridge });
    assert.equal(result.batch.status, 'interrupted'); assert.equal(result.batch.lockRetained, true);
    assert.match(result.batch.error!, /baseline or range changed between cycles/);
    assert.deepEqual(result.batch.cases[0]!.cycles?.map(cycle => cycle.status), ['complete', 'interrupted']);
    assert.equal(native.operations.filter(value => value.operation === 'adjust_mask').length, 1);
    assert.equal(native.operations.filter(value => value.operation === 'restore').length, 1);
    assert.equal(result.batch.cases[0]!.summary?.pixelRestoration, 'unverified');
  } finally { await f.close(); }
});
test('mismatched mask selection or returned state stops before a further control read or edit', async () => {
  for (const selectionFault of ['mask', 'photo', 'token', 'settings'] as const) {
    const f = await fixture(); const native = fakeBridge({ selectionFault });
    try {
      const result = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], cycles: 3, maskKind: 'subject', bridge: native.bridge });
      assert.equal(result.batch.status, 'interrupted', selectionFault); assert.equal(result.batch.lockRetained, true);
      assert.match(result.batch.error!, /selection could not be verified|Native photo identity or saved settings changed/);
      assert.deepEqual(result.batch.cases[0]!.cycles?.map(cycle => cycle.status), ['complete', 'interrupted']);
      assert.equal(native.operations.at(-1)?.operation, 'select_mask');
      assert.equal(native.operations.filter(value => value.operation === 'select_mask').length, 2);
      assert.equal(native.operations.filter(value => value.operation === 'adjust_mask').length, 1);
      assert.equal(native.operations.filter(value => value.operation === 'restore').length, 1);
      assert.equal(result.batch.cases[0]!.summary?.pixelRestoration, 'unverified');
    } finally { await f.close(); }
  }
});
test('tiny local and unrelated native residuals in a later restore stop without retry or cleanup', async () => {
  for (const kind of ['exposure', 'texture', 'unrelated', 'component']) {
    const f = await fixture();
    const native = fakeBridge({ spoofRestoredToken: true, onRestore(settings, count) {
      if (count !== 2) return;
      const mask = (settings.MaskGroupBasedCorrections as Array<Record<string, unknown>>)[0]!;
      if (kind === 'exposure') mask.LocalExposure2012 = 0.000001;
      if (kind === 'texture') mask.LocalTexture = 0.000001;
      if (kind === 'unrelated') settings.Exposure2012 = 0.150001;
      if (kind === 'component') (mask.CorrectionMasks as Array<Record<string, unknown>>)[0]!.MaskID = 'different-component';
    } });
    try {
      const result = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], cycles: 3, maskKind: 'subject', bridge: native.bridge });
      assert.equal(result.batch.status, 'interrupted', kind); assert.equal(result.batch.lockRetained, true);
      assert.match(result.batch.error!, /Restored settings or photo identity differ/);
      const item = result.batch.cases[0]!;
      assert.deepEqual(item.cycles?.map(cycle => cycle.status), ['complete', 'interrupted']);
      assert.equal(item.renders.length, 10); assert.equal(item.settingsRestorations.at(-1)?.exact, false);
      assert.equal(item.summary?.completedCycles, 1); assert.equal(item.summary?.exactSettingsRestored, false);
      assert.equal(item.summary?.pixelRestoration, 'unverified');
      assert.equal(native.operations.filter(value => value.operation === 'adjust_mask').length, 2);
      assert.equal(native.operations.filter(value => value.operation === 'restore').length, 2);
      assert.equal(result.batch.sourceUnchanged, true);
    } finally { await f.close(); }
  }
});
test('one cycle with a pixel residual stays unverified despite exact settings and later exact pairs', async () => {
  const f = await fixture(); const native = fakeBridge({ pixelResidualCycle: 2 });
  try {
    const result = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], cycles: 3, maskKind: 'background', bridge: native.bridge });
    assert.equal(result.batch.status, 'complete', result.batch.error ?? 'Expected completed experiment'); assert.equal(result.batch.lockRetained, false);
    const item = result.batch.cases[0]!; assert.equal(item.summary?.exactSettingsRestored, true);
    assert.deepEqual(item.summary?.cycles.map(cycle => cycle.pixelRestoration), ['exact-on-recorded-pairs', 'unverified', 'exact-on-recorded-pairs']);
    assert.equal(item.summary?.pixelRestoration, 'unverified'); assert.equal(item.summary?.restoredPairsExact, false);
    assert.equal(item.comparisons.filter(pair => pair.kind === 'local-restoration' && !pair.result.pixelsIdentical).length, 2);
    assert.equal(native.operations.filter(value => value.operation === 'restore').length, 4);
    assert.equal(native.operations.filter(value => value.operation === 'adjust_mask').length, 3);
    assert.equal((await analyzeRestoration(result.path)).cases[0]!.summary?.pixelRestoration, 'unverified');
  } finally { await f.close(); }
});
test('uncertain creation preserves lock and never retries a mutation or attempts cleanup restoration', async () => {
  const f = await fixture(); const native = fakeBridge({ uncertainCreate: true });
  try {
    const result = await runRestoration({ root: f.root, corpus: f.corpus, ids: f.ids, maskKind: 'subject', bridge: native.bridge });
    assert.equal(result.batch.status, 'interrupted'); assert.equal(result.batch.lockRetained, true); assert.equal(result.batch.sourceUnchanged, true);
    assert.equal(result.batch.cases[1]!.status, 'pending'); assert.equal(result.batch.cases[0]!.renders.length, 3);
    assert.equal(native.operations.filter(value => value.operation === 'create_subject_mask').length, 1); assert.equal(native.operations.filter(value => value.operation === 'restore').length, 0);
    assert.ok(result.batch.operations.some(value => value.outcomeUncertain)); assert.ok(existsSync(join(f.root, '.runtime', 'session.lock')));
    await assert.rejects(runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], maskKind: 'subject', bridge: native.bridge }), /Another editing session/);
  } finally { await f.close(); }
});
test('wrong settings on restore stop before export and a second restore', async () => {
  const f = await fixture(); const native = fakeBridge({ wrongRestore: true });
  try {
    const result = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], maskKind: 'subject', bridge: native.bridge });
    assert.equal(result.batch.status, 'interrupted'); assert.equal(result.batch.lockRetained, true); assert.match(result.batch.error!, /state does not match/);
    assert.equal(native.operations.filter(value => value.operation === 'restore').length, 1); assert.equal(result.batch.cases[0]!.renders.length, 7);
  } finally { await f.close(); }
});
test('wrong-photo exports, invalid TIFFs and unrelated creation edits are hard failures, never accepted as drift', async () => {
  for (const options of [{ wrongRenderPhoto: true }, { invalidTiff: true }, { changedCreationSetting: true }]) {
    const f = await fixture(); const native = fakeBridge(options);
    try {
      const result = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], maskKind: 'subject', bridge: native.bridge });
      assert.equal(result.batch.status, 'interrupted'); assert.equal(result.batch.lockRetained, true);
      assert.equal(native.operations.filter(value => value.operation === 'adjust_mask').length, 0); assert.equal(native.operations.filter(value => value.operation === 'restore').length, 0);
      assert.ok(result.batch.error); assert.notEqual(result.batch.cases[0]!.summary?.pixelRestoration, 'exact-on-recorded-pairs');
    } finally { await f.close(); }
  }
});
test('missing capability stops before any mutation and releases ownership', async () => {
  for (const missing of [{ missingCapability: true }, { missingSelectionCapability: true }]) {
    const f = await fixture(); const native = fakeBridge(missing);
    try {
      const result = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], maskKind: 'subject', bridge: native.bridge });
      assert.equal(result.batch.status, 'interrupted'); assert.equal(result.batch.lockRetained, false); assert.deepEqual(native.operations.map(value => value.operation), ['capabilities']);
      assert.equal(existsSync(join(f.root, '.runtime', 'session.lock')), false);
    } finally { await f.close(); }
  }
});
test('local reanalysis marks the overall pixel result unverified when any saved comparison input has changed', async () => {
  const f = await fixture(); const native = fakeBridge();
  try {
    const result = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], maskKind: 'subject', bridge: native.bridge });
    assert.equal(result.batch.status, 'complete'); assert.equal(result.batch.cases[0]!.summary?.pixelRestoration, 'exact-on-recorded-pairs');
    const originalResult = await readFile(result.path, 'utf8'); const calls = native.operations.length;
    const edited = result.batch.cases[0]!.renders.find(render => render.phase === 'edited')!;
    const baseline = result.batch.cases[0]!.renders.find(render => render.phase === 'baseline-control')!;
    await writeFile(edited.path, await readFile(baseline.path));
    const analysis = await analyzeRestoration(result.path); const item = analysis.cases[0]!; assert.ok(item.summary);
    assert.equal(item.summary.comparisonInputsValid, false); assert.equal(item.summary.invalidComparisonCount, 1);
    assert.equal(item.summary.pixelRestoration, 'unverified'); assert.equal(item.summary.effectMaximumExceedsObservedControls, false);
    assert.equal(item.summary.restoredPairsExact, true); // The unaffected restoration pairs remain a separate fact.
    assert.equal(item.comparisons.find(pair => pair.kind === 'local-effect')!.result.comparable, false);
    assert.equal(native.operations.length, calls); assert.equal(await readFile(result.path, 'utf8'), originalResult);
    const restored = result.batch.cases[0]!.renders.find(render => render.phase === 'restored-mask')!;
    await writeFile(restored.path, await readFile(result.batch.cases[0]!.renders.find(render => render.phase === 'masked-control')!.path));
    // Replacing a file with identical bytes leaves its saved provenance valid; a changed byte does not.
    const bytes = await readFile(restored.path); bytes[bytes.length - 1] ^= 1; await writeFile(restored.path, bytes);
    const changedRestoration = await analyzeRestoration(result.path);
    assert.equal(changedRestoration.cases[0]!.summary?.restoredPairsExact, false);
    assert.equal(changedRestoration.cases[0]!.summary?.pixelRestoration, 'unverified');
  } finally { await f.close(); }
});

test('explicit resume-import inherits planned cycles and reuses unchanged staged files without any import retry', async () => {
  const f = await fixture(); const native = fakeBridge({ staleImport: true });
  try {
    const failed = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], cycles: 3, maskKind: 'background', exposureDelta: 0.01, bridge: native.bridge });
    assert.equal(failed.batch.status, 'interrupted'); assert.equal(failed.batch.operations.at(-1)?.errorCode, 'STALE_STATE');
    const originalReport = await readFile(failed.path, 'utf8'); const expectedStateToken = native.selectedState().stateToken;
    const options = { root: f.root, corpus: f.corpus, resultPath: failed.path, expectedStateToken, bridge: native.bridge };
    await assert.rejects(resumeImportedRestoration(options), /Another editing session/);
    await rm(join(f.root, '.runtime', 'session.lock')); // The test explicitly reconciles its terminal fake import.
    const result = await resumeImportedRestoration(options);
    assert.equal(result.batch.status, 'complete', result.batch.error ?? 'Expected completed continuation');
    assert.equal(result.batch.cycles, 3); assert.equal(result.batch.cases[0]!.summary?.completedCycles, 3);
    assert.equal(result.batch.resumedImport?.parentExperimentId, failed.batch.id); assert.match(result.batch.resumedImport!.parentResultSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.batch.resumedImport?.observedSourceStateToken, expectedStateToken); assert.equal(result.batch.resumedImport?.observedSourcePhotoId, failed.batch.cases[0]?.sourcePhotoId ?? 'source-0');
    assert.equal(result.batch.cases[0]!.stagedPath, failed.batch.cases[0]!.stagedPath); assert.notEqual(result.path, failed.path);
    assert.equal(result.batch.cases[0]!.sourceEndVerification, 'staged-raw-only-no-import-retry');
    assert.equal(result.batch.cases[0]!.importedOriginalSettingsUnchanged, undefined); assert.equal(result.batch.cases[0]!.stagedRawUnchanged, true);
    assert.equal(result.batch.cases[0]!.summary?.exactSettingsRestored, true);
    assert.equal(native.operations.filter(item => item.operation === 'import_photo').length, 1);
    assert.equal(result.batch.operations.some(item => item.operation === 'import_photo'), false);
    assert.equal(await readFile(failed.path, 'utf8'), originalReport); assert.equal((await scanCorpus(f.source)).fingerprint, f.corpus.fingerprint);
  } finally { await f.close(); }
});
test('resume-import rejects missing token, pending/timeout journals, prior editing, changed staging and mismatched corpus before native calls', async () => {
  const f = await fixture(); const native = fakeBridge({ staleImport: true });
  try {
    const failed = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], maskKind: 'subject', bridge: native.bridge });
    const initialReport = await readFile(failed.path, 'utf8'); const expectedStateToken = native.selectedState().stateToken; const calls = native.operations.length;
    const options = { root: f.root, corpus: f.corpus, resultPath: failed.path, expectedStateToken, bridge: native.bridge };
    await rm(join(f.root, '.runtime', 'session.lock'));
    await assert.rejects(resumeImportedRestoration({ ...options, expectedStateToken: '' }), /explicit current source state token/);
    const mutations = [
      (report: typeof failed.batch) => { report.operations.at(-1)!.errorCode = 'BRIDGE_TIMEOUT'; },
      (report: typeof failed.batch) => { delete report.operations.at(-1)!.errorCode; report.operations.at(-1)!.error = 'Native timeout'; },
      (report: typeof failed.batch) => { report.operations.pop(); },
      (report: typeof failed.batch) => { report.operations.push({ at: '', operation: 'create_working_copy', phase: 'started' }); },
      (report: typeof failed.batch) => { report.cases[0]!.runId = 'prior-working-copy'; },
      (report: typeof failed.batch) => { report.corpusFingerprint = 'changed'; },
      (report: typeof failed.batch) => { report.cycles = 4; },
      (report: typeof failed.batch) => { report.cycles = 3; },
      (report: typeof failed.batch) => { report.cases[0]!.cycles = [{ cycle: 1, status: 'running', startedAt: '' }]; },
      (report: typeof failed.batch) => { report.cases[0]!.stagedPath = join(f.root, 'RAW', 'one.CR3'); report.operations[2]!.params!.path = report.cases[0]!.stagedPath; },
    ];
    for (const mutate of mutations) {
      const report = JSON.parse(initialReport) as typeof failed.batch; mutate(report); await writeFile(failed.path, JSON.stringify(report));
      await assert.rejects(resumeImportedRestoration(options)); assert.equal(native.operations.length, calls);
    }
    await writeFile(failed.path, initialReport);
    const sidecar = join(failed.batch.cases[0]!.stagedPath!.replace(/\/[^/]+$/, ''), 'one.xmp'); const originalXmp = await readFile(sidecar);
    await writeFile(sidecar, 'different sidecar'); await assert.rejects(resumeImportedRestoration(options), /RAW or XMP differs/); await writeFile(sidecar, originalXmp);
    const stagedRaw = failed.batch.cases[0]!.stagedPath!; const originalRaw = await readFile(stagedRaw);
    await writeFile(stagedRaw, 'different RAW'); await assert.rejects(resumeImportedRestoration(options), /RAW or XMP differs/); await writeFile(stagedRaw, originalRaw);
    assert.equal(native.operations.length, calls);
  } finally { await f.close(); }
});

test('historical single-cycle reports remain analyzable without cycle metadata', async () => {
  const f = await fixture(); const native = fakeBridge();
  try {
    const result = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], maskKind: 'subject', bridge: native.bridge });
    assert.equal(result.batch.status, 'complete');
    const historical = structuredClone(result.batch); delete historical.cycles;
    const item = historical.cases[0]!; delete item.plannedCycles; delete item.cycles; delete item.summary;
    for (const record of [...item.renders, ...item.comparisons, ...item.settingsRestorations]) delete record.cycle;
    const path = join(f.root, 'historical.json'); await writeFile(path, JSON.stringify(historical));
    const calls = native.operations.length; const analysis = await analyzeRestoration(path);
    assert.equal(analysis.cases[0]!.summary?.plannedCycles, 1); assert.equal(analysis.cases[0]!.summary?.completedCycles, 1);
    assert.equal(analysis.cases[0]!.summary?.pixelRestoration, 'exact-on-recorded-pairs'); assert.equal(native.operations.length, calls);
  } finally { await f.close(); }
});
test('resume-import refuses wrong selection, stale explicit state and a state race before creating any working copy', async () => {
  for (const scenario of ['selection', 'token', 'race']) {
    const f = await fixture(); const native = fakeBridge({ staleImport: true, sourceReadRace: scenario === 'race' });
    try {
      const failed = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], maskKind: 'subject', bridge: native.bridge });
      const expectedStateToken = scenario === 'token' ? 'stale-token' : native.selectedState().stateToken;
      if (scenario === 'selection') native.photos.get('source-0')!.isVirtualCopy = true;
      await rm(join(f.root, '.runtime', 'session.lock'));
      const result = await resumeImportedRestoration({ root: f.root, corpus: f.corpus, resultPath: failed.path, expectedStateToken, bridge: native.bridge });
      assert.equal(result.batch.status, 'interrupted'); assert.equal(result.batch.lockRetained, false);
      assert.equal(native.operations.filter(item => item.operation === 'create_working_copy').length, 0);
      assert.equal(native.operations.filter(item => item.operation === 'import_photo').length, 1);
    } finally { await f.close(); }
  }
});
test('file bridge resume preflight rejects pending work but permits completed request history', async () => {
  const f = await fixture(); const native = fakeBridge({ staleImport: true });
  try {
    const failed = await runRestoration({ root: f.root, corpus: f.corpus, ids: [f.ids[0]!], maskKind: 'subject', bridge: native.bridge });
    await rm(join(f.root, '.runtime', 'session.lock'));
    const bridge = join(f.root, '.runtime', 'bridge'); await mkdir(join(bridge, 'requests'), { recursive: true });
    const requestName = '11111111-2222-3333-4444-555555555555.json';
    await writeFile(join(bridge, 'heartbeat.json'), JSON.stringify({ timestamp: Date.now(), status: 'idle' }));
    await writeFile(join(bridge, 'requests', requestName), '{}');
    const result = await resumeImportedRestoration({ root: f.root, corpus: f.corpus, resultPath: failed.path, expectedStateToken: native.selectedState().stateToken });
    assert.equal(result.batch.status, 'interrupted'); assert.match(result.batch.error!, /pending call/); assert.equal(result.batch.operations.length, 0);
    assert.equal(result.batch.lockRetained, false); assert.equal(await readFile(join(bridge, 'requests', requestName), 'utf8'), '{}');
    await mkdir(join(bridge, 'responses'));
    await writeFile(join(bridge, 'responses', requestName), '{}');
    await writeFile(join(bridge, 'requests', 'ignored-non-uuid.json'), '{}');
    const fileBridge = new FileBridge(bridge); fileBridge.call = native.bridge.call;
    const resumed = await resumeImportedRestoration({ root: f.root, corpus: f.corpus, resultPath: failed.path,
      expectedStateToken: native.selectedState().stateToken, bridge: fileBridge });
    assert.equal(resumed.batch.status, 'complete', resumed.batch.error ?? 'Expected completed continuation');
    assert.ok(resumed.batch.resumedImport?.nativeBridgeIdleVerifiedAt);
    assert.equal(resumed.batch.operations.some(item => item.operation === 'import_photo'), false);
  } finally { await f.close(); }
});
