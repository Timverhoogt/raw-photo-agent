import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { cropFrame, cropMatchedDetails, planMatchedDetails } from '../src/demo/detail-geometry.ts';
import type { FramedExport } from '../src/demo/detail-geometry.ts';
import { cropDetails, readDetailSource } from '../src/demo/details.ts';

const FULL = { left: 0, top: 0, right: 1, bottom: 1 };
const point = (x: number, y: number, id = 'region') => ({ id, label: 'Visible region', x, y });

test('crop frames come from Lightroom settings and refuse ambiguous or straightened crops', () => {
  assert.deepEqual(cropFrame({ Exposure2012: 0 }), FULL);
  assert.deepEqual(cropFrame({ HasCrop: false, CropLeft: 0.2, CropTop: 0.1, CropRight: 0.9, CropBottom: 0.8 }), FULL);
  assert.deepEqual(cropFrame({ HasCrop: true, CropLeft: 0.2, CropTop: 0.1, CropRight: 0.9, CropBottom: 0.8, CropAngle: 0 }),
    { left: 0.2, top: 0.1, right: 0.9, bottom: 0.8 });
  assert.throws(() => cropFrame({ CropLeft: 0.2, CropTop: 0.1, CropRight: 0.9, CropBottom: 0.8, CropAngle: 1.5 }), /Straightened/);
  assert.throws(() => cropFrame({ CropLeft: 0.2, CropRight: 0.9 }), /incomplete/);
  assert.throws(() => cropFrame({ HasCrop: true }), /incomplete/);
  assert.throws(() => cropFrame({ CropLeft: 0.9, CropTop: 0, CropRight: 0.2, CropBottom: 1 }), /positive size/);
  assert.throws(() => cropFrame(null), /develop settings/);
});

test('the same point maps to the same scene position across crops and resolutions', () => {
  const exports: FramedExport[] = [
    { id: 'full', width: 6000, height: 4000, frame: FULL },
    { id: 'tight', width: 3000, height: 2400, frame: { left: 0.25, top: 0.2, right: 0.75, bottom: 0.8 } },
    // A downscaled export of a different crop: half the pixels per scene unit.
    { id: 'reduced', width: 2400, height: 1500, frame: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.85 } },
  ];
  const [plan] = planMatchedDetails(exports, 'tight', [point(0.5, 0.5)]);
  assert.ok(plan.available);
  assert.deepEqual(plan.candidates.full.window, { left: 2552, top: 1552, width: 896, height: 896 });
  assert.deepEqual(plan.candidates.tight.window, { left: 1052, top: 752, width: 896, height: 896 });
  assert.deepEqual(plan.candidates.reduced.window, { left: 976, top: 576, width: 448, height: 448 });
  assert.equal(plan.candidates.reduced.scale, 0.5);
  assert.ok(Math.abs(plan.candidates.full.x - 0.5) < 1e-12 && Math.abs(plan.candidates.full.y - 0.5) < 1e-12);
  assert.ok(Math.abs(plan.candidates.reduced.x - 0.5) < 1e-12 && Math.abs(plan.candidates.reduced.y - 0.4 / 0.75) < 1e-12);
});

test('regions outside any compared crop are unavailable rather than silently substituted', () => {
  const exports: FramedExport[] = [
    { id: 'full', width: 3000, height: 2000, frame: FULL },
    { id: 'tight', width: 1500, height: 1200, frame: { left: 0.25, top: 0.2, right: 0.75, bottom: 0.8 } },
  ];
  const plans = planMatchedDetails(exports, 'full', [point(0.1, 0.5, 'outside'), point(0.5, 0.5, 'inside')]);
  assert.equal(plans[0].available, false);
  assert.match(!plans[0].available ? plans[0].reason : '', /outside the crop of candidate tight/);
  assert.equal(plans[1].available, true);
});

test('windows near a crop edge stay inside the shared region for every candidate', () => {
  const exports: FramedExport[] = [
    { id: 'full', width: 3000, height: 2000, frame: FULL },
    { id: 'tight', width: 1500, height: 1200, frame: { left: 0.25, top: 0.2, right: 0.75, bottom: 0.8 } },
  ];
  const [plan] = planMatchedDetails(exports, 'tight', [point(0, 0)]);
  assert.ok(plan.available);
  // Clamped to the tight crop's corner in both exports, not to the full frame's corner.
  assert.deepEqual(plan.candidates.tight.window, { left: 0, top: 0, width: 896, height: 896 });
  assert.deepEqual(plan.candidates.full.window, { left: 750, top: 400, width: 896, height: 896 });
});

test('export dimensions that disagree with the recorded crop stop the plan', () => {
  const exports: FramedExport[] = [
    { id: 'full', width: 3000, height: 2000, frame: FULL },
    // A 90-degree orientation mix-up: dimensions swapped relative to the recorded crop.
    { id: 'tight', width: 1200, height: 1500, frame: { left: 0.25, top: 0.2, right: 0.75, bottom: 0.8 } },
  ];
  assert.throws(() => planMatchedDetails(exports, 'full', [point(0.5, 0.5)]), /does not match its recorded crop/);
  // One-pixel export rounding remains acceptable.
  exports[1] = { id: 'tight', width: 1501, height: 1199, frame: { left: 0.25, top: 0.2, right: 0.75, bottom: 0.8 } };
  assert.equal(planMatchedDetails(exports, 'full', [point(0.5, 0.5)])[0].available, true);
  assert.throws(() => planMatchedDetails(exports, 'missing', [point(0.5, 0.5)]), /belong to one of the compared exports/);
  assert.throws(() => planMatchedDetails([exports[0], { ...exports[0] }], 'full', [point(0.5, 0.5)]), /uniquely identified/);
});

