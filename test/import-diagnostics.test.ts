import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { BridgeError, FileBridge } from '../src/bridge.ts';
import { getPaths } from '../src/config.ts';
import { diffNativeSettings, runImportDiagnostic } from '../src/diagnostics/import.ts';
import { scanCorpus } from '../src/evaluation/corpus.ts';

interface Faults {
  importError?: 'STALE_STATE' | 'BRIDGE_TIMEOUT'; wrongSelection?: boolean; noTraces?: boolean;
  driftRead?: number; returnToBaseline?: boolean; replaceLock?: boolean; mutateSidecar?: boolean; mutateSource?: boolean;
  intermediateTraceDrift?: boolean; alterTraceAfterCopy?: boolean;
}
async function fixture(t: TestContext, faults: Faults = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rpa-import-diagnostic-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = getPaths(root); const source = join(root, 'RAW'); await mkdir(source);
  await writeFile(join(source, 'one.CR3'), 'original RAW bytes'); await writeFile(join(source, 'one.xmp'), '<xmp>photographer edit</xmp>');
  const corpus = await scanCorpus(source);
  for (const dir of [paths.pluginInstall, ...['requests', 'responses', 'receipts'].map(name => join(paths.bridgeDir, name))]) await mkdir(dir, { recursive: true });
  await writeFile(join(paths.pluginInstall, 'Operations.lua'), 'fixture installed native implementation');
  const heartbeat = () => writeFile(join(paths.bridgeDir, 'heartbeat.json'), JSON.stringify({ status: 'idle', timestamp: Date.now() }));
  await heartbeat();
  let now = Date.now(); const delays: number[] = []; const clock = { now: () => now, sleep: async (ms: number) => { delays.push(ms); now += ms; } };
  const operations: string[] = []; let staged: string | undefined; let reads = 0; let firstTrace: string | undefined;
  const photo = () => ({ photoId: staged ? 'imported' : 'existing', isVirtualCopy: false, fileFormat: 'RAW', name: staged ? 'one.CR3' : 'other.CR3', path: staged ?? '/untouched/other.CR3' });
  const nativeState = (drift = false) => ({ photoId: photo().photoId, stateToken: drift ? 'changed' : 'baseline',
    settings: { Exposure2012: 0, Look: { Parameters: { ...(drift ? { PointColors: {} } : {}) } } } });
  class NativePeer extends FileBridge {
    override async call<T>(operation: string, params: Record<string, unknown> = {}): Promise<T> {
      operations.push(operation); const id = randomUUID();
      const request = { protocolVersion: 1, id, operation, params, issuedAt: Date.now(), deadlineAt: Date.now() + 60_000 };
      await writeFile(join(paths.bridgeDir, 'requests', `${id}.json`), JSON.stringify(request));
      await writeFile(join(paths.bridgeDir, 'receipts', `${id}.json`), JSON.stringify({ id, operation, request }));
      let result: unknown;
      if (operation === 'capabilities') result = { operations: { import_photo: true, selected: true, read_state: true }, lightroomVersion: 'fixture',
        importDiagnostics: { directory: join(paths.bridgeDir, 'diagnostics', 'import-photo'), enabled: true, immutable: true, maxReadbacks: 64 } };
      else if (operation === 'selected') result = { count: 1, photos: [{ ...photo(), ...(staged && faults.wrongSelection ? { isVirtualCopy: true } : {}) }] };
      else if (operation === 'read_state') {
        assert.equal(params.photoId, photo().photoId);
        const number = staged ? ++reads : 0;
        result = nativeState(number > 0 && number >= (faults.driftRead ?? Infinity) && (!faults.returnToBaseline || number === faults.driftRead));
        if (number === 2 && faults.alterTraceAfterCopy) await writeFile(firstTrace!, '{}');
      } else if (operation === 'import_photo') {
        staged = String(params.path); assert.equal(params.filename, 'one.CR3');
        assert.match(staged, /\/uploads\/[a-f0-9-]{36}\/one.CR3$/);
        assert.equal(await readFile(staged, 'utf8'), 'original RAW bytes');
        assert.equal(await readFile(join(staged, '..', 'one.xmp'), 'utf8'), '<xmp>photographer edit</xmp>');
        result = photo();
        if (!faults.noTraces) {
          const dir = join(paths.bridgeDir, 'diagnostics', 'import-photo', id); await mkdir(dir, { recursive: true });
          const phases = faults.importError ? ['before-selection', 'after-selection-request']
            : faults.intermediateTraceDrift ? ['before-selection', 'after-selection-request', 'completion-guard'] : ['before-selection', 'completion-guard'];
          for (const [index, phase] of phases.entries()) {
            const file = join(dir, `${String(index + 1).padStart(4, '0')}.json`); firstTrace ??= file;
            await writeFile(file, JSON.stringify({ operation: 'import_photo', requestId: id,
              requestIssuedAt: request.issuedAt, requestDeadlineAt: request.deadlineAt, sequence: index + 1, phase, capturedAt: Date.now(),
              photo: photo(), photoId: photo().photoId, module: 'develop', selectedPhotoIds: [photo().photoId], state: nativeState(faults.intermediateTraceDrift && index === 1),
              baselineStateToken: 'baseline', guardStateToken: 'baseline', changesFromPrevious: [], changesFromBaseline: [] }));
          }
        }
        if (faults.mutateSidecar) await writeFile(join(staged, '..', 'one.xmp'), 'changed sidecar');
        if (faults.mutateSource) await writeFile(join(source, 'one.CR3'), 'changed source');
        if (faults.replaceLock) await writeFile(join(paths.runtime, 'session.lock'), '{"owner":"somebody-else"}');
        if (faults.importError) {
          if (faults.importError !== 'BRIDGE_TIMEOUT') await writeFile(join(paths.bridgeDir, 'responses', `${id}.json`), JSON.stringify({ protocolVersion: 1, id, ok: false,
            error: { code: faults.importError, message: 'Import native state changed.', outcomeUncertain: true } }));
          throw new BridgeError(faults.importError, 'Import native state changed.', { requestId: id, operation, outcomeUncertain: true });
        }
      } else throw new Error(`Unexpected diagnostic operation ${operation}`);
      await writeFile(join(paths.bridgeDir, 'responses', `${id}.json`), JSON.stringify({ protocolVersion: 1, id, ok: true, result }));
      await heartbeat(); return result as T;
    }
  }
  const bridge = new NativePeer(paths.bridgeDir);
  const run = () => runImportDiagnostic({ root, corpus, assetId: corpus.assets[0]!.id, environmentNotes: 'Offline mock; no Lightroom.', bridge, clock });
  return { root, paths, source, corpus, bridge, clock, operations, delays, run };
}

