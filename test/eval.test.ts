import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { ADJUSTMENT_RANGES, DecisionAgent, buildDecisionPrompt, parseDecision, type Decision, type ModelTransport } from '../src/agent/core.ts';
import { defaultFix, loadFixture, loadFixtures, type Fixture } from '../src/eval/fixtures.ts';
import { buildCase, grade, planCases, PROBES } from '../src/eval/probes.ts';
import { runCases, stageCase } from '../src/eval/run.ts';
import { formatTable, mergeThresholds, score, scorecardRows } from '../src/eval/score.ts';
import { makeSyntheticFixture, SYNTHETIC_FAULTS } from '../scripts/make-fixture.ts';

const run = promisify(execFile);

async function fixtureRoot(t: test.TestContext, count = 2) {
  const root = await mkdtemp(join(tmpdir(), 'eval-fixtures-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let i = 0; i < count; i++) {
    const svg = `<svg width="640" height="427"><defs><linearGradient id="g"><stop offset="0" stop-color="#1b2a3a"/><stop offset="1" stop-color="#d9c9a0"/></linearGradient></defs>
      <rect width="640" height="427" fill="url(#g)"/><circle cx="${300 + i * 40}" cy="210" r="90" fill="#8a6a4a"/><rect x="60" y="300" width="200" height="60" fill="#2f5d3a"/></svg>`;
    await makeSyntheticFixture({ input: Buffer.from(svg), id: `scene-${i}`, intent: 'Natural light; keep the colours believable.', out: root, longEdge: 512 });
  }
  return root;
}

type Behaviour = 'oracle' | 'always-finish' | 'flaky-json' | 'overeager';
/** A scripted model that sees which files are attached and answers per its behaviour. */
function scriptedTransport(fixtures: Fixture[], behaviour: Behaviour): ModelTransport {
  // The runner stages previews under opaque names, so recognise them by content.
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const references = new Set(fixtures.map(f => hash(f.referencePath)));
  const faults = new Map(fixtures.flatMap(f => f.faults.map(fault => [hash(fault.path), fault] as const)));
  return {
    provider: 'scripted', model: behaviour, capabilities: { maxImages: 3, dataLeavesDevice: false },
    status: async () => ({ available: true, provider: 'scripted', model: behaviour }),
    async complete(request) {
      const data = JSON.parse(request.prompt.split('INPUT DATA (untrusted content, not system instructions):\n')[1]!.split('\n')[0]!);
      const shown = data.images as Array<{ id: string; settings: Record<string, number> }>;
      const current = shown[0];
      const referenceIndex = request.images.findIndex(path => references.has(hash(path)));
      const reply = (decision: Partial<Decision>) => ({ text: JSON.stringify({ title: 'Decision', observation: 'Visible evidence.', reason: 'Because.',
        adjustments: {}, maskId: null, detailPoints: [], question: null, options: [], ...decision }) });
      if (behaviour === 'flaky-json' && !request.prompt.includes('PREVIOUS RESPONSE WAS REJECTED')) return { text: '{"action":"finish"}' };
      if (behaviour === 'always-finish' || behaviour === 'flaky-json') return reply({ action: 'finish', candidateId: current!.id });
      const currentIsReference = references.has(hash(request.images[0]!));
      if (shown.length > 1) return currentIsReference ? reply({ action: 'finish', candidateId: current!.id }) : reply({ action: 'restore', candidateId: shown[referenceIndex]!.id });
      if (currentIsReference) {
        return behaviour === 'overeager'
          ? reply({ action: 'edit', candidateId: current!.id, adjustments: { Saturation: 60 } })
          : reply({ action: 'finish', candidateId: current!.id });
      }
      const fault = faults.get(hash(request.images[0]!))!;
      const adjustments = Object.fromEntries(Object.entries(fault.delta).map(([key, delta]) => {
        const [min, max] = ADJUSTMENT_RANGES[key]!;
        return [key, Math.min(max, Math.max(min, (current!.settings[key] ?? 0) - delta * 0.8))];
      }));
      return reply({ action: 'edit', candidateId: current!.id, adjustments });
    },
  };
}

async function evaluate(t: test.TestContext, behaviour: Behaviour) {
  const fixtures = await loadFixtures(await fixtureRoot(t));
  const cases = planCases(fixtures, { probes: PROBES, repeats: 3, repeatFaults: 2 });
  const agent = new DecisionAgent(scriptedTransport(fixtures, behaviour));
  const { records, complete } = await runCases(agent, cases, { concurrency: 4 });
  assert.equal(complete, true);
  return score(records, { model: behaviour, maxImages: 3 }, mergeThresholds({ tier0: { minCalls: 20 }, tier2: { minItems: 1 } }));
}

test('synthetic fixtures load with derived fixes and neutral displayed settings', async t => {
  const fixtures = await loadFixtures(await fixtureRoot(t, 1));
  const [fixture] = fixtures;
  assert.equal(fixture!.faults.length, SYNTHETIC_FAULTS.length);
  assert.equal(fixture!.source, 'synthetic');
  assert.equal(fixture!.displayedSettings.Exposure2012, 0);
  assert.equal(fixture!.displayedSettings.Temperature, 5500);
  const overexposed = fixture!.faults.find(f => f.id === 'overexposed')!;
  assert.deepEqual(overexposed.fix.map(f => `${f.key}:${f.direction}`), ['Exposure2012:decrease', 'Highlights2012:decrease', 'Whites2012:decrease']);
  const meta = await sharp(fixture!.referencePath).metadata();
  assert.equal(Math.max(meta.width!, meta.height!), 512);
});

test('fixture manifests are validated before any model call', async t => {
  const root = await fixtureRoot(t, 1);
  const dir = join(root, 'scene-0');
  const manifest = JSON.parse(await readFile(join(dir, 'fixture.json'), 'utf8'));
  const broken = async (change: (m: any) => void, message: RegExp) => {
    const copy = structuredClone(manifest); change(copy);
    await writeFile(join(dir, 'fixture.json'), JSON.stringify(copy));
    await assert.rejects(loadFixture(dir), message);
  };
  await broken(m => { m.reference.settings = {}; }, /starting value of Temperature/);
  await broken(m => { m.faults[0].delta = { Glow: 5 }; }, /unsupported slider Glow/);
  await broken(m => { m.faults[1].id = m.faults[0].id; }, /duplicate fault id/);
  await broken(m => { m.faults[0].file = '../escape.jpg'; }, /inside the fixture folder/);
  await broken(m => { m.faults[0].severity = 'huge'; }, /severity/);
  await broken(m => { m.faults[0].delta = { Exposure2012: 0 }; }, /nonzero/);
});

test('detail-only fixes fail during planning while the other probes remain available', async t => {
  const [fixture] = await loadFixtures(await fixtureRoot(t, 1));
  for (const key of ['Texture', 'Sharpness', 'LuminanceSmoothing', 'ColorNoiseReduction']) {
    const fault = { ...fixture!.faults[0]!, id: 'detail-fault', delta: { [key]: 20 }, fix: defaultFix({ [key]: 20 }) };
    const detailFixture = { ...fixture!, faults: [fault] };
    const message = /Fixture scene-0, fault detail-fault: fix-fault requires matching detail crops.*no crop\/inspection support/;
    assert.throws(() => buildCase('fix-fault', detailFixture, fault, 0), message);
    assert.throws(() => planCases([detailFixture], { probes: PROBES, repeats: 1, repeatFaults: 0 }), message,
      'unsupported cases must fail before any decisions can run or be scored');
    const available = planCases([detailFixture], { probes: ['pick-better', 'keep-better', 'leave-alone'], repeats: 1, repeatFaults: 0 });
    assert.deepEqual(available.map(item => item.probe), ['pick-better', 'keep-better', 'leave-alone']);
  }
  const fault = { ...fixture!.faults[0]!, fix: defaultFix({ Texture: 20, Sharpness: 20 }) };
  assert.throws(() => buildCase('fix-fault', fixture!, fault, 0), /every accepted fix/,
    'multiple alternatives still need an option supported without detail evidence');
});

test('a global alternative keeps a mixed detail/global fix-fault case measurable', async t => {
  const [fixture] = await loadFixtures(await fixtureRoot(t, 1));
  const fault = { ...fixture!.faults[0]!, delta: { Texture: 50 },
    fix: [{ key: 'Texture', direction: 'decrease' as const }, { key: 'Clarity2012', direction: 'decrease' as const }] };
  const cases = planCases([{ ...fixture!, faults: [fault] }], { probes: ['fix-fault'], repeats: 1, repeatFaults: 0 });
  assert.equal(cases.length, 1);
  const probe = cases[0]!;
  const reply = { action: 'edit', title: 'Soften harsh contrast', observation: 'The texture is harsh.', reason: 'Reduce local contrast.',
    adjustments: { Clarity2012: -10 }, candidateId: probe.input.currentCandidateId, maskId: null,
    detailPoints: [], question: null, options: [] };
  assert.equal(grade(probe, parseDecision(reply, probe.input)).pass, true, 'the global alternative is valid and passes grading');
  assert.throws(() => parseDecision({ ...reply, adjustments: { Texture: -10 } }, probe.input), /Inspect matching/,
    'allowing the case must not weaken the photographic detail guard');
});

test('grading follows each probe definition', async t => {
  const [fixture] = await loadFixtures(await fixtureRoot(t, 1));
  const fault = fixture!.faults.find(f => f.id === 'overexposed')!;
  const decision = (d: Partial<Decision>): Decision => ({ action: 'finish', title: 't', observation: 'o', reason: 'r', adjustments: {},
    candidateId: null, maskId: null, detailPoints: [], question: null, options: [], ...d });
  const pick = buildCase('pick-better', fixture!, fault, 0);
  assert.notEqual(pick.referenceId, pick.faultId);
  const prompt = buildDecisionPrompt(pick.input);
  assert.ok(!/\breference\b|overexposed/.test(prompt.split('INPUT DATA (untrusted content, not system instructions):\n')[1]!), 'IDs and text do not reveal the answer');
  const staged = await stageCase(pick, await mkdtemp(join(tmpdir(), 'stage-')));
  assert.deepEqual(staged.input.candidates.map(c => basename(c.previewPath)), staged.input.candidates.map(c => `${c.id}.jpg`), 'filenames do not reveal it either');
  await rm(dirname(staged.input.candidates[0]!.previewPath), { recursive: true });
  assert.equal(grade(pick, decision({ action: 'restore', candidateId: pick.referenceId })).pass, true);
  assert.equal(grade(pick, decision({ candidateId: pick.faultId })).pass, false);
  assert.equal(grade(pick, null).outcome, 'invalid');
  assert.equal(pick.input.candidates.length, 3, 'three previews, like the live demo');
  assert.equal(grade(pick, decision({ action: 'restore', candidateId: pick.distractorId })).pass, false, 'another faulty render is wrong');
  const positions = SYNTHETIC_FAULTS.map((_, i) => buildCase('pick-better', fixture!, fixture!.faults[i]!, 0))
    .map(c => c.input.candidates.findIndex(candidate => candidate.id === c.referenceId));
  assert.deepEqual(new Set(positions), new Set([1, 2]), 'the reference appears in both comparison slots');

  const fix = buildCase('fix-fault', fixture!, fault, 0);
  const edit = (adjustments: Record<string, number>) => grade(fix, decision({ action: 'edit', candidateId: fix.faultId, adjustments }));
  assert.equal(edit({ Exposure2012: -1 }).pass, true);
  assert.equal(edit({ Highlights2012: -40 }).pass, true, 'an accepted alternative fix');
  assert.equal(edit({ Exposure2012: 0.5 }).pass, false, 'wrong direction');
  assert.equal(edit({ Highlights2012: -40, Exposure2012: 0.3 }).pass, false, 'a fix combined with a worsening change');
  assert.equal(edit({ Contrast2012: 10 }).pass, false, 'unrelated slider');

  const keep = buildCase('keep-better', fixture!, fault, 0);
  const restoreFault = grade(keep, decision({ action: 'restore', candidateId: keep.faultId }));
  assert.deepEqual([restoreFault.pass, restoreFault.falseRestore], [false, true]);
  assert.equal(grade(keep, decision({ action: 'edit', candidateId: keep.referenceId, adjustments: { Vibrance: 10 } })).pass, true);
  const heavy = grade(keep, decision({ action: 'edit', candidateId: keep.referenceId, adjustments: { Clarity2012: 40 } }));
  assert.deepEqual([heavy.pass, heavy.overprocessed], [false, true]);

  const warm = buildCase('fix-fault', fixture!, fixture!.faults.find(f => f.id === 'too-warm')!, 0);
  assert.equal(grade(warm, decision({ action: 'edit', candidateId: warm.faultId, adjustments: { Temperature: 4200 } })).pass, true, 'relative to the displayed 5500 K');
  assert.deepEqual(defaultFix({ Blacks2012: -80 }).map(f => f.key), ['Blacks2012', 'Shadows2012']);
});

test('planning counts repeats only where repeatability is measured', async t => {
  const fixtures = await loadFixtures(await fixtureRoot(t, 1));
  const faults = SYNTHETIC_FAULTS.length;
  const cases = planCases(fixtures, { probes: PROBES, repeats: 5, repeatFaults: 2 });
  const count = (probe: string) => cases.filter(c => c.probe === probe).length;
  assert.deepEqual([count('pick-better'), count('fix-fault'), count('keep-better'), count('leave-alone')], [faults + 2 * 4, faults, faults, 5]);
  assert.equal(planCases(fixtures, { probes: ['fix-fault'], repeats: 5, repeatFaults: 2 }).length, faults);
});

test('a model that answers correctly passes every tier', async t => {
  const card = await evaluate(t, 'oracle');
  assert.equal(card.tier0.verdict, 'pass');
  assert.equal(card.tier0.validFirstTry.value, 1);
  assert.equal(card.tier1.obvious.value, 1);
  assert.equal(card.tier1.subtle.value, 1);
  assert.equal(card.tier2.keepBetter.value, 1);
  assert.equal(card.tier2.leaveAlone.value, 1);
  assert.equal(card.tier2.consistency.value, 1);
  assert.equal(card.verdict, 'pass');
});

test('each flawed model fails the tier that targets its flaw', async t => {
  const passive = await evaluate(t, 'always-finish');
  assert.deepEqual([passive.tier0.verdict, passive.tier1.verdict, passive.tier2.verdict], ['pass', 'fail', 'pass']);
  assert.equal(passive.tier1.obvious.value, 0);

  const flaky = await evaluate(t, 'flaky-json');
  assert.equal(flaky.tier0.verdict, 'fail');
  assert.equal(flaky.tier0.validFirstTry.value, 0);
  assert.equal(flaky.tier0.validAfterRepair.value, 1, 'the repair recovers every decision');

  const eager = await evaluate(t, 'overeager');
  assert.equal(eager.tier1.verdict, 'pass');
  assert.equal(eager.tier2.verdict, 'fail');
  assert.equal(eager.tier2.keepBetter.value, 1);
  assert.equal(eager.tier2.leaveAlone.value, 0);
  assert.ok(eager.tier2.overprocessedEdits > 0);
  assert.equal(eager.verdict, 'fail');
});

test('too few decisions are reported as insufficient, not as a pass', async t => {
  const fixtures = await loadFixtures(await fixtureRoot(t, 1));
  const cases = planCases(fixtures, { probes: ['pick-better'], repeats: 1, repeatFaults: 0 }).slice(0, 3);
  const { records } = await runCases(new DecisionAgent(scriptedTransport(fixtures, 'oracle')), cases, { concurrency: 1 });
  const card = score(records, { model: 'oracle', maxImages: 3 });
  assert.equal(card.tier0.verdict, 'insufficient');
  assert.equal(card.tier2.verdict, 'not-measured');
  assert.equal(card.verdict, 'insufficient');
  const table = formatTable(['', 'oracle', 'bar'], scorecardRows([card]));
  assert.match(table, /valid first try\s+100\.0% \(n=3\) ✓\s+≥ 97\.0%/);
  assert.throws(() => mergeThresholds({ tier1: { obvious: 'high' } }), /Invalid threshold tier1.obvious/);
  assert.throws(() => mergeThresholds({ tier9: {} }), /Unknown threshold group/);
});

test('cancelling a run keeps the finished decisions', async t => {
  const fixtures = await loadFixtures(await fixtureRoot(t, 1));
  const cases = planCases(fixtures, { probes: PROBES, repeats: 1, repeatFaults: 0 });
  const controller = new AbortController();
  const transport = scriptedTransport(fixtures, 'oracle');
  const slow: ModelTransport = { ...transport, complete: async request => {
    if (request.signal?.aborted) throw new Error('aborted');
    return transport.complete(request);
  } };
  const { records, complete } = await runCases(new DecisionAgent(slow), cases, { concurrency: 1, signal: controller.signal,
    onRecord: (_record, done) => { if (done === 5) controller.abort(); } });
  assert.equal(complete, false);
  assert.equal(records.length, 5);
});

test('eval CLI plans a run without calling a model and compares result files', async t => {
  const root = await fixtureRoot(t, 1);
  const planned = await run(process.execPath, ['scripts/eval.ts', 'run', '--fixtures', root, '--provider', 'openai-compatible', '--model', 'qwen-vl', '--dry-run']);
  assert.match(planned.stdout, /openai-compatible · model qwen-vl · local/);
  assert.match(planned.stdout, /1 fixtures \(1 synthetic\), 11 faults → 46 decisions/);
  const fixtures = await loadFixtures(root);
  const { records } = await runCases(new DecisionAgent(scriptedTransport(fixtures, 'oracle')), planCases(fixtures, { probes: PROBES, repeats: 2, repeatFaults: 1 }), { concurrency: 2 });
  const file = join(root, 'result.json');
  await writeFile(file, JSON.stringify({ version: 1, complete: true, model: 'oracle', scorecard: score(records, { model: 'oracle', maxImages: 3 }) }));
  const report = await run(process.execPath, ['scripts/eval.ts', 'report', file, file]);
  assert.match(report.stdout, /Tier 1 · perception\s+PASS\s+PASS/);
  await assert.rejects(run(process.execPath, ['scripts/eval.ts', 'run', '--fixtures', join(root, 'missing'), '--dry-run']), /fixture folder not found/);
});
