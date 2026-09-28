import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, rm, stat, lstat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FileBridge } from '../bridge.ts';
import { RunStore } from '../store.ts';
import { PhotoController } from '../controller.ts';
import { getPaths } from '../config.ts';
import { CodexPhotoAgent } from './agent.ts';
import { DemoEngine, type Upload } from './session.ts';

const runFile = promisify(execFile);
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const RAW_EXTENSIONS = new Set(['.cr2','.cr3','.nef','.nrw','.arw','.srf','.sr2','.dng','.raf','.orf','.rw2','.rwl','.pef','.ptx','.srw','.3fr','.fff','.iiq','.kdc','.dcr','.mos','.mrw','.raw']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function acquireServerLock(runtime: string) {
  const path = join(runtime, 'demo-server.lock');
  const owner = randomUUID();
  const claim = async () => {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid, owner })); } finally { await file.close(); }
  };
  try { await claim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(path, 'utf8')) as {pid: number; owner: string};
    if (!Number.isInteger(previous.pid) || previous.pid <= 0 || typeof previous.owner !== 'string') throw new Error('Invalid demo-server.lock; inspect it before starting.');
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    if (alive) throw new Error('The demo server is already running for this project. Open its existing browser page.');
    // This is only the dead server's ownership file. Never remove session.lock,
    // which may represent an uncertain Lightroom operation after a crash.
    if (JSON.parse(await readFile(path, 'utf8')).owner !== previous.owner) throw new Error('Demo server ownership changed.');
    await rm(path); await claim();
  }
  return async () => {
    try { if (JSON.parse(await readFile(path, 'utf8')).owner === owner) await rm(path); } catch { /* Do not remove replaced ownership. */ }
  };
}

export function validateFilename(value: string) {
  if (!value || value.length > 160 || value !== basename(value) || /[\\/\x00-\x1f\x7f]/.test(value) || value.startsWith('.') || value.includes('..') || !RAW_EXTENSIONS.has(extname(value).toLowerCase())) throw new Error('Choose a RAW or DNG file with a simple filename (at most 160 characters).');
  return value;
}
export function allowRequest(req: IncomingMessage, port: number) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!hosts.has(req.headers.host ?? '')) return false;
  const origin = req.headers.origin;
  if (origin && ![...hosts].some(host => origin === `http://${host}`)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin','none'].includes(String(site))) return false;
  if (!['GET','HEAD'].includes(req.method ?? '') && req.headers['x-rpa-client'] !== 'demo') return false;
  return true;
}
function json(res: ServerResponse, code: number, value: unknown) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
async function body(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Expected application/json.');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 16 * 1024) throw new Error('Request too large.'); chunks.push(Buffer.from(chunk)); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, unknown>;
}
function textValue(value: unknown, name: string) { if (typeof value !== 'string') throw new Error(`${name} must be a string.`); return value; }

export async function receiveUpload(req: IncomingMessage, uploadRoot: string): Promise<Upload> {
  const name = validateFilename(decodeURIComponent(String(req.headers['x-filename'] ?? '')));
  if (req.headers['content-type'] !== 'application/octet-stream') throw new Error('Upload the RAW as application/octet-stream.');
  const declaredSize = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > MAX_UPLOAD_BYTES) throw new Error('RAW files must be nonempty and at most 200 MiB.');
  await mkdir(uploadRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(uploadRoot);
  if (canonicalRoot !== resolve(uploadRoot)) throw new Error('The upload folder must not be a symbolic link.');
  const id = randomUUID(); const directory = join(uploadRoot, id);
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, name); const temporary = join(directory, '.uploading');
  let bytes = 0;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_UPLOAD_BYTES || bytes > declaredSize) throw new Error('RAW upload exceeds its allowed size.');
        await file.writeFile(chunk);
      }
      if (bytes !== declaredSize) throw new Error('The RAW upload was incomplete.');
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
    const upload = { id, name, size: bytes, path };
    const metadata = await open(join(directory, 'upload.json'), 'wx', 0o600);
    try { await metadata.writeFile(JSON.stringify(upload)); } finally { await metadata.close(); }
    return upload;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
async function loadUpload(root: string, id: string): Promise<Upload> {
  if (!UUID.test(id)) throw new Error('Invalid upload ID.');
  const directory = join(root, id);
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== resolve(directory)) throw new Error('Invalid upload directory.');
  const upload = JSON.parse(await readFile(join(directory, 'upload.json'), 'utf8')) as Upload;
  validateFilename(upload.name);
  const expected = join(directory, upload.name);
  if (upload.id !== id || upload.path !== expected || await realpath(expected) !== resolve(expected) || !(await lstat(expected)).isFile()) throw new Error('Invalid upload path.');
  if ((await stat(expected)).size !== upload.size) throw new Error('The uploaded RAW changed after upload.');
  return upload;
}

