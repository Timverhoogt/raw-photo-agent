# Render repeatability controls

This diagnostic separates three operations that were combined in earlier recovery trials. It changes no acceptance threshold and does not enable autonomous masks.

## Fixed checkpoint pilot

Use a completed, restored diagnostic virtual copy whose identity and saved state match its report. Create a separate diagnostic copy, verify identical settings, and retain the controller's initial JPEG. Then capture exactly these TIFF blocks:

| Block | Intervention before the block | Exports |
| --- | --- | ---: |
| Unchanged | None after baseline initialization | 3 |
| Checkpoint only | Save a new snapshot of the unchanged state | 3 |
| No-op restore | Restore the original baseline snapshot while already at that state | 3 |

Each export uses the same 2048-pixel limit, 16-bit sRGB TIFF, and no output sharpening. Native identity, settings and state token must match before and after each operation. The initial JPEG primes Lightroom's renderer: the first TIFF is not described as a cold export. Within-block pairs and the first baseline TIFF against each later TIFF are retained separately. Never export or restore until a preferred answer appears.

The runner preserves the shared editing lock after an uncertain mutation, stops on changed selection/settings, validates TIFF metadata and hashes, and leaves the new diagnostic copy at its baseline. It never imports the RAW again or edits the source corpus. Starting-state sidecars retain the photographer's imported edits.

```sh
node src/restoration/cli.ts checkpoint-controls \
  --result /absolute/path/to/completed/restoration/results.json \
  --id RAW_ASSET_ID \
  --environment-notes 'Observed graphics configuration and restart history'
```

Select the exact diagnostic virtual copy recorded in the completed result, at its restored pre-creation baseline. Reports and the separate operation database go under `.runtime/restoration-controls/controls-UUID/`. The command verifies the parent report and its baseline/restored TIFF hashes, the staged RAW/XMP files, and the corpus fingerprint. Source native settings are checked at preflight and during copy creation; the run ends on its new copy and does not claim a final native reread of the parent.

Saving a checkpoint and restoring an already-current snapshot are separate controls. Nonexact checkpoint or no-op restore comparisons alone do not prove either operation caused the variation; unchanged pairs, ordering and repeated sessions are necessary context.

### Explicit baseline after a restart

A restart may change Lightroom's returned settings structure. The runner's default still requires the exact historical state. After separately inspecting and recording a change, `--source-baseline /absolute/path/to/baseline.json` accepts a frozen `{ "state": PHOTO_STATE, "reason": "EXPLANATION" }` for a **new** diagnostic experiment. It must identify the same prior working copy. The current photo, state token and full settings must exactly match it before any mutation, and the new copy must inherit those settings exactly. Both historical and new states remain in the report; no equivalence or historical restoration is claimed. Use the same frozen baseline across every matched configuration and stop if it changes again.

## First completed pilot

The `IMG_0478.CR3` pilot completed all nine TIFF exports and fifteen comparisons on 28 September 2026. No development adjustment or mask creation was requested. Recorded settings matched before and after every operation, including the no-op restoration. Each TIFF was 2048 × 1365. All fifteen comparisons were nonexact:

| Comparison group | Pairs | Maximum code difference, range across pairs | Differing pixels, range across pairs |
| --- | ---: | ---: | ---: |
| Unchanged exports, within block | 3 | 35–38 | 192–242 |
| After checkpoint, within block | 3 | 35–42 | 119–161 |
| Baseline to post-checkpoint exports | 3 | 29–42 | 156–229 |
| After no-op restore, within block | 3 | 25–42 | 143–161 |
| Baseline to post-restore exports | 3 | 35–42 | 179–218 |

Values are native 16-bit RGB codes on a 0–65535 scale, not 8-bit preview differences. The longest horizontal and vertical runs were at most five pixels. This records sparse variation across all three conditions; it does not identify its cause or establish an equivalence threshold. Automated Node tests overlapped portions of this initial pilot, so resource load was not held constant. Future configuration comparisons should run without concurrent test suites.

