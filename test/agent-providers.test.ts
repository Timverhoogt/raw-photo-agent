import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { AnthropicTransport } from '../src/agent/anthropic.ts';
import { DecisionAgent, decisionSchema, portableSchema, type DecisionInput, type ModelTransport } from '../src/agent/core.ts';
import { createTransport } from '../src/agent/index.ts';
import { OpenAICompatibleTransport } from '../src/agent/openai-compatible.ts';

async function previews(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'providers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const make = async (name: string, width: number) => {
    const path = join(dir, name);
    await sharp({ create: { width, height: Math.round(width / 1.5), channels: 3, background: '#6a7' } }).jpeg().toFile(path);
    return path;
  };
  return { small: await make('small.jpg', 600), large: await make('large.jpg', 3000) };
}
const input = (paths: string[]): DecisionInput => ({
  intent: 'Natural colour', currentCandidateId: 'a', remainingEdits: 2, history: [], feedback: [],
  candidates: paths.map((previewPath, i) => ({ id: 'abc'[i]!, description: '', previewPath, settings: { Exposure2012: 0 } })),
});
const finish = (candidateId = 'a') => JSON.stringify({ action: 'finish', title: 'Done', observation: 'Balanced.', reason: 'Nothing to add.',
  adjustments: {}, candidateId, question: null, options: [] });

test('portable schema drops unsupported limits and replaces type unions', () => {
  const schema = portableSchema(decisionSchema()) as any;
  const text = JSON.stringify(schema);
  for (const keyword of ['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems']) assert.ok(!text.includes(`"${keyword}"`), keyword);
  assert.deepEqual(schema.properties.adjustments.properties.Exposure2012, { anyOf: [{ type: 'number' }, { type: 'null' }] });
  assert.deepEqual(schema.properties.action, { type: 'string', enum: ['edit', 'restore', 'ask', 'finish'] });
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, decisionSchema().required);
});

test('decision agent repairs one invalid decision and records both attempts', async t => {
  const { small } = await previews(t);
  const prompts: string[] = [];
  let calls = 0;
  const transport: ModelTransport = { provider: 'fake', model: 'm', capabilities: { maxImages: 3, dataLeavesDevice: false },
    status: async () => ({ available: true, provider: 'fake', model: 'm' }),
    complete: async request => { prompts.push(request.prompt); return { text: calls++ === 0 ? '{"action":"finish"}' : finish() }; } };
  const seen: boolean[] = [];
  const result = await new DecisionAgent(transport, { onAttempt: a => seen.push(a.ok) }).decideDetailed(input([small]));
  assert.equal(result.decision?.action, 'finish');
  assert.deepEqual(result.attempts.map(a => [a.ok, a.errorCode]), [[false, 'INVALID_DECISION'], [true, undefined]]);
  assert.deepEqual(seen, [false, true]);
  assert.match(prompts[1]!, /PREVIOUS RESPONSE WAS REJECTED.*missing or unexpected fields/);

  calls = 0;
  const strict = await new DecisionAgent(transport, { repairAttempts: 0 }).decideDetailed(input([small]));
  assert.equal(strict.decision, null);
  assert.equal(strict.error?.code, 'INVALID_DECISION');
  calls = 0;
  await assert.rejects(new DecisionAgent(transport, { repairAttempts: 0 }).decide(input([small])), { code: 'INVALID_DECISION' });

  const failing: ModelTransport = { ...transport, complete: async () => { throw new Error('socket closed'); } };
  const failed = await new DecisionAgent(failing).decideDetailed(input([small]));
  assert.equal(failed.attempts.length, 1, 'provider failures are not repaired');
  assert.equal(failed.error?.code, 'PROVIDER_FAILED');
});

