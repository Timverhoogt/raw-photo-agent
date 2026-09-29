<h1 align="center">Raw Photo Agent</h1>

<p align="center">
  An editing agent for Lightroom Classic.<br>
  <strong>Start with your RAW. Keep the final say.</strong>
</p>

<p align="center">
  <a href="https://github.com/Timverhoogt/raw-photo-agent/actions/workflows/ci.yml"><img src="https://github.com/Timverhoogt/raw-photo-agent/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="#getting-started"><img src="https://img.shields.io/badge/Node.js-24%2B-417e38" alt="Requires Node.js 24 or newer"></a>
  <a href="#current-status"><img src="https://img.shields.io/badge/status-experimental-d6a354" alt="Experimental"></a>
</p>

<p align="center">
  <a href="#getting-started">Get started</a> ·
  <a href="docs/demo.md">Demo guide</a> ·
  <a href="docs/usage.md">CLI</a> ·
  <a href="DESIGN.md">Architecture &amp; roadmap</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<table>
  <tr>
    <th width="50%">Before</th>
    <th width="50%">After · selected edit</th>
  </tr>
  <tr>
    <td align="center" valign="middle"><a href="docs/images/bird-before.jpg"><img src="docs/images/bird-before.jpg" alt="Before: a gray bird on a pine branch, with the wider forest framing." width="100%"></a></td>
    <td align="center" valign="middle"><a href="docs/images/bird-after.jpg"><img src="docs/images/bird-after.jpg" alt="After: the same bird in a tighter crop, with lifted subject detail and restrained color." width="100%"></a></td>
  </tr>
</table>

*Guided Lightroom session: tighter framing, restrained tone and color, and a subject-mask lift. Crop and mask creation used Lightroom's interface; the autonomous demo currently makes global adjustments only. [Editing notes →](docs/example.md) · Photo: [Photography Life](https://photographylife.com/).*

Add a RAW, describe the look you want, and watch the agent work through an edit. It inspects Lightroom previews, makes bounded adjustments, and compares the result with earlier versions. You can pause, give feedback, and choose which version to keep.

### Your photo stays editable

- **A separate working copy.** Edits happen on a Lightroom virtual copy, preserving the source photo and its existing development settings.
- **A visible editing process.** The browser shows fresh previews and notes on what changed and why. Keep Lightroom beside it to see the native controls update.
- **A choice at the end.** Compare retained versions, pick a favorite, and download an sRGB JPEG. The virtual copy and snapshots remain in Lightroom.

## Getting started

You need **macOS, Adobe Lightroom Classic, Node.js 24+, and a signed-in Codex CLI 0.153.4+**. The configured model must be available to your account. No separate model API key is needed.

```sh
git clone https://github.com/Timverhoogt/raw-photo-agent.git
cd raw-photo-agent
npm ci
node src/cli.ts setup
codex login status
```

If needed, sign in with `codex login`. Then connect Lightroom:

1. Open **File → Plug-in Manager → Add** and select the `pluginPath` printed by setup.
2. Close the manager. Run **File → Plug-in Extras → Raw Photo Agent: Start / Status** and dismiss the dialog.
3. Check the connection and start the demo:

```sh
node src/cli.ts status
npm run demo
```

Open **[localhost:4318](http://127.0.0.1:4318)**. Upload a RAW/DNG (up to 200 MiB), or use the photo selected in Lightroom. Describe the intended look and begin. The final JPEG is exported at up to 8192 pixels on its long edge, without upscaling.

**Data:** RAW files, catalog edits, and the editing journal stay on your Mac. Rendered previews, the editing brief, settings, and feedback go through your signed-in Codex service. Keep `.runtime/uploads` while Lightroom references its imported files. [Setup, controls, privacy, and recovery →](docs/demo.md)

## How it works

**RAW → virtual copy → inspect → adjust → render → compare → choose**

The vision model proposes a supported action. The TypeScript controller validates it, the Lua plug-in applies it through Lightroom's SDK, and Lightroom renders the RAW again. Each candidate records its settings and a native snapshot, so the agent can attempt to return to an earlier checkpoint. A state or pixel mismatch stops the session for inspection.

The demo uses GPT-6 Astra through the signed-in Codex CLI by default. `RPA_PROVIDER` can switch it to the Claude API or an OpenAI-compatible endpoint, including a local vision model; only Codex has been checked in a live session. [Evaluate a model](docs/evaluation.md) against measurable thresholds before using it. The [manual CLI](docs/usage.md) also works without a model. For agent-led sessions outside the browser, use the [editing workflow](EDITING_WORKFLOW.md).

## Current status

**Experimental.** Live trials have exercised RAW import, virtual copies, global edits, previews, comparisons, and JPEG export. Lightroom Classic 15.5.1 and Codex CLI 0.153.4 have been checked locally.

| Available in the browser | Outside the autonomous demo |
| --- | --- |
| Global tone, white balance, color, sharpening, and conventional noise reduction | Automatic cropping, mask creation/local editing, and AI Denoise |
| Progress notes, pause/finish, creative questions, and final selection | Independent judging agents and batch editing |

The manual workflow can capture crops and adjust an existing mask. **Exact mask rollback remains unresolved**, and photographic quality needs broader evaluation. See the [live validation record](LIVE_VALIDATION.md) for measured results and the [roadmap](DESIGN.md) for planned work.

## Documentation & development

| Guide | What it covers |
| --- | --- |
| [Local demo](docs/demo.md) | Setup, controls, configuration, and recovery |
| [CLI reference](docs/usage.md) | Commands, snapshots, masks, and interruption handling |
| [Editing workflow](EDITING_WORKFLOW.md) | Assessing a photo, iterating, and getting useful feedback |
| [Architecture](DESIGN.md) | Controller, Lightroom bridge, and roadmap |
| [Native plug-in](plugin/README.md) | Protocol and supported Lightroom operations |
| [Contributing](CONTRIBUTING.md) | Development and meaningful bug reports |

```sh
npm run check
npm test
npm run check:codex   # needs the Codex CLI on PATH
npm run eval -- run --dry-run   # plan a model evaluation; see docs/evaluation.md
```

CI checks TypeScript and the controller/demo tests on Node.js 24 and 26, plus the [Lua 5.1 contract tests](plugin/RawPhotoAgent.lrplugin/tests/README.md). Mocked tests do not establish native Lightroom behavior or photographic quality.

First-party code is [MIT licensed](LICENSE). The example photograph has separate [source credit and rights](docs/example.md#photo-source).

[Workflow reference](SIMON_VIDEO_NOTES.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)