test('import diagnostic makes one fresh RAW/XMP import and binds fixed followups to native guards', async t => {
  const f = await fixture(t); const { report, path } = await f.run();
  assert.equal(report.status, 'complete', report.error ?? 'Expected completion'); assert.equal(report.lockRetained, false);
  assert.equal(existsSync(join(f.paths.runtime, 'session.lock')), false);
  assert.equal(report.preflight?.state?.photoId, 'existing'); assert.equal(report.sourceUnchanged, true); assert.equal(report.stagedUnchanged, true);
  assert.deepEqual(report.observations.map(read => [read.offsetMs, read.elapsedMs]), [[0, 0], [1000, 1000], [3000, 3000]]);
  assert.deepEqual(f.delays, [0, 1000, 2000]);
  assert.equal(f.operations.filter(op => op === 'import_photo').length, 1);
  assert.ok(f.operations.every(op => ['capabilities', 'selected', 'read_state', 'import_photo'].includes(op)));
  assert.equal(report.calls.length, 10);
  for (const call of report.calls) {
    assert.match(call.requestId!, /^[a-f0-9-]{36}$/); assert.equal(call.files.length, 3);
    for (const file of call.files) assert.equal(await readFile(file.copy, 'utf8'), await readFile(file.source, 'utf8'));
  }
  for (const observation of report.observations) assert.deepEqual(observation.comparisons?.map(value => [value.baseline, value.exactToken, value.differences]),
    [['before-selection', true, []], ['completion-guard', true, []]]);
  assert.equal(report.traces.length, 2); assert.equal(JSON.parse(await readFile(path, 'utf8')).status, 'complete');
});

test('first-followup drift from the completion guard is retained even when later reads stabilize', async t => {
  const f = await fixture(t, { driftRead: 1, returnToBaseline: true }); const { report } = await f.run();
  assert.equal(report.status, 'interrupted'); assert.equal(report.lockRetained, true); assert.equal(report.observations.length, 3);
  assert.match(report.error!, /native import baseline/);
  assert.deepEqual(report.observations[0]!.comparisons![0]!.differences,
    [{ path: '/Look/Parameters/PointColors', beforePresent: false, afterPresent: true, after: {} }]);
  assert.equal(report.observations[2]!.comparisons![0]!.exactToken, true, 'later stability must not erase the earlier failed comparison');
});

