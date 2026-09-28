import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { BridgeError } from '../src/bridge.ts';
import { PhotoController } from '../src/controller.ts';
import type { BridgeClient, PhotoState } from '../src/controller.ts';
import { verifyMaskRoundtrip } from '../src/mask-validation.ts';
import { RunStore } from '../src/store.ts';

const PHOTO_ID = 'diagnostic-copy';
const MASK_ID = 'existing-subject-mask';

async function renderFixture(path: string, level: number, format = 'JPEG') {
  if (format === 'TIFF') {
    const pixels = new Uint16Array(16 * 16 * 3).fill(Math.round(level * 257));
    await sharp(pixels, { raw: { width: 16, height: 16, channels: 3 } }).toColourspace('rgb16').tiff({ compression: 'none' }).toFile(path);
    return;
  }
  const value = Math.round(level);
  await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: value, g: value, b: value } } })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toFile(path);
}

/** Only image generation is simulated; the real controller and durable store
 * enforce candidate state, operation ordering, and interruption behavior. */
class MaskLightroom implements BridgeClient {
  exposure = 0;
  selectedMaskId = MASK_ID;
  contextStateToken: string | undefined;
  maskFailure: BridgeError | undefined;
  renderOffsets: number[] = [];
  renderEffect = 40;
  renderCount = 0;
  manualEditAfterRender: { count: number; exposure: number } | undefined;
  calls: Array<{ operation: string; params: Record<string, unknown> }> = [];
  snapshots = new Map<string, number>([['baseline-snapshot', 0]]);

  state(): PhotoState {
    const settings = {
      Exposure2012: 0,
      MaskGroupBasedCorrections: [{ CorrectionID: MASK_ID, LocalExposure2012: this.exposure / 4,
        CorrectionMasks: [{ MaskID: 'subject-component', MaskDigest: 'unchanged-geometry' }] }],
    };
    return { photoId: PHOTO_ID, settings, stateToken: createHash('sha256').update(JSON.stringify(settings)).digest('hex') };
  }

