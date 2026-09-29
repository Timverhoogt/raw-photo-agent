import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ADJUSTMENT_RANGES, CodexPhotoAgent, PhotoAgentError, buildCodexArgs, buildDecisionPrompt,
  isSupportedCodexVersion, parseCodexVersion, parseDecision, runBoundedProcess, selectDecisionImages } from '../src/demo/agent.ts';
import type { DecisionInput, ProcessRunner } from '../src/demo/agent.ts';

const input = (): DecisionInput => ({ intent: 'Keep the bird natural, with clear feather detail.',
  currentCandidateId: 'current', remainingEdits: 3, history: [], feedback: [],
  candidates: [
    { id: 'baseline', description: 'Original starting edit', previewPath: '/tmp/base.jpg', settings: { Exposure2012: 0 } },
    { id: 'best', description: 'Best retained edit', previewPath: '/tmp/best.jpg', settings: { Exposure2012: 0.1 } },
    { id: 'current', description: 'Latest edit', previewPath: '/tmp/current.jpg', settings: { Exposure2012: 0.2, Contrast2012: 4 } },
  ],
});
const decision = () => ({ action: 'edit', title: 'Lift the subject slightly', observation: 'The subject is darker than its surroundings.',
  reason: 'A small exposure increase may reveal detail.', adjustments: { Exposure2012: 0.35 },
  candidateId: 'current', question: null, options: [] });

test('decision validator normalizes nullable structured output and enforces actionable limits', () => {
  const nullable = Object.fromEntries(Object.keys(ADJUSTMENT_RANGES).map(key => [key, null]));
  assert.deepEqual(parseDecision({ ...decision(), adjustments: { ...nullable, Exposure2012: 0.35 } }, input()), decision());
  for (const change of [
    { adjustments: { Exposure2012: 6 } },
    { adjustments: { UnsupportedSlider: 1 } },
    { adjustments: { Exposure2012: 0.35, Contrast2012: 5, Shadows2012: 3, Texture: 2 } },
    { adjustments: { Exposure2012: 0.2 } },
    { candidateId: 'best' },
    { extra: 'unexpected' },
    { question: 'Unrequested question' },
    { options: ['unexpected'] },
  ]) assert.throws(() => parseDecision({ ...decision(), ...change }, input()), { code: 'INVALID_DECISION' });
  assert.throws(() => parseDecision(decision(), { ...input(), remainingEdits: 0 }), { code: 'INVALID_DECISION' });
  assert.throws(() => parseDecision('```json\n{}\n```', input()), { code: 'INVALID_DECISION' });
});

test('restore, ask and finish decisions cannot smuggle edits or invalid targets', () => {
  const restore = { ...decision(), action: 'restore', candidateId: 'best', adjustments: {} };
  assert.equal(parseDecision(restore, input()).action, 'restore');
  assert.throws(() => parseDecision({ ...restore, candidateId: 'missing' }, input()), { code: 'INVALID_DECISION' });
  assert.throws(() => parseDecision({ ...restore, candidateId: 'current' }, input()), { code: 'INVALID_DECISION' });
  assert.throws(() => parseDecision({ ...restore, adjustments: { Texture: 4 } }, input()), { code: 'INVALID_DECISION' });
  const ask = { ...restore, action: 'ask', candidateId: null, question: 'Which mood suits this image?', options: ['Warm', 'Neutral'] };
  assert.equal(parseDecision(ask, input()).action, 'ask');
  assert.throws(() => parseDecision({ ...ask, options: ['Warm'] }, input()), { code: 'INVALID_DECISION' });
  assert.throws(() => parseDecision({ ...restore, action: 'finish' }, input()), { code: 'INVALID_DECISION' });
  assert.equal(parseDecision({ ...restore, action: 'finish', candidateId: 'current' }, input()).action, 'finish');
});

test('schema allows only supported nullable numeric fields and keeps every output field required', async () => {
  const schema = JSON.parse(await readFile(new URL('../src/demo/decision.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
  const sliders = schema.properties.adjustments;
  assert.equal(sliders.additionalProperties, false);
  assert.deepEqual(new Set(sliders.required), new Set(Object.keys(ADJUSTMENT_RANGES)));
  for (const [key, [min, max]] of Object.entries(ADJUSTMENT_RANGES)) {
    assert.deepEqual(sliders.properties[key], { type: ['number', 'null'], minimum: min, maximum: max });
  }
});

test('image selection includes current, then prioritized baseline and best; prompt labels actual attachments', () => {
  const value = input();
  value.candidates.push({ id: 'unseen', description: 'Unused', previewPath: '/tmp/unseen.jpg', settings: {} });
  value.candidates[2].settings.privateMetadata = 'Do not include metadata in model input';
  value.feedback.push('Keep cooler colours.');
  const images = selectDecisionImages(value);
  assert.deepEqual(images.map(candidate => candidate.id), ['current', 'baseline', 'best']);
  const prompt = buildDecisionPrompt(value, images);
  assert.ok(prompt.includes('"attachment":1,"id":"current"'));
  assert.ok(prompt.includes('Keep cooler colours.'));
  assert.ok(!prompt.includes('privateMetadata'));
  assert.ok(!prompt.includes('/tmp/current.jpg'));
  assert.throws(() => selectDecisionImages({ ...value, currentCandidateId: 'unknown' }), { code: 'INVALID_INPUT' });
});

test('CLI arguments isolate working directory, disable external tools and pass images without a shell', () => {
  const args = buildCodexArgs({ model: 'gpt-6-astra', cwd: '/tmp/isolated', schemaPath: '/tmp/schema.json',
    outputPath: '/tmp/decision.json', images: ['/tmp/image with spaces;$(whoami).jpg'] });
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--json']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('--image') + 1], '/tmp/image with spaces;$(whoami).jpg');
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('project_doc_max_bytes=0'));
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'computer_use', 'browser_use', 'multi_agent']) {
    assert.ok(args.some((arg, i) => arg === '--disable' && args[i + 1] === feature));
  }
});

