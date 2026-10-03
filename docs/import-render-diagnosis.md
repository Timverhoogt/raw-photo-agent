# Import state and render variability diagnosis

Investigation started 2 October 2026; continued 3 October. Autonomous masking remains disabled. Exact native-state, source-integrity and pixel checks remain in force.

## What the saved evidence establishes

Two fresh imports of `IMG_0478.CR3` stopped with `STALE_STATE` on 28 September before working-copy creation, edits or exports. Later readbacks from their separate staged originals have identical settings, but neither failed experiment saved the initial settings or the first divergent readback. Those records cannot identify the changed fields or distinguish import processing, selection and entering Develop. Their original terminal error is retained in the contemporaneous experiment reports; regenerated historical bridge response files must not be mistaken for that original response.

A separate restart experiment recorded `Look.Parameters.PointColors` changing from absent to `{}` on an existing diagnostic copy. That establishes a structural readback change in that experiment only. It does not explain the earlier import failures, and absent and empty values remain distinct.

Independent analysis of the 27 TIFFs from the September GPU/restart campaign found a recurring two-state pattern. The files were decoded directly from their uncompressed native uint16 strips without color or orientation conversion; input hashes and the previously recorded decoded hashes matched.

| Observation on Lightroom 15.5.1 | Result |
| --- | --- |
| Pixel locations varying across all 27 exports | 635 of 2,795,520 (0.022715%) |
| Distinct RGB triplets at each varying location | Exactly two in this sample |
| Varying locations across each condition's nine exports | Auto 428; Off 399; restored Auto 514 |
| Within-block events where red and green changed in opposite directions | 2,006 of 2,418 events where both channels changed |

For example, zero-based coordinate `(1429, 697)` alternated between `[38454, 43002, 21811]` and `[38496, 42996, 21814]`. This is variation in stored pixel values, not only TIFF metadata or a nondeterministic decoder. The coordinate recurrence suggests a data-dependent processing or quantization boundary; it does not identify the responsible stage. Configuration blocks, repeated photos and individual pixel events are not independent experimental samples.

Private analysis and hash records are retained under `.runtime/validation/diagnosis-oct2-render/`. Earlier experiment conditions and limitations remain in [render repeatability controls](render-repeatability.md).

## Capture the first import divergence

The instrumented plug-in writes immutable numbered native readbacks under `bridge/diagnostics/import-photo/REQUEST_UUID/`. Each includes the full settings, photo and request identity, selected photo IDs, module, timestamps, original baseline token, and exact changes expressed as JSON Pointers with presence flags. Selection, Develop and final-completion observations remain separate. A mismatching readback is saved before the original `STALE_STATE` failure; no new baseline is accepted. The readback count is bounded.

```sh
node src/evaluation/cli.ts list
node src/diagnostics/cli.ts import --id RAW_ASSET_ID --environment-notes 'Recorded application build, graphics preferences and restart history'
```

This diagnostic stages fresh copies of one indexed RAW and its matching XMP and issues exactly one import. It creates no working copy and performs no development edit or export. Native traces, original requests/responses/receipts, and read-only followups at scheduled offsets of 0, 1 and 3 seconds are retained with actual observation times. Followups compare against the import's recorded guards, not a replacement baseline inferred from the first followup. Failures, uncertainty and settings drift retain the shared session lock for explicit reconciliation. A delay is an observation condition, not proof that asynchronous processing has finished.

Synchronous diagnostic writes and additional readbacks can change timing. Record the installed plug-in source hashes; successful instrumented imports cannot retrospectively establish why an earlier uninstrumented import failed.

## New environment and bounded render experiment

The installed application changed before the new trials: Lightroom Classic 15.6 build `202609251514-f839cde9`, Camera Raw 18.7 build `2743`, and macOS 27.2.0 build `26B5091g`. Observed preferences were main graphics Auto, GPU preview generation Auto, HDR in Library off, and editing through Smart Previews off. GPU export activation was not established. Keep new results separate from the 15.5.1 campaign.

An old staged original's current readback differed from its 1 October record only at `Look.Parameters.Version`: `18.5.1` became `18.7`. This is a separate cross-version observation; it cannot explain the September import failures. The existing Lightroom process was quit normally and restarted before the following trials. No graphics preferences were changed.

### Import results on 3 October

Three separately staged imports used identical `IMG_0478.CR3` bytes. The first two included its original XMP, which says `WhiteBalance="As Shot"` without Temperature or Tint. The third used a separately hashed, single-file derived corpus containing only that RAW; the normal corpus index and original XMP were preserved.

| Fresh import condition | First divergent readback | Exact changes |
| --- | --- | --- |
| RAW + XMP, starting in Develop | Selection completion guard | Missing Temperature → 5150; missing Tint → 20 |
| RAW + XMP, starting in Library | Develop completion guard | Same two additions |
| RAW only, starting in Library | Develop completion guard | Same two additions; missing FilterList → `{}`; missing Look.Parameters.PointColors → `{}` |

All three retained `WhiteBalance="As Shot"`, stopped with the original `STALE_STATE`, and performed no copy creation, edit or export. Each trial's three subsequent readbacks matched its final divergent state exactly. Scheduled followup offsets were 0/1/3 seconds, but actual observation starts were 0.023/6.599/10.050 seconds, 0.041/6.716/8.649 seconds, and 0.037/10.181/15.744 seconds respectively. Call and evidence-capture time matters; these are not measurements at exactly one and three seconds.