  async call<T>(operation: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ operation, params: structuredClone(params) });
    assert.equal(params.photoId, PHOTO_ID, 'Diagnostic operations stay on the working copy');
    if (params.expectedStateToken) assert.equal(params.expectedStateToken, this.state().stateToken);
    if (operation === 'read_state') return this.state() as T;
    if (operation === 'selected_mask') {
      assert.equal(params.maskId, MASK_ID);
      return {
        state: { ...this.state(), stateToken: this.contextStateToken ?? this.state().stateToken },
        maskContext: { selectedMaskId: this.selectedMaskId, parameters: { local_Exposure: { value: this.exposure, min: -4, max: 4 } } },
      } as T;
    }
    if (operation === 'adjust_mask') {
      assert.equal(params.maskId, MASK_ID);
      const adjustments = params.adjustments as Record<string, number>;
      assert.deepEqual(Object.keys(adjustments), ['local_Exposure']);
      this.exposure = adjustments.local_Exposure!;
      // Model an applied write whose response was lost, not merely a rejected edit.
      if (this.maskFailure) throw this.maskFailure;
      return { state: this.state() } as T;
    }
    if (operation === 'checkpoint') {
      const snapshotId = `snapshot-${this.snapshots.size}`;
      this.snapshots.set(snapshotId, this.exposure);
      return { snapshotId, state: this.state() } as T;
    }
    if (operation === 'restore') {
      assert.ok(this.snapshots.has(String(params.snapshotId)));
      this.exposure = this.snapshots.get(String(params.snapshotId))!;
      return { state: this.state() } as T;
    }
    if (operation === 'render') {
      const offset = this.renderOffsets[this.renderCount++] ?? 0;
      await renderFixture(String(params.outputPath), 100 + this.exposure * this.renderEffect + offset, String(params.format ?? 'JPEG'));
      const result = { photoId: PHOTO_ID, stateToken: this.state().stateToken, outputPath: params.outputPath };
      // A user edit immediately after native export completion must survive the
      // controller's subsequent restore preflight, even when export was valid.
      if (this.manualEditAfterRender?.count === this.renderCount) this.exposure = this.manualEditAfterRender.exposure;
      return result as T;
    }
    throw new Error(`Unexpected operation ${operation}`);
  }
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'rpa-mask-validation-'));
  const store = new RunStore(join(root, 'runs.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const peer = new MaskLightroom();
  const controller = new PhotoController(peer, store, join(root, 'renders'));
  const run = store.createRun({ sourcePhotoId: 'original', workingPhotoId: PHOTO_ID, intent: 'Verify mask rollback on an isolated copy' });
  const previewPath = join(root, 'saved-baseline.jpg');
  await renderFixture(previewPath, 100);
  const state = peer.state();
  const baseline = store.addCandidate({ runId: run.id, snapshotId: 'baseline-snapshot', stateToken: state.stateToken,
    settings: state.settings, previewPath });
  store.setBaseline(run.id, baseline.id);
  return { controller, peer, store, run, baseline };
}

test('mask diagnostic verifies an exact roundtrip and retains all original evidence', async t => {
  const { controller, peer, store, run, baseline } = await fixture(t);
  const report = await verifyMaskRoundtrip(controller, run.id, baseline.id, MASK_ID);
  assert.equal(report.passed, true);
  assert.equal(report.applied, true);
  assert.equal(report.renderedChangeVerified, true);
  assert.equal(report.settingsRestored, true);
  assert.deepEqual(report.exposure, { before: 0, requested: 0.25, observed: 0.25 });
  assert.equal(report.savedBaseline.pixelsIdentical, true);
  assert.equal(report.baselineRepeat.pixelsIdentical, true);
  assert.equal(report.changedRepeat.pixelsIdentical, true);
  assert.equal(report.changedPixels.pixelsIdentical, false);
  assert.equal(report.restorationDifference.pixelsIdentical, true);
  assert.equal(report.restorationAttempts.length, 1);
  assert.equal(peer.exposure, 0);
  assert.equal(peer.calls.filter(call => call.operation === 'adjust_mask').length, 1);
  assert.equal(peer.calls.filter(call => call.operation === 'restore').length, 1);
  assert.equal(store.getRun(run.id)!.status, 'active');
  assert.equal(store.getCandidate(baseline.id)!.previewPath, baseline.previewPath);
  assert.equal(store.listCandidates(run.id).length, 2);
  assert.deepEqual(store.listEvents(run.id).find(event => event.type === 'mask_roundtrip_checked')!.payload, report);
  const paths = [...Object.values(report.renders), ...report.restorationAttempts.map(attempt => attempt.previewPath)];
  assert.equal(new Set(paths).size, paths.length, 'Each export has independent evidence');
});

test('TIFF diagnostic compares independent lossless references and retains the saved JPEG separately', async t => {
  const { controller, peer, store, run, baseline } = await fixture(t);
  // The saved JPEG is not a lossless reference and must not enter TIFF comparisons.
  await renderFixture(baseline.previewPath!, 99);
  const report = await verifyMaskRoundtrip(controller, run.id, baseline.id, MASK_ID, 'TIFF');
  assert.equal(report.passed, true); assert.equal(report.format, 'TIFF');
  assert.equal(report.reference.source, 'separate-lossless-baseline'); assert.equal(report.reference.savedPreviewCompared, false);
  assert.notEqual(report.reference.path, baseline.previewPath); assert.equal(report.renders.saved, baseline.previewPath);
  assert.equal(report.savedBaseline.pixelsIdentical, true);
  for (const comparison of [report.savedBaseline, report.baselineRepeat, report.changedRepeat, report.restorationDifference]) {
    assert.equal(comparison.bitDepth, 16); assert.equal(comparison.pixelsIdentical, true);
  }
  assert.equal(report.changedPixels.bitDepth, 16); assert.equal(report.changedPixels.meanAbsoluteDifference, 10 * 257);
  assert.deepEqual(peer.calls.filter(call => call.operation === 'render').map(call => call.params.format), ['TIFF', 'TIFF', 'TIFF', 'JPEG', 'TIFF', 'TIFF', 'TIFF']);
  assert.equal(peer.calls.filter(call => call.operation === 'adjust_mask').length, 1);
  assert.equal(peer.calls.filter(call => call.operation === 'restore').length, 1);
  assert.equal(store.getCandidate(baseline.id)!.previewPath, baseline.previewPath);
  const paths = [...Object.values(report.renders), ...report.restorationAttempts.map(attempt => attempt.previewPath)];
  assert.equal(new Set(paths).size, paths.length);
});

test('TIFF diagnostic rejects even one low-order channel step after restoration', async t => {
  const { controller, peer, store, run, baseline } = await fixture(t);
  peer.renderOffsets = [0, 0, 0, 0, 0, 0, 1 / 257, 1 / 257];
  const report = await verifyMaskRoundtrip(controller, run.id, baseline.id, MASK_ID, 'TIFF');
  assert.equal(report.passed, false); assert.equal(report.applied, true); assert.equal(report.renderedChangeVerified, true);
  assert.equal(report.baselineRepeat.pixelsIdentical, true); assert.equal(report.changedRepeat.pixelsIdentical, true);
  assert.equal(report.restorationDifference.bitDepth, 16); assert.equal(report.restorationDifference.maximumChannelDifference, 1);
  assert.equal(report.restorationAttempts.length, 2); assert.equal(report.restorationDifference.pixelsIdentical, false);
  assert.equal(store.getRun(run.id)!.status, 'interrupted');
});

test('TIFF visible-effect threshold scales to native 16-bit channel units', async t => {
  const { controller, peer, run, baseline } = await fixture(t);
  peer.renderEffect = 4 / 257;
  const report = await verifyMaskRoundtrip(controller, run.id, baseline.id, MASK_ID, 'TIFF');
  assert.equal(report.applied, true); assert.equal(report.changedPixels.bitDepth, 16);
  assert.equal(report.changedPixels.meanAbsoluteDifference, 1);
  assert.equal(report.renderedChangeVerified, false); assert.equal(report.passed, false);
  assert.equal(report.restorationDifference.pixelsIdentical, true);
});

test('unsupported diagnostic format fails before native operations', async t => {
  const { controller, peer, run, baseline } = await fixture(t);
  await assert.rejects(verifyMaskRoundtrip(controller, run.id, baseline.id, MASK_ID, 'PNG' as 'TIFF'), /format must be JPEG or TIFF/);
  assert.equal(peer.calls.length, 0);
});

test('unchanged-state drift is distinguished while nonidentical restored pixels still fail', async t => {
  const { controller, peer, store, run, baseline } = await fixture(t);
  // Before/repeat, changed/repeat, restored/retry: only baseline repeat and
  // restored exports differ by one decoded channel level.
  peer.renderOffsets = [0, 1, 0, 0, 1, 1];
  const report = await verifyMaskRoundtrip(controller, run.id, baseline.id, MASK_ID);
  assert.equal(report.passed, false);
  assert.equal(report.settingsRestored, true);
  assert.equal(report.applied, true);
  assert.equal(report.renderedChangeVerified, true);
  assert.equal(report.savedBaseline.pixelsIdentical, true);
  assert.equal(report.baselineRepeat.pixelsIdentical, false);
  assert.equal(report.changedRepeat.pixelsIdentical, true);
  assert.equal(report.restorationAttempts.length, 2);
  assert.ok(report.restorationAttempts.every(attempt => !attempt.difference.pixelsIdentical));
  assert.equal(report.restorationDifference.maximumChannelDifference, 1, 'A tiny difference is not accepted as exact');
  assert.match(report.diagnosis, /Unchanged-state exports differ/);
  assert.equal(peer.calls.filter(call => call.operation === 'adjust_mask').length, 1);
  assert.equal(peer.calls.filter(call => call.operation === 'restore').length, 1, 'Only exports may repeat');
  assert.equal(store.getRun(run.id)!.status, 'interrupted');
  assert.equal(store.getCandidate(baseline.id)!.previewPath, baseline.previewPath);
});

test('stale baseline and changed mask context are refused before exports or mutation', async t => {
  for (const scenario of ['stale baseline', 'different mask', 'stale mask state'] as const) {
    await t.test(scenario, async t => {
      const { controller, peer, store, run, baseline } = await fixture(t);
      if (scenario === 'stale baseline') peer.exposure = 0.5;
      if (scenario === 'different mask') peer.selectedMaskId = 'different-subject-mask';
      if (scenario === 'stale mask state') peer.contextStateToken = 'changed-after-initial-read';
      await assert.rejects(verifyMaskRoundtrip(controller, run.id, baseline.id, MASK_ID), /baseline|mask or photo changed/);
      assert.ok(peer.calls.every(call => ['read_state', 'selected_mask'].includes(call.operation)));
      assert.equal(peer.renderCount, 0);
      assert.equal(store.listCandidates(run.id).length, 1);
    });
  }
});

test('uncertain mask edit preserves the bridge error and never blindly restores', async t => {
  const { controller, peer, store, run, baseline } = await fixture(t);
  const failure = new BridgeError('OUTCOME_UNKNOWN', 'The write may still be executing.', {
    operation: 'adjust_mask', requestId: 'uncertain-mask-request', outcomeUncertain: true,
  });
  peer.maskFailure = failure;
  await assert.rejects(verifyMaskRoundtrip(controller, run.id, baseline.id, MASK_ID), error => error === failure);
  assert.equal(failure.outcomeUncertain, true);
  assert.equal(peer.exposure, 0.25, 'A possibly applied adjustment stays available for explicit recovery');
  assert.equal(peer.calls.filter(call => call.operation === 'adjust_mask').length, 1);
  assert.equal(peer.calls.some(call => call.operation === 'restore'), false);
  assert.equal(peer.calls.at(-1)!.operation, 'adjust_mask');
  assert.equal(store.getRun(run.id)!.status, 'interrupted');
  assert.equal(store.listCandidates(run.id).length, 1, 'An uncertain write must not become a verified candidate');
  assert.equal(store.listEvents(run.id).some(event => event.type === 'mask_roundtrip_checked'), false);
  const interruption = store.listEvents(run.id).find(event => event.type === 'mask_roundtrip_interrupted');
  assert.deepEqual(interruption!.payload, { candidateId: baseline.id, maskId: MASK_ID, message: String(failure) });
});

test('a manual edit after the final edited export is preserved instead of restored over', async t => {
  for (const [format, count] of [['JPEG', 4], ['TIFF', 6]] as const) {
    await t.test(format, async t => {
      const { controller, peer, store, run, baseline } = await fixture(t);
      peer.manualEditAfterRender = { count, exposure: 0.75 };
      await assert.rejects(verifyMaskRoundtrip(controller, run.id, baseline.id, MASK_ID, format), /changed since the reviewed checkpoint/);
      assert.equal(peer.renderCount, count, 'No restoration export or retry runs after the manual change');
      assert.equal(peer.exposure, 0.75, 'Preserve the new manual adjustment');
      assert.equal(peer.calls.filter(call => call.operation === 'adjust_mask').length, 1);
      assert.equal(peer.calls.some(call => call.operation === 'restore'), false);
      assert.equal(store.getRun(run.id)!.status, 'interrupted');
      assert.equal(store.listEvents(run.id).some(event => event.type === 'mask_roundtrip_checked'), false);
      assert.equal(store.listEvents(run.id).some(event => event.type === 'mask_roundtrip_interrupted'), true);
    });
  }
});
