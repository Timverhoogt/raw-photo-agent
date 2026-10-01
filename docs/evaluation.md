# Repeatable RAW quality checks

This guide covers complete Lightroom editing trials and photographer preferences. For provider settings and isolated model decision probes, see [model evaluation](model-evaluation.md).

The evaluation harness keeps an indexed local corpus and compares **as-imported starting image**, **fixed gentle adjustment**, and **agent result**. A successful run establishes that real edits and exports completed. Photographic improvement requires actual photographer preferences; the runner never records those preferences or answers a creative question for you.

## Index the corpus

From the repository root, using Node.js 24+:

```sh
node src/evaluation/cli.ts index --source RAW
node src/evaluation/cli.ts list
node src/evaluation/cli.ts status
```

Indexing is local and read-only with respect to `RAW`. It records SHA-256 hashes and byte sizes for every regular file, stable RAW asset IDs, matching XMP sidecars, and reference/other files such as JPEGs. Repeating the index reports `unchanged: true` for the same file paths and bytes; changing an XMP also changes the corpus fingerprint. Previous manifests remain in `.runtime/evaluation/corpora/`. Symlinked corpus files and ambiguous duplicate sidecars are rejected.

Matching XMP is deliberately **copied with its RAW**. The runner does not reset development settings. Its starting render therefore means “as imported into Lightroom with this copied sidecar and the active import defaults,” not an untouched/reset RAW. Native settings for both comparator and agent baselines must match and are retained with the evidence. Use a separately named, deliberately prepared corpus if a reset-RAW experiment is needed; do not delete sidecars from this source set to make an informal baseline.

## Run a bounded evaluation

Finish or reconcile the existing demo session first; all editing shares `.runtime/session.lock`. The Lightroom bridge and signed-in Codex CLI must already work, as described in [demo.md](demo.md).

```sh
node src/evaluation/cli.ts run --limit 3 --max-edits 2
# Or choose exact asset IDs printed by list:
node src/evaluation/cli.ts run --id raw-ASSET_ID --max-edits 2
```

Native runs require explicit `--limit` or `--id`, accept 1–10 photos, and run serially. `--intent` and `--model` override the recorded brief and model. The default brief requests natural, restrained improvement and the default model follows `RPA_MODEL` or `gpt-6-astra`.

For each asset, the runner verifies and copies the RAW and its matching XMP into a fresh `.runtime/uploads/<UUID>/` folder. Lightroom imports that copy and creates separate virtual copies for the fixed comparator and agent. Original corpus files are never opened for writing. Imported files remain available because Lightroom continues to reference them.

The **fixed-gentle-v1 comparator** adds −20 Highlights, +15 Shadows, and +5 Vibrance to the starting numeric settings, clamping each to its supported range. It is deterministic, image-independent, and explicitly **not Lightroom Auto**. It is a modest reproducible reference, not a claim of optimal editing. If clamping makes every delta ineffective, its actual starting render is retained as the fixed comparator.

The agent uses the real `PhotoController`, Codex vision provider, decision validation, overview exports and detail-crop evidence. It can inspect, globally edit, restore, and finish within the bounded decision/edit limits. Unsupported local editing is rejected by this harness. The recorded agent result is the model's current checkpoint when it finishes; no photographer choice is synthesized. If the agent asks a creative question, that case remains incomplete with the question and options saved. The batch stops for attention instead of choosing an answer.

Results, operation history, decisions, timings and an isolated SQLite journal are saved under `.runtime/evaluation/runs/<EVAL_ID>/`. Native JPEGs remain directly under `.runtime/renders/` to satisfy the plugin's export allowlist; result records bind each path to a SHA-256 hash, role, candidate, native state token and settings. The runner never loads or overwrites `.runtime/demo/session.json`. Model usage is recorded as unavailable (`null`) because the current provider does not expose reliable accounting here.

