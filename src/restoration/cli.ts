import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { getPaths } from '../config.ts';
import { loadCorpus } from '../evaluation/corpus.ts';
import { analyzeRestoration, resumeImportedRestoration, runRestoration } from './runner.ts';
import { runCheckpointControls } from './controls.ts';

const help = `Serialized RAW restoration experiments (autonomous masking remains disabled)

First index the supplied corpus: node src/evaluation/cli.ts index --source RAW
List asset IDs: node src/evaluation/cli.ts list
node src/restoration/cli.ts run --id ID,ID --mask subject [--controls 3] [--cycles 1] [--exposure-delta 0.25] [--max-edge 2048] [--environment-notes TEXT]
node src/restoration/cli.ts analyze --result /absolute/path/to/results.json
node src/restoration/cli.ts resume-import --result /absolute/path/to/failed/results.json --expected-state-token TOKEN [--environment-notes TEXT]
node src/restoration/cli.ts checkpoint-controls --result /absolute/path/to/completed/results.json --id ID [--max-edge 2048] [--environment-notes TEXT] [--source-baseline /absolute/path/to/baseline.json]

Run uses explicit fresh RAW/XMP copies and diagnostic Lightroom virtual copies.
Choose subject or background; controls is 3–10 unchanged TIFF exports per reference state.
Cycles is 1–3 (default 1): each repeats the same local adjustment and exact local restore,
then captures two restored TIFFs against the fixed masked checkpoint. Each case ends with
one pre-creation restore. Cycles are fixed in advance, never retries until pixels agree.
All exports/settings/operations are retained. No pixel tolerance or autonomous feature gate is changed.
Uncertain/interrupted native work retains the shared lock for explicit inspection; never blind-retry.
Analyze reads saved TIFFs only and prints a separate report; it never calls Lightroom.
Resume-import is only for an explicitly reconciled single import failure with no working copy or mask.
It requires the shared lock to be free, verifies the selected original and staged RAW/XMP hashes,
and creates a new experiment with the prior recipe. It never repeats import or changes the failed report.
Checkpoint-controls requires the exact recorded diagnostic copy selected. It creates a separate copy
and captures three TIFFs each unchanged, after saving a checkpoint, and after a no-op baseline restore.
An explicit source-baseline JSON {state, reason} starts a new diagnostic baseline after a separately
inspected state change. It preserves the historical state and does not claim equivalence or recovery.
`;
const { values, positionals } = parseArgs({ options: Object.fromEntries(['id', 'mask', 'controls', 'cycles', 'exposure-delta', 'max-edge', 'environment-notes', 'result', 'expected-state-token', 'source-baseline'].map(name => [name, { type: 'string' as const }])), allowPositionals: true });
const value = (name: string) => values[name] as string | undefined;
const required = (name: string) => { const result = value(name); if (!result?.trim()) throw new Error(`--${name} is required.`); return result; };
const numeric = (name: string) => value(name) === undefined ? undefined : Number(required(name));
const output = (result: unknown) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
async function main() {
  const command = positionals[0] ?? 'help';
  if (command === 'help') { process.stdout.write(help); return; }
  if (value('source-baseline') !== undefined && command !== 'checkpoint-controls') throw new Error('--source-baseline is only valid for checkpoint-controls.');
  if (command === 'analyze') { output(await analyzeRestoration(required('result'))); return; }
  if (!['run', 'resume-import', 'checkpoint-controls'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const paths = getPaths(); const corpus = await loadCorpus(join(paths.runtime, 'evaluation'));
  const progress = (text: string) => process.stderr.write(`${text}\n`);
  if (command === 'checkpoint-controls') {
    if (['mask', 'controls', 'cycles', 'exposure-delta', 'expected-state-token'].some(name => value(name) !== undefined)) throw new Error('checkpoint-controls uses three exports per fixed block and no develop adjustment.');
    let sourceBaseline;
    if (value('source-baseline') !== undefined) {
      const path = required('source-baseline');
      if (!isAbsolute(path)) throw new Error('--source-baseline requires an absolute JSON path.');
      sourceBaseline = JSON.parse(await readFile(path, 'utf8'));
    }
    const result = await runCheckpointControls({ root: paths.root, corpus, resultPath: required('result'), assetId: required('id'),
      maxEdge: numeric('max-edge'), environmentNotes: value('environment-notes'), sourceBaseline, onProgress: progress });
    output({ id: result.report.id, path: result.path, status: result.report.status, sourceUnchanged: result.report.sourceUnchanged,
      lockRetained: result.report.lockRetained, summary: result.report.summary, error: result.report.error });
    if (result.report.status !== 'complete') process.exitCode = 2;
    return;
  }
  let result;
  if (command === 'resume-import') {
    if (['id', 'mask', 'controls', 'cycles', 'exposure-delta', 'max-edge'].some(name => value(name) !== undefined)) throw new Error('resume-import inherits the failed experiment recipe; do not override it.');
    result = await resumeImportedRestoration({ root: paths.root, corpus, resultPath: required('result'), expectedStateToken: required('expected-state-token'), environmentNotes: value('environment-notes'), onProgress: progress });
  } else {
    if (value('result') || value('expected-state-token')) throw new Error('Use resume-import for an explicitly reconciled import failure.');
    const mask = required('mask'); if (mask !== 'subject' && mask !== 'background') throw new Error('--mask must be subject or background.');
    result = await runRestoration({ root: paths.root, corpus, ids: required('id').split(',').map(id => id.trim()), maskKind: mask,
      controls: numeric('controls'), cycles: numeric('cycles'), exposureDelta: numeric('exposure-delta'), maxEdge: numeric('max-edge'), environmentNotes: value('environment-notes'), onProgress: progress });
  }
  output({ id: result.batch.id, path: result.path, status: result.batch.status, sourceUnchanged: result.batch.sourceUnchanged, lockRetained: result.batch.lockRetained,
    cases: result.batch.cases.map(item => ({ name: item.name, assetId: item.assetId, status: item.status, error: item.error, summary: item.summary })) });
  if (result.batch.status !== 'complete') process.exitCode = 2;
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