All nine TIFF file hashes verified again after completion. Their checked metadata hashes matched, and repeated decoding of the same file remained exact. The source corpus, staged RAW/XMP files and parent report were unchanged. The run ended on the new diagnostic copy at baseline and released the shared lock. It did not reread the parent photo's native settings at the end or change graphics preferences.

Private evidence: `.runtime/restoration-controls/controls-755b0ab6-8336-4ee1-a6a0-cf04c38bd214/results.json`, `.runtime/validation/checkpoint-controls-summary.json`, and `.runtime/validation/checkpoint-controls-code-provenance.json`. TypeScript checking and all 152 tests pass, including guards for uncertain snapshot operations and source/report changes during final verification.

## Environment recorded for this installation

The Lightroom UI on 28 September 2026 reported Lightroom Classic 15.5.1 build `202608131348-cab7eed5`, Camera Raw 18.5.1 build `2687`, macOS 27.0.0 build `26A428`, and an Apple M1 with 8 GB memory. Main graphics processing was **Auto**, GPU preview generation was **Auto (S3_5)**, HDR in Library was off, and editing with Smart Previews instead of Originals was off. Performance described limited acceleration; System Info reported GPU image-processing support. These observations do **not** establish that GPU export was active.

Private UI evidence and the structured environment record are in `.runtime/validation/checkpoint-controls-system-info.png` and `.runtime/validation/checkpoint-controls-environment.json`. No cache purge is part of this experiment.

## Graphics and restart follow-up

