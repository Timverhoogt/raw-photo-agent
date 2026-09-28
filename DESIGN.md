# Iterative RAW photo editing agent

Design and implementation status, 28 September 2026. The local TypeScript controller, SQLite history, and Lightroom Lua plug-in are implemented; see [README.md](README.md) for usage. A live Lightroom Classic 15.5.1 test on a virtual copy of a Canon CR3 verified native snapshot creation, +0.25 EV adjustment and readback, a visibly changed export, and exact recorded-settings restoration. The first restored export differed in 52 pixels; an additional export of the same restored state matched all baseline pixels. The original source state token remained unchanged. Existing-mask selection/readback and local exposure/texture adjustment also passed a live test, preserving other recorded settings and mask geometry. Mask settings restored exactly in both directions, but strict mask pixel comparisons did not pass. The habitat crop restored with exact pixels; its uncropped parent retained a tiny difference.

The user compared two interpretations and selected B, the closer crop. Its 5035 × 2760 JPEG was verified against its recorded export and contains an sRGB profile. [LIVE_VALIDATION.md](LIVE_VALIDATION.md) summarizes these outcomes and limits. Raw photos, exports, runtime logs, and catalog/run identifiers remain local and are not included in this repository. AI denoise remains unverified. Sections describing MCP, a standalone interface, and independent judges remain future design.

The strict roundtrip check permits one additional export of the verified restored state, retains every export and difference, and still requires exact pixel equality. It does not retry mutations. Existing-mask commands (`selected-mask`, `select-mask`, `edit-mask`) initially expose only native `local_Exposure` and `local_Texture`. They require explicit photo and mask identities, current-state checks, and an existing correction group. Native DevelopController values differ from saved `LocalExposure2012`-style fields. Their local-adjustment path has passed a live test; exact mask pixel restoration remains unresolved. Subject-mask creation currently uses Lightroom's UI, with the bridge's automatic creation operation still unsupported.

## Recommendation

Use Lightroom Classic on the host Mac as the RAW renderer and editable document store. Let a vision-capable agent inspect rendered images and choose edits. The current prototype uses the CLI; a local MCP wrapper is proposed for tested operations, with computer use for operations the bridge cannot reliably perform.

Start with one user-selected RAW and a Lightroom virtual copy. Prove a complete observe/edit/render/compare/restore cycle before adding batch processing or a separate application. A direct computer-use trial can establish the workflow before building the bridge.

MCP standardizes how the agent calls tools; it does not expand Lightroom's underlying capabilities. Both the plug-in and UI control operate a running desktop Lightroom instance. This is not a headless Lightroom service.

The main advantage over a fixed preset is adaptive visual feedback. The agent's decision sequence should respond to each image. Each candidate is rendered from the original RAW plus its current edit state; previews must never become the source of the next edit.

## Recommended build route

Build a local Lightroom integration first and drive it from an agent running in Codex. This lets the workflow be evaluated before implementing a standalone agent host and comparison application.

Use a small Lua plug-in for Lightroom operations and a TypeScript controller for command validation, operation sequencing, render tracking, and recovery. Expose a local CLI first, then wrap the same operations in MCP. Reuse audited, license-compatible bridge code where it helps; keep the agent-facing interface limited to the operations this workflow needs. Do not equate a community project's advertised feature list with verified support.

Persist run state outside the conversation from the beginning: candidate ancestry, native checkpoint references, actual parameter changes, render revisions, user choices, and status. A small SQLite database plus preview files is the proposed durable store. Lightroom owns its native edit state; the controller owns run orchestration and the journal. The controller must reconcile both after interruption instead of assuming one atomic transaction covers them.

The first acceptance milestone is one selected RAW on a virtual copy: global edit, verified fresh render, full restoration, then the same cycle with a subject mask and local adjustment. Test interruption, selection changes, and incomplete renders. The original user edit must remain intact.

