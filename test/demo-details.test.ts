import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { cropDetails, readDetailSource, DETAIL_EDGE } from '../src/demo/details.ts';

test('detail crops sample original export pixels at requested centers, clamp edges, and never enlarge', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'demo-details-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.jpg');
  const width = 2000, height = 1200;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    pixels[offset] = Math.round(x / (width - 1) * 255); pixels[offset + 1] = Math.round(y / (height - 1) * 255); pixels[offset + 2] = 100;
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toFile(sourcePath);
  const source = await readDetailSource(sourcePath, 'checkpoint-token');
  const points = [{ id: 'middle', label: 'Center region', x: 0.5, y: 0.5 }, { id: 'corner', label: 'Top left', x: 0, y: 0 }];
  const details = await cropDetails(source, points, join(directory, 'crops'));
  for (const detail of details) {
    assert.equal(detail.width, DETAIL_EDGE); assert.equal(detail.height, DETAIL_EDGE);
    assert.equal(detail.sourceWidth, width); assert.equal(detail.sourceHeight, height);
    const meta = await sharp(detail.path).metadata(); assert.equal(meta.format, 'jpeg'); assert.equal(meta.width, DETAIL_EDGE);
  }
  const middle = await sharp(details[0].path).raw().toBuffer();
  const centerOffset = (448 * DETAIL_EDGE + 448) * 3;
  assert.ok(Math.abs(middle[centerOffset] - 128) < 3);
  assert.ok(Math.abs(middle[centerOffset + 1] - 128) < 3);
  const corner = await sharp(details[1].path).raw().toBuffer();
  assert.ok(corner[0] < 3 && corner[1] < 3);
  const smallPath = join(directory, 'small.jpg');
  await sharp({ create: { width: 120, height: 80, channels: 3, background: '#aaa' } }).jpeg().toFile(smallPath);
  const small = await cropDetails(await readDetailSource(smallPath, 'small'), [points[0]], join(directory, 'small'));
  assert.equal(small[0].width, 80); assert.equal(small[0].height, 80);
});

test('source dimension changes and invalid crop points cannot silently reuse evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'demo-details-changed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'source.jpg');
  const jpeg = (width: number) => sharp({ create: { width, height: 40, channels: 3, background: '#ddd' } }).jpeg().toBuffer();
  await writeFile(path, await jpeg(60));
  const source = await readDetailSource(path, 'saved');
  await writeFile(path, await jpeg(80));
  const points = [{ id: 'region', label: 'Visible region', x: 0.5, y: 0.5 }];
  await assert.rejects(cropDetails(source, points, directory), /changed dimensions/);
  await assert.rejects(cropDetails(source, [{ ...points[0], x: NaN }], directory), /valid detail points/);
});