Only the `run` command invokes Lightroom or the model. Rendered image evidence, the editing brief, numeric settings and public history are sent through the signed-in Codex service; RAW files and sidecar bytes are not attached to model calls. Indexing and review packaging are local operations.

## Make a blinded review

Use the evaluation ID returned by a completed or partial run:

```sh
node src/evaluation/cli.ts review --run eval-UUID
```

The command returns the local `review/index.html` path. Open that page and compare versions A/B/C. Only complete cases containing all three verified real renders are included; pending, interrupted and unanswered cases remain explicitly excluded. A retained starting image is a valid agent result and may look identical to another version.

The page and public case manifest contain opaque case/candidate IDs without source filenames or variant roles. Candidate and case order are deterministic for the saved private seed; `--seed` can reproduce that ordering in a fresh package. Metadata-free PNGs preserve the decoded pixels of the saved Lightroom JPEGs; no synthetic alternatives, upscaling or aesthetic scores are generated. Images link to their full exported size. Review overviews are at most 2048 pixels on the long edge, not full sensor resolution; detail exports used during editing are separately retained.

`private.json`, next to the `review` directory, contains the seed and role mapping. Keep it out of view while judging. If sharing a review folder, share only its `review/` subdirectory. Blinding hides the variant labels and metadata; it does not promise that recognizable photographic changes cannot suggest their origin.

Click a preference, “No visible preference,” or “None acceptable,” and enter optional notes about defects or unnecessary edits. The page prepares a shell-safe command and updates it when reviewer/notes change. It does not itself submit a vote. Run the command or have the assistant record the choice you explicitly gave:

```sh
node src/evaluation/cli.ts vote --review review-ID --case case-ID --candidate candidate-ID --reviewer photographer --notes 'Better subject detail; color remains natural.'
```

Use `--candidate tie` for no visible preference or `--candidate none` when no result is acceptable. Votes are bound to the exact package, case, opaque candidate and named reviewer, with a timestamp. Each reviewer gets one immutable answer per case. Repeating the identical command returns the existing answer; changing it is rejected. No automated votes or default selections exist. These review records do not change Lightroom or select a final demo export.

After judging, generate a local administrative report that reveals the role mappings:

```sh
node src/evaluation/cli.ts summarize --review review-ID
```

The report includes completed/excluded case counts, actual human answer counts by starting/fixed/agent role plus tie/none, and the recorded observations. With no answers it explicitly returns `preferenceNotYetMeasured: true`; completed exports never become assumed preferences. Counts are per recorded reviewer answer, so multiple reviewers can contribute to one case. Malformed artifacts, unknown case/candidate IDs and duplicate reviewer/case answers are rejected. Keep this unblinded report out of view until the review is finished.

## Interruptions and interpretation

Any failure after native work begins stops the serial batch and preserves `session.lock`, saved bridge operations, current case status and remaining pending cases. No mutation, model call, or uncertain export is automatically retried. Inspect the native receipts, Lightroom state and the evaluation's separate SQLite journal before recovery. A dead PID alone does not establish that pending Lightroom work finished. The harness has no automatic resume command, and removing its lock without resolving native work is unsafe.

A review may include completed cases from a partial batch, but its excluded count and private manifest preserve incompleteness. A case that hit the decision cap without a final model assessment is also incomplete. Do not count incomplete cases as aesthetic losses or silently discard them from reliability reporting.

For each milestone, retain the same corpus fingerprint, brief, model, edit budget and comparator when making comparisons. Record completed/attempted cases, failure reason, elapsed time, actual preferences, visible defects and unnecessary edits. A new corpus fingerprint, different sidecar starting state, model, or editing budget changes the experiment. A small set of similar photographs is useful for regressions but cannot establish general photographic quality.

Harness tests use mock Lightroom/model responses to check hashing, source preservation, native path contracts, ownership, serialization, incomplete cases, blinding and immutable answers. Native bridge validation and human aesthetic evaluation remain separate evidence.