Adobe documents a diagnostic that turns **Use Graphics Processor** off and then quits and relaunches Lightroom. The preference has Auto, Custom and Off modes; Custom exposes separate facilities where supported. [GPU troubleshooting](https://helpx.adobe.com/lightroom-classic/desktop/technical-support/technical-issues/gpu-issues/troubleshoot-gpu.html), [GPU preferences](https://helpx.adobe.com/lightroom-classic/desktop/technical-support/technical-issues/gpu-issues/lightroom-gpu-faq.html).

Preview generation is also a separate GPU setting, and turning the main graphics preference off disables that facility. A broad Off comparison therefore changes more than just the export path. Record both preferences and restore their original values after the experiment. [GPU preview generation](https://helpx.adobe.com/uk/lightroom-classic/desktop/kb/gpu-preview-generation.html).

A finite follow-up should repeat the same fixed export blocks after a restart with the current configuration, after a restart with graphics processing off, and after restoring the original configuration and restarting again. Keep every block and its exact environment separate; retain the first export and its ordering rather than silently discarding it as warm-up. Cross-configuration pixel differences can be legitimate rendering differences, so compare repeatability within each configuration first. An association with GPU configuration would motivate a narrower test, not establish a cause or authorize a tolerance.

No official source above promises bit-exact CPU/GPU equivalence or repeated-export determinism. A small sample with zero differences would establish exactness only for its recorded pairs. Multi-cycle mask recovery and photographic quality remain separate tests.

### Restarted Auto / Off campaign, 28 September 2026

The restarted Auto, restarted Off, and restored-Auto conditions completed nine TIFFs and fifteen comparisons each without concurrent automated tests: twenty-seven TIFFs and forty-five nonexact comparisons in total. All settings matched the same frozen campaign baseline throughout all three runs. Within-block results are separated below. Differences are native 16-bit codes; each group has three dependent pairwise comparisons.

| Configuration | Block | Maximum difference, range | Differing pixels, range |
| --- | --- | ---: | ---: |
| Auto after restart | Unchanged | 31–42 | 150–218 |
| Auto after restart | Checkpoint only | 29–42 | 118–209 |
| Auto after restart | No-op restore | 29–42 | 115–121 |
| Off after restart | Unchanged | 25–31 | 110–220 |
| Off after restart | Checkpoint only | 29–31 | 97–187 |
| Off after restart | No-op restore | 29–31 | 138–239 |
| Restored Auto after restart | Unchanged | 35–42 | 159–172 |
| Restored Auto after restart | Checkpoint only | 29–42 | 122–224 |
| Restored Auto after restart | No-op restore | 31–42 | 180–236 |

Turning graphics processing Off did not eliminate observed variation; variation also remained after restoring Auto. This does not establish a GPU cause or exclude other renderer behavior. Lightroom also disabled GPU preview generation when the main setting was Off. Returning the main setting to Auto left preview generation Off, so preview generation was separately restored to its original Auto value. Both original preferences were verified after the final restart and reverified before the final replacement experiment.

The first restart added `Look.Parameters.PointColors: {}` to native settings readback where the key had previously been absent. The exact historical-state guard stopped before any mutation. Repeated stable readbacks were recorded as an explicit new baseline, with both old and new states preserved and no equivalence claim. All three completed conditions used that same frozen baseline. The original pilot is not a matched control for this campaign.

The first restored-Auto attempt stopped when its single `create_working_copy` call returned uncertain `TARGET_CHANGED`. Subsequent readbacks found the intended new virtual copy with settings matching the frozen baseline, but no checkpoint or export had run. The Mac locked during reconciliation. After unlock, verification established a dead runner, idle bridge, exact copy and parent settings, and unchanged source/evidence hashes before archiving its ownership lock. The interrupted report and copy remain preserved; the uncertain request was not repeated.

One separate replacement experiment then completed the final nine TIFFs and fifteen nonexact comparisons, ending at its baseline and releasing its lock. All source RAW/XMP and parent report hashes remained unchanged. Preparation was asymmetric: the final condition had an extra copy/selection cycle, a longer delay after restart, and automated checks before its exports. No test suite ran concurrently with any campaign exports. Resource load and preparation were not fully controlled, so these results do not establish causation, determinism, or an acceptance threshold.

At the time of the interruption, the client removed consumed response files while retaining request files. The plug-in then regenerated `OUTCOME_UNKNOWN` from the existing receipt without repeating the mutation. The original `TARGET_CHANGED` is preserved in the operation journal; both response representations are retained in reconciliation evidence. The follow-up client change now retains consumed original responses. It was applied after all campaign exports and did not alter their recorded execution. Asynchronous copy selection and import-time settings changes remain to be investigated.

A separate live check issued only `selected` and `read_state`: original success-response bytes survived the subsequent call and worker polling, photo settings remained unchanged, and the bridge finished idle without unanswered requests or a call lock. Evidence is `.runtime/validation/bridge-response-retention-live.json`. Remote-error retention is covered by mocked tests; no native error was deliberately induced for this check.

Private campaign evidence: `.runtime/validation/gpu-restart-campaign.json`, frozen source baseline and SHA, UI captures, code hashes, and `.runtime/validation/gpu-auto-restored-reconciliation.json`. Completed reports are `controls-5fc75520-db3e-4cec-a731-2854c269b5a9` (Auto), `controls-2ae41ce1-b870-4ce1-b16c-1d7a90891150` (Off), and `controls-29fe6fbe-7e09-4414-9254-65ad1609cecc` (restored Auto). The interrupted final attempt is `controls-de9456bd-35cc-4fa2-88db-bc12a1a381aa`. All twenty-seven TIFF hashes reverified, their checked metadata hashes matched, and the campaign record is complete with the preparation difference retained.

TypeScript and all 156 tests passed before the initial campaign exports; later review checks completed before the final replacement exports. Following the response-retention change, TypeScript and all 160 Node tests passed. The unchanged Lua plug-in has 159 passing contract checks. No cache purge, new tolerance, or autonomous masking enablement occurred. Multi-cycle edit/restore recovery and deliberate residual/boundary tests remain separate next steps.
