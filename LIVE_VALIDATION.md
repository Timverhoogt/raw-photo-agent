# Live Lightroom validation

Validation performed on macOS with Lightroom Classic 15.5.1 on 27–28 September 2026. The initial guided trial used one Canon CR3 and a separate working virtual copy; a later mask diagnostic used a second CR3 depicting two deer. These are live integrations, distinct from automated tests with simulated bridge responses. In the initial trial the user compared two interpretations and selected B, the closer crop.

The detailed journal, native snapshot references, comparison reports, source RAW, and exported photos remain local and are not included in this repository. Catalog identifiers, state hashes, and run identifiers are also omitted. A fresh checkout should run the documented acceptance workflow against a photo its user is authorized to edit; this summary is not a reproducible evidence bundle.

## Observed results

The bridge created a virtual copy and native snapshot. The exposure test changed `Exposure2012` from `0` to `0.25`, recorded that value in the child checkpoint, and produced a visibly brighter export. At 2048 × 1365 pixels, the changed export differed in approximately 96.61% of color channels, with a mean absolute channel difference of 10.7651 and a maximum of 26. This establishes that the adjustment reached the exported image.

Restoring the baseline recovered its recorded settings and state token. The **first strict pixel comparison failed**: 52 pixels, comprising 156 color channels, differed within an 8 × 8 region. Maximum channel difference was 2; mean absolute difference was 0.00002647. The original local report retains `passed: false`. The localized difference's cause has not been established.

One additional export, without another edit or restoration, retained the same state token. Its decoded sRGB pixels matched the saved baseline preview exactly: zero changed pixels and maximum difference zero. The repeat's path and settings are recorded in the local evidence. This is pixel equality, not a claim that JPEG files including metadata have identical bytes. Both the failed first comparison and the successful repeat are retained; no difference tolerance was relaxed. The controller implements this bounded check: if the first restored export differs, it exports that same verified state once more, preserves both paths and differences in `restorationAttempts`, and still requires exact pixel equality. It does not repeat an edit or snapshot restoration, and it does not rewrite the original failed report.

The original source photo's before and after state tokens matched. This supports preservation of its recorded development state.

## Crop and existing-mask follow-up

The UI-created habitat crop restored with exact decoded pixels. The uncropped tonal parent recovered its recorded state but retained a maximum channel difference of 1 after the bounded export retry. The local crop-restoration report records these as separate outcomes, not an unqualified pass for both directions.

Existing-mask selection and native readback passed. The selected mask reported exposure `1` with range −4 to 4 and texture `0` with range −100 to 100. A later `edit-mask` set native exposure to `0.25` and texture to `10`. Its saved checkpoint recorded the corresponding values `LocalExposure2012: 0.0625` and `LocalTexture: 0.1`. All other recorded settings and mask geometry matched its parent; the plug-in verifies these remain unchanged. Native control units must therefore not be confused with saved settings units.

The earlier mask/no-mask restoration test recovered exact recorded settings in both directions, but **strict pixel restoration did not pass**. Differences remained after the bounded retry, with maximum channel differences of 1–3 across the recorded attempts. The local mask-restoration report preserves those failures. Their small magnitude does not turn them into exact matches. Existing-mask adjustment is live-tested; complete exact mask pixel rollback remains unresolved. The subject mask was created through Lightroom's UI; at this stage `create_subject_mask` was unsupported by the bridge. Later native-creation trials are recorded below.

## User selection and delivery check

The user viewed two edited interpretations and selected B, the closer crop. The selected JPEG is 5035 × 2760 pixels and embeds the sRGB IEC61966-2.1 profile. An independent read-only SHA-256 comparison verified that the delivery file matches the export referenced by its recorded candidate. The image and its runtime references are excluded from the repository.

## Local browser demo trial

On 28 September 2026, the local dashboard was tested with the same Canon CR3 through its browser file chooser. The 33 MiB upload was copied into a private local upload folder, imported through the Lightroom SDK, selected in Develop, and used to create a separate virtual copy and baseline preview.

Two real GPT-6 Astra calls ran through the signed-in Codex CLI. The first inspected the baseline JPEG and proposed three absolute global settings: highlights −25, shadows +18, and temperature 6000 K. Lightroom applied those settings and rendered a new preview. The second call compared that preview with the baseline and recommended stopping. Its public observations and adjustment rationale appeared in the dashboard journal. No preset or simulated agent response was used.

