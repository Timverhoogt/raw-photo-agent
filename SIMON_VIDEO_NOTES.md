# Simon d’Entremont workflow reference

Source: [Complete Lightroom Masterclass: EDIT PHOTOS like a PRO with my 12-step process!](https://www.youtube.com/watch?v=SfIMa_2zYN4), Simon d’Entremont, February 2, 2026; duration 47:25.

Evidence: English auto-generated captions and public chapter metadata, inspected September 27, 2026. Timestamps are approximate. These are paraphrases, not a transcript.

| Step | Timestamp | Demonstrated stage |
|---|---|---|
| 1 | [1:52](https://www.youtube.com/watch?v=SfIMa_2zYN4&t=112s) | Import; select photographs. |
| 2 | [6:16](https://www.youtube.com/watch?v=SfIMa_2zYN4&t=376s) | Crop and straighten. |
| 3 | [8:35](https://www.youtube.com/watch?v=SfIMa_2zYN4&t=515s) | Set white balance and tint. |
| 4 | [10:55](https://www.youtube.com/watch?v=SfIMa_2zYN4&t=655s) | Adjust exposure and tonal range. |
| 5 | [14:54](https://www.youtube.com/watch?v=SfIMa_2zYN4&t=894s) | Consider global adjustments. |
| 6 | [17:10](https://www.youtube.com/watch?v=SfIMa_2zYN4&t=1030s) | Apply selective local adjustments. |
| 7 | [28:02](https://www.youtube.com/watch?v=SfIMa_2zYN4&t=1682s) | Refine color and saturation. |
| 8 | [32:51](https://www.youtube.com/watch?v=SfIMa_2zYN4&t=1971s) | Assess noise reduction. |
| 9 | [34:02](https://www.youtube.com/watch?v=SfIMa_2zYN4&t=2042s) | Sharpen with masking. |
| 10 | [36:09](https://www.youtube.com/watch?v=SfIMa_2zYN4&t=2169s) | Consider a tailored vignette. |
| 11 | [39:37](https://www.youtube.com/watch?v=SfIMa_2zYN4&t=2377s) | Wait thirty minutes; reassess. |
| 12 | [43:56](https://www.youtube.com/watch?v=SfIMa_2zYN4&t=2636s) | Export for intended use. |

Color comes late because contrast and clarity already affect saturation (28:02). After reassessment, he revisits shadows, vignetting, highlight color, and excessive darkening (40:17–43:27). Experimentation and reversal are explicit (14:21; 23:57).

## Engineering interpretation — our proposed design, not Simon’s instructions

- Represent stages as revisitable decisions, with a recorded reason to apply, skip, or reopen each stage.
- Give every candidate an immutable parent checkpoint containing the complete photo state, settings, masks, rendered evidence, and Lightroom version. Verify restoration empirically.
- Replace a literal thirty-minute agent sleep with an independent critique using a fresh context and randomized candidate comparisons. This is a proposed analogue, not an established equivalent to human perceptual recovery.
- Constrain the agent to the user-selected photo. A tutorial’s import/culling discussion does not authorize deleting photographs or operating on the wider catalog.
- Judge at overview, 100% detail, and intended output size. Stop on diminishing improvement and return the best retained candidate rather than the last edit.
- Treat the workflow as a decision order. Lightroom’s internal RAW rendering pipeline determines processing order; repeatedly rendering original sensor data with current settings avoids cumulative raster degradation.

No full transcript, video, audio, tutorial image, or validation photo is included in this repository. Caption wording can contain recognition errors; the timestamp links permit direct verification from the original source.
