# Raw Photo Agent Lightroom plugin

This is an initial local integration with limited live testing in Lightroom Classic 15.5.1 on macOS. That trial does not establish compatibility with every Lightroom version, RAW format, or AI feature. The plugin can import an explicitly uploaded RAW and edit a virtual copy. It does not install itself, change original development settings, or contact a network service. The [local demo](../docs/demo.md) separately sends rendered JPEG previews through the signed-in Codex CLI. Lightroom Classic must be installed and running with this plugin enabled. Only one installed copy may use a given bridge directory.

The controller prepares an installed copy of `RawPhotoAgent.lrplugin` and a `config.json` inside it:

```json
{
  "bridgeDir": "/absolute/path/to/raw-photo-agent/.runtime/bridge",
  "exportRoot": "/absolute/path/to/raw-photo-agent/.runtime/renders",
  "importRoot": "/absolute/path/to/raw-photo-agent/.runtime/uploads"
}
```

Inside-plugin configuration takes precedence over a sibling `config.json`. With neither present, the bridge uses `RawPhotoAgent.lrplugin/runtime` and its `renders` and `uploads` children. Use normalized absolute macOS paths. All configured directories and the installed plugin must be writable by Lightroom. After enabling or reloading the plug-in, close Plug-in Manager, invoke **File → Plug-in Extras → Raw Photo Agent: Start / Status**, and dismiss its dialog. Lightroom can defer initialization until this first use; the menu also restarts a stopped worker. Verify an idle heartbeat before issuing commands.

The paths above and in `config.example.json` are placeholders. The controller generates machine-specific configuration when preparing the installed plugin. Keep that configuration and runtime requests, responses, checkpoints, uploads, and renders out of a public repository; they can contain local photo paths and image data. Imported uploads remain catalog source files: keep them available while Lightroom references them. The upload process leaves the user's source file untouched.

## File protocol

The controller atomically writes `requests/<uuid>.json`; the plugin serially handles requests and atomically publishes immutable `responses/<uuid>.json` files. It leaves requests, receipts, and responses in place for reconciliation. Temporary files are ignored. No request filename may contain paths or arbitrary code.

```json
{
  "protocolVersion": 1,
  "id": "00000000-0000-4000-8000-000000000001",
  "operation": "selected",
  "params": {},
  "issuedAt": 1790546400000,
  "deadlineAt": 1790546430000
}
```

Timestamps are Unix epoch **milliseconds**. An expired request cannot begin an operation or a delayed catalog write. A deadline is not cancellation of an already-started Lightroom operation: export and snapshot work may finish later. Retrieve the original response instead of resubmitting the edit with a fresh ID after a timeout.

Responses are `{protocolVersion:1,id,ok:true,result}` or `{protocolVersion:1,id,ok:false,error:{code,message,outcomeUncertain}}`. `outcomeUncertain` is true after a catalog, selection, module, or photo mutation has begun or when a prior dispatch has no saved outcome; it is false for known precondition failures. The heartbeat is `heartbeat.json`, containing protocol/plugin versions, epoch-millisecond `timestamp`, and `status` (`idle`, `busy`, `stopped`, or `error`). During a request it also has `requestId`. It updates approximately once per second; Lightroom scheduling may delay it. Heartbeat replacement uses POSIX rename when available, otherwise a brief missing-file window is possible. Clients must tolerate that window.

An immutable receipt is saved **before dispatch**. A completed request ID reuses its saved response. If Lightroom stops after dispatch but before saving the response, that ID returns `OUTCOME_UNKNOWN` after restart and is never executed again. This provides at-most-once dispatch, not an atomic transaction across Lightroom and the filesystem. Preserve the receipt directory. Closing files and renaming them is not a guarantee against sudden power loss.

## Implemented operations

