# Restoration validation: next gate

Status: pilot implemented and three additional RAW cases measured, 28 September 2026. **Keep exact settings and pixel checks, and keep autonomous masking disabled.** Measurements below inform the remaining experiments; they set no pixel tolerance and change no feature gate.

## What the lossless trial establishes

The local [trial record](../.runtime/validation/lossless-trial.json) tests `IMG_0433.CR3` on a virtual copy. The export is 2048 × 1365, 16-bit sRGB TIFF, without output sharpening. Follow-up analysis found that the initial comparator applied an ICC conversion before reading channel values. That conversion could hide low-order differences: native RGB `[32707,30979,29634]` and `[32707,30979,29633]` both became `[32414,31038,29791]`. The historical report is retained unchanged; its numbers are not native-sample measurements.

The corrected comparator validates matching TIFF dimensions, unsigned 16-bit RGB samples, orientation and complete embedded ICC profiles, then decodes without color conversion. Its decoded samples matched independently parsed uncompressed TIFF strips exactly. [Recomputed evidence](../.runtime/validation/lossless-trial-native-samples.json) uses original sample codes on a 0–65535 scale. Means average all RGB channels, including unchanged ones.

| Comparison | Maximum | Mean absolute difference | Changed channels |
| --- | ---: | ---: | ---: |
| Two unchanged baseline exports | 17 | 0.0005421 | 0.02741% |
| Two unchanged exports after the local edit | 16 | 0.0005814 | 0.02779% |
| Before/after local exposure +0.25 | 6884 | 175.8875 | 9.51699% |
| Baseline/restored local adjustment, first export | 13 | 0.0005481 | 0.02862% |
| Baseline/restored local adjustment, second export | 17 | 0.0007530 | 0.03873% |
| Before creation/after restoring the pre-mask snapshot, final export | 17 | 0.0005465 | 0.02739% |

Both restorations recovered the exact saved settings token. Repeated exports of unchanged settings also differed, so a nonzero restored-image difference cannot be attributed solely to failed restoration. Four repeated decodes of the same saved file were identical; variation exists in the exported sample data. It also occurred before any mask was created, so AI-mask completion is not required for the phenomenon. Its cause is still unresolved.

The local edit produced a much larger measurable effect than the controls. That does **not** establish recovery of every mask pixel. The second restored export differs more than the first; extra exports do not necessarily converge. One photograph and a few pairs cannot establish a distribution or threshold. The strict comparator now additionally reports per-value histograms, 64-pixel tiles, changed-pixel bounds and spatial runs. Tests reject a coherent one-pixel halo even when its whole-image mean is tiny. Any amplified difference map declares its scale and does not modify the source.

## Additional live controls

Three unchanged exports of `IMG_0493.CR3`, with no mask and no intervening setting writes, were compared at each of two export limits. At 2048 × 1365 the three pairwise maxima were 67, 37 and 67 code values, affecting 94–216 pixels. At the photo's native 6000 × 4000 size (8192 export limit), maxima were 686, 362 and 686, affecting 322–517 pixels. Source hashes and settings remained unchanged. Full-resolution export therefore does not eliminate the variation. Keep these resolution groups separate; their maxima are observations, not acceptance bounds. Evidence: `.runtime/validation/scale-controls-0b05b688-39ce-4e09-8e89-40d13dbd97ad.json`.

Two further subject-mask pilots used three unchanged pre-mask exports, three unchanged masked exports, one +0.25 EV intervention, one local restoration followed by two read-only exports, and one pre-creation restoration/export. All exports were 2048 × 1365; both cases recovered exact native settings after both restorations. Each case has seven unchanged pairs and three restored/reference pairs, all nonexact.

| Photo | Largest unchanged maximum | Local effect maximum / mean | Local restore maxima | Pre-creation restore maximum |
| --- | ---: | ---: | ---: | ---: |
| IMG_0487, close portrait and fine hair | 30 | 8394 / 2360.0841 | 22, 26 | 24 |
| IMG_0490, mixed indoor light | 26 | 4858 / 527.3535 | 26, 26 | 33 |

In the portrait, restored comparisons changed 647–2480 pixels (0.023–0.089%); in the indoor scene, 109–177 (0.0039–0.0063%). The differences are sparse and scattered. The indoor pre-creation maximum exceeds every unchanged control maximum, so restoration must not be described as always falling within the observed controls. Overview inspection shows the intended subject brightening and its apparent removal, but does not certify every boundary or low-order sample. The supplied RAW/XMP corpus, staged RAWs, and imported originals' native settings passed preservation checks. Evidence: `.runtime/restoration/restoration-348a6148-7f7c-4ede-8ec9-148d53827832/results.json`.