export async function startDemo(options: { root?: string; port?: number } = {}) {
  const paths = getPaths(options.root);
  const uploadRoot = join(paths.runtime, 'uploads');
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const releaseServer = await acquireServerLock(paths.runtime);
  let failedStore: RunStore | undefined;
  try {
  const bridge = new FileBridge(paths.bridgeDir, { timeoutMs: 60000 });
  const store = new RunStore(paths.database);
  failedStore = store;
  const controller = new PhotoController(bridge, store, paths.exportRoot);
  const agent = new CodexPhotoAgent();
  const maxEdits = Number(process.env.RPA_MAX_EDITS ?? 6);
  if (!Number.isInteger(maxEdits) || maxEdits < 1 || maxEdits > 10) throw new Error('RPA_MAX_EDITS must be an integer from 1 to 10.');
  const engine = new DemoEngine(controller, agent, paths.runtime, { maxEdits });
  let agentStatus = await agent.status();
  let connection: { online: boolean; message?: string } = { online: false, message: 'Checking Lightroom…' };
  let refreshing = false;
  const clients = new Set<ServerResponse>();
  const snapshot = () => ({ connection, agent: agentStatus, session: engine.session });
  const broadcast = () => { const data = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`; for (const client of clients) client.write(data); };
  engine.on('change', broadcast);
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try { const result = await bridge.status(); connection = { online: result.online, ...(!result.online ? { message: 'Start Raw Photo Agent in Lightroom’s Plug-in Extras menu.' } : {}) }; }
    catch { connection = { online: false, message: 'The Lightroom bridge could not be read.' }; }
    finally { refreshing = false; broadcast(); }
  };
  await refresh();
  let boundPort = options.port ?? Number(process.env.RPA_PORT ?? 4318);
  if (!Number.isInteger(boundPort) || boundPort < 0 || boundPort > 65535) throw new Error('Invalid demo port.');
  const assets: Record<string, [string, string]> = { '/': ['index.html','text/html; charset=utf-8'], '/app.js': ['app.js','text/javascript; charset=utf-8'], '/styles.css': ['styles.css','text/css; charset=utf-8'] };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!allowRequest(req, boundPort)) { json(res,403,{error:'This demo accepts only requests from its local browser page.'}); return; }
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname]!;
        res.writeHead(200, { 'Content-Type': type }); res.end(await readFile(join(paths.root,'demo',file))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') { json(res,200,snapshot()); return; }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type':'text/event-stream', Connection:'keep-alive', 'X-Accel-Buffering':'no' });
        clients.add(res); res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`); req.on('close', () => clients.delete(res)); return;
      }
      const preview = /^\/api\/previews\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && preview) {
        const path = engine.preview(preview[1]!,preview[2]!); const info = await stat(path);
        res.writeHead(200,{ 'Content-Type':'image/jpeg', 'Content-Length':info.size, ...(preview[2] === 'final' ? {'Content-Disposition':'attachment; filename="raw-photo-agent-final.jpg"'} : {}) });
        createReadStream(path).on('error', () => res.destroy()).pipe(res); return;
      }
      if (req.method !== 'POST') { json(res,404,{error:'Not found.'}); return; }
      if (url.pathname === '/api/uploads') { const upload = await receiveUpload(req,uploadRoot); json(res,201,{upload:{id:upload.id,name:upload.name,size:upload.size}}); return; }
      if (url.pathname === '/api/lightroom/open') {
        if (process.platform !== 'darwin') throw new Error('Show Lightroom is available on macOS.');
        await runFile('open',['-a','Adobe Lightroom Classic'],{timeout:10000}); json(res,200,{ok:true}); return;
      }
      const input = await body(req);
      if (url.pathname === '/api/sessions') {
        await refresh();
        if (!connection.online) throw new Error(connection.message);
        agentStatus = await agent.status();
        if (!agentStatus.available) throw new Error(agentStatus.message ?? 'Codex is not ready.');
        const upload = input.uploadId ? await loadUpload(uploadRoot,textValue(input.uploadId,'uploadId')) : undefined;
        engine.start({intent:textValue(input.intent,'intent'), upload, useSelected:input.useSelected === true});
        json(res,202,{ok:true}); return;
      }
      const control = /^\/api\/sessions\/([^/]+)\/(pause|resume|stop|answer|choose)$/.exec(url.pathname);
      if (control) {
        const [,id,action] = control;
        if (action === 'pause') engine.pause(id!);
        if (action === 'resume') engine.resume(id!);
        if (action === 'stop') engine.stop(id!);
        if (action === 'answer') engine.answer(id!,textValue(input.questionId,'questionId'),textValue(input.answer,'answer'));
        if (action === 'choose') engine.choose(id!,textValue(input.candidateId,'candidateId'));
        json(res,202,{ok:true}); return;
      }
      json(res,404,{error:'Not found.'});
    } catch (error) { if (!res.headersSent) json(res,400,{error:error instanceof Error ? error.message : String(error)}); else res.destroy(); }
  });
  server.requestTimeout = 180000;
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(boundPort,'127.0.0.1',done); });
  boundPort = (server.address() as {port:number}).port;
  const timer = setInterval(() => { void refresh(); for (const client of clients) client.write(': heartbeat\n\n'); },3000);
  timer.unref();
  const authTimer = setInterval(() => { void agent.status().then(result => { agentStatus=result; broadcast(); }).catch(() => {}); },60000); authTimer.unref();
  return { server,engine,url:`http://127.0.0.1:${boundPort}`, close:async () => { clearInterval(timer); clearInterval(authTimer); await engine.shutdown(); for(const client of clients) client.end(); await new Promise<void>(done=>server.close(()=>done())); store.close(); await releaseServer(); } };
  } catch (error) { failedStore?.close(); await releaseServer(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = await startDemo();
  process.stdout.write(`Raw Photo Agent demo: ${demo.url}\nLightroom remains the editor. Keep its Develop window beside the browser.\n`);
  let closing = false;
  for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{ if(!closing){closing=true;void demo.close().then(()=>process.exit(0));} });
}