test('openai-compatible transport sends data URLs and a portable schema, retries 429 and reads usage', async t => {
  const { small, large } = await previews(t);
  const requests: Array<{ url: string; body: any; headers: any }> = [];
  let calls = 0;
  const fetchFake = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
    if (calls++ === 0) return new Response('busy', { status: 429, headers: { 'retry-after': '0' } });
    return Response.json({ model: 'llava-x', choices: [{ finish_reason: 'stop', message: { content: finish() } }], usage: { prompt_tokens: 900, completion_tokens: 80 } });
  }) as unknown as typeof fetch;
  const transport = new OpenAICompatibleTransport({ baseUrl: 'http://127.0.0.1:11434/v1/', model: 'llava-x', fetch: fetchFake, maxImageEdge: 1024 });
  assert.equal(transport.capabilities.dataLeavesDevice, false);
  const agent = new DecisionAgent(transport);
  const result = await agent.decideDetailed(input([small, large]));
  assert.equal(result.decision?.action, 'finish');
  assert.deepEqual(result.attempts[0]?.usage, { inputTokens: 900, outputTokens: 80, servedModel: 'llava-x' });
  assert.equal(requests.length, 2);
  const body = requests[1]!.body;
  assert.equal(requests[1]!.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(requests[1]!.headers.Authorization, undefined);
  assert.equal(body.response_format.type, 'json_schema');
  assert.ok(!JSON.stringify(body.response_format).includes('"minimum"'));
  const images = body.messages[0].content.filter((part: any) => part.type === 'image_url');
  assert.equal(images.length, 2);
  assert.ok(images.every((part: any) => part.image_url.url.startsWith('data:image/jpeg;base64,')));
  const resized = await sharp(Buffer.from(images[1].image_url.url.split(',')[1], 'base64')).metadata();
  assert.equal(Math.max(resized.width!, resized.height!), 1024, 'large previews are downscaled to the edge limit');
});

test('openai-compatible transport describes the schema in prompt mode, accepts fenced JSON and maps refusals', async t => {
  const { small } = await previews(t);
  let body: any;
  let reply: any = { choices: [{ message: { content: '```json\n' + finish() + '\n```' } }] };
  const fetchFake = (async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return Response.json(reply); }) as unknown as typeof fetch;
  const transport = new OpenAICompatibleTransport({ baseUrl: 'https://models.example/v1', model: 'm', apiKey: 'k', structuredOutput: 'none', fetch: fetchFake });
  assert.equal(transport.capabilities.dataLeavesDevice, true);
  assert.equal((await new DecisionAgent(transport).decide(input([small]))).action, 'finish');
  assert.equal(body.response_format, undefined);
  assert.match(body.messages[0].content[0].text, /matches this JSON Schema/);
  reply = { choices: [{ message: { content: null, refusal: 'no' } }] };
  await assert.rejects(new DecisionAgent(transport).decide(input([small])), { code: 'PROVIDER_REFUSED' });
  assert.throws(() => new OpenAICompatibleTransport({ baseUrl: 'http://models.example/v1', model: 'm' }), /https/);
});

test('openai-compatible status checks the endpoint and the model list', async () => {
  const list = (ids: string[], status = 200) => (async () => Response.json({ data: ids.map(id => ({ id })) }, { status })) as unknown as typeof fetch;
  const make = (fetchFake: typeof fetch) => new OpenAICompatibleTransport({ baseUrl: 'http://localhost:1234/v1', model: 'qwen-vl', fetch: fetchFake });
  assert.equal((await make(list(['qwen-vl'])).status()).available, true);
  assert.equal((await make(list(['qwen-vl:latest'])).status()).available, true);
  assert.match((await make(list(['other'])).status()).message ?? '', /does not list model qwen-vl/);
  assert.match((await make(list([], 401)).status()).message ?? '', /API key/);
  assert.match((await make((async () => { throw new Error('refused'); }) as unknown as typeof fetch).status()).message ?? '', /unreachable/);
});

