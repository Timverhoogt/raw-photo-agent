# Agent editing procedure

This procedure uses the local controller in [README.md](README.md). It is executable by an agent with shell tools and image inspection, including an agent running in Codex. It is not a background service or a model prompt already running on an API. Supply your own authorized RAW photo; the repository does not include the validation photo, exports, or runtime evidence. [LIVE_VALIDATION.md](LIVE_VALIDATION.md) summarizes the original guided trial and its limits.

## Establish the target and intention

1. Obtain the user's chosen RAW filename or exact path. Ask for one when missing. Do not infer permission to edit a different photo merely because it is selected.
2. Verify `status`, `capabilities`, and `selected`. Exactly one matching RAW/DNG must be selected in Lightroom Classic. Open Develop. Read its state and check original-file availability when the SDK reports it.
3. Use `start` with the returned photo ID, exact filename, and a short intention. This creates the working virtual copy, baseline checkpoint, and baseline preview. Preserve the returned run and candidate IDs.
4. Inspect that actual preview using an image-viewing tool. Identify the subject, strongest light or gesture, distractions, and technical limits. Do not infer photographic quality from slider values or a histogram alone.
5. If no direction was given, propose a natural rendering that preserves scene content. Ask one concise multiple-choice question only when alternative directions would materially change the image. Do not promise competition results.

## Prove the native editing cycle

For the first real photo on this installation, run `verify-roundtrip` from the baseline before creative editing. It changes exposure on the virtual copy, renders, restores the baseline snapshot, renders again, and compares decoded pixels. If the first restored export differs, it performs at most one additional export of the same verified state. Every export path and difference is retained in `restorationAttempts`; exact pixel equality is still required. Neither the edit nor the restoration is repeated.

Require a passed result, inspect the actual previews, and check that the original source settings remain unchanged. If validation fails, investigate the native integration before continuing. Passing this test establishes the tested global adjustment and restoration path; it does not validate masks, AI Denoise, or every Lightroom setting.

## Edit with visual feedback

Use [SIMON_VIDEO_NOTES.md](SIMON_VIDEO_NOTES.md) as a photographic sequence, adapted to the image. Start by judging composition and white balance, then tonal balance and subject emphasis, color, noise and detail, and final reassessment. Revisit earlier decisions when later changes alter the balance. A step may require no adjustment.

For each meaningful change:

1. Name the visible problem, intended improvement, and possible cost in one sentence.
2. Choose an existing candidate as the parent. Restore it first when branching from an earlier state. Verify the current state and selection instead of assuming the last command still owns Lightroom.
3. Apply a small, coherent group of supported adjustments with `edit`. Values are absolute. Choose them from the actual image and current settings, without copying tutorial numbers mechanically.
4. Inspect the returned fresh preview. Compare against the best retained candidate for this creative direction at equal display sizes. Inspect detail crops for noise, texture loss, clipping, and halos; use Lightroom's native 100% view when the export is reduced.
5. Retain an improvement or restore the previous best candidate. Record the rationale in the command's reason and the user-facing progress. A successful API response does not establish visual improvement.

The current bridge exposes global tone, white balance, presence, color intensity, sharpening, and conventional noise reduction. Existing-mask selection, native readback, and adjustment of only `local_Exposure` and `local_Texture` passed a live test on one validation photo. Mask settings restored exactly, but strict mask pixel restoration remains unresolved. The bridge does not expose crop, profiles, lens corrections, removal, AI Denoise, or automatic subject-mask creation. Read capabilities at run time. A missing operation must not be silently approximated with an unrelated global adjustment.

Computer use can handle an explicitly scoped manual operation on the working copy after the global restoration test passes. Save a checkpoint first, inspect the result, capture the resulting state, then test restoration to the earlier checkpoint and back before relying on it. If the operation's state cannot be verified, stop that branch and explain the limitation. Never operate simultaneous UI and bridge mutations.

For an existing mask, keep the correct virtual copy in Develop with Masking open. If the mask was created in the UI, inspect its overlay and capture that state first. Use `selected-mask --photo` to read the mask ID and native slider values/ranges; `select-mask --photo --mask` can select another existing correction group without changing development settings. Selection verifies photo identity, expected state, and correction membership. Then use `edit-mask --run --parent --mask --set --reason` to create a checkpointed local-edit candidate. An illustrative `--set` is `'{"local_Exposure":0.25,"local_Texture":10}'`; choose actual values from the image and returned ranges. Native DevelopController values differ from saved fields such as `LocalExposure2012`: the live test stored native exposure `0.25` as `0.0625`, and native texture `10` as `0.1`. Never copy saved values into the command or assume the conversion for other controls. Inspect the new export and mask edges, and test restoration to the parent and back. Record settings equality and pixel equality separately; the current mask test passed the former and failed the latter, so do not claim complete exact rollback. `create_subject_mask` remains unsupported; mask creation currently uses Lightroom's UI rather than a general bridge-based detection operation.

Avoid invented scene content and generative replacement in the default photographic workflow. Preserve the original RAW and existing user edit. Do not edit multiple selected photos or change synchronization settings as a workaround for ambiguous targeting.

## Human choices and stopping

At a meaningful aesthetic fork, create two or three real alternatives. Use `compare` to persist the question and pause the run. Display the returned previews with neutral A/B/C labels and equal sizing, then ask for the user's preference with free-form feedback available. Record only the user's actual answer with `choose`. No reply is not a decision.

Use at most three aesthetic questions initially. Preserve the best checkpoint for each useful direction. The initial controller budget is 12 editing candidates plus the baseline; the roundtrip test uses one slot. Stop earlier after two successive refinements produce no clear improvement. Do not manufacture redundant finalists to reach a count.

Present two or three genuinely different useful finals when available, along with the original baseline and relevant detail crops. Explain visible tradeoffs briefly. Restore the user's chosen checkpoint and verify the selected state before delivery. Link the actual exported preview and identify the editable working copy and checkpoint. State export dimensions and any unresolved limitations.

The current CLI exports review JPEGs up to 8,192 pixels on the long edge. A full-resolution deliverable, a separate virtual copy for every finalist, or specialized print output requires a separately verified Lightroom export/copy workflow. Do not describe review previews as full-resolution masters.

## Interruptions and future judges

After a timeout or error, inspect `history`, bridge status, current selection, and current settings. Requests may finish after the caller stops waiting. Do not repeat an uncertain mutation with a new ID. Follow the README's reconciliation/recovery commands; preserve receipts, checkpoints, and candidate evidence.

Independent judges are a later addition. Initially they should review actual rendered alternatives without seeing the editor's justification, report specific visible defects and uncertainty, and suggest a bounded refinement. Their feedback must never silently replace a result already selected by the user.
