import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import sharp from 'sharp';
import { verifyRestoredRendering } from '../src/images.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-render-verification-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reference = join(directory, 'reference.png');
  const matching = join(directory, 'matching.png');
  const differing = join(directory, 'differing.png');
  const pixels = Buffer.alloc(16 * 16 * 3, 100);
  await sharp(pixels, { raw: { width: 16, height: 16, channels: 3 } }).png().toFile(reference);
  await sharp(pixels, { raw: { width: 16, height: 16, channels: 3 } }).png().toFile(matching);
  // Even one channel differing by one level must remain an exact mismatch.
  pixels[0] = 101;
  await sharp(pixels, { raw: { width: 16, height: 16, channels: 3 } }).png().toFile(differing);
  return { reference, matching, differing };
}

test('an exact first restored render needs only one export', async t => {
  const { reference, matching } = await fixture(t);
  let calls = 0;
  const result = await verifyRestoredRendering(reference, async () => {
    calls++;
    return { previewPath: matching, candidateId: 'baseline' };
  });
  assert.equal(calls, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.difference.pixelsIdentical, true);
  assert.equal(result.preview.candidateId, 'baseline');
});

test('a transient mismatch retries once and preserves both render comparisons', async t => {
  const { reference, matching, differing } = await fixture(t);
  let calls = 0;
  const result = await verifyRestoredRendering(reference, async () => {
    calls++;
    return { previewPath: calls === 1 ? differing : matching };
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.attempts.map(attempt => attempt.previewPath), [differing, matching]);
  assert.deepEqual(result.attempts.map(attempt => attempt.difference.pixelsIdentical), [false, true]);
  assert.equal(result.difference.pixelsIdentical, true);
  assert.equal(result.preview.previewPath, matching);
});

test('persistent one-level mismatch remains false after exactly two exports', async t => {
  const { reference, differing } = await fixture(t);
  let calls = 0;
  const result = await verifyRestoredRendering(reference, async () => {
    calls++;
    return { previewPath: differing };
  });
  assert.equal(calls, 2);
  assert.equal(result.attempts.length, 2);
  assert.ok(result.attempts.every(attempt => !attempt.difference.pixelsIdentical));
  assert.equal(result.difference.pixelsIdentical, false);
  assert.equal(result.difference.maximumChannelDifference, 1);
});