An integration-test selection of the current edit exercised the comparison endpoint and final export. This was a test action, not an additional photographer preference judgment. The resulting JPEG was 6720 × 4480 with an embedded sRGB profile. SHA-256 comparison confirmed that the uploaded RAW copy matched the source file, and the editing-session lock was released on completion. The earlier photographer-selected closer crop remains a separate run.

Browser checks covered RAW selection, start, live preview and journal updates, A/B presentation, selection, and the completed state. Pause/resume, stale question rejection, uncertain-operation handling, upload constraints, and competing server ownership also have automated tests; this trial does not establish every interruption or recovery path in native Lightroom. The dashboard shows verified renders and public decision summaries. Lightroom changes in its own native window; cursor movement and a screen-sharing feed are not part of this implementation.

## Live detail-inspection demo trial

The upgraded demo ran on the deer RAW on 28 September 2026. It saved a 6000 × 4000 Lightroom JPEG for the baseline and for the edited candidate, while preserving the separate 2048-pixel overview previews. Three real model decisions requested two detail regions, proposed exposure +0.2 EV and white balance 4550 K after inspecting those regions, then compared the edited regions with the baseline and recommended stopping.

The requested regions were the foreground deer's eye/facial fur and the pale deer's upper flank. Each candidate supplied matching 896 × 896 crops extracted from its own saved export. The browser loaded all four crops, switched regions, displayed actual export dimensions, and synchronized the two scroll positions in export-pixel mode. The narrow-window layout was verified with vertically stacked before/after panes. No browser console errors were reported during these checks.

The trial remains at the final photographer comparison; no preference was fabricated and no final export was requested for this run. The earlier final-export validation remains separate. The automated suite passes 102 tests, including provider-review retry, unchanged native operation counts across retry, rejected retries after manual Lightroom changes, and manual changes during a review or just before restoration. Those simulated error tests do not establish every native failure mode.

## Validation limits

All live evidence comes from one installation. The initial two RAW trials were followed by the corpus cases below; each section states its own scope. These trials do not establish exact mask pixel rollback, AI denoise, other native dependencies, all cameras, or every interrupted operation. Photographic quality still requires inspecting the actual images and obtaining the user's preference where appropriate; one selected result is not an objective quality benchmark or evidence of a fully autonomous editor.

## Controlled mask repeatability diagnostic

On 28 September 2026, a fresh virtual copy of the completed deer photograph was created for testing. Lightroom's native **Select Subject** command created a mask over both deer. The mask was captured as its own baseline. The new `verify-mask-roundtrip` command exported that unchanged state twice, changed only native mask exposure from 0 to +0.25, read back +0.25, exported the changed state twice, and restored the mask baseline once. All overview exports were 2048 × 1365 pixels.

| Check | Observation |
| --- | --- |
| Two unchanged masked baseline exports | Not identical; maximum channel difference 1 |
| Local exposure effect | Verified; mean absolute channel difference 3.774, maximum 27 |
| Two unchanged edited exports | Not identical; maximum channel difference 3 |
| Recorded settings after restoration | Exact state-token match, including recorded mask settings |
| Restored rendering | Not identical after either export; maximum differences 3, then 2 |
| Overall strict diagnostic | Failed; no pixel tolerance relaxed |

These controls show that small differences occur without an intervening edit or restoration. They cannot be attributed solely to mask rollback. The rendering/cache/compression cause remains undetermined, and exact mask pixel restoration remains unverified. The original completed deer edit was reselected afterward and its recorded state token matched the pre-test value. The separate diagnostic copy and all render attempts remain local. The autonomous demo still excludes mask creation and local adjustments.

## 28 September 2026 — user RAW corpus and lossless mask diagnostic

The local `RAW/` corpus contains 16 CR3 files, 16 matching XMP sidecars, and one JPEG. All are excluded from Git, including sidecars. Evaluation indexes file hashes, stages fresh RAW/XMP copies, and labels the starting render **as imported with existing XMP edits**. These photographs are not neutral/reset camera baselines.

A separate virtual copy of `IMG_0433.CR3` tested the optional 16-bit, uncompressed sRGB TIFF export at 2048 × 1365 pixels, with output sharpening disabled. **The following historical metrics used a color-converted decoder; the native-sample correction is documented below.** Two unchanged exports differed: maximum 12/65535 and mean absolute difference 0.000482 channel levels. Lossless output therefore does not establish exact export repeatability on this environment.

