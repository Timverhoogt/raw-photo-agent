import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { RunStore } from '../src/store.ts';
import { PhotoController } from '../src/controller.ts';
import type { BridgeClient, PhotoState } from '../src/controller.ts';
import { compareImages } from '../src/images.ts';
import { BridgeError } from '../src/bridge.ts';

class FakeLightroom implements BridgeClient {
  selection = 'original';
  settings: Record<string, unknown> = { Exposure2012: 0, Contrast2012: 0 };
  snapshots = new Map<string, Record<string, unknown>>();
  calls: string[] = [];
  maskCalls: Record<string, unknown>[] = [];
  maskFailure: Error | undefined;
  breakRestore = false;
  skipRender = false;
  failCheckpoint = false;
  failRead = false;
  failCopyResponse = false;
  copyName = '';
  sourceWasEdited = false;
  state(): PhotoState {
    return { photoId: this.selection, settings: { ...this.settings }, stateToken: createHash('sha256').update(JSON.stringify(this.settings)).digest('hex') };
  }
  async call<T>(operation: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(operation);
    if (operation === 'selected') return { count: 1, photos: [{ photoId: this.selection, name: 'selected.CR3', fileFormat: 'RAW', isVirtualCopy: this.selection === 'copy', path: '/photos/selected.CR3', copyName: this.copyName }] } as T;
    assert.equal(params.photoId, this.selection);
    if (operation === 'create_working_copy') {
      this.selection = 'copy'; this.copyName = String(params.copyName);
      if (this.failCopyResponse) throw new Error('Copy response lost');
      return { photoId: this.selection } as T;
    }
    if (operation === 'read_state') {
      if (this.failRead) throw new Error('Lightroom offline');
      return this.state() as T;
    }
    assert.equal(this.selection, 'copy', 'Original must not be mutated');
    if (params.expectedStateToken) assert.equal(params.expectedStateToken, this.state().stateToken);
    if (operation === 'checkpoint') {
      if (this.failCheckpoint) throw new Error('Checkpoint failed');
      const snapshotId = `snapshot-${this.snapshots.size + 1}`;
      this.snapshots.set(snapshotId, { ...this.settings });
      return { snapshotId, state: this.state() } as T;
    }
    if (operation === 'apply') { Object.assign(this.settings, params.adjustments); return { state: this.state() } as T; }
    if (operation === 'adjust_mask') {
      this.maskCalls.push(structuredClone(params));
      if (this.maskFailure) throw this.maskFailure;
      this.settings.MaskGroupBasedCorrections = [{ maskId: params.maskId, adjustments: { ...params.adjustments as Record<string, unknown> } }];
      return { state: this.state(), maskId: params.maskId, appliedAdjustments: params.adjustments } as T;
    }
    if (operation === 'restore') {
      if (!this.breakRestore) this.settings = { ...this.snapshots.get(String(params.snapshotId))! };
      return { state: this.state() } as T;
    }
    if (operation === 'render') {
      if (!this.skipRender) {
        const level = Math.round(100 + Number(this.settings.Exposure2012) * 40);
        await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: level, g: level, b: level } } }).jpeg().toFile(String(params.outputPath));
      }
      return { photoId: this.selection, stateToken: this.state().stateToken, outputPath: params.outputPath } as T;
    }
    throw new Error(`Unexpected operation: ${operation}`);
  }
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'rpa-controller-'));
  const store = new RunStore(join(root, 'runs.sqlite'));
  const peer = new FakeLightroom();
  const renders = join(root, 'renders'); mkdirSync(renders);
  const controller = new PhotoController(peer, store, renders);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, peer, controller };
}

test('explicit target and filename are required before any copy or mutation', async t => {
  const { controller, peer } = fixture(t);
  await assert.rejects(controller.start('original', 'Natural', 'another.CR3'), /does not match/);
  assert.deepEqual(peer.calls, ['selected']);
});

test('global edit, fresh previews and native restore roundtrip returns identical pixels', async t => {
  const { controller, store } = fixture(t);
  const { run, baseline } = await controller.start('original', 'Natural', 'selected.CR3');
  const edit = await controller.edit(run.id, baseline.id, { Exposure2012: 0.25 }, 'Lift subject exposure');
  assert.equal(edit.parentId, baseline.id);
  assert.equal((await compareImages(baseline.previewPath!, edit.previewPath!)).pixelsIdentical, false);
  await controller.restore(run.id, baseline.id);
  const restored = await controller.render(run.id, baseline.id);
  assert.equal((await compareImages(baseline.previewPath!, restored.previewPath!)).pixelsIdentical, true);
  assert.equal(store.getCandidate(baseline.id)!.previewPath, baseline.previewPath, 'original evidence stays immutable');
});

