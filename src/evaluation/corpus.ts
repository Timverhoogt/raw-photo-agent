import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const RAW_EXTENSIONS = new Set(['.3fr', '.arw', '.cr2', '.cr3', '.dng', '.erf', '.fff', '.iiq', '.kdc', '.mos', '.mrw', '.nef', '.nrw', '.orf', '.pef', '.raf', '.raw', '.rw2', '.rwl', '.srw']);
export interface CorpusFile { path: string; bytes: number; sha256: string }
export interface CorpusAsset { id: string; name: string; raw: CorpusFile; sidecars: CorpusFile[] }
export interface Corpus {
  version: 1; source: string; fingerprint: string; files: CorpusFile[]; assets: CorpusAsset[];
  otherFiles: CorpusFile[]; sidecarPolicy: 'copy-matching-xmp'; baseline: 'as-imported';
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function within(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
async function futureRealpath(path: string): Promise<string> {
  const full = resolve(path);
  try { return await realpath(full); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await futureRealpath(dirname(full)), basename(full));
  }
}
async function sourceFile(root: string, path: string) {
  const full = resolve(root, path);
  if (!within(root, full) || await realpath(full) !== full || !(await lstat(full)).isFile()) throw new Error(`Unsafe corpus path: ${path}`);
  return full;
}
export async function scanCorpus(source: string): Promise<Corpus> {
  const root = await realpath(resolve(source)); const files: CorpusFile[] = [];
  async function walk(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Corpus symlinks are not accepted: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const before = await lstat(path); const sha256 = await hashFile(path); const after = await lstat(path);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`Corpus changed while hashing: ${path}`);
        files.push({ path: relative(root, path).split(sep).join('/'), bytes: after.size, sha256 });
      }
    }
  }
  await walk(root); files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const assets = files.filter(file => RAW_EXTENSIONS.has(extname(file.path).toLowerCase())).map(raw => {
    const stem = raw.path.slice(0, -extname(raw.path).length).toLowerCase();
    const sidecars = files.filter(file => extname(file.path).toLowerCase() === '.xmp' && file.path.slice(0, -4).toLowerCase() === stem);
    if (sidecars.length > 1) throw new Error(`Ambiguous matching XMP sidecars for ${raw.path}`);
    return { id: `raw-${digest(JSON.stringify([raw.path, raw.sha256])).slice(0, 20)}`, name: basename(raw.path), raw, sidecars };
  });
  const used = new Set(assets.flatMap(asset => [asset.raw.path, ...asset.sidecars.map(file => file.path)]));
  return { version: 1, source: root, fingerprint: digest(JSON.stringify(files)), files, assets,
    otherFiles: files.filter(file => !used.has(file.path)), sidecarPolicy: 'copy-matching-xmp', baseline: 'as-imported' };
}
export async function indexCorpus(source: string, evaluationRoot: string) {
  const corpus = await scanCorpus(source); const root = await futureRealpath(evaluationRoot);
  if (root === corpus.source || within(corpus.source, root)) throw new Error('Evaluation output must be outside the source corpus.');
  await mkdir(join(root, 'corpora'), { recursive: true, mode: 0o700 });
  const path = join(root, 'corpora', `${corpus.fingerprint}.json`);
  let previous: { fingerprint: string } | undefined;
  try { previous = JSON.parse(await readFile(join(root, 'latest.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { await writeFile(path, `${JSON.stringify(corpus, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await writeFile(join(root, 'latest.json'), JSON.stringify({ fingerprint: corpus.fingerprint, path, source: corpus.source }, null, 2), { mode: 0o600 });
  return { corpus, path, unchanged: previous?.fingerprint === corpus.fingerprint };
}
export async function loadCorpus(evaluationRoot: string): Promise<Corpus> {
  const { path, source } = JSON.parse(await readFile(join(evaluationRoot, 'latest.json'), 'utf8'));
  return { ...JSON.parse(await readFile(path, 'utf8')), source };
}
/** Fresh copies are imported; the corpus RAW and matching XMP are never opened for writing. */
export async function stageAsset(corpus: Corpus, asset: CorpusAsset, destination: string, allowedUploadRoot: string) {
  const source = await realpath(corpus.source);
  await mkdir(allowedUploadRoot, { recursive: true, mode: 0o700 });
  const uploads = await realpath(allowedUploadRoot); const target = await futureRealpath(destination);
  if (!within(uploads, target) || target === source || within(source, target)) throw new Error('Staged assets must be inside the allowed upload root and outside the corpus.');
  if (!corpus.assets.some(item => item.id === asset.id && JSON.stringify(item) === JSON.stringify(asset))) throw new Error('Asset does not belong to this corpus.');
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (await realpath(dirname(target)) !== dirname(target)) throw new Error('Staging paths must not contain symlinks.');
  await mkdir(target, { mode: 0o700 });
  for (const file of [asset.raw, ...asset.sidecars]) {
    const original = await sourceFile(source, file.path);
    if (await hashFile(original) !== file.sha256) throw new Error(`Corpus changed; re-index before staging ${file.path}.`);
    const copied = join(target, basename(file.path));
    await copyFile(original, copied, 1); await chmod(copied, 0o600);
    if (await hashFile(copied) !== file.sha256 || await hashFile(original) !== file.sha256) throw new Error(`Copy verification failed: ${file.path}`);
  }
  return { path: join(target, asset.name), name: asset.name, sidecars: asset.sidecars.map(file => join(target, basename(file.path))) };
}
