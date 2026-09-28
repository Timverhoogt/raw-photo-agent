# CLI guide

Run all commands from the project root. The controller requires Node.js 24 or newer. Native editing requires Lightroom Classic running on the same Mac, with the plug-in enabled. See the [project overview](../README.md) for installation and current scope.

Commands return JSON. Substitute the photo, run, candidate, and mask IDs returned by earlier commands for the uppercase placeholders in these examples. Inspect the exported image before deciding whether an edit improved it.

## Prepare the Lightroom plug-in

From this project directory:

```sh
node src/cli.ts setup
```

The command prints `pluginPath` and `bridgeDir`. The prepared plug-in is inside the project:

```text
<project>/.runtime/RawPhotoAgent.lrplugin
```

In Lightroom Classic, open **File → Plug-in Manager → Add** and select that `.lrplugin` directory. Then use **File → Plug-in Extras → Raw Photo Agent: Start / Status** and dismiss its dialog. Lightroom can defer initialization until this first menu use. After updating plug-in source, run `setup` again, reload this plug-in in Plug-in Manager, close the manager, and repeat **Start / Status**. This sequence was verified during the live Lightroom trial.

Check the connection and available operations:

```sh
node src/cli.ts status
node src/cli.ts capabilities
```

`status` reports the heartbeat and saved runs. An online heartbeat establishes communication, not editing correctness. Read `capabilities` before assuming a particular development setting or mask operation is available; implemented SDK access still requires a live acceptance test.

Setup copies this project's plug-in and writes its local configuration. It does not remove photographs, catalogs, other plug-ins, or existing run history.

## Start with one explicitly selected RAW

Select exactly one RAW or DNG in Lightroom Classic and open **Develop** (native snapshot restoration requires that module), then read its identity:

```sh
node src/cli.ts selected
node src/cli.ts state --photo 'PHOTO_ID'
```

Replace uppercase placeholders below with values returned by the commands. For `--filename`, supply the exact filename the user selected, such as `DSC_0123.NEF`; do not infer a target from another selected image.

```sh
node src/cli.ts start \
  --photo 'PHOTO_ID' \
  --filename 'DSC_0123.NEF' \
  --intent 'Natural wildlife rendering; retain feather detail and surrounding habitat'
```

`start` checks both photo ID and filename, creates a working virtual copy, saves a baseline checkpoint, and renders its preview. Save the returned `run.id`, `run.workingPhotoId`, and `baseline.id`. Keep the working virtual copy selected for subsequent operations. Mutating operations are restricted by the plug-in to the selected virtual copy.

All commands emit JSON. Preview paths point to files that a person or vision-capable agent can inspect; the CLI itself does not judge their appearance.

## Edit, inspect, and restore

Each edit names an existing parent candidate and its intended improvement. Values are **absolute settings**, not increments: `Exposure2012: 0.25` means +0.25 EV, not an additional +0.25 EV on every call.

```sh
node src/cli.ts edit \
  --run 'RUN_ID' \
  --parent 'BASELINE_CANDIDATE_ID' \
  --set '{"Exposure2012":0.25}' \
  --reason 'Brighten the subject slightly while retaining highlight texture'
```

The command checks the parent's state, applies the requested adjustment, saves a child checkpoint, and renders it. `--set @/absolute/path/adjustments.json` also accepts a JSON file. Use only settings supported by the bridge.

Inspect the returned `previewPath` before deciding whether to retain the change. View saved candidates, choices, and operation events with:

```sh
node src/cli.ts history --run 'RUN_ID'
```

To return to an earlier candidate and obtain a fresh preview:

```sh
node src/cli.ts restore --run 'RUN_ID' --candidate 'BASELINE_CANDIDATE_ID'
node src/cli.ts render --run 'RUN_ID' --candidate 'BASELINE_CANDIDATE_ID' --size 2048
```

`render` requires Lightroom's current state to match the requested candidate; it does not implicitly restore that candidate. Each export has a fresh path. A candidate's first preview remains its primary recorded evidence, while later renders appear in the event journal.