The `IMG_0478.CR3` background pilot completed through the explicit import-only recovery path below. Native exposure readback was exactly +0.01 EV. Its effect maximum was 349 and mean 72.2745 code values, versus an observed unchanged-control maximum of 42. Local restore maxima were 38 and 42; pre-creation restore maximum was 25. Both saved settings states restored exactly, while all three restored/reference pixel comparisons were nonexact (130–187 differing pixels). This demonstrates measurement of a small intended intervention, not a validated minimum defect or a deliberately failed undo.

An unfiltered effect difference map at 256× amplification shows broad background changes and little/no change in the child and central elephant statue interiors. It is a difference image, not a mask-coverage export: unchanged pixels can also result from clipping or tonal response. Native mask completion remains only “stored and selected.” The original corpus and staged RAW hashes matched at completion. This resumed mode verifies the original's native settings only at preflight and finishes on the restored diagnostic copy. Evidence: `.runtime/restoration/restoration-178060c0-1b29-4eed-ba3c-d88ab64e014c/results.json`; difference-map recipe and hashes: `.runtime/validation/IMG_0478-background-effect.json`.

## Remaining experiments

The first fixed checkpoint-only/no-op restore pilot has completed on `IMG_0478.CR3`: nine TIFFs, fifteen nonexact comparisons, exact settings throughout, and unchanged source/evidence hashes. The subsequent restarted Auto, GPU Off, and restored-Auto conditions completed twenty-seven more TIFFs with exact settings against a common, explicitly rebased post-restart baseline; all forty-five comparisons were nonexact. Both original Auto preferences are restored and reverified. The first final-Auto attempt stopped before exports during copy-selection verification; its copy and evidence were preserved and reconciled after unlock. One separate replacement completed with the extra preparation recorded. See [render repeatability](render-repeatability.md) for separate comparison groups, baseline changes, interruption evidence and scope limits. Asynchronous copy selection, import-time settings changes, repeated edit/restore cycles, and deliberate residual/boundary tests remain the next reliability and recovery work.

1. **Collect matched controls on varied images.** Start with the supplied RAW folder, then extend to 5–10 varied images: fine fur/hair, hard subject edges, smooth gradients, dark noise, bright highlights, and small subjects. Near-duplicate frames are not independent scene coverage. Run 10 unchanged exports per state and three edit/restore cycles as an initial measurement batch, not as a certification sample size. Include states with no mask, a subject mask, a background mask, and multiple existing masks. Preserve originals; run all interventions on explicit diagnostic virtual copies.
2. **Separate rendering from recovery.** Capture unchanged reference exports before any mutation. Interleave unchanged exports with checkpoint-only controls and real edit/restore cycles; repeat unchanged exports after recovery. Keep all samples and record ordering/timing. Do not repeatedly restore or export until a convenient comparison passes. Separate warm exports from first exports after reopening the photo and after restarting Lightroom. Compare 2048-pixel and full-resolution exports in separate groups. Record Lightroom/build, process version, profile, GPU configuration, export recipe, decoder version, source digest, state tokens, and mask identities; do not pool differing environments.
3. **Measure spatial differences.** Retain current exactness, dimensions, maximum, mean, and changed-channel fraction. Add channel-difference histograms and per-tile summaries, plus an unfiltered difference map for human inspection. Inspect the subject interior, thin edges, eyes/fur, and background independently. Sparse coherent edge errors can disappear in a whole-image mean. Verify TIFF depth and ICC metadata before decoding; retain the original uint16 samples and avoid rescaling, registration, blur, or 8-bit conversion during verification.
4. **Probe timing and opaque mask state.** Compare an immediately returned native result with later read-only exports at recorded intervals, without assuming a fixed sleep proves completion. Repeat mask creation followed by pre-creation restoration, local exposure restoration, local texture restoration, and subject/background sequences separately. Inspect visible coverage and edges in Lightroom. Stable stored group/component IDs alone do not establish completed AI pixel coverage.

## Deliberate failure controls

Use isolated working copies or generated comparison fixtures. Every failure below must be rejected or reported as unverified; none may silently pass recovery:

| Deliberate regression | What it exercises |
| --- | --- |
| Leave a small exposure/texture residual; restore the wrong snapshot; change an unrelated control or existing mask | Exact settings guard and attribution of unrelated changes |
| Compare the edited render while supplying an unchanged settings fixture | Pixel verification independent of the state token |
| Alter a small contiguous edge region or thin halo in a uint16 fixture | Spatial sensitivity when whole-image averages remain small |
| Change one 16-bit channel by one code value | Decoder precision and exact comparison, independent of any future perceptual classification |
| Supply wrong dimensions, bit depth/profile, orientation, another photo, or stale render provenance | Input and identity validation |
| Interrupt a native mutation, change selection, or expire its deadline | Uncertain outcomes must stop the run without automatic mutation retries |