| Operation | Parameters | Result |
| --- | --- | --- |
| `capabilities` | `{}` | Versions, operation flags, adjustment ranges, restrictions; `liveValidated:false`. |
| `selected` | `{}` | `{photos:[{photoId,name,copyName,fileFormat,isVirtualCopy,path}],count,photoId?}`. |
| `import_photo` | `{path,filename}` | Original photo descriptor after restricted upload import/reuse, exact selection, and entry to Develop. |
| `reveal_photo` | `{photoId}` | Photo descriptor after entering Develop while preserving the exact current selection. |
| `create_working_copy` | `{photoId,copyName}` | `{photoId,sourcePhotoId,photo,state}`. |
| `read_state` | `{photoId}` | `{photoId,settings,stateToken,masks,masksAvailable,masksSource,stateTokenScope}`. |
| `selected_mask` | `{photoId,maskId?}` | Read-only `{state,maskContext}` with selected group/component identity and native controller values/ranges. |
| `select_mask` | `{photoId,expectedStateToken,maskId}` | `{state,maskContext}` after selecting and verifying an existing mask; settings must remain unchanged. |
| `checkpoint` | `{photoId,name}` | `{snapshotId,name,state}`. |
| `apply` | `{photoId,expectedStateToken,adjustments}` | `{state,appliedAdjustments}`. |
| `restore` | `{photoId,snapshotId,expectedStateToken}` | `{state,snapshotId,settingsVerified:true,renderComparisonRequired:true}`. |
| `render` | `{photoId,expectedStateToken,outputPath,maxEdge?}` | Output path, photo/state identity, JPEG size and color settings. |
| `adjust_mask` | `{photoId,expectedStateToken,maskId,adjustments}` | `{state,maskId,appliedAdjustments,maskContext,renderComparisonRequired:true}`. |
| `create_subject_mask` | Reserved | `UNSUPPORTED`, with no mutation. |

Photo IDs are opaque strings combining the catalog path digest and Lightroom's local photo ID. Every photo-ID operation requires exactly one selected photo matching that ID; it never changes photo selection to recover a mismatched target. Explicit upload import is the exception: it finds an original by the restricted path or imports it, then selects that original. `create_working_copy` invokes the SDK's copy operation, which selects the new copy, then checks its identity and settings.

`import_photo` accepts only `importRoot/UUID/filename` with an exact filename match, a supported RAW/DNG extension, and a nonempty existing file. It rejects traversal, unsafe filenames, and paths redirected by the SDK's alias resolver. The SDK does not expose a documented Unix `lstat`/no-follow primitive; the demo upload boundary additionally uses native filesystem checks to reject symlinks. The handler checks `findPhotoByPath`, rechecks inside catalog write access before `addPhoto`, verifies the resulting original, selects it alone, and enters Develop. Once catalog/selection work begins, a failure reports an uncertain outcome rather than inviting an automatic retry.

Photo edits and snapshots require a virtual copy. Import creates or locates an original without applying development settings, and `reveal_photo` only changes the active module. Global and local adjustments accept RAW/DNG only. `apply` accepts explicit numeric SDK development keys listed by `capabilities`: modern tone controls use `Exposure2012`, `Contrast2012`, `Highlights2012`, etc. Unknown names and out-of-range values fail before writing. The only exposed white-balance mode is `Custom`; changing Temperature/Tint also sets that mode. Auto tone, process-version changes, profiles, crop, removal, lens correction, Denoise, and mask creation are not exposed in this version. All requested adjustment values are read back after the write.

Existing-mask adjustment is narrowly limited to `local_Exposure` and `local_Texture` via `LrDevelopController.setValue`. These are **controller-native units**, not the `LocalExposure2012`/`LocalTexture` values stored inside `getDevelopSettings`; inspect `selected_mask` first. Its `maskContext.parameters` maps each supported control to `{value,min,max}` from Lightroom. Both selection and adjustment require Develop with Masking open. The requested `maskId` must be a stored group `CorrectionID`, not a component `MaskID`. `adjust_mask` selects that existing group if necessary, confirms the selected ID, and checks each numeric range before setting. It never changes photo selection or creates a missing mask. It waits up to five seconds per control for native readback and a changed stored field, verifies all other settings/mask geometry remain unchanged, and reports potentially applied failure rather than retrying an unverified write. A live trial confirmed existing-mask selection and controller values/ranges; repeat the acceptance checks on each supported Lightroom environment.

State tokens hash canonicalized `getDevelopSettings` plus photo identity. They deliberately exclude edit counters, so restoring an earlier state recovers the same token. They are concurrency checks for represented SDK state, **not proof that every opaque AI cache or external dependency is unchanged**. They cannot lock out a human editing Lightroom at the same time. Stop editing manually during a request. A photo switch detected during an operation causes an error; an already-applied change is not silently retried or rolled back onto another selection.