To retain an intentional manual edit to the working copy, capture it as a new checkpoint while the run is active:

```sh
node src/cli.ts capture \
  --run 'RUN_ID' \
  --parent 'PARENT_CANDIDATE_ID' \
  --reason 'Capture the manually refined crop'
```

Edits do not consume previous JPEGs as input: Lightroom develops the RAW using the current native settings. The initial `edit` budget is 12 editing candidates plus the baseline. Creating more edits is not itself evidence of improvement.

## Work with an existing mask

Existing-mask selection, readback, and local adjustment have passed a live test on the sample RAW. Exact recorded mask settings were restored in both directions, but strict pixel restoration remains unresolved. Check `capabilities` on the running plug-in. The initial supported local controls are only `local_Exposure` and `local_Texture`.

Keep the working virtual copy selected in Develop and open Lightroom's Masking panel. A mask must already exist. It can be created through Lightroom's UI, then inspected and saved using `capture` before local edits. The bridge's `create_subject_mask` operation remains unsupported; these commands do not provide automated subject detection or create a new mask.

Read the selected mask and its current native slider values and ranges:

```sh
node src/cli.ts selected-mask --photo 'WORKING_PHOTO_ID'
```

Use `maskContext.selectedMaskId` as the explicit target. To select a different existing correction group, obtain its `CorrectionID` from `state` and run:

```sh
node src/cli.ts select-mask --photo 'WORKING_PHOTO_ID' --mask 'MASK_ID'
node src/cli.ts selected-mask --photo 'WORKING_PHOTO_ID'
```

`select-mask` changes only the Masking panel's selection. It verifies the exact selected photo, expected state, and membership of that correction ID in the photo's existing masks. It does not select another photo or alter development settings.

For an active run at the captured parent checkpoint, an illustrative adjustment is:

```sh
node src/cli.ts edit-mask \
  --run 'RUN_ID' \
  --parent 'MASK_PARENT_CANDIDATE_ID' \
  --mask 'MASK_ID' \
  --set '{"local_Exposure":0.25,"local_Texture":10}' \
  --reason 'Gently lift the subject and test texture without brightening the background'
```

These are absolute **native `LrDevelopController` values**. Their units differ from saved settings fields such as `LocalExposure2012`; do not copy saved values or assume a conversion. In the live test, native exposure `0.25` and texture `10` were stored as `LocalExposure2012: 0.0625` and `LocalTexture: 0.1`. Read `maskContext.parameters` and choose values within the returned ranges. The command targets the existing mask, reads back its native controls, creates a child checkpoint, and renders it. Inspect the mask boundary and actual preview, then assess settings and pixel restoration separately. A successful settings check must not be reported as an exact pixel-restoration pass, and a command's success alone does not establish correct subject selection or a better photograph.

## Record a visual choice

Once two or three candidates have verified previews:

```sh
node src/cli.ts compare \
  --run 'RUN_ID' \
  --candidates 'CANDIDATE_A_ID,CANDIDATE_B_ID' \
  --question 'Keep more habitat or use the tighter crop?'
```

This returns A/B/C labels, candidate IDs, preview paths, and a choice ID, and puts the run in `awaiting_choice`. It **does not open a web comparison UI or collect a response automatically**. Show the real previews at matching display sizes, then record the user's actual choice:

```sh
node src/cli.ts choose \
  --choice 'CHOICE_ID' \
  --candidate 'CANDIDATE_A_ID' \
  --feedback 'Keep the habitat; soften the background contrast in a new version'
```

The requested decision is journaled, the chosen checkpoint is restored and verified, and only then is the choice committed and editing resumed. Repeating an already recorded decision does not repeat the restoration. Feedback is saved text; it does not automatically produce another edit. Existing decisions are immutable. A new preference or refinement requires a new branch and comparison. No reply is not a choice.

## Check rendering and restoration

For an **existing-mask diagnostic**, first create a separate working copy/run, open Masking, select the intended mask, and capture that state as a baseline. Then run:

```sh
node src/cli.ts verify-mask-roundtrip \
  --run 'RUN_ID' --candidate 'MASK_BASELINE_CANDIDATE_ID' --mask 'MASK_ID'
```

This records two unchanged-state exports, makes one bounded native mask exposure change (normally +0.25), verifies its readback and visible effect, repeats the changed export, and restores the native baseline once. Restoration allows one additional export, never another mutation. The report separates saved-baseline agreement, unchanged export repeatability, applied effect, restored settings, and exact restored pixels. It preserves all evidence and returns exit code 2 with `passed: false` when any check fails. The test uses 2048-pixel exports and does not establish mask creation/deletion recovery or full-resolution equivalence. Uncertain native errors preserve the shared session lock and require inspection before further work.

For an active run whose current state matches a chosen baseline, this command performs a real mutation test on its working virtual copy:

```sh
node src/cli.ts verify-roundtrip --run 'RUN_ID' --candidate 'BASELINE_CANDIDATE_ID'
```

It exports the baseline, makes a 0.25 EV exposure change, verifies read-back and changed preview pixels, saves a test candidate, restores the baseline snapshot, exports again, and compares decoded pixels. If that restored export differs, the command exports the same verified state once more; `restorationAttempts` preserves each export path and difference. It does not repeat the edit or restore, and it does not relax pixel tolerance. The test candidate remains in history and uses an editing-candidate slot. `passed: true` requires the edit to visibly change the preview and a restored export to match the baseline pixels exactly. It is not proof that every Lightroom feature or AI dependency is restorable. Inspect the actual images as well.

Compare any two render files directly:

```sh
node src/cli.ts image-diff \
  --before '/absolute/path/before.jpg' \
  --after '/absolute/path/after.jpg'
```

The output reports dimension equality and pixel differences after orientation and sRGB conversion. It measures rendering differences, not photographic quality.

For detail inspection, export a sufficiently large preview, then extract a region into a fresh output file:

```sh
node src/cli.ts render --run 'RUN_ID' --candidate 'CANDIDATE_ID' --size 8192
node src/cli.ts crop \
  --input '/absolute/path/render.jpg' \
  --output '/absolute/path/subject-detail.png' \
  --region '{"left":0,"top":0,"width":512,"height":512}'
```

Check the actual exported dimensions. A 100% crop of a reduced preview is not a 100% view of the source photo; the current render limit is 8,192 pixels on the long edge. For larger originals, use Lightroom's native 100% view. Evaluate noise, subject texture, highlights, and mask boundaries at an appropriate resolution, then reassess the whole image at its intended viewing size.

## Resume after interruption

The bridge does not automatically retry an uncertain request. A timeout may mean Lightroom is still processing it. The bounded additional export in `verify-roundtrip` occurs only after a successful export whose pixels differ; it is not a retry of a timeout or mutation. Inspect Lightroom and the journal before sending further mutations:

```sh
node src/cli.ts status
node src/cli.ts history --run 'RUN_ID'
node src/cli.ts state --photo 'WORKING_PHOTO_ID'
```

Once the bridge is idle and the intended working copy is selected, if its state already matches a saved candidate, reconcile the interrupted run:

```sh
node src/cli.ts reconcile --run 'RUN_ID' --candidate 'CANDIDATE_ID'
```

Otherwise restore a named checkpoint explicitly, inspect the result, then reconcile:

```sh
node src/cli.ts recover --run 'RUN_ID' --candidate 'CANDIDATE_ID'
node src/cli.ts render --run 'RUN_ID' --candidate 'CANDIDATE_ID'
node src/cli.ts reconcile --run 'RUN_ID' --candidate 'CANDIDATE_ID'
```

`recover` is only for interrupted runs; ordinary active runs use `restore`. Reconciliation returns to `awaiting_choice` when a user decision is still pending.

If initialization failed before its first candidate, the durable run still records the source and requested working-copy name. Inspect the operation response and select the exact virtual copy named `Raw Photo Agent RUN_PREFIX`. Then resume without creating another copy:

```sh
node src/cli.ts resume-start --run 'RUN_ID' --photo 'WORKING_PHOTO_ID' --filename 'DSC_0123.NEF'
```

This verifies the copy's identity, name, source path, and original settings. It also handles an incomplete initialization left marked active after a hard process termination, once any abandoned lock has been inspected. If no copy exists, the run cannot be resumed this way; reselect the original and start a new run after confirming the prior request did not create a copy.

If a process crash leaves `session.lock` or `bridge/call.lock`, inspect its recorded PID and Lightroom activity before deciding it is stale. Locks are not broken automatically. Do not delete the run database, bridge directory, or Lightroom catalog to clear a connection problem.

## Files and remaining limits

Runtime data stays under `.runtime/`: `runs.sqlite` holds candidates, choices, and events; `renders/` holds preview files; `bridge/` holds request/response transport; and `RawPhotoAgent.lrplugin/` is the prepared plug-in. Keep that state together when retaining a run. Lightroom separately owns the virtual copies and native snapshots in its catalog.

- The running desktop Lightroom session is required. Commands serialize access to this bridge; they do not prevent a person or another plug-in from changing Lightroom between commands. State checks reject mismatches.
- Existing-mask selection, local exposure, and local texture have passed a live test on the sample RAW; check `capabilities` for the running plug-in. Exact mask settings restoration passed, while strict mask pixel restoration did not. Guarded native subject/background creation is implemented; stored identity and selection do not certify completed pixel coverage or recovery. Autonomous demo masking remains disabled.
- AI denoise automation is not a verified feature. Do not assume a denoise operation preserves photo identity or that a settings JSON object captures every native dependency.
- The demo supports comparison, iterative global edits, and a final JPEG export. Automatic aesthetic scoring, selective autonomous refinement, final-delivery export presets, a production batch workflow, and independent judge loops remain future work.
- The photographic procedure and future architecture are in [DESIGN.md](../DESIGN.md); the selected tutorial is documented in [SIMON_VIDEO_NOTES.md](../SIMON_VIDEO_NOTES.md).

### Lossless restoration diagnostics

`render --run ID --candidate ID --format TIFF` exports a separate 16-bit sRGB TIFF; the candidate's saved JPEG remains unchanged. Use `verify-mask-roundtrip --run ID --candidate ID --mask MASK_ID --format TIFF` on an explicitly selected diagnostic copy to compare unchanged controls, a local exposure change, and a single restoration. Image differences report `bitDepth`; 16-bit channel values range from 0 to 65535. Exact state and exact pixels remain separate checks. See [restoration validation](restoration-validation.md) and [quality evaluation](evaluation.md).

For a repeatable corpus pilot, `node src/restoration/cli.ts run --id RAW_ASSET_ID --mask subject --controls 3` creates isolated copies, captures matched controls and both restoration stages, and records native sample, metadata and spatial evidence. `analyze --result /absolute/path/to/results.json` rechecks saved TIFFs without Lightroom. The separate `resume-import` command is restricted to an explicitly reconciled import-only `STALE_STATE` failure; its full requirements and source-verification scope are documented in [restoration validation](restoration-validation.md#reconciled-import-only-interruption).

`checkpoint-controls --result /absolute/path/to/completed/results.json --id RAW_ASSET_ID` separates unchanged exports, checkpoint-only exports, and restoration of an already-current snapshot on a new diagnostic copy. It captures nine fixed TIFFs without adjusting any development setting. See [render repeatability controls](render-repeatability.md) for its targeting requirements and environment scope.

If a separately inspected restart changes the native settings structure, an explicit `--source-baseline /absolute/path/to/baseline.json` containing `{ "state": PHOTO_STATE, "reason": "WHY_A_NEW_BASELINE_IS_NEEDED" }` starts a new diagnostic baseline. Preserve the observed difference and use the same frozen baseline for every matched configuration. The runner still requires exact current identity, token and full settings before copying; it retains both historical and new states and makes no equivalence or historical restoration claim. Without this option, the historical baseline remains mandatory.
