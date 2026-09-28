import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { getPaths } from '../config.ts';
import { indexCorpus, loadCorpus } from './corpus.ts';
import { runEvaluation } from './runner.ts';
import type { EvaluationBatch } from './runner.ts';
import { buildReview, recordVote, summarizeReview } from './review.ts';

const help = `Local RAW quality evaluation

node src/evaluation/cli.ts index --source RAW
node src/evaluation/cli.ts list
node src/evaluation/cli.ts status
node src/evaluation/cli.ts run --limit 3 --max-edits 2 [--id ID,ID] [--intent TEXT] [--model NAME]
node src/evaluation/cli.ts review --run EVAL_ID [--seed SECRET]
node src/evaluation/cli.ts vote --review REVIEW_ID --case CASE_ID --candidate CANDIDATE_ID --reviewer NAME [--notes TEXT]
node src/evaluation/cli.ts summarize --review REVIEW_ID

Index/list/status/review/vote/summarize are local-only. Run imports fresh RAW+matching XMP copies,
uses Lightroom and the signed-in Codex model, and requires explicit --limit or --id.
Starting renders are as-imported, including XMP; they are not reset/untouched originals.
The fixed comparator is Highlights -20, Shadows +15, Vibrance +5 (bounded deltas), not Auto.
No model question is answered and no photographer vote is fabricated by run.
An interrupted native run retains session.lock for manual reconciliation; never blind-retry.
`;
const names = ['source', 'limit', 'id', 'max-edits', 'intent', 'model', 'run', 'seed', 'review', 'case', 'candidate', 'reviewer', 'notes'] as const;
const { values, positionals } = parseArgs({ options: Object.fromEntries(names.map(name => [name, { type: 'string' as const }])), allowPositionals: true });
const command = positionals[0] ?? 'help';
const value = (name: string) => typeof values[name] === 'string' ? values[name] as string : undefined;
const required = (name: string) => { const found = value(name); if (!found?.trim()) throw new Error(`--${name} is required.`); return found; };
const output = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
const paths = getPaths(); const evaluationRoot = join(paths.runtime, 'evaluation');
async function main() {
  if (command === 'help') { process.stdout.write(help); return; }
  if (command === 'index') {
    const { corpus, path, unchanged } = await indexCorpus(value('source') ?? join(paths.root, 'RAW'), evaluationRoot);
    output({ path, unchanged, fingerprint: corpus.fingerprint, rawCount: corpus.assets.length, sidecarCount: corpus.assets.reduce((sum, item) => sum + item.sidecars.length, 0),
      otherFiles: corpus.otherFiles.map(file => file.path), baseline: corpus.baseline, sidecarPolicy: corpus.sidecarPolicy }); return;
  }
  if (command === 'list' || command === 'status') {
    const corpus = await loadCorpus(evaluationRoot);
    const result: Record<string, unknown> = { fingerprint: corpus.fingerprint, source: corpus.source, baseline: corpus.baseline,
      assets: corpus.assets.map(asset => ({ id: asset.id, name: asset.name, bytes: asset.raw.bytes, sha256: asset.raw.sha256, sidecars: asset.sidecars.map(file => file.path) })), otherFiles: corpus.otherFiles.map(file => file.path) };
    if (command === 'status') {
      let runs: string[] = []; try { runs = await readdir(join(evaluationRoot, 'runs')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      result.runs = await Promise.all(runs.filter(id => /^eval-[a-f0-9-]{36}$/.test(id)).map(async id => {
        const path = join(evaluationRoot, 'runs', id, 'results.json'); const batch = JSON.parse(await readFile(path, 'utf8')) as EvaluationBatch;
        return { id, path, status: batch.status, cases: batch.cases.map(item => ({ assetId: item.assetId, status: item.status, elapsedMs: item.elapsedMs, error: item.error })) };
      }));
      try { result.sessionLock = JSON.parse(await readFile(join(paths.runtime, 'session.lock'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    output(result); return;
  }
  if (command === 'run') {
    const corpus = await loadCorpus(evaluationRoot);
    if (value('source') && await realpath(required('source')) !== corpus.source) throw new Error('The requested source differs from the indexed corpus. Run index first.');
    const result = await runEvaluation({ root: paths.root, corpus, limit: value('limit') === undefined ? undefined : Number(required('limit')),
      ids: value('id')?.split(','), maxEdits: value('max-edits') === undefined ? undefined : Number(required('max-edits')),
      intent: value('intent'), model: value('model'), onProgress: message => process.stderr.write(`${message}\n`) });
    output({ id: result.batch.id, path: result.path, status: result.batch.status, cases: result.batch.cases.map(item => ({ assetId: item.assetId, name: item.name, status: item.status, elapsedMs: item.elapsedMs, error: item.error })) });
    if (result.batch.status !== 'complete') process.exitCode = 2; return;
  }
  if (command === 'review') {
    const id = required('run'); if (!/^eval-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid evaluation run ID.');
    const batch = JSON.parse(await readFile(join(evaluationRoot, 'runs', id, 'results.json'), 'utf8')) as EvaluationBatch;
    const seed = value('seed') ?? randomBytes(32).toString('hex'); const reviewId = `review-${createHmac('sha256', seed).update(batch.id).digest('hex').slice(0, 20)}`;
    const reviews = join(evaluationRoot, 'reviews'); await mkdir(reviews, { recursive: true, mode: 0o700 });
    output(await buildReview(batch, join(reviews, reviewId), seed)); return;
  }
  if (command === 'vote') {
    const id = required('review'); if (!/^review-[a-f0-9]{20}$/.test(id)) throw new Error('Invalid review ID.');
    output(await recordVote(join(evaluationRoot, 'reviews', id), { caseId: required('case'), candidateId: required('candidate'), reviewer: required('reviewer'), notes: value('notes') })); return;
  }
  if (command === 'summarize') {
    const id = required('review'); if (!/^review-[a-f0-9]{20}$/.test(id)) throw new Error('Invalid review ID.');
    output(await summarizeReview(join(evaluationRoot, 'reviews', id))); return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
