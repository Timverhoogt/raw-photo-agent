// Scores a model provider against tiers 0–2. See docs/model-evaluation.md.
//   node scripts/eval.ts run    --fixtures fixtures [--provider anthropic --model claude-opus-5-5] [--dry-run]
//   node scripts/eval.ts report results/eval-a.json results/eval-b.json
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPhotoAgent } from '../src/agent/index.ts';
import { loadFixtures } from '../src/eval/fixtures.ts';
import { PROBES, planCases, type ProbeName } from '../src/eval/probes.ts';
import { runCases } from '../src/eval/run.ts';
import { formatTable, mergeThresholds, score, scorecardRows, type CallRecord, type Scorecard } from '../src/eval/score.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fixtures: { type: 'string', default: 'fixtures' },
    provider: { type: 'string' }, model: { type: 'string' },
    repeats: { type: 'string', default: '5' }, 'repeat-faults': { type: 'string', default: '2' },
    concurrency: { type: 'string', default: '2' }, limit: { type: 'string' },
    probes: { type: 'string', default: PROBES.join(',') },
    repair: { type: 'string' }, thresholds: { type: 'string' }, out: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const integer = (name: string, value: string | undefined, min: number, max: number) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
  return n;
};

interface ResultFile {
  version: 1; createdAt: string; complete: boolean; provider: string; model: string;
  settings: Record<string, unknown>; thresholds: ReturnType<typeof mergeThresholds>; scorecard: Scorecard; records: CallRecord[];
}

async function run() {
  const thresholds = mergeThresholds(values.thresholds ? JSON.parse(await readFile(values.thresholds, 'utf8')) : undefined);
  const probes = values.probes!.split(',').map(p => p.trim()) as ProbeName[];
  for (const probe of probes) if (!PROBES.includes(probe)) throw new Error(`Unknown probe ${probe}. Use: ${PROBES.join(', ')}.`);
  let fixtures = await loadFixtures(values.fixtures!);
  if (values.limit) fixtures = fixtures.slice(0, integer('limit', values.limit, 1, 10_000));
  if (!fixtures.length) throw new Error(`No fixtures in ${values.fixtures}. See docs/model-evaluation.md.`);
  const repeats = integer('repeats', values.repeats, 1, 20);
  const cases = planCases(fixtures, { probes, repeats, repeatFaults: integer('repeat-faults', values['repeat-faults'], 0, 100) });
  const agent = createPhotoAgent(process.env, {
    provider: values.provider, model: values.model, refusalFallback: false,
    ...(values.repair !== undefined ? { repairAttempts: integer('repair', values.repair, 0, 2) } : {}),
  });
  const faults = fixtures.reduce((n, f) => n + f.faults.length, 0);
  const synthetic = fixtures.filter(f => f.source === 'synthetic').length;
  process.stdout.write(`Provider ${agent.provider} · model ${agent.model}${agent.capabilities.dataLeavesDevice ? ' · previews leave this computer' : ' · local'}\n` +
    `${fixtures.length} fixtures (${synthetic} synthetic), ${faults} faults → ${cases.length} decisions` +
    ` (${probes.map(p => `${p} ${cases.filter(c => c.probe === p).length}`).join(', ')}); each may add a repair call.\n`);
  if (values['dry-run']) return;
  const status = await agent.status();
  if (!status.available) throw new Error(status.message ?? 'The provider is not available.');

  const controller = new AbortController();
  process.once('SIGINT', () => { process.stderr.write('\nStopping: finishing the scorecard from completed decisions…\n'); controller.abort(); });
  const started = Date.now();
  const { records, complete } = await runCases(agent, cases, {
    concurrency: integer('concurrency', values.concurrency, 1, 16), signal: controller.signal,
    onRecord: (record, done, total) => process.stderr.write(`\r${done}/${total} ${record.decision ? '·' : '✗'} ${record.probe} ${record.fixtureId}${record.faultId ? `/${record.faultId}` : ''}`.padEnd(80)),
  });
  process.stderr.write('\n');
  const scorecard = score(records, { model: agent.model, maxImages: agent.capabilities.maxImages }, thresholds);
  const out = values.out ?? join('results', `eval-${agent.provider}-${agent.model.replace(/[^\w.-]+/g, '_')}-${new Date(started).toISOString().replace(/[:.]/g, '-')}.json`);
  const result: ResultFile = { version: 1, createdAt: new Date(started).toISOString(), complete, provider: agent.provider, model: agent.model,
    settings: { fixtures: fixtures.map(f => ({ id: f.id, source: f.source, faults: f.faults.length })), probes, repeats,
      repeatFaults: Number(values['repeat-faults']), repairAttempts: values.repair ?? process.env.RPA_REPAIR_ATTEMPTS ?? 1,
      durationMs: Date.now() - started },
    thresholds, scorecard, records };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`\n${formatTable(['', agent.model, 'bar'], scorecardRows([scorecard]))}\n\n${complete ? '' : 'INCOMPLETE RUN. '}Results: ${out}\n`);
  if (synthetic) process.stdout.write('Synthetic fixtures approximate Lightroom edits; confirm with Lightroom-rendered fixtures before relying on a verdict.\n');
}

async function report() {
  if (!positionals.length) throw new Error('Pass one or more result files.');
  const results = await Promise.all(positionals.map(async path => JSON.parse(await readFile(path, 'utf8')) as ResultFile));
  for (const r of results) if (r.version !== 1) throw new Error('Unsupported result file version.');
  process.stdout.write(`${formatTable(['', ...results.map(r => `${r.model}${r.complete ? '' : ' (partial)'}`), 'bar'], scorecardRows(results.map(r => r.scorecard)))}\n`);
}

const command = positionals.shift();
try {
  if (command === 'run') await run();
  else if (command === 'report') await report();
  else process.stdout.write('Usage: node scripts/eval.ts run [--fixtures DIR] [--provider P] [--model M] [--dry-run]\n       node scripts/eval.ts report RESULT.json [...]\nSee docs/model-evaluation.md.\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
