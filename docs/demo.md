# Local Lightroom demo

The demo runs a browser interface at **http://127.0.0.1:4318** and edits through the installed Lightroom Classic plugin. It uses your signed-in Codex CLI, with `gpt-6-astra` as the default model, to inspect actual rendered previews and choose the next supported action.

One live browser trial completed upload, native import, virtual-copy creation, two Astra decisions around an actual global edit/render, and a 6720 × 4480 JPEG export with an embedded sRGB profile. The final choice in that trial tested export integration; it was not a new photographer preference. See [LIVE_VALIDATION.md](../LIVE_VALIDATION.md) for the evidence and remaining limits.

## Setup

Use Node.js 24+, Lightroom Classic on macOS, and an installed Codex CLI with a valid login. Local integration checks used Lightroom Classic **15.5.1** and Codex CLI **0.153.4**. Other versions need their own checks; signing in alone does not establish access to every model.

From the repository root:

```sh
npm ci
node src/cli.ts setup
codex login status
```

If needed, sign in with `codex login`. The demo reuses that local login; it does not ask you to paste credentials into the browser. OpenAI documents `codex exec`, structured output, ephemeral sessions, and reuse of saved CLI authentication in [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

1. Open Lightroom **File → Plug-in Manager → Add** and select the `pluginPath` printed by setup.
2. Close Plug-in Manager. Invoke **File → Plug-in Extras → Raw Photo Agent: Start / Status** and dismiss the dialog.
3. Run `node src/cli.ts status` and confirm the bridge is online.
4. Run `npm run demo`, then open [the local page](http://127.0.0.1:4318).

For a plugin update, rerun `node src/cli.ts setup`, choose **Reload Plug-in** in Plug-in Manager, close it, then invoke **Start / Status** and dismiss the dialog again. Setup copies the source plugin into `.runtime/RawPhotoAgent.lrplugin` and writes local configuration; it does not click through installation for you.

## Editing a photo

Choose one **RAW/DNG file up to 200 MiB** to upload, or choose **the currently selected Lightroom photo**. The selected-photo path requires exactly one RAW/DNG in the current catalog. Give a brief direction, such as “Natural light and restrained color; preserve the atmosphere.”

An upload is copied into `.runtime/uploads/<UUID>/<filename>`. The plugin adds that path to the catalog or reuses its existing original, selects it, and opens Develop. It then creates a virtual copy, saves a native baseline snapshot, and exports the first preview. The source photo's existing development settings are preserved, and uploading does not change the user's original file. Lightroom continues to reference the uploaded file, so keep it available after import; deleting the uploads directory would leave those catalog entries without their RAW source.

Each decision receives the current JPEG and up to two comparison JPEGs, supported numeric settings, the editing intention, prior public observations, and your feedback. The model can propose a small global edit, restore a pictured checkpoint, ask a creative question, or finish. The controller validates the response, applies permitted values, checkpoints, and renders again. Previews never become the source of later edits: Lightroom develops the RAW with its current settings.

The default limit is **six edits**, with at most twelve model decisions and two creative questions. A round changes at most three supported global parameters. The agent can finish earlier when it does not see a useful next edit.

## Watching and controlling the session

Keep the real Lightroom window beside the browser. **Show Lightroom** brings that application forward; the browser is a separate preview and control panel. There is no screen stream or simulated cursor. SDK changes occur in the actual editor.

Progress arrives through server-sent events. The public notes describe observations, intended changes, checkpoint results, and questions. They are structured summaries for the photographer; the CLI's raw event stream and internal reasoning are not published to the page.

- **Pause** cancels an active model inspection or waits for the current native work to reach a checkpoint. It does not undo an edit or cancel an already-started Lightroom operation. Initialization first completes the baseline. **Resume** continues the same in-memory session.
- **Finish** stops further editing at the next checkpoint and presents the retained versions. It keeps the latest completed work available for comparison.
- **Creative questions** offer two or three options. An answer is tied to the current question and informs the next decision; silence is not a selection.
- **Final comparison** presents two or three retained versions when available. Choose one to make it active in Lightroom and export it. If no edit was retained, the baseline is exported directly.

The final JPEG is sRGB, quality 0.9, with no upscaling and a **maximum long edge of 8192 pixels**. This is not an unconditional full-resolution export for larger cameras. Final preparation must finish before another pause/finish action is accepted. A result can be downloaded from the page; its editable virtual copy and snapshots remain in Lightroom.

## Configuration

```sh
RPA_MODEL=gpt-6-astra RPA_MAX_EDITS=4 npm run demo
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `RPA_MODEL` | `gpt-6-astra` | Model requested from the signed-in Codex CLI; it must support image input and be available to the account. |
| `RPA_MAX_EDITS` | `6` | Global editing budget, integer 1–10. |
| `RPA_PORT` | `4318` | Local HTTP port; the server binds to `127.0.0.1`. |
| `RPA_CODEX_BIN` | `codex` | Executable path/name when the CLI is not on the server's `PATH`. |

Model calls use a read-only Codex invocation with executable, browser, computer-use, connector, and plugin tools disabled. The model returns a validated decision; the TypeScript controller performs Lightroom operations. Account usage and model availability still apply. This local setup does not require an additional model API key.

## Local data and model requests

RAW files, Lightroom state, SQLite records, run logs, preview JPEGs, and final exports are stored locally and excluded from Git. The upload endpoint writes into a private directory and accepts only the supported RAW/DNG filename extensions; the plugin also confines import paths and verifies the resulting catalog photo.

**Rendered JPEGs, the editing brief, relevant numeric settings, public decision history, and feedback are sent through your signed-in Codex service.** The demo does not attach the RAW file to the model. Local HTTP hosting does not mean offline model processing. The account's service and data settings govern those requests.

Each decision uses an ephemeral CLI invocation and a temporary working directory. Temporary decision files are removed after the call; the local candidate journal and exported previews remain for comparison and recovery. These controls are not a claim about server-side retention.

## Interruptions and recovery

One demo server owns the runtime, and one editing session owns `session.lock`, including pauses and pending user choices. This prevents a second demo or a mutating CLI command from taking over the active session.

A bridge timeout does not cancel Lightroom. If an operation may have started, the demo reports an error, retains `session.lock`, and does not retry it. Inspect the pending bridge request/receipt, the current Lightroom selection, and the run journal before recovery. Remove a session lock only after confirming that its owner and native work have finished and deciding how to reconcile the saved run. See the [CLI interruption and recovery guide](usage.md).

A restarted server marks a nonterminal saved session interrupted instead of resuming model calls or edits. Server ownership and editing-session locks are separate: detecting a dead server does not authorize deletion of an unresolved editing-session lock.

Restoration first checks recorded settings, then compares a fresh 2048-pixel preview against the saved preview. It may export once more if the first render has not settled; it never retries the mutation and still requires exact decoded-pixel equality. A mismatch stops the session for inspection. Existing-mask settings have restored correctly in a live trial, but small remaining pixel differences mean general mask rollback is not established.

## Current limits

The autonomous demo uses **global numeric adjustments only**. It does not crop, straighten, create or adjust masks, heal/remove objects, apply AI Denoise, or invoke independent judges. The manual CLI retains its guarded existing-mask exposure/texture controls and can capture manual native edits. An MCP wrapper, automatic local editing, detail-aware review, and independent critique loops remain future work.

The browser reports real candidates and operations, but photographic quality still needs human evaluation. No award-winning outcome is promised. Keep [native validation](../LIVE_VALIDATION.md), [mocked tests](../plugin/RawPhotoAgent.lrplugin/tests/README.md), and aesthetic evaluation separate.

For the native calls, see the Adobe-authored SDK reference mirrors for [catalog import and selection](https://lrc.mcor.dev/modules/LrCatalog.html), [Develop module switching](https://lrc.mcor.dev/modules/LrApplicationView.html), and [development controls](https://lrc.mcor.dev/modules/LrDevelopController.html).