The reproduced failure is an incomplete early native settings readback whose missing fields appear when the RAW loads in Develop. The module contrast supports delayed field materialization; the RAW-only control shows that the matching XMP is not necessary for the white-balance additions. It does not establish whether RAW decoding, catalog initialization, profile defaults or another internal Lightroom stage supplies them. A first-hand [Adobe SDK bug report about missing Temperature/Tint](https://community.adobe.com/bug-reports-674/p-sdk-photo-getdevelopsettings-sometimes-returns-nil-for-temperature-and-tint-664106) describes a related historical behavior; it is corroboration, not proof of the cause in version 15.6.

Source, derived-corpus and staged-file hashes remained unchanged. After each failed runner exited, reconciliation verified its terminal native response, idle bridge, exact selected staged original, two further exact readbacks and retained evidence hashes before archiving that runner's own lock. Failed reports and their original baselines were not rewritten or accepted. The later render experiment used a separately recorded current baseline and does not convert any failed import into a success.

### Render results on 3 October

On one new diagnostic virtual copy, the fixed experiment captured five baseline TIFFs with `ColorNoiseReduction=25`, five with only that setting changed to zero, then restored the baseline snapshot once and captured five more. The controller's initial JPEG primed the renderer; these were not cold exports. Exports used a 2048-pixel limit, lossless unsigned 16-bit sRGB TIFF and no output sharpening. Native settings were checked around each operation and export.

| Comparison | Pairs | Changed pixels per pair | Maximum channel difference, uint16 |
| --- | --- | --- | --- |
| A1: baseline, color noise 25 | 10 | 83–225 | 26–31 |
| B: color noise 0 | 10 | 64–116 | 26–29 |
| A2: restored baseline, color noise 25 | 10 | 168–270 | 26–42 |
| A1 versus A2, separately | 25 | 88–257 | 18–42 |

All 55 pairs were nonexact. Disabling color-noise reduction did not eliminate variability. Although B showed fewer changed locations in this sequence, one photo, one session and fixed block ordering cannot establish a causal reduction. The pairs share exports and are not independent samples. Within each five-export block, every varying coordinate still had exactly two RGB triplets: 318 coordinates in A1, 188 in B and 446 in A2.

The single restore recovered the diagnostic copy's entire baseline settings and token exactly. Independent direct uint16 decoding reproduced every saved decoded hash, metric and histogram across all 55 comparisons. All 56 referenced files matched their recorded hashes, including the 33-file source corpus, 15 TIFFs, initial JPEG and baseline/environment/code evidence. Original native settings were checked at preflight and copy creation; there was no final native readback of that original. Source and staged RAW/XMP bytes were verified at completion.

These results separate native-state restoration from render repeatability: exact native state still produced small pixel differences. They establish neither an acceptable tolerance nor readiness for autonomous masking.

## Evidence and implementation verification

Private native states, image files and absolute machine paths remain outside Git. Reproduction scripts, frozen inputs, hashes and full reports are retained locally:

| Evidence | Private location under `.runtime/` |
| --- | --- |
| Develop-start RAW + XMP import | `diagnostics/import-16819f14-f03b-48b4-9a28-907b1a42a570/results.json` |
| Library-start RAW + XMP import | `diagnostics/import-5470f15c-3f1f-44b1-aeea-30e4cd1e668c/results.json` |
| Library-start RAW-only import | `diagnostics/import-155cdc5d-9e60-4edc-93f9-54a41892c897/results.json` |
| Import reconciliation, RAW-only lineage and environment | `validation/diagnosis-oct3/` |
| Fixed render script and protocol | `validation/diagnosis-oct3-render/run-aba.ts` and `README.md` |
| Render report | `validation/diagnosis-oct3-render/aba-37114a53-5168-457b-8d2f-7bac343456af/results.json` |

The render report SHA-256 is `d1dce7dae2ff839dffee394c2442d827344786491815157f2566ff79296627a0`. All imports and renders used Operations.lua SHA-256 `ff66addde308b68c64143a1555b257f1614882deb2ae1a91945f6b7b6b9324a9`.

`npm run check`, all 206 Node tests and 245 Lua checks passed. Tests cover retained native evidence, immutable snapshots, presence/type differences, drift attribution, ownership, deadlines and persistence errors. Passing mock tests does not establish native render determinism.

Startup instrumentation now records the initializer phase, generation, ownership flags and error in `bridge/startup.json` and the Start / Status dialog. Once the initializer runs, an unresolved previous worker gets a bounded 15-second wait and a restart-required result; ownership is never cleared speculatively. Earlier delayed startup eventually produced an idle heartbeat, so a permanent deadlock was not established. After all trials, the new initializer was installed and reloaded: the dialog showed `initializer-queued`, then a fresh idle heartbeat and successful read-only capabilities/selection/state calls confirmed a running bridge. The selected RAW-only original retained exactly the preceding native state and token. Evidence is `validation/diagnosis-oct3/startup-reload-check.json`; this live check exercised normal startup, while unresolved-worker behavior was tested with mocks.

## Remaining work and decision

The bounded diagnosis is complete; reliable import readiness and pixel-exact recovery remain open product work. Keep current fail-closed guards and autonomous masking disabled.

1. Design an explicit import-readiness contract before changing baseline acquisition. Retain the early state and every transition; demonstrate when a complete native baseline can be captured without silently accepting drift or touching original development settings. Validate on additional camera files, sidecar conditions and fresh application sessions.
2. If deeper renderer attribution is needed, repeat a predeclared control in an independent session and test one additional processing stage at a time, such as sharpening. Keep original TIFFs, exact state comparisons and environment versions separate. Color-noise zero and historical graphics Off are not fixes.
3. Establish restoration acceptance independently of this diagnosis. Do not invent pixel tolerances from one photo or normalize missing values. Re-run the required mask recovery evidence before enabling autonomous masking.
