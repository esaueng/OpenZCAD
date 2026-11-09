# Phase 3 round 3: direct-edit performance

Prepared drags are substantially faster, but **neither the 100 ms warm pointer-frame target nor the 1.5 s canonical-release target is qualified**. Exact geometry is preserved. The paired local packages and browser hashes are the same as [round 2](video-parity-phase3-round2.md); package manifests and the lockfile remain unchanged. PR #1276 remains on hold pending the Remus refresh.

The controlled comparison uses Chrome, the same STEP file with its R1 cap rim, five real pointer positions per gesture, cancellation, a second gesture ending at R1.9 / diameter 14.6, canonical acceptance, and Undo. The before app is `08e0cfd0` plus timing instrumentation only. Four positions after the initial frame form each warm median; these are small, host-specific samples, not percentile guarantees. The native-history checks are additional qualification, not a controlled before/after comparison. This round does not rerun A0–A8 or change round 2's functional gap classifications.

The paint proxy is the production viewer's first matching WebGL frame after installation (`presented=1`), not hardware scanout or a GPU-finish fence. Pointer events, worker timings and actual render work are measured; screenshots confirm the resulting frame. The reported proxy already exceeds both targets, before any unmeasured compositor/scanout latency.

## Warm frame breakdown

All numbers are milliseconds. Columns show before → after medians from the sequential Chrome captures. Rows describing enclosing stages overlap their children and must not be added together. “Other worker” is elapsed worker time minus **all** timed kernel calls: an upper bound on history keys, JSON handling, mesh processing, cloning, posting, and cooperative yields. It includes the separately shown JS stages below; it is not a claim that every millisecond is history work.

| Stage | A2 convex | A7 boss diameter | Finding |
|---|---:|---:|---|
| Pointer → first rendered matching geometry | **221.6 → 104.1** | **761.6 → 211.6** | 53% / 72% reduction; targets unmet |
| Complete worker request | 146.1 → 76.9 | 684.4 → 179.6 | Includes exact operation and disposable projection |
| `previewPreparedGroupEdit` | 34.1 → 41.0 | 72.6 → 71.0 | Actual binding call, not Node timing extrapolated to Chrome |
| `tessellateSolidGroupedBinary` | 96.6 → 27.6 | 535.0 → 79.4 | Preview uses 8× linear deflection and 0.18 rad angular deflection; canonical remains 0.06 rad and ordinary linear deflection |
| Position/index extraction | 0.4 → 0.1 | 0.3 → 0.1 | WASM getters materialize buffers; read once. Face-offset handling remains inside projection |
| Face-area integration | 3.4 → 0.2 | 27.5 → 17.0 | Only the edited dimension's matching faces are measured during prepared frames; remaining face metadata is pending |
| All other worker JS and yields | 11.9 → 5.2 | 13.4 → 4.4 | Upper bound, includes the following JS stages |
| Spline-bound refinement | 4.8 → 0 | 4.4 → 0 | Disposable mesh retains conservative bounds; completed measurement still refines them |
| Publication `structuredClone` | 1.5 → 0.2 | 1.4 → 0.2 | Detached publication remains mandatory |
| Adapter solid validation | 0.1 → 0.1 | 0.1 → <0.1 | Validation was not removed |
| Checkpoint restore | 0.1 → 0.1 | 0.2 → <0.1 | Not the dominant cost; source still restored before each frame |
| Serialization / journal summary calls | 0 → 0 | 0 → 0 | No arena serialization, journal parsing, or canonical replay per warm frame |
| Worker `postMessage` | not separately captured → 0.1 | not separately captured → 0.1 | Existing transferred buffers retained |
| Remaining request/reply transport | 0.9 → 1.0 | 1.0 → 1.8 | Main round trip minus worker duration, queue and send time; includes dispatch/scheduling |
| Worker queue | 0 → 0 | 0 → 0 | Warm median; existing one-in-flight/latest-pending scheduling retained |
| Scene installation | 65.7 → 17.2 | 65.8 → 15.2 | Fewer temporary triangles reduce smoothing, outlines and GPU buffer installation |
| WebGL render | 2.6 → 1.4 | 4.3 → 1.8 | Actual first-frame draw duration; scheduling is included in the pointer total |

Chrome records the worker binding measures as `oz.direct.kernel.*`, adapter stages as `oz.direct.*`, and main phases as `oz.drag.*` / `oz:edit.*`. The kernel is wrapped **only during an explicitly requested profile**; normal execution restores the original method descriptors.

The initial preparations still take 907.0 ms (blend) and 924.2 ms (boss); first-frame times are 1683.0 and 2728.1 ms. Cold compilation and first-gesture preparation are excluded from the warm median, not hidden as a successful 100 ms frame. Before, selection-triggered syncs between frames spent 3907.9 / 3192.2 ms in four `moveFacesJournaled` proofs plus 246.6 / 193.2 ms in `meshQuality`, then discarded the prepared handle. Cache/deduplication now avoids those equivalent syncs. Boolean requests share a result only when the adapter's actual per-boolean probe decisions match; genuinely different lineage demand still misses the cache.