test('uncropped candidates keep the existing detail windows', () => {
  const exports: FramedExport[] = [{ id: 'a', width: 2000, height: 1200, frame: FULL }, { id: 'b', width: 2000, height: 1200, frame: FULL }];
  for (const [x, y] of [[0.5, 0.5], [0, 0], [1, 1], [0.37, 0.81]]) {
    const [plan] = planMatchedDetails(exports, 'a', [point(x, y)]);
    assert.ok(plan.available);
    const legacyLeft = Math.max(0, Math.min(2000 - 896, Math.round(x * 1999 - 447.5)));
    const legacyTop = Math.max(0, Math.min(1200 - 896, Math.round(y * 1199 - 447.5)));
    assert.ok(Math.abs(plan.candidates.b.window.left - legacyLeft) <= 1 && Math.abs(plan.candidates.b.window.top - legacyTop) <= 1);
    assert.deepEqual(plan.candidates.a.window, plan.candidates.b.window);
  }
});

test('matched crops from differently cropped and scaled exports show the same scene pixels', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'detail-geometry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A textured synthetic scene, so any misregistration produces large differences.
  const width = 2400, height = 1600;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    pixels[offset] = 128 + Math.round(100 * Math.sin(x / 7) * Math.cos(y / 11));
    pixels[offset + 1] = Math.round(x / width * 255); pixels[offset + 2] = Math.round(y / height * 255);
  }
  const scene = sharp(pixels, { raw: { width, height, channels: 3 } });
  const write = async (name: string, region: { left: number; top: number; width: number; height: number }, scale = 1) => {
    const path = join(directory, `${name}.jpg`);
    let image = scene.clone().extract(region);
    if (scale !== 1) image = image.resize(Math.round(region.width * scale), Math.round(region.height * scale), { kernel: 'lanczos3' });
    await image.jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toFile(path);
    return path;
  };
  const tight = { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 };
  const sources = [
    { id: 'full', frame: FULL, ...await readDetailSource(await write('full', { left: 0, top: 0, width, height }), 'full') },
    { id: 'tight', frame: tight, ...await readDetailSource(await write('tight', { left: 600, top: 400, width: 1200, height: 800 }), 'tight') },
  ];
  const { plans, details } = await cropMatchedDetails(sources, 'tight', [point(0.3, 0.6)], join(directory, 'details'));
  assert.ok(plans[0].available);
  const [fullDetail] = details.full, [tightDetail] = details.tight;
  assert.equal(fullDetail.width, tightDetail.width);
  assert.equal(fullDetail.x, 0.3); assert.equal(tightDetail.x, 0.3);
  assert.ok(Math.abs(fullDetail.frameX - (0.25 + 0.3 * 0.5)) < 1e-12);
  const raw = (path: string) => sharp(path).raw().toBuffer();
  const meanDifference = (a: Buffer, b: Buffer) => a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;
  assert.ok(meanDifference(await raw(fullDetail.path), await raw(tightDetail.path)) < 2);
  // The legacy same-coordinate crop of the full export shows a different region.
  const [legacy] = await cropDetails(sources[0], [point(0.3, 0.6)], join(directory, 'legacy'));
  // Green and blue encode scene position, so their channel means reveal the displaced region.
  const position = async (path: string) => (await sharp(path).stats()).channels.slice(1).map(channel => channel.mean);
  const [legacyPosition, matchedPosition, fullPosition] = await Promise.all([position(legacy.path), position(tightDetail.path), position(fullDetail.path)]);
  assert.ok(Math.abs(legacyPosition[0] - matchedPosition[0]) + Math.abs(legacyPosition[1] - matchedPosition[1]) > 20);
  assert.ok(Math.abs(fullPosition[0] - matchedPosition[0]) + Math.abs(fullPosition[1] - matchedPosition[1]) < 1);

  // A reduced-resolution export receives a smaller window of the same scene, never enlarged.
  const reduced = { id: 'reduced', frame: tight, ...await readDetailSource(await write('reduced', { left: 600, top: 400, width: 1200, height: 800 }, 0.5), 'reduced') };
  const matched = await cropMatchedDetails([sources[0], reduced], 'reduced', [point(0.3, 0.6)], join(directory, 'scaled'));
  const [small] = matched.details.reduced, [large] = matched.details.full;
  assert.equal(small.width * 2, large.width);
  assert.equal(small.scale, 0.5);
  const downscaled = await sharp(large.path).resize(small.width, small.height, { kernel: 'lanczos3' }).raw().toBuffer();
  assert.ok(meanDifference(downscaled, await raw(small.path)) < 6);
});
