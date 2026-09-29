# The README comparison

The front-page images are saved Lightroom exports from the guided editing trial on 27–28 September 2026. They show the starting render and the closer composition selected by the photographer.

| Before | After |
| --- | --- |
| [Starting render](images/bird-before.jpg), 2048 × 1365 | [Selected edit](images/bird-after.jpg), 2048 × 1123 |

Both previews were copied byte for byte from the original trial exports. Their different aspect ratios reflect the Lightroom crop. The starting image is a developed RAW preview with its existing profile and lens corrections.

## What changed

- Global exposure increased by 0.15 EV, with softer highlights, moderately opened shadows, and a firm black point.
- Vibrance was set to +8. White balance was retained.
- A subject mask was created through Lightroom's native interface. The bridge then applied +0.25 EV exposure and Texture +10 to that mask.
- Light luminance noise reduction and edge-masked sharpening were applied after detail inspection.
- Two compositions were retained: more surrounding habitat, or a tighter emphasis on the bird. The photographer chose the latter.

No scene content was generated or removed. Work took place on a virtual copy, and the source photo's recorded development settings matched their starting state after editing.

**This was a guided session.** Crop and mask creation involved Lightroom's native interface. It illustrates the broader controller workflow; the current autonomous browser demo supports global numeric adjustments only. It is one selected example, not a quality benchmark or proof of general rollback reliability. See [live validation](../LIVE_VALIDATION.md).

## Photo source

The source is Photography Life's Canon EOS R RAW sample, [`Canon-eos-r-raw-00018.cr3`](https://photographylife.com/dl/raw/canon-eos-r/Canon-eos-r-raw-00018.cr3). Credit for the source photograph belongs to [Photography Life](https://photographylife.com/). This project supplies the editing comparison and does not claim ownership of the photograph or grant a license to it.

Only the two review JPEGs are included for this example. The RAW, full-size exports, Lightroom catalog identifiers, and local editing journal remain outside the repository.