Normal Chrome with heavy trace/profiling disabled measures warm medians **105.5 / 222.3 ms** for STEP blend/boss. It also passes cancel, commit and Undo. Neither target is claimed from a selected faster sample. Final native-history medians are 121.3 / 169.4 ms, with canonical paints at 4046.9 / 2032.5 ms and cached idle echoes at 14.8 / 21.7 ms. All four final drags pass.

## Release and remaining costs

“Canonical paint” is the Chrome trace interval from the last real `pointerup` dispatch to the first `oz:edit.frame` with completed analysis on the committed revision. The older round-2 harness's Node wall-clock time also waits for diagnostics polling and the idle status echo; it is retained separately for comparison. It is not the time of the first canonical paint.

| Release stage | A2 before → after ms | A7 before → after ms | Classification |
|---|---:|---:|---|
| **Release → canonical paint** | **3203.9 → 4075.4** | **4305.5 → 4838.7** | Target unmet; release regressed in these captures |
| Complete canonical worker | 3099.8 → 3899.0 | 4237.4 → 4694.6 | Includes the following work |
| Everything outside that worker request | 104.1 → 176.4 | 68.1 → 144.1 | Main submission, queue/dispatch, installation and first-frame overhead combined |
| `commitPreparedGroupEditJournaled` | 2098.4 → 2266.9 | 1318.5 → 1303.6 | Kernel call; blend call alone exceeds 1.5 s |
| Adapter-requested validation | 697.4 → 778.8 | 3.0 → 4.2 | Kernel validation remains authoritative |
| Planar capability proofs, move + mesh-quality calls | 0 → 0 | 2828.2 → 2730.8 | App requests completion metadata; time is inside four kernel moves and quality checks. Not journal-JSON overhead |
| Volume | 207.8 → 180.4 | 7.0 → 5.8 | Kernel integration |
| Full-quality tessellation | 19.7 → 528.8 | 9.3 → 562.1 | Kernel meshing; coarse previews no longer pre-warm the final-quality cache |
| STEP canonical idle echo | 1391.8 → 7.7 | no separate echo in capture → 5.1 | App result-cache improvement; first paint need not wait for this echo |
| Legacy polling-based release | 4853.0 → 4422.2 | 5504.8 → 5303.1 | Includes automation/polling and idle completion |

The remaining browser kernel preview + tessellation lower bounds are about **69 ms for A2 and 150 ms for A7**, before metadata, main-thread installation or paint. A7 still has 17 ms of kernel area work for matching dimension faces. The canonical tessellation regression is a measured tradeoff of disposable preview quality, not an improvement claim. The app still requests planar capability proofs during imported-body completion; moving that discovery off the critical path would require preserving its current editing/recognition contract. No validation, proof, mass property, exact result or canonical mesh is replaced by a guessed or approximate answer to meet a timing target. Kernel commit and final-quality meshing require further performance work.

Read-only source inspection confirms that Remus includes both deflection and angular tolerance in its face mesh key (`crates/operations/src/tessellate/face_cache.rs:658–659`). A coarse cached projection therefore cannot answer the full-quality request. No kernel source or packages were modified.

## Evidence and reproduction

Local-only evidence is intentionally outside Git. The supplied part, screenshots, Chrome traces, runtime details and fingerprints are not published with the PR.

- [Before A2 pointer/geometry ledger](../../artifacts/video-parity-phase3-round3/before/step-blend-pointer.json), [worker](../../artifacts/video-parity-phase3-round3/before/step-blend-worker.json), [Chrome trace](../../artifacts/video-parity-phase3-round3/before/step-blend-chrome.json).
- [Before A7 pointer/geometry ledger](../../artifacts/video-parity-phase3-round3/before/step-cylinder-pointer.json), [worker](../../artifacts/video-parity-phase3-round3/before/step-cylinder-worker.json), [Chrome trace](../../artifacts/video-parity-phase3-round3/before/step-cylinder-chrome.json).
- [After A2 ledger](../../artifacts/video-parity-phase3-round3/final-head/step-blend-pointer.json), [worker](../../artifacts/video-parity-phase3-round3/final-head/step-blend-worker.json), [Chrome trace](../../artifacts/video-parity-phase3-round3/final-head/step-blend-chrome.json), [preview PNG](../../artifacts/video-parity-phase3-round3/final-head/step-blend-pointer-preview.png), [canonical PNG](../../artifacts/video-parity-phase3-round3/final-head/step-blend-pointer-committed.png).
- [After A7 ledger](../../artifacts/video-parity-phase3-round3/final-head/step-cylinder-pointer.json), [worker](../../artifacts/video-parity-phase3-round3/final-head/step-cylinder-worker.json), [Chrome trace](../../artifacts/video-parity-phase3-round3/final-head/step-cylinder-chrome.json), [preview PNG](../../artifacts/video-parity-phase3-round3/final-head/step-cylinder-pointer-preview.png), [canonical PNG](../../artifacts/video-parity-phase3-round3/final-head/step-cylinder-pointer-committed.png).
- [Runtime wasm hashes](../../artifacts/video-parity-phase3-round3/final-head/step-runtime.json), [normal-mode A2](../../artifacts/video-parity-phase3-round3/after-untraced-rerun/step-blend-pointer.json), [normal-mode A7](../../artifacts/video-parity-phase3-round3/after-untraced-rerun/step-cylinder-pointer.json), [aggregate](../../artifacts/video-parity-phase3-round3/summary.json).