Next, conduct guided editing through Codex with actual previews, multiple-choice feedback, and separate final candidates. Assess results on a small varied photo set against human preference. Parallel development and read-only reviews are useful; serialize all mutations of the running Lightroom session.

After the workflow succeeds, add a dedicated comparison interface and an API-driven agent host. Reuse the controller and persistent run model. A standalone host must provide its own computer-use execution adapter for fallback operations; it cannot assume access to Codex's session tools. Add independent judges after collecting human evaluation, initially without automatic restarts.

The thin integration has completed a guided single-photo edit and user choice, with the validation limits summarized above. Next steps are investigating exact mask pixel restoration and repeating the acceptance workflow on a varied photo set before broader automation. Follow [EDITING_WORKFLOW.md](EDITING_WORKFLOW.md) for the current agent-driven procedure.

## Intended user experience

1. The user selects exactly one RAW in Lightroom Classic and gives an optional direction, such as natural wildlife, restrained landscape, or dramatic portrait. Lightroom Classic is the chosen initial target.
2. The agent identifies the subject, strongest visual feature, distractions, technical limitations, and a short editing intention.
3. It preserves the starting state and creates an independent virtual copy for its work.
4. It makes small, purposeful changes, inspecting the new rendering after each meaningful group.
5. It keeps a successful candidate or restores the best checkpoint for that direction. At meaningful aesthetic forks it offers a small multiple-choice comparison using real previews. It may revise an earlier decision as later edits change the balance.
6. It presents two or three useful final interpretations for comparison, with the original available as a toggle. The user can select one, request a refinement, or retain an earlier version. Offer fewer finalists when additional versions would be redundant.
7. It returns the chosen editable Lightroom copy, named checkpoints, a before/after comparison, an export, and a concise explanation of the choices.

Default direction: natural photographic rendering that preserves scene content. Award-winning quality is an aspiration to assess with human reviewers, not a guaranteed model capability.

## Human feedback in the first version

Use guided mode initially. Routine technical edits run automatically; questions address choices that would materially change the photograph's interpretation. The following are illustrative options, chosen and worded to suit the actual image:

| Moment | Example choices | What is shown |
|---|---|---|
| Establish intention | Faithful and natural / More dramatic / Suggest a direction | Starting image and a short proposed intention. |
| Resolve a composition fork | Keep more environment / Tighter subject crop / Keep current crop | Actual candidate crops at equal display size. |
| Resolve a tonal or color tradeoff | Softer contrast / Stronger subject separation / Keep current balance | Two or three rendered alternatives; describe visible differences. |
| Choose a final result | Select A / Select B / Select C | Polished alternatives with synchronized zoom, matching detail crops, and an original toggle. |
| Refine a choice | Keep this crop, soften the color / Reduce background darkness / Finish this version | Selected image plus free-form feedback. |

Provide free-form feedback and a way to retain the current direction. Do not force a decision between unwanted alternatives. Ask one question at a time; avoid repeated questions whose answer is already known. Use a small configured question budget, with three aesthetic checkpoints as an initial default.

In a guided run, waiting for a choice is a durable paused state. Save the run and candidates; no reply is not a selection. The agent may finish rendering already planned alternatives while waiting, but it must not treat a default button as a submitted preference. A separately user-selected autonomous mode can carry on under its stated creative brief and present finalists later.

Final comparisons use neutral A/B/C labels initially, equal dimensions, consistent color rendering, and the same output sharpening. Keep an honest view of crop-resolution differences. Reveal explanations on demand so they do not bias the initial visual choice. The selected candidate remains the authority for delivery; do not substitute a later judge preference silently.

Feedback applies to this photo by default. Reusing it as a general preference across future photographs should be an explicit user choice.

## Candidate history and control flow

Maintain a graph of candidates, with a best retained checkpoint per creative direction. A single global winner would prematurely discard legitimate alternatives. Each candidate has a stable ID, parent ID, full native state reference, render revision, intention version, decision history, and review references.