test('stale parent is refused before apply and user edits are preserved', async t => {
  const { controller, peer } = fixture(t);
  const { run, baseline } = await controller.start('original', 'Natural', 'selected.CR3');
  peer.settings.Exposure2012 = 1;
  await assert.rejects(controller.edit(run.id, baseline.id, { Exposure2012: 0.25 }, 'Try exposure'), /differs from the parent/);
  assert.equal(peer.calls.includes('apply'), false);
  assert.equal(peer.settings.Exposure2012, 1);
});

test('mask edits target the explicit mask and parent state, then checkpoint and render', async t => {
  const { controller, store, peer } = fixture(t);
  const { run, baseline } = await controller.start('original', 'Natural', 'selected.CR3');
  const callOffset = peer.calls.length;
  const adjustments = { local_Exposure: 0.2, local_Texture: 0.1 };
  const edited = await controller.editMask(run.id, baseline.id, 'subject-mask-1', adjustments, 'Lift the subject gently', 'restrained');
  assert.deepEqual(peer.maskCalls, [{
    photoId: run.workingPhotoId, expectedStateToken: baseline.stateToken, maskId: 'subject-mask-1', adjustments,
  }]);
  assert.deepEqual(peer.calls.slice(callOffset), ['read_state', 'adjust_mask', 'checkpoint', 'render']);
  assert.equal(edited.parentId, baseline.id);
  assert.equal(edited.direction, 'restrained');
  assert.notEqual(edited.stateToken, baseline.stateToken);
  assert.ok(edited.previewPath);
  assert.equal(store.listCandidates(run.id).length, 2);
  assert.equal(peer.settings.Exposure2012, 0, 'Global exposure remains unchanged');
  const event = store.listEvents(run.id).find(event => event.type === 'operation_started' && (event.payload as { operation: string }).operation === 'adjust_mask');
  assert.deepEqual((event!.payload as { params: unknown }).params, peer.maskCalls[0]);
});

test('mask edits refuse a stale parent before changing the selected mask', async t => {
  const { controller, peer, store } = fixture(t);
  const { run, baseline } = await controller.start('original', 'Natural', 'selected.CR3');
  peer.settings.Contrast2012 = 10;
  await assert.rejects(controller.editMask(run.id, baseline.id, 'subject-mask-1', { local_Exposure: 0.2 }, 'Lift subject'), /differs from the parent/);
  assert.deepEqual(peer.maskCalls, []);
  assert.equal(store.listCandidates(run.id).length, 1);
  assert.equal(peer.settings.Contrast2012, 10);
});

test('mask failures preserve the plugin error and interrupt without recording a false candidate', async t => {
  const { controller, peer, store } = fixture(t);
  const { run, baseline } = await controller.start('original', 'Natural', 'selected.CR3');
  const failure = new BridgeError('VERIFY_FAILED', 'Inspect the local edit.', { outcomeUncertain: true });
  peer.maskFailure = failure;
  await assert.rejects(controller.editMask(run.id, baseline.id, 'subject-mask-1', { local_Exposure: 0.2 }, 'Lift subject'), error => error === failure);
  assert.equal(store.getRun(run.id)!.status, 'interrupted');
  assert.equal(store.listCandidates(run.id).length, 1);
  assert.equal(peer.calls.at(-1), 'adjust_mask');
});

test('mask edits respect pending choices and the shared candidate budget before contacting Lightroom', async t => {
  const { controller, peer, store } = fixture(t);
  const { run, baseline } = await controller.start('original', 'Natural', 'selected.CR3');
  store.setRunStatus(run.id, 'awaiting_choice');
  const callCount = peer.calls.length;
  await assert.rejects(controller.editMask(run.id, baseline.id, 'subject-mask-1', { local_Exposure: 0.2 }, 'Lift subject'), /awaiting_choice/);
  assert.equal(peer.calls.length, callCount);
  store.setRunStatus(run.id, 'active');
  for (let i = 0; i < 12; i++) store.addCandidate({ runId: run.id, parentId: baseline.id, snapshotId: `budget-${i}`, stateToken: baseline.stateToken });
  await assert.rejects(controller.editMask(run.id, baseline.id, 'subject-mask-1', { local_Exposure: 0.2 }, 'Lift subject'), /run limit/);
  assert.equal(peer.calls.length, callCount);
});

test('comparison pauses edits until an actual choice and restores the selected branch', async t => {
  const { controller, store, peer } = fixture(t);
  const { run, baseline } = await controller.start('original', 'Natural', 'selected.CR3');
  const edit = await controller.edit(run.id, baseline.id, { Exposure2012: 0.25 }, 'More light');
  const { choice } = controller.compare(run.id, [baseline.id, edit.id], 'Which balance?');
  assert.equal(store.getRun(run.id)!.status, 'awaiting_choice');
  await assert.rejects(controller.edit(run.id, edit.id, { Exposure2012: 0.5 }, 'More'), /awaiting_choice/);
  await controller.choose(choice.id, baseline.id, 'Keep the restrained version');
  assert.equal(store.getRun(run.id)!.status, 'active');
  assert.equal(peer.settings.Exposure2012, 0);
  await assert.rejects(controller.choose(choice.id, edit.id), /already|immutable|decision/i);
});

