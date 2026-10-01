import type { PhotoController, PhotoState } from './controller.ts';
import { compareImages, verifyRestoredRendering } from './images.ts';

interface MaskReadback {
  state: PhotoState;
  maskContext: { selectedMaskId: string; parameters: Record<string, { value: number; min: number; max: number }> };
}

/** Diagnostic only: one bounded exposure change on an explicitly selected existing
 * mask, then one native restoration. Never retries a Lightroom mutation. */
export async function verifyMaskRoundtrip(controller: PhotoController, runId: string, candidateId: string, maskId: string, format: 'JPEG' | 'TIFF' = 'JPEG') {
  if (format !== 'JPEG' && format !== 'TIFF') throw new Error('Mask verification format must be JPEG or TIFF.');
  const run = controller.run(runId);
  if (run.status !== 'active') throw new Error('The mask diagnostic requires an active run on a separate working copy.');
  const baseline = controller.candidate(runId, candidateId);
  if (!baseline.previewPath) throw new Error('The baseline requires its saved preview.');
  const state = await controller.state(run.workingPhotoId);
  if (state.stateToken !== baseline.stateToken) throw new Error('Restore the diagnostic baseline before running this test.');
  const context = await controller.bridge.call<MaskReadback>('selected_mask', { photoId: run.workingPhotoId, maskId });
  const exposure = context.maskContext.parameters.local_Exposure;
  if (context.state.stateToken !== baseline.stateToken || context.maskContext.selectedMaskId !== maskId) throw new Error('The mask or photo changed before the diagnostic.');
  if (!exposure || ![exposure.value, exposure.min, exposure.max].every(Number.isFinite) || exposure.min >= exposure.max
    || exposure.value < exposure.min || exposure.value > exposure.max) throw new Error('Lightroom did not return a valid native mask exposure range.');
  const delta = Math.min(0.25, (exposure.max - exposure.min) / 4);
  const value = exposure.value + delta <= exposure.max ? exposure.value + delta : exposure.value - delta;
  try {
    // Two exports at the exact same state distinguish ordinary repeatability from
    // the additional question of restoration. Keep every failed comparison.
    // Lossless verification gets its own reference. Comparing that export to the
    // stored JPEG would test JPEG encoding differences rather than restoration.
    const referencePath = format === 'TIFF' ? (await controller.render(runId, candidateId, 2048, format)).previewPath! : baseline.previewPath;
    const before = await controller.render(runId, candidateId, 2048, format);
    const repeat = await controller.render(runId, candidateId, 2048, format);
    const baselineRepeat = await compareImages(before.previewPath!, repeat.previewPath!);
    const savedBaseline = await compareImages(referencePath, before.previewPath!);
    const changed = await controller.editMask(runId, candidateId, maskId, { local_Exposure: value }, 'Mask rollback diagnostic');
    const readback = await controller.bridge.call<MaskReadback>('selected_mask', { photoId: run.workingPhotoId, maskId });
    const observed = readback.maskContext.parameters.local_Exposure?.value;
    const applied = Number.isFinite(observed) && Math.abs(observed! - value) <= 0.0001
      && readback.maskContext.selectedMaskId === maskId && readback.state.stateToken === changed.stateToken
      && changed.stateToken !== baseline.stateToken;
    const changedRender = format === 'TIFF' ? await controller.render(runId, changed.id, 2048, format) : changed;
    const changedPixels = await compareImages(before.previewPath!, changedRender.previewPath!);
    const changedRepeatRender = await controller.render(runId, changed.id, 2048, format);
    const changedRepeat = await compareImages(changedRender.previewPath!, changedRepeatRender.previewPath!);
    await controller.restore(runId, candidateId, false, changed.stateToken);
    const restoredState = await controller.state(run.workingPhotoId);
    const restoration = await verifyRestoredRendering(before.previewPath!, () => controller.render(runId, candidateId, 2048, format));
    const settingsRestored = restoredState.stateToken === baseline.stateToken;
    const renderedChangeVerified = changedPixels.sameDimensions && typeof changedPixels.meanAbsoluteDifference === 'number'
      && changedPixels.meanAbsoluteDifference > 0.1 * (changedPixels.bitDepth === 16 ? 257 : 1);
    const passed = applied && renderedChangeVerified && settingsRestored && savedBaseline.pixelsIdentical
      && baselineRepeat.pixelsIdentical && changedRepeat.pixelsIdentical && restoration.difference.pixelsIdentical;
    const report = {
      candidateId, changedCandidateId: changed.id, maskId, format,
      reference: { path: referencePath, source: format === 'TIFF' ? 'separate-lossless-baseline' : 'saved-preview', savedPreviewCompared: format === 'JPEG' },
      exposure: { before: exposure.value, requested: value, observed }, applied, renderedChangeVerified, settingsRestored,
      savedBaseline, baselineRepeat, changedPixels, changedRepeat,
      restorationDifference: restoration.difference, restorationAttempts: restoration.attempts,
      renders: { saved: baseline.previewPath, ...(format === 'TIFF' ? { reference: referencePath } : {}), before: before.previewPath, repeat: repeat.previewPath,
        changed: changedRender.previewPath, changedRepeat: changedRepeatRender.previewPath },
      passed,
      diagnosis: !baselineRepeat.pixelsIdentical || !changedRepeat.pixelsIdentical
        ? 'Unchanged-state exports differ. Pixel differences cannot be attributed solely to snapshot restoration.'
        : !restoration.difference.pixelsIdentical ? 'Unchanged-state exports matched, but restored pixels did not match.'
          : passed ? 'This existing-mask exposure roundtrip passed; mask creation/deletion and other photos remain unverified.'
            : 'Restoration matched, but another diagnostic check failed. Inspect the full report.',
    };
    controller.store.addEvent(runId, 'mask_roundtrip_checked', report);
    if (!passed) controller.store.setRunStatus(runId, 'interrupted');
    return report;
  } catch (error) {
    controller.store.setRunStatus(runId, 'interrupted');
    controller.store.addEvent(runId, 'mask_roundtrip_interrupted', { candidateId, maskId, message: String(error) });
    // Preserve outcomeUncertain from the bridge. Do not restore after an uncertain
    // operation: it may still be executing in Lightroom.
    throw error;
  }
}