```text
inspect -> establish intention -> edit a branch -> render -> compare
                    ^                              |
                    |                              +-> keep or restore
                    |                              +-> ask meaningful user choice
                    |                                      |
                    +--------------------------------------+
                                                           |
                                              assemble finalists
                                                           |
                            [later: independent review -> bounded refinement]
                                                           |
                                                user selection
                                                   /       \
                                               refine      export -> complete
```

Accepted checkpoints are immutable. Refinement creates a child; rejection restores the verified parent. A request such as "A's crop with B's softer color" creates a new candidate and requires a fresh render and inspection, because edits interact. It is not a blind merge of settings.

Changing the creative brief increments the intention version and may reopen an earlier ancestor. Preserve previous finalists. If the user edits Lightroom directly, capture that state as a new checkpoint before resuming. Label any comparison awaiting user input as stale if its underlying candidates have changed.

## Independent judges: later phase

Implement human comparisons and reliable restoration before adding automated judges. Later, judges can recommend reopening an edit from a named checkpoint. They do not directly control Lightroom.

Use separate review contexts. Proposed roles are a technical reviewer for artifacts and detail, a composition reviewer for visual hierarchy, and an intention reviewer for fidelity to the user's choices. Run at least two reviewers for an automated restart decision; a third is optional. Fresh contexts supply procedural independence, not a guarantee of independent taste or errors. Model diversity can be evaluated later.

Each reviewer receives the same baseline, candidate exports, region crops, current user intention, explicit user decisions, and intended output. Hide the editing agent's rationale, candidate ranking, other reviews, and model identity. Randomize candidate presentation order while keeping the ID mapping reliable. Revisit order-sensitive judgments instead of treating them as strong evidence.

Require structured, grounded feedback:

```json
{
  "candidate_ids": ["candidate_12", "candidate_17"],
  "render_revisions": ["render_12_v1", "render_17_v1"],
  "intent_version": 2,
  "preference": "candidate_12",
  "confidence": "medium",
  "findings": [{
    "category": "technical",
    "region": "upper-right subject edge",
    "observation": "A bright outline is visible against the background",
    "severity": "material",
    "suggested_experiment": "Reduce the local exposure contrast and inspect the edge again",
    "preserve": ["chosen crop", "overall warmth"]
  }],
  "recommendation": "bounded_refinement"
}
```

Also permit `tie`, `insufficient_evidence`, `keep`, and `ask_user`. Judges should describe a visible issue and testable experiment, not invent exact slider values from appearance alone. Reject reviews for stale renders or an obsolete intention version.

The controller decides whether to reopen the loop. A grounded technical issue with corroboration or an objective check can trigger a child branch automatically within the run budget. A preference disagreement about mood, color, or composition goes to the user. Explicit user choices outrank generic judge preferences.

Suggested initial bounds: two judge rounds and at most two judge-triggered refinements, all within the shared 12-candidate run budget. Restarts never reset that budget. Stop if revisions oscillate, the same unsupported criticism repeats, or no candidate clearly improves the result. Preserve the earlier version unless the proposed fix wins a fresh comparison. Evaluate reviewer agreement with human choices before allowing wider autonomous use.

A review requested after completion reopens the selected finalist as a child. It must not silently overwrite the delivered result.

## Components

```text
User-selected RAW + editing intention
                 |
                 v
Agent: inspect -> propose -> edit -> inspect -> compare
                 |                         |
                 v                         v
        Local MCP/CLI bridge          Saved candidates
                 |                   and edit journal
                 v
        Lightroom Classic Lua plug-in
                 |
                 v
        RAW render + editable state

Computer use supplies any missing or unreliable operations.
```

The model receives a clean overview, relevant full-resolution crops, current settings, and the editing intention. Screenshots establish UI state; color-consistent exports provide the primary aesthetic comparison. RAW sensor files are developed by Lightroom. OpenAI's documented image input formats are rendered formats such as PNG and JPEG, not camera RAW files.

