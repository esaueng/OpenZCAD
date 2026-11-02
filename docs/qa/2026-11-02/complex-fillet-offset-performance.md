# Complex-fillet face-offset qualification

The integrated development build meets the 2× target for continuous exact
dragging and typed exact preview: **2.30×** and **2.24×** faster respectively.
Apply improves less; Undo remains variable and its median is slower. This is
local development qualification, not proof of a deployed kernel release.

This campaign measures a planar face connected to a complex fillet on the
supplied private, 44-feature native-history part. H02 remains **Partial**:
these results cover this operation and device, not the broader history-cache,
memory-retention or general interactive-CAD acceptance criteria.

## Changes and bottlenecks

[OpenZCAD #1155](https://github.com/esaueng/OpenZCAD/pull/1155) caches each
neighbor's mesh depth within one recognition call and computes an approximate
collision travel hint only after the matching exact refusal. Successful exact
offsets no longer pay for the unused hint. Repeated recognition calls on this
part fell from about 175–190 ms to 1–3 ms; initial mesh preparation still costs
about 120 ms. These are isolated frontend measurements, not browser speedups.

Native profiling identified curved-face tessellation as a remaining cost.
[Remus #1492](https://github.com/esaueng/remus/pull/1492) groups consecutive
boundary segments into blocks of 16. A query can skip a block only when it is
outside the union of the segments' existing outward-rounded bounds. Unknown
bounds retain the original scan, including segment order and narrow distance
arithmetic. It preserves tolerances, mesh accuracy and exact acceptance.

Three alternating native runs reduced the median of per-run median mesh times
from 72.6 ms to 64.0 ms (12% lower), and first-mesh times from 186.7 ms to
141.1 ms (24% lower). The kernel change alone is not a 2× improvement.

## Browser method and identities

The same Playwright probes drive headed Microsoft Edge 156.0.4314.58 on one
Windows laptop, Intel UHD / ANGLE D3D11, viewport 1440×1000 and DPR approximately
1. The Browser plugin was unavailable, so these runs use installed Edge through
Playwright. The input file, screenshots, arena dumps, JSONL records, CPU profiles
and complete build identities remain external to the repository.

Select the top planar face by normal and nearest area, then offset it by +3 mm.
Each pointer case commands 120 real moves; browser event coalescing can reduce
the observed event count. Typed cases independently measure exact preview,
authoritative Apply and Undo. Runs rotate the three builds in this order:
baseline/current/combined, combined/baseline/current,
current/combined/baseline. No CPU profiling is enabled in timing runs.

| Arm | Application source | Kernel |
| --- | --- | --- |
| Original baseline | `a4543025652198bb226c1282b1af0c43e43e020e` | paired `2026.1.101`, immutable `44607bac87fe90ddf443ec5d5a7bd40574e890ec` |
| Current app control | `bc47dcb3403ad2ed0bbd88547d1586e36284e589` | paired `2026.1.102`, immutable `2f062f27ac95debabf9fb369f9972d24b21b169b` |
| Combined candidate | same current app | paired Linux build of the boundary-block patch, committed as `b28770ffffbccad95faa8d4f7b5168ceac41c06e` |

The current app includes the merged frontend optimization, checked-source
checkpoint follow-up and subsequent coplanar-rendering changes. Therefore this
control comparison does not isolate #1155 alone. The candidate kernel is a
development overlay, not a published release. Its metadata reports the external
checkout context `4df288c8` with `dirty: true`; the retained paired-build log and
fingerprints identify the actual binaries:

- core SHA-256: `af880ea0a00e85237905cd93caa1c6a47d146aabb6e265f427a00c4d38c938dc`
- translator SHA-256: `bc9206c0a025bd3ca8189bc6eb5d9c7a626a8054b5b44446878b8167794a8898`

The baseline has the same five-line, opt-in rendered-body observation hook as
the candidate. It returns installed geometry only when the test asks for it;
the original production geometry and rendering algorithms are unchanged. An
initial typed baseline attempt lacked this hook and failed its frame witness.
That attempt is excluded from typed timing claims and retained as an
instrumentation failure. Successful earlier pointer samples are retained.

The frame witness compares the accepted exact mesh with the installed mesh
after `renderer.render`. A whole-body bounding box cannot witness this face
move because the taller adjacent cylinder preserves the box. The probe does
not measure physical display scanout. It rejects refusal, missing changed
geometry, preview/Apply mesh mismatch and failed Undo; pointer records also
assert no proxy presentation.

## Integrated browser results

All 18 cases passed: three pointer and three typed cases for each arm. All nine
typed cases have the same exact preview mesh across builds; Apply matches that
mesh and Undo restores the original. Runtime-error lists are empty. All nine
pointer cases have accepted geometry and zero refusals/proxy frames.

Values are milliseconds: median of three per-run values, followed by their
minimum–maximum. The p95 row is the median of per-run p95 values, not a pooled
event percentile. Speedup divides the baseline median by the combined median.

| Phase | Original baseline | Current app control | Combined candidate | Speedup |
| --- | ---: | ---: | ---: | ---: |
| Continuous drag p50 | 2,482.1 (2,312.1–2,648.5) | 1,341.5 (1,227.1–1,381.1) | 1,077.2 (1,021.1–1,134.7) | **2.30×** |
| Continuous drag p95 | 3,004.2 (2,962.0–3,562.4) | 1,903.7 (1,868.9–2,014.0) | 1,508.3 (1,352.2–1,580.3) | 1.99× |
| First pointer geometry | 1,905.2 (1,769.1–2,565.4) | 1,148.4 (1,090.9–1,220.4) | 1,051.3 (1,045.1–1,056.4) | 1.81× |
| Pointer release | 1,638.7 (1,614.5–1,818.3) | 1,099.3 (866.7–1,117.4) | 976.6 (969.8–1,060.6) | 1.68× |
| Typed exact preview | 1,395.4 (1,096.7–1,801.1) | 691.9 (678.3–739.9) | 623.9 (507.8–642.0) | **2.24×** |
| Typed Apply | 1,034.3 (1,027.8–1,676.6) | 774.2 (683.5–915.7) | 747.6 (678.4–825.3) | 1.38× |
| Typed Undo | 385.5 (317.7–458.3) | 354.4 (313.0–376.5) | 431.7 (287.9–446.0) | 0.89× |

The current-control versus combined comparison also includes CI versus local
WASM build differences. The same-toolchain native before/after comparison
above isolates the boundary-block source change. Host variability is visible
both within this campaign and against the earlier campaign below; neither
campaign is discarded to improve the reported result.

## Correctness and development environment

Windows application control prevented native Rust build scripts from running.
WSL 2 Ubuntu now provides an independent Linux source clone, Rust 1.96.0,
the wasm32 target, wasm-pack 0.15.1, wasm-bindgen-cli 0.2.126 and Node 22.22.1.
Both agent and provisioning accounts have the shared privacy guard; the real
project hooks remain chained. Windows protections were preserved. The existing
Windows Remus checkout was preserved.

The [paired development workflow](../../plans/edit-pipeline-performance.md#paired-kernelbrowser-development)
builds both WASM packages with `cargo xtask wasm-build` and overlays them only
when both directories are explicitly selected. The installed Linux
`remus-wasm-build` helper uses that command. Immutable dependency checks remain
enabled for ordinary app builds.

Kernel validation:

- 3,667 operations tests passed, 27 skipped; 997 I/O tests passed, 3 skipped.
- Eight focused clearance regressions pass, including cross-block/hole and
  nonfinite inputs, rounded-endpoint controls, a segment-work guard and whole
  display/measurement mesh bit parity against the original predicate.
- The supplied part passes 108 byte comparisons across twelve offsets and two
  mesh accuracies: exact solid arenas, positions, normals, indices and face groups.
- Both paired builds pass runtime smoke and installed-tarball consumer checks.
  Formatting, all-target/all-feature Clippy, taplo, machete, layer boundaries,
  deterministic-hash and documentation checks pass.

Kernel CI reports +693 B raw core and +207,496 B raw lazy translator against
its committed base packages, within existing hard limits. Local paired builds
with the same toolchain measured +693 B for each module; those two comparisons
have different bases and must remain separate. Generated packages are excluded
from the kernel source PR.

The app implementation PR passed its exact-head quality, unit, web, parity,
build, browser-smoke and privacy gates, then merged as `83ef8547`; its separate
queue candidate passed CI and Cloudflare verify, with upload skipped. Earlier
full Windows root/web suite attempts had failures reproduced on the clean
baseline; those attempts are not represented as passing full suites. The
current pinned and local-overlay app builds both pass the complete top-level
build, including provenance and bundle-size checks.

The kernel implementation passed its full exact-head CI and advisory checks,
including native shards and paired WASM consumer tests, then merged as
`30338a2c8bddc0808abd5350661dfadaa6e3a6f3`. Its separate merge-group CI and privacy
checks passed. Package refresh and application consumption remain separate
from these source merges and the tested local overlay.

## Earlier campaign and limitations

An earlier app source (`ad11d106`, before the integrated checked-source and
renderer changes), with the same candidate kernel, produced six successful
pointer runs per arm across two campaigns. Pooling all six gives per-run p50
medians of 1,735.35 ms baseline, 934.25 ms app-only and 796.70 ms combined:
**2.18×** baseline-to-combined. Baseline values ranged 1,640.6–2,071.1 ms and
combined values 714.1–933.4 ms. The even-count median is the mean of its two
middle values. These samples are not pooled with the newer app source.

The earlier complete three-run campaign measured typed preview at
1,071.6 → 562.4 ms, Apply at 1,010.1 → 531.1 ms and Undo at 261.5 → 339.6 ms.
It does not establish a 2× gain for those phases. Diagnostic Undo CPU profiles
show variable main-thread mesh/shading and edge-overlay work; the worker time
alone does not explain the frame delay. Follow-up probes varied substantially,
including a faster app-control Undo, so no production Undo fix is claimed.

Absolute browser times vary with host load, JIT and thermal state. Rotated run
order and retained ranges reduce selection bias but are not confidence
intervals or a universal GPU/browser performance claim. Interactive frame rates,
other faces/models, touch, WKWebView, sustained thermals, worker retention and
physical input/display latency require separate qualification. Local overlay
results do not prove deployment of the kernel patch to production.
