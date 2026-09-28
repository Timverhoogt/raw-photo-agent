# Raw Photo Agent roadmap

Updated 28 September 2026. The goal is a Lightroom assistant that makes image-specific editing decisions, checks the result, can backtrack, and leaves the photographer with an editable result they prefer.

## Working today

One RAW upload or explicit Lightroom selection; a protected original and working virtual copy; iterative global edits; agent-requested detail inspection; matching before/after crops; checkpoints; public progress notes; review retry; final choice and JPEG export. Repeatable local quality evaluation now indexes RAW/XMP hashes, runs separate working copies, creates blinded comparison pages, and records explicit photographer preferences. See [evaluation usage](docs/evaluation.md) and separate live Lightroom evidence in [LIVE_VALIDATION.md](LIVE_VALIDATION.md). Automated checks establish integration behavior, not general photographic quality.

## Next milestone: selective editing with verified recovery

Start with one existing subject mask on a separate working copy. Apply a bounded local exposure adjustment, inspect the subject and mask boundary, compare the result, and restore the prior state. Then extend to subject/background mask creation and local edits only after the same recovery checks succeed.

Subject/background creation and a guarded existing-mask agent loop are implemented; autonomous demo masking stays disabled. The repeatable [restoration pilot](docs/restoration-validation.md) now records unchanged controls, a bounded edit, both restoration steps, source hashes, native settings and spatial TIFF differences. The comparator was corrected to retain native 16-bit samples without an ICC conversion that could hide low-order changes. Synthetic one-bit and thin-edge regressions are detected.

Three user RAWs have live subject-mask restoration evidence, including a close portrait and mixed indoor light. A fourth RAW completed a background-mask pilot with a measurable +0.01 EV intervention. Saved settings recover exactly; exported pixels remain nonexact. A separate unchanged-export trial at native resolution also varied. Neither a whole-image average nor the largest observed control difference is an acceptance threshold. An explicit, guarded import-only recovery path is implemented and live-tested; it allowed the background trial to continue without repeating its failed import.

A fixed [checkpoint/no-op restore pilot](docs/render-repeatability.md) is now implemented and live-tested on one RAW. All nine exports retained identical settings, while all fifteen pixel comparisons remained nonexact, including unchanged pairs. Source and evidence hashes verified. This separates these controls in the record but does not establish the cause of variation.

The approved restarted Auto and GPU Off conditions have now completed without concurrent automated tests: eighteen TIFFs, thirty nonexact comparisons, exact settings against the same explicitly recorded post-restart baseline. Turning graphics processing Off did not eliminate variation. Both original graphics preferences are restored to Auto and verified after restart. The final restored-Auto trial stopped during virtual-copy selection verification before any export; its copy and evidence are preserved, and reconciliation awaits the Mac being unlocked. See [campaign details](docs/render-repeatability.md#restarted-auto--off-campaign-28-september-2026).

Next, reconcile the interrupted copy creation and finish the final Auto condition as a separate recorded experiment. Fix retention of consumed bridge responses and investigate asynchronous copy selection, then run repeated edit/restore cycles and diagnose the import-time settings change observed on one corpus file. Restart also added an empty field to native settings readback; that difference remains explicit rather than normalized away. Preserve exact native-state checks and every observed pixel difference; nonexact comparisons remain unverified. Expand deliberate residual and boundary tests before proposing a calibrated recovery rule or enabling autonomous local edits.

Done when one selected RAW can undergo a subject/background edit, boundary inspection, backtracking, and candidate comparison with verified targeting and recovery. Mask creation/deletion and existing-mask parameter restoration require separate evidence.

## Milestones after that

| Milestone | User-visible result | Acceptance gate |
| --- | --- | --- |
| Composition and richer editing | Crop/straighten alternatives, selective light/color, and refinement requests such as “keep this crop, soften the background.” | Render and compare actual alternatives; preserve resolution and correctly map detail regions across different crops; verify recovery. |
| Reliable single-photo beta | Simple startup, persistent session browsing/resume, understandable recovery, and dependable final export. | Varied RAWs complete successfully; interruption and Lightroom-selection changes preserve user work; results remain editable. |
| Independent critique | A separate reviewer flags visible defects and suggests bounded refinements. | Observe first, compare critiques with photographer judgments, then enable limited revisions; preserve the user's selected result. |
| Batch workflow and optional preferences | Review a shoot efficiently, keep a consistent intended look, and reuse explicitly saved preferences. | Single-photo quality and reliability hold across a varied test set; support per-photo exceptions and review. |

## Quality evaluation runs alongside every milestone

The supplied corpus contains 16 RAWs and 16 matching XMP sidecars. Preserve these originals and existing edits; use fresh copies for every run. The first three-photo integration run completed successfully and its blinded review awaits photographer preferences. Next expand to 5–10 photographs spanning different lighting, subjects, noise levels, and compositional challenges. Compare the as-imported starting image, the explicit fixed gentle comparator, and the agent result through blinded photographer selection. The fixed comparator is not Lightroom Auto. Record preference, visible defects, unnecessary edits, failures, time, and available model-usage data. Repeat the same set when adding tools so improvements and regressions are visible. No quality win is claimed before photographer votes exist.

The outcome matters more than the number of steps: retaining a good image is valid, and a more complex edit must earn its place through visible improvement. A complete general-purpose editor, broad camera support, automated mask quality, and a proven quality advantage remain future outcomes.
