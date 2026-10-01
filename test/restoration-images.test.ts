import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import sharp from 'sharp';
import { compareLosslessTiff } from '../src/restoration/images.ts';
import { compareImages } from '../src/images.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-native-tiff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profileImage = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'black' } })
    .withIccProfile('srgb').tiff().toBuffer();
  const icc = (await sharp(profileImage).metadata()).icc!;
  return { directory, icc };
}

/** Small independent TIFF encoder: uint16 samples are written verbatim, without
 * Sharp's colour conversions. ICC embedding must not modify these code values. */
function nativeTiff(width: number, height: number, values: Uint16Array, icc?: Buffer, orientation = 1): Buffer {
  assert.equal(values.length, width * height * 3);
  const count = icc ? 12 : 11;
  const bitsOffset = 8 + 2 + count * 12 + 4;
  const profileOffset = bitsOffset + 6;
  const pixelOffset = profileOffset + (icc?.length ?? 0);
  const bytes = Buffer.alloc(pixelOffset + values.length * 2);
  bytes.write('II'); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4); bytes.writeUInt16LE(count, 8);
  let entry = 10;
  const tag = (id: number, type: number, length: number, value: number) => {
    bytes.writeUInt16LE(id, entry); bytes.writeUInt16LE(type, entry + 2); bytes.writeUInt32LE(length, entry + 4);
    if (type === 3 && length === 1) bytes.writeUInt16LE(value, entry + 8); else bytes.writeUInt32LE(value, entry + 8);
    entry += 12;
  };
  tag(256, 4, 1, width); tag(257, 4, 1, height); tag(258, 3, 3, bitsOffset);
  tag(259, 3, 1, 1); tag(262, 3, 1, 2); tag(273, 4, 1, pixelOffset);
  tag(274, 3, 1, orientation); tag(277, 3, 1, 3); tag(278, 4, 1, height);
  tag(279, 4, 1, values.length * 2); tag(284, 3, 1, 1);
  if (icc) tag(34675, 7, icc.length, profileOffset);
  for (let i = 0; i < 3; i++) bytes.writeUInt16LE(16, bitsOffset + i * 2);
  icc?.copy(bytes, profileOffset);
  for (let i = 0; i < values.length; i++) bytes.writeUInt16LE(values[i]!, pixelOffset + i * 2);
  return bytes;
}

test('preserves known embedded-ICC native samples and detects one low bit', async t => {
  const { directory, icc } = await fixture(t);
  const before = join(directory, 'before.tif'); const after = join(directory, 'after.tif');
  const values = new Uint16Array([10000, 20000, 30000, 500, 65534, 1]);
  await writeFile(before, nativeTiff(2, 1, values, icc));
  const expected = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => expected.writeUInt16LE(value, index * 2));
  values[5] = 2;
  await writeFile(after, nativeTiff(2, 1, values, icc));
  const result = await compareLosslessTiff(before, after);
  assert.equal(result.comparable, true); assert.equal(result.pixelsIdentical, false);
  assert.equal(result.before.decodedSha256, createHash('sha256').update(expected).digest('hex'));
  assert.equal(result.before.metadata.iccSha256, result.after.metadata.iccSha256);
  assert.equal(result.maximumChannelDifference, 1); assert.equal(result.metrics?.changedChannels, 1);
  assert.equal(result.meanAbsoluteDifference, 1 / 6);
  assert.deepEqual(result.histogram, [{ difference: 0, channels: 5 }, { difference: 1, channels: 1 }]);
  assert.deepEqual(result.spatial?.boundingBox, { left: 1, top: 0, width: 1, height: 1 });
  const identical = await compareLosslessTiff(before, before);
  assert.equal(identical.pixelsIdentical, true); assert.equal(identical.spatial?.boundingBox, null);
  assert.equal(identical.spatial?.changedTiles, 0);
});

test('public restoration comparison preserves a native one-bit difference with an embedded ICC profile', async t => {
  const { directory, icc } = await fixture(t);
  const before = join(directory, 'before.tif'); const after = join(directory, 'after.tif');
  // Real trial sample codes: ICC conversion previously collapsed this blue-channel
  // distinction. The public path must compare the stored codes themselves.
  await writeFile(before, nativeTiff(1, 1, new Uint16Array([32707, 30979, 29634]), icc));
  await writeFile(after, nativeTiff(1, 1, new Uint16Array([32707, 30979, 29633]), icc));
  const result = await compareImages(before, after);
  assert.equal(result.sameDimensions, true); assert.equal(result.pixelsIdentical, false);
  assert.equal(result.bitDepth, 16); assert.equal(result.maximumChannelDifference, 1);
  assert.equal(result.meanAbsoluteDifference, 1 / 3); assert.equal(result.changedChannelFraction, 1 / 3);
});