Native subject-mask creation returned one stored group and component with selected identities. A +0.25 native local exposure change visibly brightened the birds; its mean difference was 175.612 and maximum 6615 channel levels. Repeated changed-state TIFF exports differed by at most 13 levels. Restoring the mask parameters recovered the exact state token, but the rendered comparison was nonexact (maximum 13, mean 0.000670). Restoring the pre-creation snapshot also recovered its exact state token; the image difference was maximum 12, mean 0.000483. This separates successful native-state restoration from unresolved exact pixel repeatability. It does not certify every mask boundary, background masks, or AI cache restoration on other photographs.

Private evidence: `.runtime/validation/lossless-trial.json`, with immutable render paths and all comparisons. No uncertain mutation was retried. Autonomous demo local editing remains disabled by default. A guarded loop and subject/background creation operations are implemented, but their availability is not a general quality or restoration guarantee.

## 28 September 2026 — first corpus quality run

Three supplied RAWs (`IMG_0433`, `IMG_0470`, `IMG_0493`) completed the serialized evaluation without interruption. Each case retained real Lightroom renders for the imported XMP starting state, fixed-gentle-v1 comparator, and agent result; the agent made one global edit and then finished after viewing the result. Matching initial native settings were checked across the two working copies. End-to-end case times, including import, both comparator/agent copies and all exports, were approximately 196, 180 and 150 seconds. These are full evaluation-case times, not isolated model latency.

The corpus fingerprint was unchanged after the run and a second indexing pass confirmed all 16 RAWs, 16 XMPs and the reference JPEG retain their original bytes. The prior completed demo session remained separate and survived a server restart. The private batch journal is `.runtime/evaluation/runs/eval-1eef94c3-e30a-4e09-8ac5-c23945ed6256/results.json`; its three complete cases produced a blinded review package with zero exclusions. No photographer preferences have yet been recorded, so photographic improvement is not measured.

At that point, TypeScript check and 126 tests passed; native mock harnesses passed 159 Lua 5.1 contract checks. The safe Masking-panel-opening refinement had been copied into the installed plug-in directory but needed a Lightroom reload: macOS locked before that final UI step. Live trials above used the immediately preceding plug-in load. No dependent native operation was attempted after the lock. The follow-up below completed the reload.

The blinded page was opened and visually checked in the in-app browser: three cases, nine images, no selected choices, no horizontal overflow, and no browser errors. Screenshot: `.runtime/validation/corpus-quality-review.png`. The local preview serves only the public `review/` folder; its private role mapping and vote files are outside the served directory. Browser inspection succeeded while macOS was locked.

## Follow-up — native sample comparison correction

The pending plug-in reload completed and Lightroom 15.5.1 reports the guarded subject/background operations and lossless export support. A read-only independent investigation found that the initial TIFF comparator applied ICC conversion despite requesting 16-bit output. A one-code source difference could disappear under that conversion. The public comparison path now validates profiled TIFF inputs and compares original RGB sample codes without ICC conversion. Independent uncompressed-strip parsing and hand-encoded fixtures verify preservation.

Original trial artifacts remain unchanged. Recomputed native-sample comparisons are in `.runtime/validation/lossless-trial-native-samples.json` and the corrected metrics appear in [restoration validation](docs/restoration-validation.md). The unchanged baseline maximum is 17/65535, rather than the historical color-converted 12; exactness still fails. Repeated decoding is deterministic, and pre-mask export variation excludes mask creation as a necessary cause. No GPU, cache, or resizing cause has yet been established, and no tolerance was introduced.

## Follow-up — repeatable corpus restoration pilot

The serialized restoration CLI ran two additional subject-mask cases: `IMG_0487.CR3` (close portrait, fine hair) and `IMG_0490.CR3` (mixed indoor light). Each used fresh RAW/XMP copies and a diagnostic virtual copy, three unchanged pre-mask TIFFs, three unchanged masked TIFFs, one +0.25 EV local change, one local restoration with two exports, and one pre-creation restoration with one export. Both restored exact saved settings in both directions. All six restored/reference comparisons were nonexact; the two cases' unchanged control maxima were 30 and 26 native code values. The indoor pre-creation restoration reached 33, above its observed controls. No acceptance threshold was inferred.

