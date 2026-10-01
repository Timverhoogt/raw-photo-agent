# Model evaluation

This guide covers provider settings and isolated model decision probes. For complete Lightroom editing trials and blinded photographer preferences, see [RAW quality evaluation](evaluation.md).

Before a model drives the demo, `scripts/eval.ts` checks that it clears three tiers. Each tier has a bar a model must pass:

| Tier | Question | Measured by | Default bar |
| --- | --- | --- | --- |
| **0 · Hard gates** | Can it take part at all? | Every call in the run | Valid decision on the first try ≥ 97%; after one repair ≥ 99.5%; p95 latency ≤ 60 s; accepts 3 images per request |
| **1 · Perception** | Does it see known faults and fix them the right way? | `pick-better`, `fix-fault` | ≥ 90% on obvious faults, ≥ 70% on subtle ones |
| **2 · Restraint** | Does it leave good work alone, and decide the same way twice? | `keep-better`, `leave-alone`, repeats | Each ≥ 80% |

A tier reads **INSUFFICIENT** when it has too few samples to judge (under 30 calls, 10 tier 1 items, or 5 items per restraint probe) and **NOT-MEASURED** when its probes did not run.

The harness does not measure tier 3, taste: whether you prefer the model's finished edit. Use the separate [RAW quality evaluation](evaluation.md) for blinded photographer comparisons of complete Lightroom sessions. Tier 2 also uses single decisions as a proxy for restraint; it does not run full Lightroom sessions.

## Quick start

```sh
# 1. Build a fixture from a JPEG you consider well edited (repeat for 10+ photos).
node scripts/make-fixture.ts --input ~/Pictures/heron-final.jpg --id heron \
  --intent "Natural wildlife; keep feather detail and the soft habitat"

# 2. See how many decisions a run needs, without calling a model.
node scripts/eval.ts run --provider anthropic --model claude-opus-5-5 --dry-run

# 3. Run it. Results are written to results/ (ignored by Git).
node scripts/eval.ts run --provider anthropic --model claude-opus-5-5

# 4. Compare models side by side.
node scripts/eval.ts report results/eval-*.json
```

Each fixture with the 11 synthetic faults needs **46 decisions** at the default settings. Some decisions add a repair call. Start with `--limit 3` to check setup and cost before a full run; the scorecard reports the tokens actually used. `Ctrl-C` stops the run and still writes a partial scorecard.

| Option | Default | Purpose |
| --- | --- | --- |
| `--fixtures DIR` | `fixtures` | Folder of fixture folders |
| `--provider`, `--model` | from `RPA_PROVIDER`, `RPA_MODEL` | Provider and model under test |
| `--limit N` | all | Use only the first N fixtures |
| `--probes LIST` | all four | Comma-separated subset of `pick-better,fix-fault,keep-better,leave-alone` |
| `--repeats N` | `5` | Calls per repeated item, used for the repeatability score |
| `--repeat-faults N` | `2` | How many faults per fixture repeat `pick-better` |
| `--repair N` | `1` | Repair calls after an invalid decision (0–2), as in the demo |
| `--concurrency N` | `2` | Parallel calls; lower it on rate limits |
| `--thresholds FILE` | built in | JSON overrides, such as `{"tier1": {"subtle": 0.6}}` |
| `--out FILE` | `results/eval-<provider>-<model>-<time>.json` | Result file |

## Providers

The demo and the harness share these settings. `codex-cli` remains the default.

| `RPA_PROVIDER` | Model | Credentials | Previews leave this computer? |
| --- | --- | --- | --- |
| `codex-cli` | `RPA_MODEL`, default `gpt-6-astra` | `codex login` | Yes |
| `anthropic` | `RPA_MODEL`, default `claude-opus-5-5` | `ANTHROPIC_API_KEY` or `ant auth login` | Yes |
| `openai-compatible` | `RPA_MODEL` (required) | `RPA_API_KEY` if the endpoint needs one | Only if `RPA_BASE_URL` is not on this computer |

```sh
# A local vision model in Ollama: nothing leaves the Mac.
RPA_PROVIDER=openai-compatible RPA_BASE_URL=http://127.0.0.1:11434/v1 RPA_MODEL=<vision model> \
  node scripts/eval.ts run

# OpenRouter or another hosted endpoint.
RPA_PROVIDER=openai-compatible RPA_BASE_URL=https://openrouter.ai/api/v1 RPA_API_KEY=... RPA_MODEL=<model> \
  node scripts/eval.ts run
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `RPA_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible endpoint. Plain `http` is accepted only for this computer. |
| `RPA_STRUCTURED_OUTPUT` | `json_schema` | `json_object` or `none` for servers without schema-constrained output. The schema is then described in the prompt. |
| `RPA_MAX_IMAGE_EDGE` | `2048` | Downscale larger previews before sending them to an OpenAI-compatible endpoint |
| `RPA_EFFORT` | `high` | Claude effort level (`low`–`max`); ignored for Haiku |
| `RPA_REPAIR_ATTEMPTS` | `1` | Extra calls after an invalid decision (0–2) |
| `RPA_TIMEOUT_MS` | `180000` | Per-call time limit |