test('provider reads only final output, cleans isolated files and exposes no status credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'demo-agent-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preview = join(dir, 'preview.jpg');
  await writeFile(preview, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const value = input();
  value.candidates = value.candidates.map(candidate => ({ ...candidate, previewPath: preview }));
  let workingDir = '';
  const runner: ProcessRunner = async (_binary, args, options) => {
    if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.153.4\n', stderr: '' };
    if (args[0] === 'login') return { code: 0, stdout: '', stderr: 'Logged in using API key: never-display-this' };
    workingDir = options.cwd;
    assert.notEqual(workingDir, process.cwd());
    assert.equal((await stat(workingDir)).mode & 0o777, 0o700);
    assert.equal(options.captureOutput, undefined);
    assert.equal(options.stdin?.includes('Keep the bird natural'), true);
    await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(decision()));
    return { code: 0, stdout: '{"type":"reasoning","text":"PRIVATE"}', stderr: 'PRIVATE' };
  };
  const agent = new CodexPhotoAgent({ runner, model: 'gpt-6-astra' });
  assert.deepEqual(await agent.status(), { available: true, provider: 'codex-cli', model: 'gpt-6-astra' });
  assert.deepEqual(await agent.decide(value), decision());
  await assert.rejects(stat(workingDir), { code: 'ENOENT' });
});

test('provider rejects unsupported previews and does not launch for an already aborted call', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'demo-agent-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preview = join(dir, 'raw.nef');
  await writeFile(preview, 'not a jpeg');
  const value = input();
  value.candidates = [{ ...value.candidates[2], previewPath: preview }];
  let calls = 0;
  const agent = new CodexPhotoAgent({ runner: async () => { calls++; return { code: 0, stdout: '', stderr: '' }; } });
  await assert.rejects(agent.decide(value), { code: 'INVALID_INPUT' });
  await assert.rejects(agent.decide(value, AbortSignal.abort()), { code: 'ABORTED' });
  assert.equal(calls, 0);
});

test('bounded runner discards JSONL output and enforces byte and time limits', async () => {
  const options = { cwd: tmpdir(), timeoutMs: 3_000, maxOutputBytes: 2_048 };
  const result = await runBoundedProcess(process.execPath, ['-e', 'process.stdout.write("private reasoning"); process.stderr.write("private diagnostics")'], options);
  assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  await assert.rejects(runBoundedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)'], options), { code: 'OUTPUT_LIMIT' });
  await assert.rejects(runBoundedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, timeoutMs: 40 }), { code: 'TIMEOUT' });
});

test('aborting a stubborn child kills its process before the runner rejects', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'demo-agent-abort-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidPath = join(dir, 'pid');
  const controller = new AbortController();
  const task = runBoundedProcess(process.execPath, ['-e',
    'require("node:fs").writeFileSync(process.argv[1],String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)', pidPath],
  { cwd: dir, timeoutMs: 5_000, maxOutputBytes: 2_048, signal: controller.signal });
  let pid = 0;
  for (let i = 0; i < 100; i++) {
    try { pid = Number(await readFile(pidPath, 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid > 0);
  controller.abort();
  await assert.rejects(task, (error: unknown) => error instanceof PhotoAgentError && error.code === 'ABORTED');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('version parsing and minimum comparison', () => {
  assert.deepEqual(parseCodexVersion('codex-cli 0.153.4\n'), [0, 153, 4]);
  assert.equal(parseCodexVersion('no version'), undefined);
  assert.equal(isSupportedCodexVersion([0, 153, 4]), true);
  assert.equal(isSupportedCodexVersion([0, 158, 0]), true);
  assert.equal(isSupportedCodexVersion([1, 0, 0]), true);
  assert.equal(isSupportedCodexVersion([0, 153, 3]), false);
  assert.equal(isSupportedCodexVersion([0, 99, 9]), false);
});

test('status refuses an old or unreadable Codex CLI before checking login', async () => {
  const calls: string[] = [];
  const make = (stdout: string, code = 0) => new CodexPhotoAgent({ runner: async (_b, args) => {
    calls.push(args[0]!); return { code, stdout, stderr: '' };
  } });
  const old = await make('codex-cli 0.150.0').status();
  assert.equal(old.available, false);
  assert.match(old.message ?? '', /older than the tested 0\.153\.4/);
  const unreadable = await make('garbage').status();
  assert.equal(unreadable.available, false);
  assert.match(unreadable.message ?? '', /version/);
  assert.equal((await make('', 1).status()).available, false);
  assert.equal(calls.includes('login'), false);
});