Source corpus hashes, staged RAW hashes and imported originals' before/after native settings matched. A separate read-only audit verified saved TIFF hashes, profile/geometry metadata, comparison provenance and spatial totals. Overview inspection showed the intended subject brightening and its apparent removal; this does not establish exact boundary or low-order pixel recovery. The original batch and a separate local reanalysis remain in `.runtime/restoration/restoration-348a6148-7f7c-4ede-8ec9-148d53827832/results.json` and `.runtime/validation/subject-restoration-reanalysis.json`.

An independent no-mask experiment exported `IMG_0493.CR3` three times at each of two resolutions with unchanged settings. At 2048 × 1365, pairwise maxima were 37–67, with 94–216 changed pixels; at native 6000 × 4000, maxima were 362–686, with 322–517 changed pixels. Full-resolution export does not remove the variation. Evidence: `.runtime/validation/scale-controls-0b05b688-39ce-4e09-8e89-40d13dbd97ad.json`. These resolution groups are not pooled.

The background case exposed a separate initialization issue: two fresh `IMG_0478.CR3` imports returned terminal `STALE_STATE` after catalog insertion/selection and before any working copy, checkpoint or mask was requested. The shared lock remained held. Read-only reconciliation verified the selected staged original, repeated stable settings, unchanged staged RAW/XMP and corpus hashes, and an idle bridge before releasing each lock. Both failed reports and reconciliation records remain local. The cause of the import-time state change is unproven; no native guard was relaxed and no uncertain call was blindly retried.

The new explicit `resume-import` command then completed the background pilot from that verified original without another import. It recorded the failed report's SHA-256, required the explicit current state token and matching RAW/XMP hashes, and created a new working virtual copy. Native +0.01 EV read back exactly; the effect maximum was 349 and mean 72.2745 native code values, compared with an observed unchanged-control maximum of 42. Local restoration maxima were 38 and 42; pre-creation restoration maximum was 25. Both native settings states restored exactly, but all restored pixel comparisons remained nonexact. The amplified difference image shows broad background changes with little/no change in the child and central statue interiors; it does not certify semantic targeting or every mask edge.

The completed resumed report is `.runtime/restoration/restoration-178060c0-1b29-4eed-ba3c-d88ab64e014c/results.json`. No import was issued by that run, all ten planned TIFFs were retained, the staged RAW and original corpus hashes matched, and its session lock was released. Original native settings were verified at preflight only; this mode ends on the restored diagnostic copy and does not claim a final native reread of the original. Local reanalysis is saved separately in `.runtime/validation/background-restoration-reanalysis.json`.

Current automated validation: TypeScript check and all 144 tests pass. New cases cover native 16-bit precision, coherent thin-edge differences, stale comparison inputs, serialized experiment controls, retained locks after uncertain writes, and explicit import-only recovery guards. The queue check distinguishes completed bridge history from unanswered requests. Earlier plug-in checks remain 159 passing Lua contract checks; no native plug-in code changed during this follow-up. Autonomous demo masking remains disabled, and photographer preferences for the blinded quality review remain unrecorded.

## Follow-up — checkpoint-only and no-op restoration controls

A new diagnostic virtual copy of the completed `IMG_0478.CR3` working copy captured three unchanged TIFFs, three after saving a checkpoint, and three after restoring the already-current baseline snapshot. The initial JPEG export is explicitly recorded as priming; this was not a cold-start trial. No import, development adjustment or mask creation was requested. All operation boundaries retained exact development settings. The new copy finished at baseline.

All fifteen comparisons were nonexact. Within-block maxima were 35–38 before either intervention, 35–42 after checkpoint creation, and 25–42 after the no-op restore. Corresponding changed-pixel ranges were 192–242, 119–161 and 143–161 out of 2,795,520 pixels. Baseline-to-later comparisons are retained separately in [render repeatability](docs/render-repeatability.md). The maximum spatial run was five pixels. These measurements show sparse variation across the three conditions; they do not establish checkpoint/restore causation, GPU causation, or a tolerance.

Lightroom's UI reported version 15.5.1 build `202608131348-cab7eed5`, Camera Raw 18.5.1 build `2687`, Apple M1, 8 GB memory, graphics processing Auto and GPU preview generation Auto. Actual GPU export use was not established. No graphics preference, restart or cache purge occurred. Automated Node tests overlapped portions of this pilot; resource load was not controlled, and future configuration blocks should run without concurrent tests.

