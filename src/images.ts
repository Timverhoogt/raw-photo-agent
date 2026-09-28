import sharp from 'sharp';

export async function compareImages(beforePath: string, afterPath: string) {
  const [before, after] = await Promise.all([
    sharp(beforePath).rotate().toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(afterPath).rotate().toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (before.info.width !== after.info.width || before.info.height !== after.info.height || before.info.channels !== after.info.channels) {
    return { sameDimensions: false, pixelsIdentical: false, before: before.info, after: after.info };
  }
  let totalDifference = 0; let maxDifference = 0; let changedChannels = 0;
  for (let i = 0; i < before.data.length; i++) {
    const difference = Math.abs(before.data[i]! - after.data[i]!);
    totalDifference += difference;
    maxDifference = Math.max(maxDifference, difference);
    if (difference !== 0) changedChannels++;
  }
  return {
    sameDimensions: true, pixelsIdentical: changedChannels === 0,
    width: before.info.width, height: before.info.height,
    meanAbsoluteDifference: totalDifference / before.data.length,
    maximumChannelDifference: maxDifference,
    changedChannelFraction: changedChannels / before.data.length,
  };
}

/** Retry only the read-only export once if Lightroom's first restored render has
 * not settled. Each comparison remains exact; no pixel tolerance is introduced. */
export async function verifyRestoredRendering<T extends { previewPath: string }>(
  referencePath: string,
  render: () => Promise<T>,
) {
  const attempts: Array<{
    previewPath: string;
    difference: Awaited<ReturnType<typeof compareImages>>;
  }> = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const preview = await render();
    const difference = await compareImages(referencePath, preview.previewPath);
    attempts.push({ previewPath: preview.previewPath, difference });
    if (difference.pixelsIdentical || attempt === 1) {
      return { preview, difference, attempts };
    }
  }
  throw new Error('Restored-render verification did not execute.');
}

export async function detailCrop(input: string, output: string, region: { left: number; top: number; width: number; height: number }) {
  for (const [name, value] of Object.entries(region)) {
    if (!Number.isInteger(value) || value < (name === 'width' || name === 'height' ? 1 : 0)) throw new Error('Crop coordinates must be nonnegative integers and dimensions positive.');
  }
  await sharp(input).rotate().extract(region).png().toFile(output);
  return { path: output, ...region, note: 'Native pixels from the supplied render; export full resolution before interpreting this as sensor-level 100% detail.' };
}