test('terminal import failure records bounded read-only evidence but never retries or releases its lock', async t => {
  const f = await fixture(t, { importError: 'STALE_STATE' }); const { report } = await f.run();
  assert.equal(report.import?.status, 'failed'); assert.equal(report.import?.error?.code, 'STALE_STATE');
  assert.equal(report.traces.length, 2); assert.equal(report.observations.length, 3); assert.equal(report.lockRetained, true);
  assert.equal(f.operations.filter(op => op === 'import_photo').length, 1);
  assert.ok(report.observations.every(read => read.comparisons?.[0]?.baseline === 'before-selection'));
});

test('intermediate trace drift and subsequent evidence replacement cannot be hidden by stable followups', async t => {
  for (const faults of [{ intermediateTraceDrift: true }, { alterTraceAfterCopy: true }]) {
    const f = await fixture(t, faults); const { report } = await f.run();
    assert.equal(report.status, 'interrupted'); assert.equal(report.lockRetained, true);
    assert.match(report.error!, /trace records settings drift|native evidence changed/);
    assert.equal(report.observations.length, 3);
  }
});

test('an unanswered import blocks all followup native calls even when its heartbeat says idle', async t => {
  const f = await fixture(t, { importError: 'BRIDGE_TIMEOUT' }); const { report } = await f.run();
  assert.equal(report.lockRetained, true); assert.equal(report.status, 'interrupted');
  assert.deepEqual(f.operations, ['capabilities', 'selected', 'read_state', 'import_photo']);
  assert.match(report.observations[0]!.error!, /not confirmed idle/);
});

test('wrong selection and missing native baselines cannot become diagnostic successes', async t => {
  for (const faults of [{ wrongSelection: true }, { noTraces: true }]) {
    const f = await fixture(t, faults); const { report } = await f.run();
    assert.equal(report.status, 'interrupted'); assert.equal(report.lockRetained, true);
    assert.equal(f.operations.filter(op => op === 'import_photo').length, 1);
    assert.equal(f.operations.filter(op => op === 'read_state').length, 1, 'never read an unrelated photo or accept an untraced baseline');
  }
});

test('post-import RAW/XMP provenance failures retain the diagnostic lock', async t => {
  for (const faults of [{ mutateSidecar: true }, { mutateSource: true }]) {
    const f = await fixture(t, faults); const { report } = await f.run();
    assert.equal(report.status, 'interrupted'); assert.equal(report.lockRetained, true); assert.match(report.error!, /changed during diagnosis/);
  }
});

test('existing and replaced session locks are never deleted', async t => {
  const blocked = await fixture(t); await writeFile(join(blocked.paths.runtime, 'session.lock'), '{"owner":"existing"}');
  await assert.rejects(blocked.run(), /Another editing session/); assert.deepEqual(blocked.operations, []);
  assert.equal(await readFile(join(blocked.paths.runtime, 'session.lock'), 'utf8'), '{"owner":"existing"}');
  const replaced = await fixture(t, { replaceLock: true }); const { report } = await replaced.run();
  assert.equal(report.lockRetained, true); assert.equal(report.status, 'interrupted');
  assert.equal(await readFile(join(replaced.paths.runtime, 'session.lock'), 'utf8'), '{"owner":"somebody-else"}');
  assert.deepEqual(replaced.operations, ['capabilities', 'selected', 'read_state', 'import_photo']);
});

test('pending preflight work blocks import and missing inputs fail before native calls', async t => {
  const f = await fixture(t); const id = randomUUID();
  await writeFile(join(f.paths.bridgeDir, 'requests', `${id}.json`), JSON.stringify({ protocolVersion: 1, id, operation: 'apply', params: {} }));
  const { report } = await f.run(); assert.equal(report.status, 'interrupted'); assert.equal(report.lockRetained, false); assert.deepEqual(f.operations, []);
  await assert.rejects(runImportDiagnostic({ root: f.root, corpus: f.corpus, assetId: '', environmentNotes: 'test', bridge: f.bridge }), /exactly one explicit/);
  await assert.rejects(runImportDiagnostic({ root: f.root, corpus: f.corpus, assetId: f.corpus.assets[0]!.id, environmentNotes: '', bridge: f.bridge }), /environment-notes/);
});

test('settings diffs preserve absence, null, empty objects, arrays, values and escaped paths', () => {
  assert.deepEqual(diffNativeSettings({ a: {}, b: [], c: 0, 'x/y~': null }, { a: [], b: {}, c: 0.01, absent: {} }), [
    { path: '/a', beforePresent: true, afterPresent: true, before: {}, after: [] },
    { path: '/absent', beforePresent: false, afterPresent: true, after: {} },
    { path: '/b', beforePresent: true, afterPresent: true, before: [], after: {} },
    { path: '/c', beforePresent: true, afterPresent: true, before: 0, after: 0.01 },
    { path: '/x~1y~0', beforePresent: true, afterPresent: false, before: null },
  ]);
});
