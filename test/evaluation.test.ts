import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { hashFile, indexCorpus, scanCorpus, stageAsset } from '../src/evaluation/corpus.ts';
import { acquireEvaluationLock, fixedAdjustments, runEvaluation, selectAssets } from '../src/evaluation/runner.ts';
import type { EvaluationBatch, EvaluationAgent } from '../src/evaluation/runner.ts';
import { buildReview, recordVote, summarizeReview } from '../src/evaluation/review.ts';
import type { BridgeClient } from '../src/controller.ts';
import type { Decision, DecisionInput } from '../src/agent/core.ts';

async function corpusFixture() {
  const root = await mkdtemp(join(tmpdir(), 'rpa-evaluation-')); const source = join(root, 'RAW'); await mkdir(source);
  await writeFile(join(source, 'one.CR3'), 'raw sample one'); await writeFile(join(source, 'one.xmp'), '<xmp>original edit</xmp>');
  await writeFile(join(source, 'two.CR3'), 'raw sample two'); await writeFile(join(source, 'reference.JPG'), 'reference only');
  return { root, source, corpus: await scanCorpus(source), close: () => rm(root, { recursive: true, force: true }) };
}
test('corpus hashing is stable, inventories reference JPEGs, and detects sidecar changes without changing RAW identity', async () => {
  const f = await corpusFixture();
  try {
    const root = join(f.root, '.runtime', 'evaluation');
    const first = await indexCorpus(f.source, root); const again = await indexCorpus(f.source, root);
    assert.equal(first.unchanged, false); assert.equal(again.unchanged, true); assert.equal(first.path, again.path);
    assert.equal(first.corpus.assets.length, 2); assert.deepEqual(first.corpus.otherFiles.map(file => file.path), ['reference.JPG']);
    await writeFile(join(f.source, 'one.xmp'), '<xmp>changed edit</xmp>');
    const changed = await indexCorpus(f.source, root); assert.equal(changed.unchanged, false);
    assert.notEqual(changed.corpus.fingerprint, first.corpus.fingerprint); assert.equal(changed.corpus.assets[0]!.id, first.corpus.assets[0]!.id);
    assert.equal((await readdir(join(root, 'corpora'))).length, 2);
    assert.deepEqual(JSON.parse(await readFile(first.path, 'utf8')), first.corpus);
    await assert.rejects(indexCorpus(f.source, join(f.source, 'output')), /outside/);
  } finally { await f.close(); }
});
test('staging verifies fresh RAW and XMP copies, never writes source files, and rejects changed sources and unsafe paths', async () => {
  const f = await corpusFixture();
  try {
    const uploads = join(f.root, '.runtime', 'uploads'); const before = await scanCorpus(f.source);
    const staged = await stageAsset(f.corpus, f.corpus.assets[0]!, join(uploads, 'first', 'one'), uploads);
    assert.equal(await hashFile(staged.path), f.corpus.assets[0]!.raw.sha256); assert.equal(staged.sidecars.length, 1);
    assert.equal(await readFile(staged.sidecars[0]!, 'utf8'), '<xmp>original edit</xmp>');
    await writeFile(staged.sidecars[0]!, 'changed copied sidecar'); assert.equal((await scanCorpus(f.source)).fingerprint, before.fingerprint);
    await assert.rejects(stageAsset(f.corpus, f.corpus.assets[0]!, join(uploads, 'first', 'one'), uploads), /EEXIST/);
    await assert.rejects(stageAsset(f.corpus, f.corpus.assets[0]!, join(f.source, 'copy'), uploads), /allowed upload/);
    await writeFile(join(f.source, 'one.CR3'), 'modified original externally');
    await assert.rejects(stageAsset(f.corpus, f.corpus.assets[0]!, join(uploads, 'second'), uploads), /Corpus changed/);
  } finally { await f.close(); }
});
test('corpus symlinks and ambiguous XMP matches are rejected', async () => {
  const f = await corpusFixture();
  try { await symlink(join(f.source, 'one.CR3'), join(f.source, 'linked.CR3')); await assert.rejects(scanCorpus(f.source), /symlinks/); }
  finally { await f.close(); }
});
test('native selection requires explicit bounded assets and fixed comparator is a documented clamped delta', async () => {
  const f = await corpusFixture();
  try {
    assert.throws(() => selectAssets(f.corpus, {}), /explicit/); assert.throws(() => selectAssets(f.corpus, { limit: 0 }), /1 to 10/);
    assert.throws(() => selectAssets(f.corpus, { ids: ['missing'] }), /Unknown asset/); assert.equal(selectAssets(f.corpus, { limit: 1 }).length, 1);
    assert.deepEqual(fixedAdjustments({ Highlights2012: -95, Shadows2012: 90, Vibrance: 0 }), { Highlights2012: -100, Shadows2012: 100, Vibrance: 5 });
    assert.throws(() => fixedAdjustments({}), /numeric/);
  } finally { await f.close(); }
});
test('evaluation refuses existing Lightroom ownership and preserves interrupted or externally replaced locks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rpa-eval-lock-'));
  try {
    const release = acquireEvaluationLock(root, { batchId: 'test' }); assert.throws(() => acquireEvaluationLock(root, {}), /Another editing session/);
    release(true); assert.ok(existsSync(join(root, 'session.lock'))); await rm(join(root, 'session.lock'));
    const replacement = acquireEvaluationLock(root, {}); await writeFile(join(root, 'session.lock'), '{"owner":"another"}'); replacement(false);
    assert.equal(JSON.parse(await readFile(join(root, 'session.lock'), 'utf8')).owner, 'another');
  } finally { await rm(root, { recursive: true, force: true }); }
});
function decision(input: DecisionInput, overrides: Partial<Decision> = {}): Decision {
  return { action: 'finish', title: 'Ready', observation: 'The visible photograph is balanced.', reason: 'Keep this checkpoint.',
    candidateId: input.currentCandidateId, maskId: null, adjustments: {}, question: null, options: [], detailPoints: [], ...overrides } as Decision;
}
function fakeBridge(options: { uncertainApply?: boolean } = {}) {
  const photos = new Map<string, { id: string; path: string; settings: Record<string, number>; copy: boolean }>();
  const imports = new Map<string, string>(); const snapshots = new Map<string, Record<string, number>>();
  const operations: string[] = []; let selected = '';
  const state = () => ({ photoId: selected, settings: { ...photos.get(selected)!.settings }, stateToken: JSON.stringify([selected, photos.get(selected)!.settings]) });
  const bridge: BridgeClient = { async call<T>(operation: string, params: Record<string, unknown> = {}): Promise<T> {
    operations.push(operation); let result: unknown;
    if (operation === 'import_photo') {
      const path = String(params.path);
      assert.match(path, /\/uploads\/[a-f0-9-]{36}\/[^/]+$/);
      if (!imports.has(path)) { const id = `source-${imports.size}`; imports.set(path, id); photos.set(id, { id, path, copy: false, settings: { Exposure2012: 0, Highlights2012: 0, Shadows2012: 0, Vibrance: 0 } }); }
      selected = imports.get(path)!; result = { photoId: selected, name: basename(path), path, fileFormat: 'RAW', isVirtualCopy: false };
    } else if (operation === 'selected') {
      const photo = photos.get(selected)!; result = { count: 1, photos: [{ photoId: selected, name: basename(photo.path), path: photo.path, fileFormat: 'RAW', isVirtualCopy: photo.copy }] };
    } else if (operation === 'read_state') { assert.equal(params.photoId, selected); result = state(); }
    else if (operation === 'create_working_copy') {
      const photo = photos.get(selected)!; selected = `copy-${photos.size}`; photos.set(selected, { ...photo, id: selected, copy: true, settings: { ...photo.settings } }); result = { photoId: selected };
    } else if (operation === 'checkpoint') {
      const id = `snapshot-${snapshots.size}`; snapshots.set(id, { ...photos.get(selected)!.settings }); result = { snapshotId: id, state: state() };
    } else if (operation === 'apply') {
      if (options.uncertainApply) throw Object.assign(new Error('Native outcome uncertain'), { outcomeUncertain: true });
      Object.assign(photos.get(selected)!.settings, params.adjustments); result = { state: state() };
    } else if (operation === 'render') {
      assert.match(String(params.outputPath), /\/renders\/[^/]+\.jpg$/);
      const value = 100 + Math.round(photos.get(selected)!.settings.Exposure2012! * 20);
      await sharp({ create: { width: params.maxEdge === 8192 ? 120 : 60, height: params.maxEdge === 8192 ? 80 : 40, channels: 3, background: { r: value, g: value, b: value } } }).jpeg().toFile(String(params.outputPath));
      result = { outputPath: params.outputPath, photoId: selected, stateToken: state().stateToken };
    } else throw new Error(`Unexpected operation: ${operation}`);
    return result as T;
  } };
  return { bridge, operations, photos };
}
test('real runner flow serializes source copies and actual saved renders without touching demo state or recording preferences', async () => {
  const f = await corpusFixture(); const native = fakeBridge();
  try {
    const demo = join(f.root, '.runtime', 'demo'); await mkdir(demo, { recursive: true }); await writeFile(join(demo, 'session.json'), 'main demo session');
    const result = await runEvaluation({ root: f.root, corpus: f.corpus, limit: 2, maxEdits: 1, bridge: native.bridge,
      agent: { async decide(input) { return decision(input, input.remainingEdits ? { action: 'edit', adjustments: { Exposure2012: 0.1 } } : {}); } } });
    assert.equal(result.batch.status, 'complete'); assert.equal(result.batch.cases.length, 2);
    for (const item of result.batch.cases) { assert.equal(item.status, 'complete'); assert.deepEqual(item.renders.map(render => render.role), ['fixed', 'starting', 'agent']); assert.equal(item.decisions.length, 2); }
    assert.equal(await readFile(join(demo, 'session.json'), 'utf8'), 'main demo session');
    assert.equal((await scanCorpus(f.source)).fingerprint, f.corpus.fingerprint);
    assert.equal(existsSync(join(f.root, '.runtime', 'session.lock')), false);
    assert.equal(native.operations.filter(operation => operation === 'import_photo').length, 4);
    for (const photo of native.photos.values()) if (!photo.copy) assert.deepEqual(photo.settings, { Exposure2012: 0, Highlights2012: 0, Shadows2012: 0, Vibrance: 0 });
    assert.ok(!native.operations.includes('choose')); assert.equal(result.batch.modelUsage, null);
  } finally { await f.close(); }
});
test('uncertain native evaluation failure stops the batch, retains lock and never retries', async () => {
  const f = await corpusFixture(); const native = fakeBridge({ uncertainApply: true }); let modelCalls = 0;
  try {
    const result = await runEvaluation({ root: f.root, corpus: f.corpus, limit: 2, bridge: native.bridge, agent: { async decide(input) { modelCalls++; return decision(input); } } });
    assert.equal(result.batch.status, 'interrupted'); assert.equal(result.batch.cases[0]!.status, 'interrupted'); assert.equal(result.batch.cases[1]!.status, 'pending');
    assert.equal(native.operations.filter(operation => operation === 'apply').length, 1); assert.equal(modelCalls, 0);
    assert.ok(existsSync(join(f.root, '.runtime', 'session.lock')));
    await assert.rejects(runEvaluation({ root: f.root, corpus: f.corpus, limit: 1, bridge: native.bridge, agent: { async decide(input) { return decision(input); } } }), /Another editing session/);
  } finally { await f.close(); }
});
test('creative questions remain unanswered and incomplete; no agent result or vote is invented', async () => {
  const f = await corpusFixture(); const native = fakeBridge();
  try {
    const result = await runEvaluation({ root: f.root, corpus: f.corpus, limit: 1, bridge: native.bridge, agent: { async decide(input) {
      return decision(input, { action: 'ask', candidateId: null, question: 'Warm or neutral?', options: ['Warm', 'Neutral'] });
    } } });
    assert.equal(result.batch.cases[0]!.status, 'needs_answer'); assert.equal(result.batch.cases[0]!.renders.some(render => render.role === 'agent'), false);
    assert.ok(existsSync(join(f.root, '.runtime', 'session.lock')));
    await assert.rejects(buildReview(result.batch, join(f.root, 'incomplete-review'), 'secret'), /No complete cases/);
  } finally { await f.close(); }
});
test('blinded packages use opaque deterministic orders, strip identity metadata and record immutable real answers separately', async () => {
  const f = await corpusFixture(); const native = fakeBridge();
  try {
    const result = await runEvaluation({ root: f.root, corpus: f.corpus, limit: 1, bridge: native.bridge, agent: { async decide(input) { return decision(input); } } });
    const a = await buildReview(result.batch, join(f.root, 'review-a'), 'private deterministic seed');
    const b = await buildReview(result.batch, join(f.root, 'review-b'), 'private deterministic seed');
    const publicText = await readFile(join(a.directory, 'review', 'cases.json'), 'utf8');
    const html = await readFile(a.page, 'utf8'); const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
    const tricky = "O'Brien $(not-a-command) `still literal`";
    const quoted = runInNewContext(`${script}; quote(${JSON.stringify(tricky)})`, { document: { querySelectorAll: () => [], addEventListener: () => {} } });
    assert.equal(quoted, "'O'\\''Brien $(not-a-command) `still literal`'");
    assert.equal(publicText, await readFile(join(b.directory, 'review', 'cases.json'), 'utf8'));
    for (const secret of [f.source, f.corpus.assets[0]!.name, 'starting', 'fixed', 'agent', 'private deterministic seed']) assert.ok(!publicText.includes(secret));
    assert.equal(existsSync(join(a.directory, 'votes')), false);
    const item = JSON.parse(publicText).cases[0]; const candidate = item.candidates[0];
    const privateData = JSON.parse(await readFile(join(a.directory, 'private.json'), 'utf8'));
    const image = join(a.directory, 'review', candidate.image); const original = privateData.cases[0].mapping[candidate.id].path;
    assert.deepEqual(await sharp(image).raw().toBuffer(), await sharp(original).raw().toBuffer());
    const metadata = await sharp(image).metadata(); assert.equal(metadata.exif, undefined); assert.equal(metadata.xmp, undefined);
    const input = { caseId: item.id, candidateId: candidate.id, reviewer: 'Photographer', notes: 'Preferred for visible light.' };
    const vote = await recordVote(a.directory, input); assert.deepEqual(await recordVote(a.directory, input), vote);
    await assert.rejects(recordVote(a.directory, { ...input, candidateId: 'tie' }), /immutable/);
    await assert.rejects(recordVote(a.directory, { ...input, caseId: '../unrelated' }), /Unknown/);
    assert.equal((await recordVote(a.directory, { ...input, reviewer: 'Second reviewer', candidateId: 'tie' })).candidateId, 'tie');
    assert.equal((await readdir(join(a.directory, 'votes'))).length, 2);
  } finally { await f.close(); }
});
test('review refuses changed or missing rendered evidence', async () => {
  const f = await corpusFixture(); const native = fakeBridge();
  try {
    const result = await runEvaluation({ root: f.root, corpus: f.corpus, limit: 1, bridge: native.bridge, agent: { async decide(input) { return decision(input); } } });
    await writeFile(result.batch.cases[0]!.renders[0]!.path, 'changed');
    await assert.rejects(buildReview(result.batch, join(f.root, 'invalid-review')), /Saved render changed/);
  } finally { await f.close(); }
});
test('local review summary separates unmeasured preferences from actual mapped human votes and rejects invalid artifacts', async () => {
  const f = await corpusFixture(); const native = fakeBridge();
  try {
    const result = await runEvaluation({ root: f.root, corpus: f.corpus, limit: 1, bridge: native.bridge, agent: { async decide(input) { return decision(input); } } });
    result.batch.cases.push({ assetId: f.corpus.assets[1]!.id, name: f.corpus.assets[1]!.name, status: 'pending', renders: [], decisions: [], runIds: [] });
    const review = await buildReview(result.batch, join(f.root, 'summary-review'), 'summary-seed');
    const zero = await summarizeReview(review.directory);
    assert.equal(zero.completedCaseCount, 1); assert.equal(zero.excludedCaseCount, 1); assert.equal(zero.answeredCaseCount, 0);
    assert.equal(zero.actualHumanVotesCount, 0); assert.equal(zero.preferenceNotYetMeasured, true);
    assert.deepEqual(zero.votesByRole, { starting: 0, fixed: 0, agent: 0, tie: 0, none: 0 }); assert.deepEqual(zero.notes, []);
    const manifest = JSON.parse(await readFile(join(review.directory, 'private.json'), 'utf8')); const item = manifest.cases[0];
    for (const [index, candidateId] of [...item.candidates.map((candidate: { id: string }) => candidate.id), 'tie', 'none'].entries()) {
      await recordVote(review.directory, { caseId: item.id, candidateId, reviewer: `Reviewer ${index}`, notes: `Observation ${index}` });
    }
    const measured = await summarizeReview(review.directory);
    assert.equal(measured.actualHumanVotesCount, 5); assert.equal(measured.preferenceNotYetMeasured, false); assert.equal(measured.answeredCaseCount, 1);
    assert.deepEqual(measured.votesByRole, { starting: 1, fixed: 1, agent: 1, tie: 1, none: 1 });
    assert.deepEqual(measured.notes.map(vote => vote.notes).sort(), ['Observation 0', 'Observation 1', 'Observation 2', 'Observation 3', 'Observation 4']);
    const unknown = { caseId: item.id, candidateId: 'candidate-unknown', reviewer: 'Unknown candidate reviewer', notes: '', recordedAt: new Date().toISOString() };
    const unknownName = `${createHash('sha256').update(JSON.stringify([unknown.caseId, unknown.reviewer])).digest('hex')}.json`;
    const unknownPath = join(review.directory, 'votes', unknownName); await writeFile(unknownPath, JSON.stringify(unknown));
    await assert.rejects(summarizeReview(review.directory), /Unknown case or candidate/); await rm(unknownPath);
    const malformedPath = join(review.directory, 'votes', `${'a'.repeat(64)}.json`); await writeFile(malformedPath, '{malformed');
    await assert.rejects(summarizeReview(review.directory), /Malformed vote JSON/); await writeFile(malformedPath, '{}');
    await assert.rejects(summarizeReview(review.directory), /Malformed vote fields/);
  } finally { await f.close(); }
});