test('a failed restore interrupts the run instead of claiming success', async t => {
  const { controller, store, peer } = fixture(t);
  const { run, baseline } = await controller.start('original', 'Natural', 'selected.CR3');
  await controller.edit(run.id, baseline.id, { Exposure2012: 0.25 }, 'More light');
  peer.breakRestore = true;
  await assert.rejects(controller.restore(run.id, baseline.id), /does not match/);
  assert.equal(store.getRun(run.id)!.status, 'interrupted');
});

test('render success without an actual file interrupts the run', async t => {
  const { controller, store, peer } = fixture(t);
  const { run, baseline } = await controller.start('original', 'Natural', 'selected.CR3');
  peer.skipRender = true;
  await assert.rejects(controller.render(run.id, baseline.id), /could not be verified/);
  assert.equal(store.getRun(run.id)!.status, 'interrupted');
});

test('a lost copy response has a durable run and explicit initialization recovery', async t => {
  const { controller, store, peer } = fixture(t);
  peer.failCopyResponse = true;
  await assert.rejects(controller.start('original', 'Natural', 'selected.CR3'), /response lost/);
  const run = store.listRuns()[0]!;
  assert.equal(run.status, 'interrupted');
  assert.equal(run.workingPhotoId, `pending:${run.id}`);
  assert.ok(store.listEvents(run.id).some(event => event.type === 'start_requested'));
  const result = await controller.resumeStart(run.id, 'copy', 'selected.CR3');
  assert.equal(result.run.workingPhotoId, 'copy');
  assert.equal(result.run.baselineSnapshotId, result.baseline.snapshotId);
});

test('failed first checkpoint can resume without creating a second copy', async t => {
  const { controller, store, peer } = fixture(t);
  peer.failCheckpoint = true;
  await assert.rejects(controller.start('original', 'Natural', 'selected.CR3'), /Checkpoint failed/);
  const run = store.listRuns()[0]!;
  assert.equal(run.status, 'interrupted');
  assert.equal(store.listCandidates(run.id).length, 0);
  peer.failCheckpoint = false;
  await controller.resumeStart(run.id, 'copy', 'selected.CR3');
  assert.equal(peer.calls.filter(call => call === 'create_working_copy').length, 1);
});

test('explicit resume also recovers an active incomplete initialization after hard termination', async t => {
  const { controller, store, peer } = fixture(t);
  peer.failCheckpoint = true;
  await assert.rejects(controller.start('original', 'Natural', 'selected.CR3'), /Checkpoint failed/);
  const run = store.listRuns()[0]!;
  store.setRunStatus(run.id, 'active'); // Simulate the last durable status before an abrupt exit.
  peer.failCheckpoint = false;
  await controller.resumeStart(run.id, 'copy', 'selected.CR3');
  assert.equal(store.listCandidates(run.id).length, 1);
});

test('failed choice restoration stays interrupted and keeps the decision pending', async t => {
  const { controller, store, peer } = fixture(t);
  const { run, baseline } = await controller.start('original', 'Natural', 'selected.CR3');
  const edit = await controller.edit(run.id, baseline.id, { Exposure2012: 0.25 }, 'More light');
  const { choice } = controller.compare(run.id, [baseline.id, edit.id], 'Which balance?');
  peer.failRead = true;
  await assert.rejects(controller.choose(choice.id, baseline.id), /offline/);
  assert.equal(store.getRun(run.id)!.status, 'interrupted');
  assert.equal(store.getChoice(choice.id)!.selectedCandidateId, null);
  peer.failRead = false;
  await controller.reconcile(run.id, edit.id);
  assert.equal(store.getRun(run.id)!.status, 'awaiting_choice');
  await controller.choose(choice.id, baseline.id);
  assert.equal(store.getRun(run.id)!.status, 'active');
});

test('replaying a decided choice does not overwrite later editing', async t => {
  const { controller, peer } = fixture(t);
  const { run, baseline } = await controller.start('original', 'Natural', 'selected.CR3');
  const edit = await controller.edit(run.id, baseline.id, { Exposure2012: 0.25 }, 'More light');
  const { choice } = controller.compare(run.id, [baseline.id, edit.id], 'Which balance?');
  await controller.choose(choice.id, edit.id);
  await controller.edit(run.id, edit.id, { Exposure2012: 0.5 }, 'Refine');
  const beforeCalls = peer.calls.length;
  await controller.choose(choice.id, edit.id);
  assert.equal(peer.calls.length, beforeCalls);
  assert.equal(peer.settings.Exposure2012, 0.5);
});
