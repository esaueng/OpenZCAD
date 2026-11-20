# Parameter edit and reopen timings

Parameter validation used to build exact geometry with a different lineage request from the committed document. The subsequent live rebuild repeated work. Eligible edits now reuse the validated result. An owned project can save the corresponding kernel session once idle, including after draft display refinement. Legacy blends that can repair edge selections continue to request the carry proposal.

## Chromium results

Median milliseconds from three fresh pages per revision and fixture. Each page executes the same five edits. Edit timing runs from input to the committed exact-analysis event. Reload timing runs from navigation to the geometry worker’s ready event.

| Fixture       | Action                           | Baseline ms | Candidate ms | Speedup | Checked result reused |
| ------------- | -------------------------------- | ----------: | -----------: | ------: | --------------------: |
| opening_width | reload                           |         685 |          753 |   0.91× |                     — |
| opening_width | first edit after assistant apply |         548 |          313 |   1.75× |                   0/3 |
| opening_width | warm edit before reload          |         465 |          186 |   2.49× |                   3/3 |
| opening_width | first edit after reload          |         588 |          240 |   2.45× |                   3/3 |
| opening_width | second edit after reload         |         507 |          218 |   2.32× |                   3/3 |
| opening_width | immediate edit after reload      |         918 |          662 |   1.39× |                   2/3 |
| holder_height | reload                           |         565 |          532 |   1.06× |                     — |
| holder_height | first edit after assistant apply |         160 |          109 |   1.47× |                   3/3 |
| holder_height | warm edit before reload          |         160 |          100 |   1.59× |                   3/3 |
| holder_height | first edit after reload          |         324 |          118 |   2.75× |                   3/3 |
| holder_height | second edit after reload         |         289 |           95 |   3.03× |                   3/3 |
| holder_height | immediate edit after reload      |         659 |          474 |   1.39× |                   3/3 |

## Reload and coverage

The probe reloads after the edited document reaches IndexedDB. Saving the kernel session is separately throttled. The cache events below count how often the first navigation restored the entire history before geometry became ready. A missing session makes the app replay the history.

| Fixture       | Features | Result bodies / faces | Persisted parameter | Full prefix restored, baseline | Full prefix restored, candidate |
| ------------- | -------: | --------------------: | ------------------: | -----------------------------: | ------------------------------: |
| opening_width |       15 |               8 / 108 |                  50 |                            3/3 |                             3/3 |
| holder_height |       31 |              17 / 134 |                  40 |                            3/3 |                             2/3 |

The opening-width reload median increased by 68 ms despite restoring all 15 features on every run. One lettered-holder reload on the candidate replayed all 31 features and took 902 ms. The edit timings alone do not explain either observation.

## Reproduction

Baseline `e1b28ace099311944841c1c2052be50f31417e6b` and candidate used the same benchmark file, fixture contents, lockfile and pinned Remus packages. Copy the candidate’s `test/e2e/perf-holder-reload.spec.ts` into the baseline checkout. Run each checkout three times, alternating the order in successive pairs. Use a distinct output path per invocation.

```sh
OZ_PERF=1 OZ_PERF_ANGLE=gl OZ_PERF_OUT=/tmp/holder-run.jsonl \
  pnpm exec playwright test perf-holder-reload.spec.ts --workers=1
```

Runs used Chromium on a Ryzen 9 5900XT and GeForce RTX 3090 with hardware OpenGL. Other local verification work overlapped parts of the comparison. The probe covers the observed committed analysis. Later projection write-back, frame presentation, and integrated GPU performance remain unmeasured here.

| Fixture       | Action                           | Baseline samples (ms) | Candidate samples (ms) |
| ------------- | -------------------------------- | --------------------- | ---------------------- |
| opening_width | reload                           | 685, 678, 759         | 753, 712, 756          |
| opening_width | first edit after assistant apply | 547, 548, 613         | 287, 313, 321          |
| opening_width | warm edit before reload          | 445, 465, 518         | 188, 186, 185          |
| opening_width | first edit after reload          | 588, 525, 621         | 240, 233, 248          |
| opening_width | second edit after reload         | 460, 513, 507         | 213, 218, 221          |
| opening_width | immediate edit after reload      | 924, 848, 918         | 666, 586, 662          |
| holder_height | reload                           | 539, 717, 565         | 532, 902, 520          |
| holder_height | first edit after assistant apply | 144, 175, 160         | 108, 109, 122          |
| holder_height | warm edit before reload          | 146, 165, 160         | 110, 100, 96           |
| holder_height | first edit after reload          | 322, 345, 324         | 143, 106, 118          |
| holder_height | second edit after reload         | 289, 328, 265         | 96, 95, 95             |
| holder_height | immediate edit after reload      | 659, 738, 656         | 474, 522, 460          |
