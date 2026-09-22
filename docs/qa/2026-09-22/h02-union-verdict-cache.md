# H02 production benchmark: history cache on the private hammer holder (H02)

Measured 2026-09-22 on this Linux workstation (headless Chromium via
Playwright 1.62.1, production `vite preview` build), private source
`shapr3d_hammer_holder.step` (Shapr3D export, 910 KB, 42 NURBS faces),
parameter `holder_height` via the verified `Parameterize holder and text`
proposal. Probe: `test/e2e/perf-holder-reload.spec.ts` (`OZ_PERF=1`,
private scenario via `OZ_PERF_HOLDER_STEP`, `OZ_PERF_HOLDER_PARAMETER`,
`OZ_PERF_HOLDER_SUGGESTIONS`). Raw samples are local-only (private source);
the table below is the recorded comparison. The probe change in this PR
(raising the verified-chip/proposal waits for the NURBS-heavy source) is
harness-only and changes no product behavior.

Cache-disabled = `MAX_HISTORY_CHECKPOINTS = 0` (full rebuild every sync);
cache-enabled = shipped `MAX_HISTORY_CHECKPOINTS = 32` (prefix restore).
One run each; wall times, medians not claimed.

## Result

**The history cache is what makes a hammer-holder edit ~21 s instead of
~50 s.** Every edit replays only the parameter-dependent suffix (bridges,
moves, union, text) instead of the full history including the four NURBS
carve intersections and the import feature, and reuses the unchanged
prefix bodies' measurements by handle identity. The first edit after a
settled reload costs the same as any warm edit in both modes.

| Scenario (ms) | Cache-disabled | Cache-enabled | Delta |
| --- | ---: | ---: | --- |
| Warm edit before reload (exact) | 49,759 | 20,691 | −29,068 (−58%) |
| First edit after settled reload (exact) | 49,174 | 20,729 | −28,445 (−58%) |
| Second edit after reload (exact) | 49,637 | 20,885 | −28,751 (−58%) |
| Edit typed before reload settles (exact) | 98,413 | 71,374 | −27,039 (−27%) |
| Reload to exact ready | 51,194 | 53,055 | +1,861 (noise) |

First-edit-after-reload equals warm-edit in both modes (enabled: 20,729 vs
20,691; disabled: 49,174 vs 49,759), so the H02 budget shape
(first ≤ 1.5 × warm + 250 ms) holds either way — the cache moves both.

## Where the time goes (warm edit, worker stages)

| Stage (ms) | Disabled | Enabled | Note |
| --- | ---: | ---: | --- |
| Replay (`history: Building history`) | 30,501 | 9,348 | −21,153: skips import + 4 carve intersections |
| Union feature (`…opening`) | 5,926 | 5,905 | unchanged: always replayed |
| Text feature | 3,232 | 3,360 | unchanged: always replayed |
| Measurement bodies (excl. sub-stages) | 18,505 | 10,607 | −7,898: prefix bodies reused by handle |
| Holder body (final, with recognition) | ~5,800 | ~5,750 | unchanged: edited body re-measures |
| Text body | ~2,660 | ~2,670 | unchanged: edited body re-measures |

Union (5.9 s) and text (3.3 s) features plus holder/text measurement
(~8.4 s combined) dominate every enabled edit at ~17.6 s of ~20.7 s.
The union feature's own cost is the fuse plus the gate's strict
validation and closed-projection tessellation; the holder measurement
repeats the strict validation and the imported-feature/opening/volume
passes on the same handle. That repeated validation is the narrowly
justified cache path implemented in this PR (below).

## Narrowly justified change

The union gate now heals via `unifyFacesChecked` on a copy and hands its
strict verdict (`strictErrors`, `meshClosed`) to the same sync's
measurement pass through a per-sync handle-keyed map, replacing that
pass's second `validateSolid` on the same handle. Acceptance is unchanged
(strict solid AND closed projection, else the raw union stands); bodies
without a verdict validate exactly as before; the map dies with the sync
and handles are never mutated in place after their feature ran. The
union refusal reads the verdict instead of re-validating. Expected
saving on this fixture: one strict NURBS validation per edit (~1–2 s of
the ~2.1 s `Volume and validation` holder sub-stage); to be confirmed by
a follow-up probe run, not claimed here.

Regression coverage: `test/exact-kernel-adapter.test.ts` — verdict reuse
caps strict `validateSolid` calls at one per union sync; verdict-to-refusal
mapping is pinned without a kernel; checked vs plain gate agreement pins
the shipped body strict with a non-refusing verdict. Exact B-rep behavior
and validation are preserved: no tolerance, oracle, refusal, or geometry
path changed.