## Agent procedure

The initial photographic reference is [Simon d'Entremont's 12-step Lightroom Classic masterclass](https://www.youtube.com/watch?v=SfIMa_2zYN4). English auto-generated captions were reviewed; they are not included in the repository. Source notes and timestamped stages are in [SIMON_VIDEO_NOTES.md](SIMON_VIDEO_NOTES.md). The procedure below is our engineering adaptation, not a verbatim transcript or a requirement to reproduce every example setting.

Use the source notes as the initial creative sequence. The numbered checks below describe the agent's responsibilities, not a fixed execution order. An early detail assessment can identify noise without committing to denoising yet; revisit color after local tone changes. Import and culling are outside the selected-photo MVP.

1. **Understand the photograph.** Identify the subject and visual hierarchy. Inspect an overview and subject detail. Note whether focus, motion, clipping, or resolution limits what editing can achieve.
2. **Preserve the baseline.** Record the selected photo identity, current development state, engine version, and original rendering. Create a virtual copy and a named starting snapshot. Disable multi-photo synchronization for this run.
3. **Choose a foundation.** Inspect the camera profile, white balance, lens corrections, and chromatic aberration. Compare alternatives only where there is a concrete benefit.
4. **Assess noise and detail early.** If denoising is needed, test its effect at 100%. Verify whether the operation changes image identity or creates a derivative before continuing. Keep denoising and sharpening decisions revisitable.
5. **Shape composition.** Test crop and straightening against the subject and intended output. Preserve sufficient resolution and meaningful scene context.
6. **Balance global tones.** Adjust exposure, important highlights, shadows, whites, blacks, and contrast in small related groups. Preserve intentional deep shadows and specular highlights where appropriate.
7. **Refine color.** Adjust color relationships and saturation according to the intended mood, checking believable skin, foliage, sky, or plumage where relevant.
8. **Direct attention locally.** Create and inspect subject/background or other appropriate masks. Check overlays and boundaries before local adjustments. Avoid bright outlines, mask spill, and unnatural subject separation.
9. **Refine detail.** Inspect subject texture, noise, sharpening halos, and shadow artifacts at 100%, then judge the whole picture at its intended viewing size.
10. **Finish and verify.** Compare the strongest candidate with both the starting image and intermediate checkpoints. Restore the best candidate and verify the exported image, including output size and color profile.

These are decision stages, not mandatory slider changes. Skip unnecessary stages and revisit earlier ones when the image warrants it.

## Independent photographic perspective

[Matt Hill's Lightroom Classic walkthrough](https://www.nationalparksatnight.com/blog/2021/2/27/controlling-highlights-in-urban-and-suburban-night-photography) supplies a detailed second opinion from night photography. He builds a global foundation, then makes local highlight corrections. His light-source example emphasizes believable illumination rather than maximum recovered detail. This 2021 article is useful for photographic judgment, not current AI-feature behavior.

[Matt Kloskowski's masking explanation](https://mattk.com/art-of-masking/) supplies a complementary example: globally lifting shadows to improve one tree makes other trees implausibly bright. Its public text supports that example; the paid course has not been reviewed.

Our resulting design choices are to judge regions by their visual role and switch to a local adjustment when a problem is regional. Bright lights and intentional dark areas must not be penalized solely for extreme pixel values. These references inform the critique rubric without requiring a fixed look.

For every candidate:

```text
State the visual problem and expected improvement.
Save the complete prior state.
Change a small, related group of settings.
Verify the correct photo and actual settings after the operation.
Wait for the operation and fresh render to finish.
Compare the new render with the best retained candidate and baseline.
Accept and checkpoint, or restore and verify the prior best state.
```

## Quality evaluation

Use visual comparisons plus technical checks. A single numeric "beauty score" must not control the edit.

- Evaluate subject clarity, composition, visual hierarchy, tonal balance, color coherence, and fit to the user's intention.
- Check important-region clipping, halos, noise amplification, texture loss, mask spill, and resolution after cropping. Image metrics are evidence, not targets to maximize or minimize blindly.
- Include 100% crops of the subject, critical highlights, shadows, and mask edges. Overview images alone hide defects.
- Compare candidates at identical dimensions, color space, and viewing conditions. Use neutral candidate labels and vary A/B presentation order when asking for a second critique.
- Always compare against the best retained candidate for the current creative direction and preserve the user's selected alternatives. More editing is not presumed to be better.
- Suggested initial bounds: at most 12 candidate rounds, and stop after two successive refinement rounds show no clear improvement. These are configurable starting choices, not validated optimum values.
- On reaching a limit, restore the best retained state and disclose unresolved issues.

Checkpoint records should contain parent checkpoint, Lightroom photo/copy identity, named native snapshot reference, settings, mask-related state/reference, preview paths, engine version, actual changes, observed result, and accept/reject decision. Do not assume a JSON copy of slider values captures every AI edit or mask dependency.

## Proposed tool contract

These names describe the interface to implement; they are not claims about currently installed tools.

| Tool | Purpose |
|---|---|
| `capabilities` | Return editor/plugin versions and operations actually available and tested. |
| `get_selected_photo` | Resolve exactly one explicit target and report RAW/original availability. |
| `create_working_copy` | Preserve the user's existing edit and return the new copy identity. |
| `read_state` | Return current settings, mask metadata, and revision for that identity. |
| `save_checkpoint` | Create a native snapshot and persistent journal entry. |
| `apply_adjustments` | Validate parameter names/ranges, apply absolute values, and read them back. |
| `create_mask` / `adjust_mask` | Use supported SDK calls; return verified mask identity and completion state. |
| `render_preview` | Render the requested revision with consistent color settings; include detail crops. |
| `restore_checkpoint` | Restore full native state and verify settings and rendered result. |
| `present_comparison` | Present current candidate renders with a durable question ID and capture a real user selection or refinement request. |
| `branch_candidate` | Create a child of an immutable checkpoint while preserving its creative direction and user choices. |
| `request_independent_reviews` | Later: provide identical review packages to separate reviewers and collect revision-bound critiques. |
| `export_final` | Export the chosen state with explicit output parameters. |

Serialize mutations per Lightroom session. Every mutation must identify its photo/copy and expected prior revision. Prevent stale previews and late asynchronous actions from being attributed to a different candidate. If the user switches photos mid-run, pause or re-establish the explicit target before editing.

## What the documentation establishes

- Adobe supports Lua plug-ins for Lightroom Classic. Its SDK reference documents development adjustment access, snapshots, virtual copies, rendering, and AI mask operations. Some controller operations require the Develop module and current-photo context. The global-exposure cycle above has been live-tested; documented operations beyond that tested scope still require their own validation.
- Mask creation is not necessarily a UI-only feature in the SDK. Its reference exposes `createNewMask` and operations for selecting and combining masks. This prototype still reports `create_subject_mask` as unsupported and uses the UI for creation. Guarded existing-mask selection and exposure/texture adjustment have passed a live test, as has exact recorded mask-settings restoration. Strict mask pixel restoration has not passed. UI creation does not establish a general bridge-based subject-detection capability.
- AI denoising automation coverage remains unverified. Use computer use only if it works reliably in a local test; do not advertise it as a tested API feature.
- Adobe's older Firefly Lightroom editing API reached its announced end of life on 31 July 2026. Adobe directs users to Photoshop API v2. This is separate from Lightroom's cloud catalog API.
- Photoshop API v2 is a possible hosted rendering backend, but it would require a separate architecture and validation of editing/masking coverage and Lightroom round-tripping.
- RawTherapee offers a useful headless alternative: the agent versions complete PP3 parameter files and renders the original RAW via CLI. darktable offers CLI/XMP rendering and richer masking, including AI object masks in version 5.6. Neither should be assumed to match Lightroom rendering or preserve Lightroom editability.

## First implementation and verification

Community candidates inspected at source level:

- [Automaat/lightroom-mcp](https://github.com/Automaat/lightroom-mcp): a focused starting point with development controls and exports. Its selected-settings preset checkpoints should not be treated as complete photo-state restoration; masks and native snapshot restoration need work.
- [znznzna/lightroom-cli](https://github.com/znznzna/lightroom-cli): broader CLI/Python/MCP coverage, including mask operations and JPEG previews. Snapshot creation is present, but snapshot restoration was not found in the inspected implementation. Preview freshness and mask completion still need live verification.

These are candidates for evaluation, not installed dependencies or endorsements of runtime reliability.

1. Select a representative user-provided RAW and conduct one desktop editing trial on a virtual copy. Record operational gaps and actual time per render.
2. Evaluate an existing community Lightroom bridge before building a new one. Inspect source and test photo targeting, preview freshness, and complete snapshot restoration; tool counts alone are not evidence of reliability.
3. Prove the minimal bridge cycle: read settings, save snapshot, change exposure, render, restore snapshot, render again. Compare the restored state with baseline.
4. Add subject/background masking only after verifying mask creation, preview completion, local adjustment targeting, and rollback of both masks and adjustments.
5. Add guided comparison checkpoints and two or three final candidates. Verify pause/resume, persisted user choices, branch restoration, synchronized image comparison, and user-requested refinements.
6. Run the agent procedure on a small varied set of user-selected RAWs. Compare original, a fixed preset/Auto baseline, and the agent result through blinded human preference review. Measure failures, time, and model cost as well as preference.
7. Add independent judges in an observational mode first: record their critiques without automatically editing, and compare them with human decisions. Enable bounded restarts only after the feedback proves useful.
8. Expand only when the editable result, recovery behavior, and photographic quality are useful. Batch processing follows these checks.

## Sources

- [OpenAI: GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [OpenAI: computer use](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [OpenAI: supported image inputs](https://developers.openai.com/api/docs/guides/images-vision#image-input-requirements)
- [Adobe: Lightroom Classic SDK](https://developer.adobe.com/lightroom-classic)
- [Adobe SDK reference mirror: Develop controller](https://lrc.mcor.dev/modules/LrDevelopController.html) — Adobe-authored reference hosted by a third party.
- [Adobe SDK reference mirror: photos and snapshots](https://lrc.mcor.dev/modules/LrPhoto.html)
- [Adobe SDK reference mirror: catalog and virtual copies](https://lrc.mcor.dev/modules/LrCatalog.html)
- [Adobe: native history and snapshots](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/develop-module-options.html)
- [Adobe: old Lightroom editing API retirement](https://developer.adobe.com/firefly-services/docs/lightroom/getting-started/deprecation-announcement/)
- [Adobe: Photoshop API v2 edit migration](https://developer.adobe.com/firefly-services/docs/photoshop/guides/photoshop-v2/v1-to-v2/edit-operations)
- [RawTherapee: CLI](https://rawpedia.pixls.us/command-line_options/)
- [RawTherapee: processing profiles](https://rawpedia.pixls.us/sidecar_files_-_processing_profiles/)
- [darktable 5.6 release](https://www.darktable.org/2026/06/darktable-5.6.0-released/)
- [Simon d'Entremont: Complete Lightroom Masterclass: EDIT PHOTOS like a PRO with my 12-step process!](https://www.youtube.com/watch?v=SfIMa_2zYN4) — user-selected reference; English auto-generated transcript retrieved.
- [Matt Hill: Controlling Highlights in Urban and Suburban Night Photography](https://www.nationalparksatnight.com/blog/2021/2/27/controlling-highlights-in-urban-and-suburban-night-photography) — independent Lightroom Classic walkthrough, used for photographic principles.
- [Matt Kloskowski: The Art of Masking](https://mattk.com/art-of-masking/) — public masking example; full paid course not reviewed.
