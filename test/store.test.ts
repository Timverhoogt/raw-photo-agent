import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunStore } from '../src/store.ts';

function fixture(t: test.TestContext): { store: RunStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'raw-photo-store-'));
  const path = join(dir, 'private', 'runs.sqlite');
  const store = new RunStore(path);
  t.after(() => {
    try { store.close(); } catch { /* A reopen test closes its initial connection. */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, path };
}

const runInput = { id: 'run-a', sourcePhotoId: 'raw-1', workingPhotoId: 'copy-1', intent: 'Natural wildlife' };
const candidateInput = { id: 'candidate-a', runId: 'run-a', snapshotId: 'native-1', stateToken: 'state-1', settings: { exposure: 0.2 } };

test('candidate graph rejects a parent from another run without leaving a partial candidate', (t) => {
  const { store } = fixture(t);
  store.createRun(runInput);
  store.createRun({ ...runInput, id: 'run-b', workingPhotoId: 'copy-2' });
  const parent = store.addCandidate(candidateInput);
  assert.throws(() => store.addCandidate({ ...candidateInput, id: 'bad', runId: 'run-b', parentId: parent.id }), /another run/);
  assert.equal(store.getCandidate('bad'), null);
  assert.deepEqual(store.listCandidates('run-b'), []);
  assert.throws(() => store.addCandidate({ ...candidateInput, id: 'missing', parentId: 'absent' }), /not found/);
  const child = store.addCandidate({ ...candidateInput, id: 'child', parentId: parent.id, stateToken: 'state-2' });
  assert.equal(child.parentId, parent.id);
  assert.equal(store.listCandidates('run-a').length, 2);
});

test('a choice only accepts listed candidates in its run and a decided choice is immutable', (t) => {
  const { store } = fixture(t);
  store.createRun(runInput);
  store.createRun({ ...runInput, id: 'run-b' });
  store.addCandidate(candidateInput);
  store.addCandidate({ ...candidateInput, id: 'candidate-b' });
  store.addCandidate({ ...candidateInput, id: 'unlisted' });
  store.addCandidate({ ...candidateInput, id: 'foreign', runId: 'run-b' });
  const choice = store.createChoice({ id: 'choice-a', runId: 'run-a', candidateIds: ['candidate-a', 'candidate-b'], question: 'Which treatment?' });
  const pausedRun = store.getRun('run-a');
  assert.equal(pausedRun?.status, 'awaiting_choice');
  for (const badId of ['foreign', 'unlisted', 'missing']) {
    assert.throws(() => store.choose(choice.id, badId), /listed in the choice/);
    assert.deepEqual(store.getRun('run-a'), pausedRun);
    assert.deepEqual(store.getChoice(choice.id), choice);
  }
  const selected = store.choose(choice.id, 'candidate-a', 'Keep the environment');
  assert.equal(selected.selectedCandidateId, 'candidate-a');
  assert.equal(selected.feedback, 'Keep the environment');
  assert.ok(selected.chosenAt);
  assert.equal(store.getRun('run-a')?.status, 'active');
  assert.throws(() => store.choose(choice.id, 'candidate-b'), /immutable/);
  assert.throws(() => store.choose(choice.id, 'candidate-a', 'Changed feedback'), /immutable/);
  assert.deepEqual(store.getChoice(choice.id), selected);
  store.setRunStatus('run-a', 'completed');
  assert.deepEqual(store.choose(choice.id, 'candidate-a', 'Keep the environment'), selected);
  assert.equal(store.getRun('run-a')?.status, 'completed', 'retry must not reactivate a completed run');
});

test('choice construction is atomic and does not reactivate a run on retry', (t) => {
  const { store } = fixture(t);
  store.createRun(runInput);
  store.createRun({ ...runInput, id: 'run-b' });
  store.addCandidate(candidateInput);
  store.addCandidate({ ...candidateInput, id: 'foreign', runId: 'run-b' });
  assert.throws(() => store.createChoice({ runId: 'run-a', candidateIds: ['candidate-a', 'foreign'], question: 'Bad comparison' }), /another run/);
  assert.deepEqual(store.listChoices('run-a'), []);
  assert.equal(store.getRun('run-a')?.status, 'active');
  const input = { id: 'choice-a', runId: 'run-a', candidateIds: ['candidate-a'], question: 'Keep this?' };
  store.createChoice(input);
  const choice = store.choose('choice-a', 'candidate-a');
  assert.deepEqual(store.createChoice(input), choice);
  assert.equal(store.getRun('run-a')?.status, 'active');
});

test('run, branch, preview, events and pending choice survive database reopen', (t) => {
  const { store, path } = fixture(t);
  const run = store.createRun({ ...runInput, baselineSnapshotId: 'baseline', baselineStateToken: 'baseline-state' });
  const candidate = store.addCandidate({ ...candidateInput, settings: { masks: [{ id: 'subject', exposure: 0.25 }] } });
  store.setCandidatePreview(candidate.id, '/previews/candidate-a.jpg');
  store.addEvent(run.id, 'checkpoint_saved', { candidateId: candidate.id, verified: true });
  const choice = store.createChoice({ runId: run.id, candidateIds: [candidate.id], question: 'Finish this version?' });
  const before = { run: store.getRun(run.id), candidate: store.getCandidate(candidate.id), events: store.listEvents(run.id) };
  store.close();
  const reopened = new RunStore(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.listRuns(), [before.run]);
  assert.deepEqual(reopened.getCandidate(candidate.id), before.candidate);
  assert.deepEqual(reopened.listEvents(run.id), before.events);
  assert.deepEqual(reopened.getChoice(choice.id), choice);
  assert.equal(reopened.getRun(run.id)?.status, 'awaiting_choice');
  assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('duplicate IDs are idempotent only for matching immutable content', (t) => {
  const { store } = fixture(t);
  store.createRun(runInput);
  store.setRunStatus(runInput.id, 'interrupted');
  const before = store.getRun(runInput.id);
  assert.deepEqual(store.createRun(runInput), before);
  assert.throws(() => store.createRun({ ...runInput, intent: 'Different intent' }), /different content/);
  const input = { ...candidateInput, settings: { exposure: 0.2, contrast: 5 } };
  const candidate = store.addCandidate(input);
  assert.deepEqual(store.addCandidate({ ...input, settings: { contrast: 5, exposure: 0.2 } }), candidate);
  store.setCandidatePreview(candidate.id, '/previews/one.jpg');
  const rendered = store.getCandidate(candidate.id);
  assert.deepEqual(store.addCandidate(input), rendered, 'retry must not erase a subsequently recorded render');
  assert.throws(() => store.addCandidate({ ...input, stateToken: 'new-state' }), /different content/);
  assert.throws(() => store.addCandidate({ ...input, settings: { exposure: 0.3 } }), /different content/);
  assert.throws(() => store.setCandidatePreview(candidate.id, '/previews/two.jpg'), /already recorded/);
  store.setCandidatePreview(candidate.id, '/previews/one.jpg');
  assert.deepEqual(store.getCandidate(candidate.id), rendered);
  const choiceInput = { id: 'choice-a', runId: runInput.id, candidateIds: [candidate.id], question: 'Keep?' };
  store.createChoice(choiceInput);
  assert.throws(() => store.createChoice({ ...choiceInput, question: 'Something else?' }), /different content/);
  assert.equal(store.listChoices(runInput.id).length, 1);
});

test('choosing one comparison never silently resolves another pending comparison', (t) => {
  const { store } = fixture(t);
  store.createRun(runInput);
  store.addCandidate(candidateInput);
  for (const id of ['first', 'second']) store.createChoice({ id, runId: 'run-a', candidateIds: ['candidate-a'], question: 'Keep?' });
  store.choose('first', 'candidate-a');
  assert.equal(store.getRun('run-a')?.status, 'awaiting_choice');
  store.choose('second', 'candidate-a');
  assert.equal(store.getRun('run-a')?.status, 'active');
});

test('invalid references and unusable checkpoint identities fail explicitly', (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.addCandidate(candidateInput), /Run not found/);
  assert.throws(() => store.setRunStatus('missing', 'active'), /Run not found/);
  assert.throws(() => store.addEvent('missing', 'event', {}), /Run not found/);
  store.createRun(runInput);
  assert.throws(() => store.addCandidate({ ...candidateInput, snapshotId: '' }), /snapshotId/);
  assert.throws(() => store.addCandidate({ ...candidateInput, stateToken: ' ' }), /stateToken/);
  assert.throws(() => store.addCandidate({ ...candidateInput, settings: 1n }), /JSON serializable/);
  assert.throws(() => store.setCandidatePreview('missing', '/preview.jpg'), /Candidate not found/);
  assert.throws(() => store.choose('missing', 'candidate-a'), /Choice not found/);
  assert.throws(() => store.createChoice({ runId: 'run-a', candidateIds: [], question: 'Keep?' }), /at least one/);
  assert.throws(() => store.createChoice({ runId: 'run-a', candidateIds: ['a', 'a'], question: 'Keep?' }), /unique/);
  assert.equal(store.getRun('missing'), null);
  assert.equal(store.getCandidate('missing'), null);
  assert.equal(store.getChoice('missing'), null);
});

test('working-copy attachment replaces only a pending identity and survives reopen', (t) => {
  const { store, path } = fixture(t);
  store.createRun({ ...runInput, workingPhotoId: `pending:${runInput.id}` });
  store.setRunStatus(runInput.id, 'interrupted');
  store.addEvent(runInput.id, 'copy_creation_uncertain', { requestId: 'request-1' });
  const attached = store.attachWorkingCopy(runInput.id, 'copy-found-in-lightroom');
  assert.equal(attached.workingPhotoId, 'copy-found-in-lightroom');
  assert.equal(attached.status, 'interrupted', 'identity reconciliation alone must not resume the run');
  assert.deepEqual(store.attachWorkingCopy(runInput.id, 'copy-found-in-lightroom'), attached);
  assert.throws(() => store.attachWorkingCopy(runInput.id, 'another-copy'), /already assigned/);
  store.addCandidate(candidateInput);
  assert.deepEqual(store.attachWorkingCopy(runInput.id, 'copy-found-in-lightroom'), attached, 'an identical retry works after later checkpoints');
  store.close();
  const reopened = new RunStore(path);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getRun(runInput.id), attached);
  assert.equal(reopened.listEvents(runInput.id).length, 1);
});

test('working-copy attachment rejects the wrong pending marker or an existing candidate graph', (t) => {
  const { store } = fixture(t);
  const run = store.createRun({ ...runInput, workingPhotoId: 'pending:another-run' });
  assert.throws(() => store.attachWorkingCopy(run.id, 'copy-1'), /already assigned/);
  assert.deepEqual(store.getRun(run.id), run);
  const pending = store.createRun({ ...runInput, id: 'run-b', workingPhotoId: 'pending:run-b' });
  store.addCandidate({ ...candidateInput, runId: pending.id });
  assert.throws(() => store.attachWorkingCopy(pending.id, 'copy-2'), /candidates have been recorded/);
  assert.deepEqual(store.getRun(pending.id), pending);
  assert.throws(() => store.attachWorkingCopy('missing', 'copy-1'), /Run not found/);
  assert.throws(() => store.attachWorkingCopy(run.id, ''), /photoId/);
});

test('baseline can only be assigned from a same-run checkpoint and cannot be replaced', (t) => {
  const { store } = fixture(t);
  const run = store.createRun(runInput);
  store.createRun({ ...runInput, id: 'run-b' });
  store.addCandidate(candidateInput);
  store.addCandidate({ ...candidateInput, id: 'foreign', runId: 'run-b' });
  assert.throws(() => store.setBaseline(run.id, 'foreign'), /another run/);
  assert.throws(() => store.setBaseline(run.id, 'missing'), /Candidate not found/);
  assert.deepEqual(store.getRun(run.id), run);
  const assigned = store.setBaseline(run.id, candidateInput.id);
  assert.equal(assigned.baselineSnapshotId, candidateInput.snapshotId);
  assert.equal(assigned.baselineStateToken, candidateInput.stateToken);
  assert.deepEqual(store.setBaseline(run.id, candidateInput.id), assigned);
  store.addCandidate({ ...candidateInput, id: 'new', snapshotId: 'another-snapshot', stateToken: 'another-state' });
  assert.throws(() => store.setBaseline(run.id, 'new'), /already assigned/);
  assert.deepEqual(store.getRun(run.id), assigned);
  assert.throws(() => store.setBaseline('missing', candidateInput.id), /Run not found/);
  const partial = store.createRun({ ...runInput, id: 'partial', baselineSnapshotId: 'native-1' });
  store.addCandidate({ ...candidateInput, id: 'partial-candidate', runId: partial.id });
  assert.throws(() => store.setBaseline(partial.id, 'partial-candidate'), /already assigned/);
  assert.deepEqual(store.getRun(partial.id), partial, 'do not rewrite partially existing baseline history');
});
