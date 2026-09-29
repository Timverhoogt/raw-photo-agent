import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileLogger, errorFields } from '../src/log.ts';
import { closeWithin, startDemo } from '../src/demo/server.ts';

test('logger writes private JSON Lines and rotates one generation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'log-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'logs', 'demo.log');
  const logger = new FileLogger(path, 200);
  logger.log('info', 'first', { n: 1 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  for (let i = 0; i < 5; i++) logger.log('warn', 'filler', { i });
  const current = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(current.every(entry => entry.event && entry.level && entry.at));
  assert.ok((await stat(`${path}.1`)).size > 0);
});

test('logger never throws when it cannot write', () => {
  const logger = new FileLogger(join(tmpdir(), 'log-test-ok', 'x.log'));
  (logger as unknown as { path: string }).path = '/proc/definitely/not/writable/x.log';
  assert.doesNotThrow(() => logger.log('error', 'ignored'));
});

test('errorFields keeps message and code but truncates the stack', () => {
  const error = Object.assign(new Error('boom'), { code: 'E_X' });
  const fields = errorFields(error);
  assert.equal(fields.message, 'boom'); assert.equal(fields.code, 'E_X');
  assert.ok(String(fields.stack).split('\n').length <= 6);
  assert.deepEqual(errorFields('text'), { message: 'text' });
});

test('closeWithin reports a hung shutdown instead of waiting forever', async () => {
  const events: string[] = [];
  const logger = { log: (_l: string, event: string) => { events.push(event); } };
  assert.equal(await closeWithin(async () => {}, 1000, logger), true);
  assert.equal(await closeWithin(() => new Promise<void>(() => {}), 30, logger), false);
  assert.equal(await closeWithin(async () => { throw new Error('nope'); }, 1000, logger), false);
  assert.deepEqual(events, ['shutdown_failed', 'shutdown_failed']);
});

test('startDemo logs its lifecycle and shuts down cleanly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'demo-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events: Array<{ level: string; event: string }> = [];
  const demo = await startDemo({ root, port: 0, logger: { log: (level, event) => { events.push({ level, event }); } } });
  const port = new URL(demo.url).port;
  const state = await fetch(demo.url + '/api/state', { headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(state.status, 200);
  const stream = await fetch(demo.url + '/api/events');
  assert.equal(stream.status, 200);
  const started = Date.now();
  await demo.close();
  assert.ok(Date.now() - started < 5000, 'close must not wait on an open event stream');
  assert.deepEqual(events.map(e => e.event).filter(e => e.startsWith('server_')), ['server_started', 'server_stopped']);
});
