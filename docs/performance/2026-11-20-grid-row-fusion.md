# Exact grid pattern builds

The 10×10 Grid pattern on the public ×50 bar took 6.98 s to preview before
this change and 1.43 s after it, a 4.89× speedup on the measured desktop.
The bar is 1,010 × 18 × 5 mm. The 20 mm grid pitch makes copies overlap in X
and leaves 2 mm between adjacent rows in Y.

A three-round adapter profile on the base attributed a median 6,299 ms to one
`fuseAll` in a 6,917 ms preview. A separate operation trace of the pinned
WASM recorded ten N-way unions, one per row. The adapter now fuses the first
row, translates the raw exact result and joins the separated rows before the
usual checked face unification. A private kernel releases the intermediate
solids together. The original full-grid operation handles skipped copies,
curved stock, touching rows, large world coordinates and failed qualification.

## Browser measurements

These historical durations used the test driver's clock. For 3×3 it started
before a redundant body pick and read Done after the Objects panel closed.
For count edits it started after the keypad input had already triggered the
preview. The [matched rerun from the actual input event](2026-11-20-grid-preview-row-reuse.md)
records when the corresponding preview became eligible to commit. Each pair exercised both local builds in a fresh Chromium
context, on the same host with hardware rendering. The workload, probe and
pinned packages were the same. Trial order was base/candidate,
candidate/base, base/candidate.

| Grid | Baseline, three runs | Candidate, three runs | Median speedup |
| --- | --- | --- | ---: |
| 3×3 | 655, 661, 654 | 573, 557, 574 | 1.14× |
| 10×3 | 2,326, 2,324, 2,173 | 871, 863, 891 | 2.67× |
| 10×10 | 6,935, 6,977, 7,139 | 1,427, 1,441, 1,396 | 4.89× |

The local baseline used OpenZCAD `1ccd73041`, the candidate used the same
source plus this patch, and both used Remus `c81a719a9` (2026.1.151).
Hardware was a Ryzen 9 5900XT and NVIDIA RTX 3090, Chromium 156.0.8078.4
with ANGLE OpenGL. All six browser runs completed without runtime errors.
These are local desktop medians. Integrated-GPU and deployed-beta timings
remain unmeasured for this change.

## Reproduction and correctness

Run `node scripts/measure-active1-baselines.mjs --only pattern-browser --runs 3 --angle gl`
on each build. Run `PATTERN_PERF_RUN=1 pnpm exec vitest run --config test/perf/pattern-preview.config.ts`
for the per-method breakdown in the adapter (`PATTERN_PERF_OUT` selects the
raw JSONL). The adapter's middle workload is 3×10 and the browser's is 10×3.

Three adapter rounds per build gave 10×10 medians of 6,917 and 1,288 ms. The
two candidate fuse calls together took a median 634 ms. Both arms published
780 faces, no warnings and zero replay on Done in every 10×10 sample.
The regression suite compares the nested grid with the full fuse after
session restore, including mesh data, topology, fixed-timestamp STEP and a
subsequent subtraction. It also exercises skipped instances, touching rows,
near-contact and distant placements.
