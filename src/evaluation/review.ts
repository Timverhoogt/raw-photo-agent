import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import type { EvaluationBatch, EvaluationRender } from './runner.ts';

interface BlindCandidate { id: string; label: string; image: string }
interface BlindCase { id: string; candidates: BlindCandidate[]; width: number; height: number }
interface ReviewPrivate {
  version: 1; id: string; batchId: string; corpusFingerprint: string; seed: string;
  cases: Array<BlindCase & { assetId: string; name: string; mapping: Record<string, EvaluationRender> }>;
  excluded: Array<{ assetId: string; status: string; error?: string }>;
}
export interface Vote { caseId: string; candidateId: string; reviewer: string; notes: string; recordedAt: string }
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function buildReview(batch: EvaluationBatch, destination: string, seed = randomBytes(32).toString('hex')) {
  if (!seed.trim() || seed.length > 1024) throw new Error('A nonempty blinding seed of at most 1024 characters is required.');
  const hash = (value: string) => createHmac('sha256', seed).update(value).digest('hex');
  const id = `review-${hash(batch.id).slice(0, 20)}`; const root = resolve(destination);
  await mkdir(root, { mode: 0o700 });
  const publicDirectory = join(root, 'review'); await mkdir(join(publicDirectory, 'images'), { recursive: true, mode: 0o700 });
  const privateManifest: ReviewPrivate = { version: 1, id, batchId: batch.id, corpusFingerprint: batch.corpusFingerprint, seed, cases: [], excluded: [] };
  for (const item of batch.cases) {
    if (item.status !== 'complete') { privateManifest.excluded.push({ assetId: item.assetId, status: item.status, error: item.error }); continue; }
    if (item.renders.length !== 3 || new Set(item.renders.map(render => render.role)).size !== 3
      || !['starting', 'fixed', 'agent'].every(role => item.renders.some(render => render.role === role))) throw new Error(`Case lacks three actual comparator renders: ${item.assetId}`);
    const caseId = `case-${hash(`${batch.corpusFingerprint}:${item.assetId}`).slice(0, 16)}`;
    const candidates: BlindCandidate[] = []; const mapping: Record<string, EvaluationRender> = {}; let width = 0; let height = 0;
    const order = item.renders.map(render => ({ render, key: hash(`${caseId}:${render.role}:${render.sha256}`) })).sort((a, b) => a.key.localeCompare(b.key));
    for (const [index, { render, key }] of order.entries()) {
      const bytes = await readFile(render.path);
      if (sha(bytes) !== render.sha256) throw new Error(`Saved render changed: ${render.path}`);
      const metadata = await sharp(bytes).metadata();
      if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height || metadata.orientation && metadata.orientation !== 1) throw new Error('Review requires upright actual Lightroom JPEG renders.');
      if (index && (metadata.width !== width || metadata.height !== height)) throw new Error('Comparison renders must have matching dimensions.');
      width = metadata.width; height = metadata.height;
      const candidateId = `candidate-${key.slice(0, 16)}`; const image = `images/${candidateId}.png`;
      // PNG preserves decoded export pixels and strips file/camera/role metadata that could reveal identity.
      await sharp(bytes).png().toFile(join(publicDirectory, image)); await chmod(join(publicDirectory, image), 0o600);
      candidates.push({ id: candidateId, label: String.fromCharCode(65 + index), image }); mapping[candidateId] = render;
    }
    privateManifest.cases.push({ id: caseId, assetId: item.assetId, name: item.name, candidates, mapping, width, height });
  }
  if (!privateManifest.cases.length) throw new Error('No complete cases with real renders are available for blinded review.');
  privateManifest.cases.sort((a, b) => hash(a.id).localeCompare(hash(b.id)));
  const publicManifest = { version: 1, id, excludedCount: privateManifest.excluded.length,
    cases: privateManifest.cases.map(({ id, candidates, width, height }) => ({ id, candidates, width, height })) };
  await writeFile(join(root, 'private.json'), JSON.stringify(privateManifest, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile(join(publicDirectory, 'cases.json'), JSON.stringify(publicManifest, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile(join(publicDirectory, 'index.html'), reviewHtml(publicManifest), { flag: 'wx', mode: 0o600 });
  return { id, directory: root, page: join(publicDirectory, 'index.html'), caseCount: privateManifest.cases.length, excludedCount: privateManifest.excluded.length };
}
function reviewHtml(manifest: { id: string; cases: BlindCase[]; excludedCount: number }) {
  const behavior = `const reviewId=${JSON.stringify(manifest.id)};
function quote(value){const apostrophe=String.fromCharCode(39);return apostrophe+value.split(apostrophe).join(apostrophe+String.fromCharCode(92)+apostrophe+apostrophe)+apostrophe}
const choices=new Map();
function update(caseId){const reviewer=document.getElementById('reviewer').value.trim();const notes=document.getElementById('notes-'+caseId).value;document.getElementById('command-'+caseId).textContent='node src/evaluation/cli.ts vote --review '+quote(reviewId)+' --case '+quote(caseId)+' --candidate '+quote(choices.get(caseId))+' --reviewer '+quote(reviewer)+' --notes '+quote(notes)}
document.querySelectorAll('button[data-case]').forEach(button=>button.addEventListener('click',()=>{const caseId=button.dataset.case;choices.set(caseId,button.dataset.candidate);document.querySelectorAll('button[data-case="'+caseId+'"]').forEach(b=>b.classList.toggle('chosen',b===button));update(caseId)}));
document.addEventListener('input',()=>choices.forEach((_value,caseId)=>update(caseId)));`;
  const sections = manifest.cases.map((item, index) => `<section><h2>Photograph ${index + 1}</h2><p class="muted">${escape(item.id)} · ${item.width} × ${item.height} export pixels</p><div class="grid">${item.candidates.map(candidate => `<figure><figcaption>Version ${candidate.label}</figcaption><a href="${candidate.image}" target="_blank"><img src="${candidate.image}" alt="Photograph ${index + 1}, version ${candidate.label}" loading="lazy"></a><button data-case="${item.id}" data-candidate="${candidate.id}">Prefer ${candidate.label}</button><small>${candidate.id}</small></figure>`).join('')}</div><p><button data-case="${item.id}" data-candidate="tie">No visible preference</button> <button data-case="${item.id}" data-candidate="none">None acceptable</button></p><label>Visible defects or unnecessary edits <textarea id="notes-${item.id}" rows="2" placeholder="Optional observations"></textarea></label><pre id="command-${item.id}">Choose a preference to prepare its recording command.</pre></section>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Photograph quality review</title><style>body{margin:0;background:#151719;color:#e9e9e9;font:16px system-ui,sans-serif;padding:28px}main{max-width:1800px;margin:auto}h1{font-size:28px}h2{font-size:21px}p{max-width:900px;line-height:1.6}.muted,small{color:#b4bcc4}section{padding:25px 0;border-top:1px solid #42484d;margin-top:30px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}figure{margin:0}figcaption{font-weight:650;margin-bottom:12px}img{width:100%;height:auto;display:block;background:#000}button{margin:12px 5px 8px 0;padding:10px 16px;border:1px solid #687984;border-radius:6px;background:#27313a;color:#fff;cursor:pointer}button.chosen{background:#336b52}small{display:block;overflow-wrap:anywhere}textarea,input{display:block;background:#20262b;color:#fff;border:1px solid #607080;padding:10px;border-radius:5px;width:min(700px,90%);margin-top:8px}pre{white-space:pre-wrap;word-break:break-all;background:#22282c;padding:16px;line-height:1.5;font-size:13px}@media(max-width:850px){.grid{grid-template-columns:1fr}}</style><main><h1>Which version would you keep?</h1><p>Compare the complete photograph, then open an image for its exported detail. Judge light, color, subject clarity and visible defects. Versions are blinded; no ranking or preference has been supplied. All images come from actual saved renders.</p><p class="muted">${manifest.cases.length} complete photographs${manifest.excludedCount ? `; ${manifest.excludedCount} incomplete cases excluded` : ''}. Selecting a button prepares a command. It does not submit an answer or change Lightroom. Run the command after adding your observations to record your immutable preference.</p><label>Your reviewer name <input id="reviewer" value="photographer" maxlength="100"></label>${sections}</main><script>${behavior}</script></html>`;
}
export async function recordVote(directory: string, input: { caseId: string; candidateId: string; reviewer: string; notes?: string }): Promise<Vote> {
  const manifest = JSON.parse(await readFile(join(directory, 'private.json'), 'utf8')) as ReviewPrivate;
  const item = manifest.cases.find(item => item.id === input.caseId);
  if (!item || ![...item.candidates.map(candidate => candidate.id), 'tie', 'none'].includes(input.candidateId)) throw new Error('Unknown case or candidate for this review.');
  if (typeof input.reviewer !== 'string' || !input.reviewer.trim() || input.reviewer.length > 100) throw new Error('An explicit reviewer name of 1–100 characters is required.');
  if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 4000)) throw new Error('Notes must be at most 4000 characters.');
  const fields = { caseId: input.caseId, candidateId: input.candidateId, reviewer: input.reviewer.trim(), notes: input.notes ?? '' };
  const vote = { ...fields, recordedAt: new Date().toISOString() };
  const votes = join(directory, 'votes'); await mkdir(votes, { recursive: true, mode: 0o700 });
  const path = join(votes, `${sha(JSON.stringify([fields.caseId, fields.reviewer]))}.json`);
  try { await writeFile(path, JSON.stringify(vote, null, 2), { flag: 'wx', mode: 0o600 }); return vote; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const old = JSON.parse(await readFile(path, 'utf8')) as Vote;
    if (Object.entries(fields).every(([key, value]) => old[key as keyof Vote] === value)) return old;
    throw new Error('This reviewer already answered this case. Recorded preferences are immutable.');
  }
}

/** Administrative unblinding report; reads only explicitly recorded photographer answers. */
export async function summarizeReview(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'private.json'), 'utf8')) as ReviewPrivate;
  const votesDirectory = join(directory, 'votes'); let files: string[] = [];
  try { files = await readdir(votesDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const counts = { starting: 0, fixed: 0, agent: 0, tie: 0, none: 0 };
  const notes: Array<Vote & { role: keyof typeof counts }> = [];
  const answered = new Set<string>(); const reviewerCases = new Set<string>();
  for (const name of files.sort()) {
    const path = join(votesDirectory, name);
    if (!/^[a-f0-9]{64}\.json$/.test(name) || !(await lstat(path)).isFile()) throw new Error(`Malformed vote artifact: ${name}`);
    let vote: Vote;
    try { vote = JSON.parse(await readFile(path, 'utf8')) as Vote; } catch { throw new Error(`Malformed vote JSON: ${name}`); }
    if (!vote || typeof vote !== 'object' || Array.isArray(vote) || Object.keys(vote).sort().join(',') !== 'candidateId,caseId,notes,recordedAt,reviewer'
      || typeof vote.caseId !== 'string' || typeof vote.candidateId !== 'string'
      || typeof vote.reviewer !== 'string' || !vote.reviewer.trim() || vote.reviewer !== vote.reviewer.trim() || vote.reviewer.length > 100
      || typeof vote.notes !== 'string' || vote.notes.length > 4000 || typeof vote.recordedAt !== 'string'
      || !Number.isFinite(Date.parse(vote.recordedAt)) || new Date(vote.recordedAt).toISOString() !== vote.recordedAt) throw new Error(`Malformed vote fields: ${name}`);
    const item = manifest.cases.find(item => item.id === vote.caseId);
    const mapped = item?.mapping[vote.candidateId];
    if (!item || !(['tie', 'none'].includes(vote.candidateId) || item.candidates.some(candidate => candidate.id === vote.candidateId) && mapped)) throw new Error(`Unknown case or candidate in vote: ${name}`);
    const role = vote.candidateId === 'tie' || vote.candidateId === 'none' ? vote.candidateId : mapped!.role;
    if (!Object.hasOwn(counts, role)) throw new Error(`Unknown role mapping in vote: ${name}`);
    const identity = JSON.stringify([vote.caseId, vote.reviewer]);
    if (name !== `${sha(identity)}.json` || reviewerCases.has(identity)) throw new Error(`Malformed or duplicate reviewer/case vote: ${name}`);
    reviewerCases.add(identity); answered.add(vote.caseId); counts[role]++; notes.push({ ...vote, role });
  }
  return { reviewId: manifest.id, batchId: manifest.batchId, corpusFingerprint: manifest.corpusFingerprint,
    completedCaseCount: manifest.cases.length, excludedCaseCount: manifest.excluded.length, answeredCaseCount: answered.size,
    actualHumanVotesCount: notes.length, preferenceNotYetMeasured: notes.length === 0, votesByRole: counts, notes,
    interpretation: notes.length === 0 ? 'No photographer preferences have been recorded.' : 'Counts reflect recorded reviewer answers, not automated scores. Multiple reviewers may answer the same case.' };
}