Before/after canonical mesh and face-geometry SHA-256 fingerprints match exactly for both STEP gestures. Cancel and Undo match the original fingerprint. Browser runtime hashes match core `6746f551bdb76a5953c85ae56c6d9ca8331fc692b019e6f0461311e4f8d4ba23` and IO `e4f40290debc91ab9734680316a130909ef6dc8202ba6fb4c28bcf26fc9ff250`; version alone was not accepted as proof. Two overlapping Playwright teardowns collided in the older shared output directory; affected captures were excluded and both STEP captures rerun sequentially with isolated output. The config now derives its output directory from the evidence root.

Run from the repository root, reusing round 2's generated R1-rim input. Environment values below are local paths, never manifest changes:

```powershell
$env:REMUS_WASM_PKG='<readonly combined core package directory>'
$env:REMUS_WASM_IO_PKG='<readonly combined IO package directory>'
$env:VITE_E2E='1'
$env:VITE_E2E_FULL_RENDER='1'
pnpm.cmd build
pnpm.cmd --filter @openzcad/web preview --host 127.0.0.1 --port 25349
# In a second shell:
$env:VIDEO_PARITY_INPUT=(Resolve-Path artifacts/video-parity-phase3-round2/input).Path
$env:VIDEO_PARITY_ROUND2='1'
$env:VIDEO_PARITY_PROFILE='1'
$env:VIDEO_PARITY_OUT='artifacts/video-parity-phase3-round3/reproduce'
$env:VIDEO_PARITY_EXPECT_CORE='6746f551bdb76a5953c85ae56c6d9ca8331fc692b019e6f0461311e4f8d4ba23'
$env:VIDEO_PARITY_EXPECT_IO='e4f40290debc91ab9734680316a130909ef6dc8202ba6fb4c28bcf26fc9ff250'
pnpm.cmd exec playwright test --config test/perf/video-parity-wiring.playwright.config.ts --grep 'step (blend|cylinder) pointer'
node scripts/report-video-parity-round3.mjs artifacts/video-parity-phase3-round3 reproduce
# Normal mode: unset VIDEO_PARITY_PROFILE, set VIDEO_PARITY_CHROME=1,
# choose a fresh VIDEO_PARITY_OUT, and run sequentially.
```

The override's source-commit safety check may require the same per-command Git `safe.directory` setting documented in round 2. Never change the read-only Remus checkout or the shared hooks configuration.

## App changes and validation

- `packages/kernel-adapter/src/display-tessellation.ts:18` and `exact-display-projection.ts:26`: disposable prepared-drag projection quality, with completed bounds refinement and normal display quality retained.
- `packages/kernel-adapter/src/exact.ts:3401` and `preview-face-geometry-cache.ts:133`: keep the normal display anchor, defer unrelated face measurements, and retain the dragged dimension's measured metadata. Prepared bindings are required; the older pin keeps the existing path.
- `apps/web/src/worker/exactRebuildCache.ts:8`, `geometryWorker.ts:1076`, and `hooks/useGeometryWorker.ts:113`: deduplicate equivalent results without collapsing different boolean probe decisions. The eager rule is preserved explicitly.
- `packages/kernel-adapter/src/direct-edit-profile.ts:15`, `apps/web/src/worker/geometryWorker.ts:654`, and `apps/web/src/lib/faceDragTrace.ts:54`: opt-in binding/stage profiling and matching Chrome user timing markers.

Final checks pass: lint (18 existing hook warnings), TypeScript, the complete web suite (512 files / 5,591 tests), 70 focused root regressions on each kernel, 12 actual boolean-demand tests on each kernel, two supplied-part canonical mesh/volume replay checks, and the combined-kernel parity corpus (92 passed, one existing skip). Canonical replay compares binary mesh digests and volume after establishing the same ordinary source display anchor in a fresh session without previewing. Both root builds include wasm verification and bundle budgets. The combined kernel passes four final pointer/cancel/commit/Undo cases; the installed pin passes six browser regressions. Roadmap fragments and the privacy guard pass.

The initial full web run exposed three fixtures that requested boolean cache invalidation without a boolean; those now use actual unions and retain the real invalidation assertions. A run spanning edits is not counted as final evidence. The frozen-source full run passes all 5,591 tests. Full root `pnpm test` still fails in local Vite collection with `TypeError: code.charCodeAt is not a function`, as in round 2 and the pinned baseline. The named root checks, corpus and complete web suite are separate evidence, not a passing full root-unit gate.

No merge, auto-merge or deployment is authorized by this held PR. Hosted checks must be distinguished from these local results, and the PR still needs requalification after the paired Remus refresh.