function fakeAnthropic(respond: (body: any) => any, retrieve: () => Promise<unknown> = async () => ({})) {
  const bodies: any[] = [];
  const client = { beta: { messages: { create: async (body: any) => { bodies.push(body); return respond(body); } } }, models: { retrieve } };
  return { client: client as unknown as Anthropic, bodies };
}
const message = (text: string, stop = 'end_turn', model = 'claude-opus-5-5') =>
  ({ model, stop_reason: stop, content: [{ type: 'text', text }], usage: { input_tokens: 5000, output_tokens: 300 } });

test('anthropic transport sends images first, structured output, effort, and fallback only when enabled', async t => {
  const { small } = await previews(t);
  const { client, bodies } = fakeAnthropic(() => message(finish()));
  const live = new AnthropicTransport({ client });
  const result = await new DecisionAgent(live).decideDetailed(input([small, small]));
  assert.equal(result.decision?.action, 'finish');
  assert.deepEqual(result.attempts[0]?.usage, { inputTokens: 5000, outputTokens: 300, servedModel: 'claude-opus-5-5' });
  const body = bodies[0];
  assert.equal(body.model, 'claude-opus-5-5');
  assert.deepEqual(body.messages[0].content.map((block: any) => block.type), ['image', 'image', 'text']);
  assert.equal(body.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(!JSON.stringify(body.output_config.format.schema).includes('"maxLength"'));
  assert.equal(body.output_config.effort, 'high');
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(body.thinking, undefined);

  await new DecisionAgent(new AnthropicTransport({ client, refusalFallback: false, effort: 'medium' })).decide(input([small]));
  assert.equal(bodies[1].fallbacks, undefined);
  assert.equal(bodies[1].betas, undefined);
  assert.equal(bodies[1].output_config.effort, 'medium');
  await new DecisionAgent(new AnthropicTransport({ client, model: 'claude-haiku-4-5' })).decide(input([small]));
  assert.equal(bodies[2].output_config.effort, undefined, 'Haiku does not take effort');
  assert.equal(bodies[2].fallbacks, undefined, 'fallback is only sent for models that accept it');
});

test('anthropic transport maps refusals, truncation and status errors', async t => {
  const { small } = await previews(t);
  let reply = message('', 'refusal');
  const { client } = fakeAnthropic(() => reply, async () => { throw new Anthropic.NotFoundError(404, {}, 'missing', new Headers()); });
  const agent = new DecisionAgent(new AnthropicTransport({ client }));
  await assert.rejects(agent.decide(input([small])), { code: 'PROVIDER_REFUSED' });
  reply = message('{"action":', 'max_tokens');
  await assert.rejects(agent.decide(input([small])), { code: 'OUTPUT_LIMIT' });
  assert.match((await agent.status()).message ?? '', /not available to this account/);
  const denied = fakeAnthropic(() => reply, async () => { throw new Anthropic.AuthenticationError(401, {}, 'bad key', new Headers()); });
  assert.match((await new AnthropicTransport({ client: denied.client }).status()).message ?? '', /ANTHROPIC_API_KEY/);
});

test('provider selection reads RPA_* variables and keeps Codex as the default', () => {
  assert.equal(createTransport({}).provider, 'codex-cli');
  const local = createTransport({ RPA_PROVIDER: 'openai-compatible', RPA_MODEL: 'qwen-vl' });
  assert.equal(local.provider, 'openai-compatible');
  assert.equal(local.capabilities.dataLeavesDevice, false);
  const claude = createTransport({ RPA_PROVIDER: 'anthropic' }, { model: 'claude-sonnet-5-5' });
  assert.equal(claude.model, 'claude-sonnet-5-5');
  assert.equal(createTransport({ RPA_PROVIDER: 'anthropic' }).model, 'claude-opus-5-5');
  assert.throws(() => createTransport({ RPA_PROVIDER: 'gemini' }), /RPA_PROVIDER must be one of/);
  assert.throws(() => createTransport({ RPA_PROVIDER: 'openai-compatible' }), /RPA_MODEL is required/);
  assert.throws(() => createTransport({ RPA_PROVIDER: 'anthropic', RPA_EFFORT: 'extreme' }), /RPA_EFFORT/);
});
