import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { getPaths } from '../config.ts';
import { loadCorpus } from '../evaluation/corpus.ts';
import { runImportDiagnostic } from './import.ts';

const help = `Import-only Lightroom diagnosis

Index first: node src/evaluation/cli.ts index --source RAW
List IDs: node src/evaluation/cli.ts list
node src/diagnostics/cli.ts import --id RAW_ID --environment-notes TEXT

Imports exactly one fresh indexed RAW with its matching XMP. No working copy,
edit, export, retry, settling acceptance, or automatic recovery is performed.
Native import traces and read-only observations at 0/1/3 seconds are retained.
Failure, uncertainty, or any settings drift keeps the shared session lock for
manual reconciliation. Delays never authorize a replacement baseline.
`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { id: { type: 'string' }, 'environment-notes': { type: 'string' } } });
  if (!positionals.length || positionals[0] === 'help') { process.stdout.write(help); return; }
  if (positionals.length !== 1 || positionals[0] !== 'import') throw new Error('Use import or help.');
  if (!values.id?.trim() || values.id.includes(',')) throw new Error('--id must name exactly one indexed RAW.');
  if (!values['environment-notes']?.trim()) throw new Error('--environment-notes is required.');
  const paths = getPaths(); const corpus = await loadCorpus(join(paths.runtime, 'evaluation'));
  const result = await runImportDiagnostic({ root: paths.root, corpus, assetId: values.id, environmentNotes: values['environment-notes'] });
  process.stdout.write(`${JSON.stringify({ id: result.report.id, path: result.path, status: result.report.status,
    lockRetained: result.report.lockRetained, error: result.report.error }, null, 2)}\n`);
  if (result.report.status !== 'complete') process.exitCode = 2;
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
