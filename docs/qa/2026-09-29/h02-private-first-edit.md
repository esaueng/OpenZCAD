# H02: restore the fixed text source with the existing holder prefix

Measured locally on 2026-09-29 on an Apple M5 Pro, macOS 27.0,
headless Chromium (Playwright 1.62.1), production Vite preview build.
The private hammer STEP and raw samples remain local. No source geometry or
project documents are included in this report. Baseline product commit:
`20e5217ce0de3eeba6665037d9fd8ee057edd822`; both builds use the same frozen
Remus pair (`594cd308`).

## Change and scope

A newly compiled `Parameterize holder and text` recipe now orders its fixed
Text import immediately after the pre-existing history, before the holder's
carving and parameter-dependent suffix. The existing exact-history checkpoint
cache then restores that import after a settled reload. Body order is
preserved; the parameter-driven `Keep text together` transform still runs at
the end, and the final union and every measurement/recognition check still run.

This is a feature-order change in the recipe compiler, not a new branch cache.
It introduces no new cache type, kernel dependency, or arena-handle lifetime
assumption. The checkpoint/cache byte and replay-work limits remain unchanged.
Checkpoint contents do change because they now include Text earlier. Worker
retained heap was not measured, so no zero-memory-delta claim is made. The
proposed caches in the private-holder cache design remain gated on their
acceptance benchmark and W02 contract.

Existing saved recipes retain their order. Reopening an existing document does
not silently rewrite its feature history. This evidence applies to holders
parameterized by the updated recipe compiler, then saved and reloaded.

## Measurement boundary

Probe: `test/e2e/perf-holder-reload.spec.ts`, private scenario,
`holder_height`, verified `Parameterize holder and text` suggestion.
Each run imports the same local source and applies the verified recipe, takes
a warm edit, saves/reloads, then takes the first and second edits after exact
reload readiness, followed by a second reload with an immediate edit.

The probe now requires the worker's latest live state to be ready and fresh,
the parameter's successful commit readout, exact preflight readiness, and a
newer committed live version. It no longer falls back to preflight or the
page clock when live exact completion is absent. Saved parameter values must
survive each reload. A blank status is insufficient to call a reload settled.

The first exploratory run exposed that old boundary error: its reload-ready
time was absent and its apparent first settled edit included the cold rebuild.
That run is excluded from the comparison. The commit readout is checked before
the readiness wait because it is transient.

Preview-install measures remain separate from Enter-to-exact-completion times.
They run from the draft input callback to viewport object installation, before
browser presentation, GPU completion or scanout; they are not Enter-to-exact
completion measurements.
No preview is accepted as geometry or counted as exact readiness.

## Measured comparison

Three serial runs per build, identical local source and parameter sequence.
Baseline runs precede optimized runs; this is a small exploratory sample,
not a randomized or isolated tail-latency study. p95 uses nearest rank and is
therefore the maximum of three samples. Every optimized run enabled
`OZ_PERF_BUDGET=1`; all exact-readiness, within-run timing and Text-restoration
assertions passed. Baseline saved values also survived every reload.

| Wall-clock metric (ms)          | Baseline median / p95 | Text-prefix median / p95 |
| ------------------------------- | --------------------: | -----------------------: |
| Warm edit before reload         |       10,984 / 11,330 |           9,220 / 13,138 |
| First edit after settled reload |       10,902 / 12,306 |           9,271 / 14,026 |
| Second edit after reload        |       10,779 / 12,257 |           9,103 / 10,058 |
| Immediate edit during reload    |       40,077 / 40,871 |          36,670 / 39,118 |
| Reload to exact readiness       |       31,507 / 32,231 |          35,908 / 43,058 |

First-edit exact samples (ms): baseline `[12306, 10728, 10902]`, optimized
`[8668, 14026, 9271]`. Median exact completion improves **15.0%**, but sample
p95 **worsens 14.0%**. The slower optimized run is retained, not filtered out.
Reload and warm-edit timing slowed in that run too; a process check found no
leftover benchmark runner. This does not establish the cause of the variation.

First settled edit's exact preflight stages:

| Worker stage (ms)                             | Baseline median / p95 | Text-prefix median / p95 |
| --------------------------------------------- | --------------------: | -----------------------: |
| Suffix replay                                 |         5,095 / 5,286 |            3,337 / 4,760 |
| Growing-holder union                          |         2,914 / 3,002 |            2,858 / 4,057 |
| Fixed Text import                             |         2,156 / 2,258 |         0 / 0 (restored) |
| Body measurement, excluding nested sub-stages |         5,292 / 5,509 |            5,344 / 7,622 |

Both histories have 31 features and 17 measured/reused body entries. The first
edit restores 16 features and replays 15 in both orders: geometric checkpoint
spacing replaces Text replay with a small static boundary span. Measurement
still processes nine bodies and reuses eight; the change does not remove the
edited holder/text measurements. Timings of nested measurement stages are not
added twice. Union time is part of suffix replay, not an additional total cost.

The first-edit preview-install metric is `null` in all six samples. No preview
latency improvement is claimed or substituted into the exact-completion table.

The design's **20% p95 exact-completion improvement is not met**. Its proposed
branch/measurement records remain unaccepted. The narrowly justified result
here is removal of repeated fixed Text construction using the existing prefix
cache, with a measured median improvement; it is not a proven tail-latency fix.
The observed measurement and reload variability remain H02 follow-up work.

## Regression coverage

`test/growing-holder-lettering.test.ts` exercises unplaced and rigidly placed
sources, cold adapter startup, save/normalize/reload, the first edit, the old
feature order as a fresh no-checkpoint oracle, warning-free exact completion,
body order, bounds, volume, face count, topology/lineage, recognition proofs,
mesh triangle counts, consumption/exportability, rigid previews, undo/redo,
and text-toggle exports. A changed lettering selection must replay Text and
produce the same refusal and attributed warnings as an uncached oracle. Only
the two diagnostic opening face handles are normalized across different kernel
arenas; published topology witnesses and
lineage references are compared structurally.

The cold rebuild must execute Text. The first edit must skip Text while still
executing the union and `Keep text together`. This is a deterministic regression
check independent of hardware timing. Existing H02 within-run timing budgets
remain enabled separately for the performance run.

The private timings prove successful exact preflight/live completion with zero
warnings; full private B-rep/lineage byte equivalence was not independently
measured. The structural old-order oracle comparison uses redistributable
lettering fixtures.

H02 remains partial: old saved recipes are unchanged, the larger proposed
branch/measurement caches are not accepted, and timing samples on one machine
do not establish a universal absolute latency budget.

## Local validation

- Frozen dependency install, lint and typecheck passed (lint: 19 existing warnings).
- `pnpm test`: 3,156 root and 1,498 web tests passed; existing skips retained.
- `pnpm test:parity-corpus`: 174 passed, one existing skip.
- `pnpm build`: passed, including bundle budgets.
- Focused Playwright: five passed (three holder workflows and both public
  performance probes with budgets enabled).
- Private production probe: three baseline and three optimized runs passed;
  optimized runs enabled timing and Text-restoration budgets.

No merge, standalone deployment, migration or Apple Silicon workflow dispatch
is part of this evidence. Hosted PR checks and live behavior are separate.