test('coherent thin halo remains visible in spatial metrics despite a tiny image mean', async t => {
  const { directory, icc } = await fixture(t);
  const before = join(directory, 'before.tif'); const after = join(directory, 'after.tif');
  const width = 256; const height = 256; const values = new Uint16Array(width * height * 3).fill(10000);
  await writeFile(before, nativeTiff(width, height, values, icc));
  // A one-pixel rectangle on a tile boundary, one code value in one channel.
  for (let y = 63; y <= 70; y++) for (let x = 60; x <= 67; x++) {
    if (x === 60 || x === 67 || y === 63 || y === 70) values[(y * width + x) * 3]!++;
  }
  await writeFile(after, nativeTiff(width, height, values, icc));
  const output = join(directory, 'difference.png');
  const result = await compareLosslessTiff(before, after, { differenceMap: { path: output, amplification: 65535 } });
  assert.equal(result.pixelsIdentical, false); assert.equal(result.metrics?.changedPixels, 28);
  assert.ok(result.meanAbsoluteDifference! < 0.00015);
  assert.equal(result.spatial?.changedTiles, 4);
  assert.deepEqual(result.spatial?.boundingBox, { left: 60, top: 63, width: 8, height: 8 });
  assert.equal(result.spatial?.longestHorizontalRun, 8); assert.equal(result.spatial?.longestVerticalRun, 8);
  assert.equal(result.spatial?.horizontalAdjacentPairs, 14); assert.equal(result.spatial?.verticalAdjacentPairs, 14);
  assert.deepEqual(result.histogram, [{ difference: 0, channels: width * height * 3 - 28 }, { difference: 1, channels: 28 }]);
  assert.equal(result.differenceMap?.amplification, 65535); assert.equal(result.differenceMap?.filtered, false);
  assert.equal((await sharp(output).metadata()).channels, 1);
  const map = await sharp(output).greyscale().raw().toBuffer();
  assert.equal(map[63 * width + 60], 255); assert.equal(map[65 * width + 64], 0);
  assert.equal((await readFile(before)).equals(nativeTiff(width, height, new Uint16Array(width * height * 3).fill(10000), icc)), true);
  await assert.rejects(compareLosslessTiff(before, after, { differenceMap: { path: output, amplification: 10 } }), /EEXIST/);
});

test('rejects mismatched geometry, depth, profile, orientation, and stale file provenance', async t => {
  const { directory, icc } = await fixture(t);
  const before = join(directory, 'before.tif'); const other = join(directory, 'other.tif');
  await writeFile(before, nativeTiff(2, 2, new Uint16Array(12).fill(10000), icc));
  await writeFile(other, nativeTiff(4, 1, new Uint16Array(12).fill(10000), icc));
  let result = await compareLosslessTiff(before, other);
  assert.equal(result.sameDimensions, false); assert.equal(result.comparable, false); assert.equal(result.pixelsIdentical, false);
  assert.equal(result.metrics, undefined);
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'black' } }).withIccProfile('srgb').tiff().toFile(other);
  result = await compareLosslessTiff(before, other);
  assert.ok(result.issues.some(issue => issue.includes('16-bit'))); assert.equal(result.pixelsIdentical, false);
  const differentIcc = Buffer.from(icc); differentIcc[80] = (differentIcc[80]! + 1) % 256;
  await writeFile(other, nativeTiff(2, 2, new Uint16Array(12).fill(10000), differentIcc));
  result = await compareLosslessTiff(before, other);
  assert.ok(result.issues.includes('Embedded ICC profiles differ')); assert.equal(result.pixelsIdentical, false);
  await writeFile(other, nativeTiff(2, 2, new Uint16Array(12).fill(10000), icc, 6));
  result = await compareLosslessTiff(before, other);
  assert.ok(result.issues.some(issue => issue.includes('upright'))); assert.equal(result.comparable, false);
  await writeFile(other, nativeTiff(2, 2, new Uint16Array(12).fill(10000)));
  result = await compareLosslessTiff(other, other);
  assert.ok(result.issues.some(issue => issue.includes('ICC profile'))); assert.equal(result.pixelsIdentical, false);
  result = await compareLosslessTiff(before, before, { expectedAfterSha256: '0'.repeat(64) });
  assert.ok(result.issues.some(issue => issue.includes('provenance'))); assert.equal(result.pixelsIdentical, false);
  const valid = await compareLosslessTiff(before, before);
  assert.equal((await compareLosslessTiff(before, before, { expectedBeforeSha256: valid.before.sha256, expectedAfterSha256: valid.after.sha256 })).pixelsIdentical, true);
});

test('signed residual sweeps detect one-code defects across tile and image boundaries', async t => {
  const { directory, icc } = await fixture(t);
  const before = join(directory, 'before.tif'); const after = join(directory, 'after.tif');
  const width = 130; const height = 130;
  const baseline = new Uint16Array(width * height * 3).fill(32768);
  await writeFile(before, nativeTiff(width, height, baseline, icc));
  const regions = [
    { left: 129, top: 129, width: 1, height: 1 },
    { left: 129, top: 0, width: 1, height: 130 },
    { left: 63, top: 63, width: 3, height: 3 },
  ];
  for (const region of regions) for (const residual of [-256, -1, 1, 256]) {
    const values = baseline.slice(); const pixels = region.width * region.height;
    for (let y = region.top; y < region.top + region.height; y++) for (let x = region.left; x < region.left + region.width; x++) {
      // Opposing red/blue residuals must not cancel in aggregate measurements.
      values[(y * width + x) * 3]! += residual;
      values[(y * width + x) * 3 + 2]! -= residual;
    }
    await writeFile(after, nativeTiff(width, height, values, icc));
    const result = await compareLosslessTiff(before, after);
    assert.equal(result.comparable, true); assert.equal(result.pixelsIdentical, false);
    assert.equal(result.metrics?.changedPixels, pixels); assert.equal(result.metrics?.changedChannels, pixels * 2);
    assert.equal(result.maximumChannelDifference, Math.abs(residual));
    assert.equal(result.metrics?.absoluteDifferenceSum, pixels * 2 * Math.abs(residual));
    assert.deepEqual(result.spatial?.boundingBox, region);
    assert.equal(result.spatial?.longestHorizontalRun, region.width); assert.equal(result.spatial?.longestVerticalRun, region.height);
    assert.deepEqual(result.histogram, [{ difference: 0, channels: width * height * 3 - pixels * 2 }, { difference: Math.abs(residual), channels: pixels * 2 }]);
    assert.equal(result.spatial?.tiles.reduce((sum, tile) => sum + tile.changedPixels, 0), pixels);
  }
});
