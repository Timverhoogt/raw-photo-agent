import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import sharp from 'sharp';
import { RunStore } from '../src/store.ts';
import { journalExport, mapRunDetails, parseDetailPoints } from '../src/detail-map.ts';

const WIDTH = 2400, HEIGHT = 1600;
const TIGHT = { CropLeft: 0.25, CropTop: 0.25, CropRight: 0.75, CropBottom: 0.75, CropAngle: 0, HasCrop: true };

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'detail-map-'));
  const store = new RunStore(join(root, 'runs.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const offset = (y * WIDTH + x) * 3;
    pixels[offset] = 128 + Math.round(100 * Math.sin(x / 7) * Math.cos(y / 11));
    pixels[offset + 1] = Math.round(x / WIDTH * 255); pixels[offset + 2] = Math.round(y / HEIGHT * 255);
  }
  const scene = sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } });
  const exportImage = async (name: string, region: { left: number; top: number; width: number; height: number }) => {
    const path = join(root, `${name}.jpg`);
    await scene.clone().extract(region).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toFile(path);
    return path;
  };
  store.createRun({ id: 'run', sourcePhotoId: 'raw', workingPhotoId: 'copy', intent: 'Bird portrait' });
  store.addCandidate({ id: 'wide', runId: 'run', snapshotId: 's1', stateToken: 'state-wide', settings: { Exposure2012: 0 } });
  store.addCandidate({ id: 'tight', runId: 'run', parentId: 'wide', snapshotId: 's2', stateToken: 'state-tight', settings: { Exposure2012: 0, ...TIGHT } });
  // Mirror PhotoController.logged(): started params, then the completed result.
  let operation = 0;
  const render = (stateToken: string, outputPath: string, maxEdge: number, format = 'JPEG', resultToken = stateToken) => {
    const operationId = `render-${++operation}`;
    store.addEvent('run', 'operation_started', { operationId, operation: 'render', params: { photoId: 'copy', expectedStateToken: stateToken, outputPath, maxEdge, format } });
    store.addEvent('run', 'operation_completed', { operationId, operation: 'render', result: { outputPath, photoId: 'copy', stateToken: resultToken } });
    return operationId;
  };
  return { root, store, exportImage, render };
}

test('journal exports are matched to the exact candidate state and prefer the largest render', async t => {
  const { store, exportImage, render } = await fixture(t);
  const small = await exportImage('wide-small', { left: 0, top: 0, width: 300, height: 200 });
  const large = await exportImage('wide-large', { left: 0, top: 0, width: WIDTH, height: HEIGHT });
  const tiff = await exportImage('wide-tiff', { left: 0, top: 0, width: WIDTH, height: HEIGHT });
  const wide = store.getCandidate('wide')!;
  assert.equal(journalExport(store, 'run', wide), undefined);
  render('state-wide', small, 2048);
  const largest = render('state-wide', large, 8192);
  render('state-wide', tiff, 8192, 'TIFF');
  render('state-wide', join(tmpdir(), 'detail-map-missing.jpg'), 8192);
  // An export whose returned state differs from the candidate is not its evidence.
  render('state-wide', small, 8192, 'JPEG', 'state-other');
  assert.deepEqual(journalExport(store, 'run', wide), { path: large, maxEdge: 8192, operationId: largest });
  assert.equal(journalExport(store, 'run', store.getCandidate('tight')!), undefined);
});

test('detail-map crops the same scene region from a wide and a cropped candidate', async t => {
  const { root, store, exportImage, render } = await fixture(t);
  render('state-wide', await exportImage('wide', { left: 0, top: 0, width: WIDTH, height: HEIGHT }), 8192);
  render('state-tight', await exportImage('tight', { left: 600, top: 400, width: 1200, height: 800 }), 8192);
  const points = parseDetailPoints('[{"id":"eye","label":"Eye","x":0.3,"y":0.6},{"id":"edge","label":"Left edge","x":0.1,"y":0.5}]');
  const output = join(root, 'map');
  const report = await mapRunDetails(store, 'run', ['wide', 'tight'], 'wide', points, output);
  assert.deepEqual(report.candidates.map(item => [item.id, item.width, item.height]), [['wide', 2400, 1600], ['tight', 1200, 800]]);
  assert.deepEqual(report.candidates[1].frame, { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 });
  const [eye, edge] = report.regions;
  assert.equal(edge.available, false);
  assert.ok(eye.available);
  const [wideDetail, tightDetail] = eye.candidates;
  assert.deepEqual(wideDetail.window, { left: 600, top: 400, width: 800, height: 800 });
  assert.deepEqual(tightDetail.window, { left: 0, top: 0, width: 800, height: 800 });
  const raw = (path: string) => sharp(path).raw().toBuffer();
  const [a, b] = await Promise.all([raw(wideDetail.path), raw(tightDetail.path)]);
  assert.ok(a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length < 2);
  const sheet = await sharp(eye.sheet).metadata();
  assert.equal(sheet.width, 800 * 2 + 8); assert.equal(sheet.height, 800);
  await assert.rejects(mapRunDetails(store, 'run', ['wide', 'tight'], 'wide', points, output), /already exists/);
});

test('detail-map refuses missing evidence and invalid requests before writing output', async t => {
  const { root, store, exportImage, render } = await fixture(t);
  const points = parseDetailPoints('[{"id":"eye","label":"Eye","x":0.5,"y":0.5}]');
  const output = join(root, 'map');
  render('state-wide', await exportImage('wide', { left: 0, top: 0, width: WIDTH, height: HEIGHT }), 8192);
  await assert.rejects(mapRunDetails(store, 'run', ['wide', 'tight'], 'wide', points, output), /no recorded JPEG export.*--size 8192/);
  await assert.rejects(mapRunDetails(store, 'run', ['wide'], 'wide', points, output), /at least two/);
  await assert.rejects(mapRunDetails(store, 'run', ['wide', 'tight'], 'other', points, output), /--anchor/);
  await assert.rejects(mapRunDetails(store, 'run', ['wide', 'ghost'], 'wide', points, output), /does not belong/);
  // Dimensions swapped relative to the recorded crop cannot be verified.
  render('state-tight', await exportImage('rotated', { left: 600, top: 400, width: 800, height: 1200 }), 8192);
  await assert.rejects(mapRunDetails(store, 'run', ['wide', 'tight'], 'wide', points, output), /does not match its recorded crop/);
  assert.equal(existsSync(output), false);
  assert.throws(() => parseDetailPoints('{"id":"eye"}'), /JSON array/);
  assert.throws(() => parseDetailPoints('[{"id":"eye","label":"Eye","x":2,"y":0.5}]'), /JSON array/);
});
