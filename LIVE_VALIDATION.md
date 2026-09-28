# Live Lightroom validation

Validation performed on macOS with Lightroom Classic 15.5.1 on 27–28 September 2026, using one Canon CR3 and a separate working virtual copy. This was a live guided integration, distinct from automated tests with simulated bridge responses. The user compared two interpretations and selected B, the closer crop.

The detailed journal, native snapshot references, comparison reports, source RAW, and exported photos remain local and are not included in this repository. Catalog identifiers, state hashes, and run identifiers are also omitted. A fresh checkout should run the documented acceptance workflow against a photo its user is authorized to edit; this summary is not a reproducible evidence bundle.

## Observed results

The bridge created a virtual copy and native snapshot. The exposure test changed `Exposure2012` from `0` to `0.25`, recorded that value in the child checkpoint, and produced a visibly brighter export. At 2048 × 1365 pixels, the changed export differed in approximately 96.61% of color channels, with a mean absolute channel difference of 10.7651 and a maximum of 26. This establishes that the adjustment reached the exported image.

Restoring the baseline recovered its recorded settings and state token. The **first strict pixel comparison failed**: 52 pixels, comprising 156 color channels, differed within an 8 × 8 region. Maximum channel difference was 2; mean absolute difference was 0.00002647. The original local report retains `passed: false`. The localized difference's cause has not been established.

One additional export, without another edit or restoration, retained the same state token. Its decoded sRGB pixels matched the saved baseline preview exactly: zero changed pixels and maximum difference zero. The repeat's path and settings are recorded in the local evidence. This is pixel equality, not a claim that JPEG files including metadata have identical bytes. Both the failed first comparison and the successful repeat are retained; no difference tolerance was relaxed. The controller implements this bounded check: if the first restored export differs, it exports that same verified state once more, preserves both paths and differences in `restorationAttempts`, and still requires exact pixel equality. It does not repeat an edit or snapshot restoration, and it does not rewrite the original failed report.

The original source photo's before and after state tokens matched. This supports preservation of its recorded development state.

## Crop and existing-mask follow-up

The UI-created habitat crop restored with exact decoded pixels. The uncropped tonal parent recovered its recorded state but retained a maximum channel difference of 1 after the bounded export retry. The local crop-restoration report records these as separate outcomes, not an unqualified pass for both directions.

Existing-mask selection and native readback passed. The selected mask reported exposure `1` with range −4 to 4 and texture `0` with range −100 to 100. A later `edit-mask` set native exposure to `0.25` and texture to `10`. Its saved checkpoint recorded the corresponding values `LocalExposure2012: 0.0625` and `LocalTexture: 0.1`. All other recorded settings and mask geometry matched its parent; the plug-in verifies these remain unchanged. Native control units must therefore not be confused with saved settings units.

The earlier mask/no-mask restoration test recovered exact recorded settings in both directions, but **strict pixel restoration did not pass**. Differences remained after the bounded retry, with maximum channel differences of 1–3 across the recorded attempts. The local mask-restoration report preserves those failures. Their small magnitude does not turn them into exact matches. Existing-mask adjustment is live-tested; complete exact mask pixel rollback remains unresolved. The subject mask was created through Lightroom's UI, and `create_subject_mask` remains unsupported by this bridge.

## User selection and delivery check

The user viewed two edited interpretations and selected B, the closer crop. The selected JPEG is 5035 × 2760 pixels and embeds the sRGB IEC61966-2.1 profile. An independent read-only SHA-256 comparison verified that the delivery file matches the export referenced by its recorded candidate. The image and its runtime references are excluded from the repository.

## Local browser demo trial

On 28 September 2026, the local dashboard was tested with the same Canon CR3 through its browser file chooser. The 33 MiB upload was copied into a private local upload folder, imported through the Lightroom SDK, selected in Develop, and used to create a separate virtual copy and baseline preview.

Two real GPT-6 Astra calls ran through the signed-in Codex CLI. The first inspected the baseline JPEG and proposed three absolute global settings: highlights −25, shadows +18, and temperature 6000 K. Lightroom applied those settings and rendered a new preview. The second call compared that preview with the baseline and recommended stopping. Its public observations and adjustment rationale appeared in the dashboard journal. No preset or simulated agent response was used.

An integration-test selection of the current edit exercised the comparison endpoint and final export. This was a test action, not an additional photographer preference judgment. The resulting JPEG was 6720 × 4480 with an embedded sRGB profile. SHA-256 comparison confirmed that the uploaded RAW copy matched the source file, and the editing-session lock was released on completion. The earlier photographer-selected closer crop remains a separate run.

Browser checks covered RAW selection, start, live preview and journal updates, A/B presentation, selection, and the completed state. Pause/resume, stale question rejection, uncertain-operation handling, upload constraints, and competing server ownership also have automated tests; this trial does not establish every interruption or recovery path in native Lightroom. The dashboard shows verified renders and public decision summaries. Lightroom changes in its own native window; cursor movement and a screen-sharing feed are not part of this implementation.

## Validation limits

The live evidence covers one RAW and installation: the global-exposure cycle, existing-mask selection/readback/adjustment, human preference selection, and the distinct restoration results above. It does not establish exact mask pixel rollback, AI denoise, other native dependencies, all cameras, or interrupted operations. Photographic quality still requires inspecting the actual images and obtaining the user's preference where appropriate; one selected result is not an objective quality benchmark or evidence of a fully autonomous editor.