For Claude models that support it, the demo turns on server-side refusal fallback: if a safety classifier declines, Anthropic retries the request on a recommended model. **The harness turns it off**, so every scored decision comes from the model under test; a decline counts as a failed call.

## How grading works

For each fixture, the harness compares a **reference** render (a good edit) with **fault** renders (the same photo with one known slider change).

- **`pick-better`**: the latest edit is a fault. The two earlier checkpoints are the reference and a different fault, in shuffled order. The model passes if it restores the reference.
- **`fix-fault`**: only the fault is shown. The model passes if it edits a slider that fixes the fault in the right direction and changes no faulted slider the wrong way. Magnitude is not graded. For example, overexposure is fixed by lowering Exposure, Highlights or Whites; add a `fix` list in the manifest to change the accepted moves.
- **`keep-better`**: the latest edit is the reference and the earlier checkpoint is a fault. The model passes if it does not restore the fault and any edit stays small.
- **`leave-alone`**: only the reference is shown. The model passes if it finishes, asks, or makes a small edit.

A small edit changes each slider by at most 0.35 EV of exposure, 400 K of temperature, 8 of tint, or 15 on a 100-point slider. The scorecard also counts **overprocessing**: any edit that raises Saturation, Vibrance, Clarity, Texture, Dehaze or Contrast by more than 25.

Three rules keep the test fair:

- **Pixels only.** Every candidate shows the same displayed slider values, so the model must judge by pixels.
- **No name hints.** Candidate IDs are opaque hashes. Before each call, previews are copied to files named after those IDs, so a filename such as `overexposed.jpg` never reaches the model.
- **Invalid counts as wrong.** An invalid decision fails the probe.

Scores average an item's repeats first, so repeated items do not outweigh the others. The repeatability score counts an item as consistent when at least 80% of its calls reach the same outcome (for example, "restore the reference").

## Fixtures

```text
fixtures/heron/
  fixture.json
  reference.jpg
  overexposed.jpg
  ...
```

```json
{
  "id": "heron",
  "intent": "Natural wildlife; keep feather detail and the soft habitat",
  "source": "lightroom",
  "reference": { "file": "reference.jpg", "settings": { "Exposure2012": 0.15, "Temperature": 5200, "Tint": 4 } },
  "faults": [
    { "id": "overexposed", "file": "overexposed.jpg", "severity": "obvious", "delta": { "Exposure2012": 2 } },
    { "id": "too-warm", "file": "too-warm.jpg", "severity": "subtle", "delta": { "Temperature": 800 },
      "fix": [{ "key": "Temperature", "direction": "decrease" }] }
  ]
}
```

`reference.settings` sets the slider values shown to the model. Temperature, sharpening and noise reduction have no zero default, so give their reference value whenever a fault uses them.

The single-decision harness supplies overview previews without detail crops or an inspection round. If every accepted fix for a fault changes Texture, sharpening, or noise reduction, planning a `fix-fault` probe fails before any model call: those adjustments require matching detail evidence in the shared photo validator. This is an unsupported experiment, not a model failure. The same fixture can still use `--probes pick-better,keep-better,leave-alone`. A fault with a photographically valid global alternative in its `fix` list can also run `fix-fault`; the detail-dependent alternatives remain prohibited without crops. Do not add an unrelated alternative merely to bypass this check.

**Synthetic fixtures** (`make-fixture.ts`) approximate 11 Lightroom changes with `sharp`: ±2 EV exposure, oversaturation, ±3000 K white balance, crushed blacks, heavy clarity, plus four subtle versions. They are quick to make but are not Lightroom renders. The scorecard says so when any fixture is synthetic.

**Lightroom fixtures** are the ones to trust. For each photo:

1. Export your finished edit as `reference.jpg` (sRGB, long edge 2048).
2. For each fault, make a virtual copy, change one slider by the fault's `delta`, and export it at the same size.
3. Write `fixture.json` with `"source": "lightroom"`.

The manual CLI's `edit` and `render` commands can make those exports for you. Use at least 10 photos across different subjects and light. With about 200 tier 1 items, a 90% score has a margin of roughly ±4 points.

Fixture photos and results stay out of Git (`fixtures/*/` and `results/` are ignored).