Sweep residual magnitude and affected area and report the smallest reliably detected case. Do not only test the conspicuous +0.25 exposure change. Synthetic fixtures validate the comparator; real Lightroom residuals validate the end-to-end path. Neither substitutes for the other.

## Conditions for proposing a different gate

First attempt to identify and control the unchanged-render variation. If a calibrated equivalence check remains necessary, develop its rule using unchanged controls only, freeze it, then evaluate it on separate photos/sessions and deliberate failures. Do not set a boundary from the maximum observed on this one image or adapt it to a candidate's restored result. Treat photo/session repeats as dependent observations; millions of image pixels are not millions of independent validation samples.

A proposal must publish false accept/reject results, uncertainty, spatial sensitivity, environment scope, and the minimum defect it aims to catch. Overlap between unchanged variation and targeted defects means that case remains unverified. Exact settings/provenance checks stay mandatory. Any future result should distinguish **exact pixel restoration**, **equivalence under a validated rule**, and **unverified restoration**; equivalence must never be labelled pixel identity. Until that evidence is reviewed, the current strict failure remains correct and autonomous masking stays disabled.

## Running the reproducible pilot

The implemented runner performs three to ten unchanged exports at each of two states, one before/after local exposure comparison, two read-only exports after a single local restore, and one export after a single pre-creation restore. With three controls this is ten TIFFs per case, plus the controller's normal baseline/edit JPEGs. It does not retry writes or export until a preferred result appears. This smaller pilot is not the full multi-cycle/restart experiment proposed above.

```sh
node src/evaluation/cli.ts index --source RAW
node src/evaluation/cli.ts list
node src/restoration/cli.ts run --id RAW_ASSET_ID --mask subject --controls 3
node src/restoration/cli.ts run --id RAW_ASSET_ID --mask background --controls 3
node src/restoration/cli.ts analyze --result /absolute/path/to/results.json
```

Use exact indexed IDs, not filenames, and run one native batch at a time. `--exposure-delta` sets a positive delta up to 0.5 native EV; `--max-edge` records an export limit from 256 to 8192. `--environment-notes` records known conditions without inferring uncollected GPU settings or restart history. The result includes Lightroom capabilities, installed plug-in source hash, decoder/runtime versions, current settings and state tokens, render hashes, exact comparisons, and explicitly unmeasured conditions. Results and the separate SQLite journal live under `.runtime/restoration/restoration-UUID/`. Difference-map PNGs amplify code differences by a declared factor; they are diagnostic views, not photographs or acceptance thresholds.

Each case imports new RAW/XMP copies, verifies a protected source original and a separate virtual copy, then leaves the diagnostic copy at the pre-creation snapshot. It reselects the staged original for native-settings verification, verifies the staged RAW digest, and verifies the original corpus fingerprint. A completed experiment means the planned measurements finished; its pixel-restoration result may still be **unverified**. Neither completion nor a control maximum enables autonomous masks. Native-state, metadata/profile, or provenance failures stop the experiment and retain the shared lock after mutation work. Inspect saved operations before recovery; a dead process alone does not establish completion of an outstanding Lightroom call.

### Reconciled import-only interruption

An `IMG_0478.CR3` pilot stopped during import because settings changed before the plug-in's completion check. A second fresh import reproduced this. Neither reached working-copy creation or any edit. Their failure reports remain unchanged. Reconciliation inspected the terminal response, current selected original, repeated settings reads, staged RAW/XMP and corpus hashes, and an idle bridge before releasing the owned session lock. This does not establish the cause of the import-time change.

For this narrowly defined case, explicit continuation reuses the verified staged original and creates a new diagnostic virtual copy:

```sh
node src/restoration/cli.ts resume-import \
  --result /absolute/path/to/failed/results.json \
  --expected-state-token CURRENT_VERIFIED_SOURCE_TOKEN
```

This command inherits the failed experiment's recipe and requires a one-case import-only `STALE_STATE` report. It rejects timeouts, other mutations, changed source files, a different selection and a stale token; it does not release locks or retry the import. The new report links the failed report by SHA-256. Original native settings are verified at preflight only in this mode: the command finishes on the restored working copy, avoiding another import/selection operation. It still verifies working-copy restoration and source bytes, but does not claim a final native reread of the original.

`analyze` reads saved evidence and prints a new report without Lightroom calls or replacing the original result. Invalid comparison inputs make the overall pixel result unverified even when other restoration pairs match. Deliberate synthetic controls cover single low-bit changes, thin coherent regions, stale hashes and incompatible image metadata. Real +0.25 and +0.01 EV interventions serve as positive controls; deliberately retained native residuals, multiple edit/restore cycles, and restoration across restarts still need separate evidence. The completed restart/GPU campaign measured unchanged, checkpoint-only, and no-op restoration exports; it does not establish those broader recovery properties.