The source corpus, staged RAW/XMP files and parent report remained unchanged. All nine saved TIFF hashes reverified, checked metadata hashes matched, and same-file decoding was exact. The shared lock was released. The private result is `.runtime/restoration-controls/controls-755b0ab6-8336-4ee1-a6a0-cf04c38bd214/results.json`, with a separate `.runtime/validation/checkpoint-controls-summary.json`. Source native settings were checked at preflight and during native copy creation only; no final native reread of the parent is claimed.

At completion of this checkpoint pilot, TypeScript and all 152 tests passed. Eight new control tests covered fixed operation counts, selection/state/provenance guards, interrupted snapshot/copy outcomes, invalid exports, and source/report changes during final verification. The GPU comparison was then prepared and awaiting approval; its subsequent execution is recorded below. Autonomous masking remains disabled.

## Follow-up — approved restart and GPU controls

After explicit approval, restarted Auto, restarted Off, and restored Auto each completed the fixed nine-export protocol without concurrent automated tests. The twenty-seven TIFFs yielded forty-five nonexact comparisons; full development settings matched the same frozen campaign baseline at every operation boundary. Unchanged pairs had maximum differences of 31–42 in Auto, 25–31 in Off, and 35–42 after restoring Auto. Disabling graphics acceleration did not eliminate variation. The separate within-block and baseline-to-later groups are recorded in [render repeatability](docs/render-repeatability.md).

The first restart added an empty `Look.Parameters.PointColors` object to native readback. The historical-state guard rejected it before mutation. A new, explicitly supplied diagnostic baseline preserves both structures and rejects any further drift; no equivalence or historical recovery claim is made. The new API/CLI path passed four additional tests, bringing the suite to 156. TypeScript and the full suite completed before live exports.

Main graphics processing and GPU preview generation are both restored to their original Auto settings, verified after a final restart, and reverified before the final replacement run. Preview generation required a separate reset after restoring the main preference. The first final-Auto attempt returned uncertain `TARGET_CHANGED` during copy creation, before any checkpoint or JPEG/TIFF export. Subsequent read-only verification found the intended new copy with stable settings matching the frozen baseline. The Mac locked during reconciliation. After unlock, the dead runner, idle bridge, exact copy and parent states, and unchanged source/evidence hashes were verified before archiving the ownership lock. The interrupted report and copy remain preserved, and the uncertain request was not repeated.

One separate replacement run completed nine TIFFs and fifteen nonexact comparisons, retained exact settings, ended at baseline, and released its lock. Within-block maximum differences were 35–42 unchanged, 29–42 after checkpoint creation, and 31–42 after no-op restoration; changed-pixel ranges were 159–172, 122–224, and 180–236 respectively. The original RAW/XMP and parent report hashes remained unchanged. The extra copy/selection cycle, longer post-restart delay, and automated checks before this run are recorded preparation differences. No automated checks ran concurrently with the exports; this does not imply fully controlled load, causal isolation, or repeatability beyond the observed pairs.

Private evidence: `.runtime/validation/gpu-restart-campaign.json` and `.runtime/validation/gpu-auto-restored-reconciliation.json`, including source baseline, report/UI/code hashes and original preference restoration. The completed replacement is `.runtime/restoration-controls/controls-29fe6fbe-7e09-4414-9254-65ad1609cecc/results.json`. The failed response is preserved in the runner journal. At the time of the interruption, deleting consumed native responses while retaining requests caused the plug-in to regenerate `OUTCOME_UNKNOWN` from the receipt without reexecuting the operation. The client now preserves consumed original responses; this change was applied after all campaign exports. Asynchronous copy-selection behavior, import-time settings changes, repeated edit/restore cycles, and deliberate residual/boundary tests remain next. No tolerance or autonomous masking feature gate changed.

The final audit reverified all twenty-seven TIFF hashes, common checked metadata, and the exact frozen baseline across the three completed runs. The campaign is complete with its preparation difference recorded. After the response-retention change, TypeScript and all 160 Node tests passed; the unchanged Lua plug-in has 159 passing contract checks.

A separate live response-retention check used two read-only native calls (`selected` and `read_state`). Original success-response bytes remained unchanged across the next call and worker polling, settings were unchanged, and the bridge ended idle without pending requests or a call lock. Evidence: `.runtime/validation/bridge-response-retention-live.json`. Remote-error retention has mocked coverage; this live check did not deliberately induce a native error.