Checkpoints append a request-specific suffix to the supplied name and use native Lightroom snapshots. The recorded `snapshotID` is used for restoration, not `id_global`. Restore requires the selected photo in Develop and a checkpoint recorded by this bridge. It waits up to five seconds (bounded by the request deadline) for represented settings to match. An unmatched result returns `RESTORE_UNVERIFIED`. The caller must then compare fresh baseline/restored renders to validate full visual recovery, including masks and AI-dependent edits. Snapshots are not a backup of the RAW or catalog.

Renders use `LrExportSession` and wait for a completed rendition rather than cached thumbnails. They use JPEG quality 0.9, sRGB, no export sharpening, no watermark, no reimport, limited metadata, and no upscaling. `maxEdge` defaults to 2048 and permits 256–8192 pixels. `outputPath` must be a new file directly in `exportRoot`, with a basename containing only ASCII letters, numbers, periods, underscores, or hyphens, ending in `.jpg`. `..` and subdirectories are rejected. Completed scratch exports are moved into place only after state/target checks. A failed or interrupted operation may leave scratch files for diagnosis. The plugin never deletes photos, snapshots, receipts, or existing exports.

## Validation

The offline harnesses currently report **104 checks: 82 operation checks and 22 IPC/lifecycle checks**. See [portable test instructions](RawPhotoAgent.lrplugin/tests/README.md). They mock the SDK and do not require Adobe Lightroom, a catalog, or photos. The plugin itself runs in Lightroom's Lua environment; a separate Lua interpreter or optional Python/Lupa environment is needed only for these offline checks.

Run the following live acceptance sequence before relying on a new Lightroom version or environment:

1. Enable the prepared plugin and verify `capabilities` and `selected` without changing a photo.
2. On a user-chosen RAW, create a working copy and checkpoint; change exposure, render, restore, and render again.
3. Compare settings and decoded image pixels across recovery, allowing documented rendering nondeterminism if observed.
4. Exercise stale tokens, wrong/no/multiple selections, missing originals, duplicate request IDs, deadlines, and restart after a dispatched request.
5. Test native snapshots containing real masks/AI edits before claiming full rollback, and verify the existing-mask controls with fresh renders. Mask creation remains disabled.

A live browser trial also completed upload/import, virtual-copy creation, a model-proposed global edit, fresh render, model review, and final JPEG export. See the [live validation record](../LIVE_VALIDATION.md). Existing-mask commands remain a manual CLI capability; the autonomous demo only applies global settings.

Offline checks cannot establish Lightroom SDK runtime correctness. `capabilities.liveValidated` remains `false`: limited successful live trials do not certify the complete acceptance sequence or all supported inputs.

## SDK references and attribution

- [Adobe Lightroom Classic SDK](https://developer.adobe.com/lightroom-classic)
- Adobe-authored reference mirrors: [LrPhoto](https://lrc.mcor.dev/modules/LrPhoto.html), [LrCatalog](https://lrc.mcor.dev/modules/LrCatalog.html), [LrDevelopController](https://lrc.mcor.dev/modules/LrDevelopController.html), [LrExportSession](https://lrc.mcor.dev/modules/LrExportSession.html), [LrExportRendition](https://lrc.mcor.dev/modules/LrExportRendition.html), [LrApplicationView](https://lrc.mcor.dev/modules/LrApplicationView.html), [LrFileUtils](https://lrc.mcor.dev/modules/LrFileUtils.html).
- [Vendored json.lua](RawPhotoAgent.lrplugin/vendor/json.lua) is rxi/json.lua v0.1.2, MIT licensed, unmodified. Its copyright and permission notice are preserved in the source and [JSON-LICENSE.txt](RawPhotoAgent.lrplugin/vendor/JSON-LICENSE.txt). [Upstream source](https://github.com/rxi/json.lua/tree/v0.1.2); [repository third-party notices](../THIRD_PARTY_NOTICES.md).

No third-party Lightroom bridge code or Adobe SDK distribution is included. Lightroom provides the SDK runtime modules used by the plugin. Adobe Lightroom Classic is a separately installed product; this project is not affiliated with Adobe.
