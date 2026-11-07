# Video parity: Phase 3, round 4

The released paired Remus packages are now pinned to
`a4ca54227315cca37e8fd07e3e891f3e4295baf1` (2026.1.125). The strict
R1.5 video-order run is **not a complete pass**. After the cap is lowered to
z26, its convex edit previews but canonical acceptance refuses a non-manifold
reconstruction. Concave R4→R2 now succeeds. Later operations are attempted on
that same surviving body; they are not evidence that the missing prefix worked.
PR #1276 remains on hold. No merge or deployment is claimed.

## Executable identity and method

`package.json` and the frozen lockfile use the same immutable main commit for
core and IO. No local path override remains. `remus-checksums.json` was recorded
with `scripts/verify-remus-artifacts.mjs --record`, which checks installed bytes
against the immutable upstream Git blobs. The browser independently hashes the
actual wasm responses, rather than trusting the unchanged version string:

| Module | Browser SHA-256                                                    |
| ------ | ------------------------------------------------------------------ |
| Core   | `fdf4bfb484dee781cfb0a8ad614556f628391b1e18ebf54752a41115c3ef7301` |
| IO     | `39b00df6be2754447c165ca4ee17b044ec32fe1e4394a7dba7ea14f14c3e028c` |

The native-history matrix opens round 2's generated W-Fillet recipe with its
R1 cap rim already present. A0 qualifies this loaded state, not a new interactive
recreation of all original fillets. Actual UI selection, pointer previews,
keypad entry, Apply, cancel and Undo drive the edits. Selection helpers identify
the face/edge or project its pick point; they do not author features or call
adapter operations. The broad free-end chamfer explicitly selects its tangent
chain by double-click; that route is labelled rather than credited as one-pick
reference parity.

Each matrix pointer probe starts a real drag, waits for the matching production
viewer frame, then cancels. Canonical acceptance is measured separately from
the actual Apply button's pointer-up to a completed-analysis frame on a newer
committed revision. These cold single-frame measurements are not warm medians
or drag-release measurements. The isolated A2/A7 profiles below use actual drag
release. The frame proxy is the first matching WebGL render, not hardware scanout.

Every committed or preserved body is checked with a read-only replay of the
document observed at the worker boundary: strict/detailed kernel validation,
one visible body/solid, actual UI triangle boundary/non-manifold/winding counts,
analytic face census, and volume at deflections 0.005, 0.02 and 0.1. This replay
does not perform the UI edits. Raw journals, documents, meshes, screenshots and
traces remain in ignored local artifacts.

## Acceptance matrix

| Attempt        | UI outcome                                                                                                                                                                           | Health                               | Analytic census                                  |   Volume mm³ | Pointer → frame ms | Apply release → canonical ms | Screenshot                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------ | -----------: | -----------------: | ---------------------------: | ---------------------------------------------------------------------------------------------------------------- |
| A0-rim         | Partial: loaded fixture: Accepted                                                                                                                                                    | closed / manifold / valid; ΔV=0.0e+0 | plane 7, cylinder 5, torus 2, bspline 2          | 16339.872377 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-A0-rim.png)                            |
| A1-long        | Pass: Accepted                                                                                                                                                                       | closed / manifold / valid; ΔV=0.0e+0 | plane 7, cylinder 5, torus 2, bspline 2          | 19189.923511 |              845.3 |                        732.1 | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A1-long-committed.png)      |
| A1-short       | Pass: Accepted                                                                                                                                                                       | closed / manifold / valid; ΔV=0.0e+0 | plane 7, cylinder 5, torus 3, bspline 4          | 15207.725299 |             1562.1 |                        651.7 | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A1-short-committed.png)     |
| A2-convex      | Fail: Refused: The resulting body wouldn't be valid.                                                                                                                                 | closed / manifold / valid; ΔV=0.0e+0 | plane 7, cylinder 5, torus 3, bspline 4          | 15207.725299 |             5467.6 |                            — | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A2-convex-refused.png)      |
| A2-concave     | Pass: Accepted                                                                                                                                                                       | closed / manifold / valid; ΔV=0.0e+0 | plane 7, cylinder 5, torus 3, bspline 4          | 15179.445406 |             2156.4 |                       6066.9 | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A2-concave-committed.png)   |
| A3             | Pass: Accepted                                                                                                                                                                       | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 7, torus 4, bspline 4          | 15168.300635 |             1679.9 |                        146.6 | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A3-committed.png)           |
| A4-fillet-1.5  | Fail: Refused: Radius; mm; Not built; Can’t round this edge here; Solid unchanged; Why?                                                                                              | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 7, torus 4, bspline 4          | 15168.300635 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A4-fillet-1.5.png)          |
| A4-fillet-3.7  | Fail: Refused: Radius; mm; Not built; Can’t round this edge here; Solid unchanged; Why?                                                                                              | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 7, torus 4, bspline 4          | 15168.300635 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A4-fillet-3.7.png)          |
| A4-chamfer-5   | Pass: Accepted                                                                                                                                                                       | closed / manifold / valid; ΔV=0.0e+0 | plane 10, bspline 4, torus 4, cylinder 7         | 15005.800635 |              321.4 |                        152.7 | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A4-chamfer-5-committed.png) |
| A4-chamfer     | Pass: Accepted                                                                                                                                                                       | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 10, torus 4, bspline 4, cone 2 | 15152.836004 |              243.8 |                        108.2 | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A4-chamfer-committed.png)   |
| A5-negative    | Pass rejection: Rejected: Radius should be positive                                                                                                                                  | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 10, torus 4, bspline 4, cone 2 | 15152.836004 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-A5-negative.png)                       |
| A6             | Pass: Accepted                                                                                                                                                                       | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 16, torus 4, bspline 4, cone 6 | 15118.377848 |              289.2 |                        123.8 | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A6-committed.png)           |
| A7-D14.6       | Fail: Refused: Diameter; mm; Not built; That diameter does not fit the existing supports and fillets. Try a smaller diameter.; Solid unchanged; Why?; Ø Diameter; R Radius           | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 16, torus 4, bspline 4, cone 6 | 15118.377848 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A7-D14.6.png)               |
| A7-D17         | Fail: Refused: Diameter; mm; Not built; That diameter does not fit the existing supports and fillets. Try a smaller diameter.; Solid unchanged; Why?; Ø Diameter; R Radius           | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 16, torus 4, bspline 4, cone 6 | 15118.377848 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A7-D17.png)                 |
| A7-D21.1       | Fail: Refused: Diameter; mm; Not built; That diameter does not fit the existing supports and fillets. Try a smaller diameter.; Solid unchanged; Why?; Ø Diameter; R Radius           | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 16, torus 4, bspline 4, cone 6 | 15118.377848 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A7-D21.1.png)               |
| A7-D14.7       | Fail: Refused: Diameter; mm; Not built; That diameter does not fit the existing supports and fillets. Try a smaller diameter.; Solid unchanged; Why?; Ø Diameter; R Radius           | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 16, torus 4, bspline 4, cone 6 | 15118.377848 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A7-D14.7.png)               |
| A7-D60         | Pass rejection: Refused: Diameter; mm; Not built; That diameter does not fit the existing supports and fillets. Try a smaller diameter.; Solid unchanged; Why?; Ø Diameter; R Radius | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 16, torus 4, bspline 4, cone 6 | 15118.377848 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A7-D60.png)                 |
| A8 cancel/Undo | Pass: Accepted                                                                                                                                                                       | closed / manifold / valid; ΔV=0.0e+0 | plane 7, cylinder 5, torus 2, bspline 2          | 16339.872377 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A8-undo.png)                |

Undo to original: true; final health valid: true.

Every preserved/committed body in the strict run has zero strict errors, zero
UI boundary/non-manifold/winding edges and zero spread in the kernel's
`volume(solid, deflection)` readings. These checks qualify the surviving body,
not a rejected candidate. The original two fitted corner patches remain;
permitted A1 shortening adds two sampled corner/rim patches while the seven
planes and five cylinders stay analytic. Later successes do **not** repair the
failed A2 convex prefix. A5/A8 preservation remains independently qualified.
An em dash means no accepted canonical frame or no observable matching pointer
frame; exact pointer probe timeouts are retained in JSON.

### R1.9 W14 comparison and failure attribution

This is a separate one-body run, not a substitution for requested R1.5. The
immutable upstream W14 fixture uses `BAND = 1.9`
([source](https://github.com/esaueng/remus/blob/a4ca54227315cca37e8fd07e3e891f3e4295baf1/crates/operations/tests/video_parity_full_order.rs#L72)).
An earlier comparison that ignored its radius override is excluded. The final
comparison ledger is [here](../../artifacts/video-parity-phase3-round4/w14-r19-control/matrix.md).

| Attempt                     | Result on this actual app body                                                      | Classification / evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Convex R1.5 after A1        | UI preview; commit refuses, original body unchanged                                 | **Kernel**: `blend-cluster-reblend-failed` ends in “translation-invariant blend move does not close: its mesh at deflection 0.001953125 has 0 boundary and 1 non-manifold edges.” Raw prepared preview and journaled commit reproduce the refusal. [Control](../../artifacts/video-parity-phase3-round4/lowered-blend-kernel-control.json), [kernel guard](https://github.com/esaueng/remus/blob/a4ca54227315cca37e8fd07e3e891f3e4295baf1/crates/operations/src/resize_blend.rs#L2905).                                                                                     |
| Convex R1.9 after A1        | Commits; B-rep valid, stable volume 15241.628826; display mesh has 3 boundary edges | **Remus WASM tessellation/binding output**: direct `tessellateSolidGroupedBinary` also has 3 boundaries at 0.005, and zero at 0.01/0.02. Canonical display quality was not weakened to hide this. Census P7/C5/T4/BS4. [PNG](../../artifacts/video-parity-phase3-round4/w14-r19-control/history-cumulative-A2-convex-committed.png).                                                                                                                                                                                                                                        |
| Concave R2 after R1.9       | The blend selection helper acquires no handle; UI attempt not verified              | **Kernel capability, plus disclosed UI coverage limit**: both remaining vertical R4 bands refuse direct calls. One names unsupported supports `["plane", "cylinder", "torus"]`; the other says “plane/cylinder support contacts are not full closed loops.” Both preparations report `blend-cluster-not-prepared`. This is not credited as a successful UI edit. [Control](../../artifacts/video-parity-phase3-round4/concave-after-convex-kernel-control.json), [PNG](../../artifacts/video-parity-phase3-round4/w14-r19-control/history-cumulative-A2-concave-error.png). |
| A3 R1                       | Commits on the surviving R1.9 body; original 3 display boundaries remain            | **Partial**: P7/C7/T4/BS5, volume 15230.246002. A new fitted patch is disclosed. [PNG](../../artifacts/video-parity-phase3-round4/w14-r19-control/history-cumulative-A3-committed.png).                                                                                                                                                                                                                                                                                                                                                                                     |
| A4 R1.5 / R3.7              | Both one-pick strict attempts and explicit-chain R1.9 controls refuse               | **Kernel operation refusal on the observed bodies**: “Can’t round this edge here” / “Can’t round these edges here.” The requested successful prefix is absent, so this does not isolate a failure on the intended final geometry. `packages/kernel-adapter/src/exact-edge-modifiers.ts` is the fillet binding route.                                                                                                                                                                                                                                                        |
| A4 chamfer 5 / retained 0.7 | Strict surviving body builds both; R1.9 control refuses 5 and builds 0.7            | **Partial workflow**: retained 0.7 uses explicit double-click chain selection. Automatic one-pick free-end propagation is an **app gap**; `apps/web/src/lib/interaction/chamferChain.ts` only offers the qualified automatic bottom-chain path.                                                                                                                                                                                                                                                                                                                             |
| A6 0.8                      | One pick propagates and commits in both runs                                        | Strict surviving body is closed; R1.9 control retains its earlier display gap. [R1.9 PNG](../../artifacts/video-parity-phase3-round4/w14-r19-control/history-cumulative-A6-committed.png).                                                                                                                                                                                                                                                                                                                                                                                  |
| A7 14.6 / 17 / 21.1 / 14.7  | Refused safely in both cumulative runs; no accepted 21.1 preview                    | **Kernel** on these app-generated states. The R1.9 body also refuses direct `resizeCylindricalFace` and journaled/prepared routes: “move-face does not support face … (nurbs): face is adjacent to selected move boundary edge …”. The adapter does not merely hide a successful new route. [Control](../../artifacts/video-parity-phase3-round4/cumulative-cylinder-kernel-control.json).                                                                                                                                                                                  |
| A7 oversize 60              | Refused, unchanged                                                                  | Strict run has the clear diameter-fit message. The R1.9 control hits its unsupported source geometry first; it does not independently qualify an oversize-specific refusal after the intended full chain.                                                                                                                                                                                                                                                                                                                                                                   |
| A8 cancel / Undo            | Restores original fingerprint and healthy R1-rim body in both runs                  | [Strict Undo](../../artifacts/video-parity-phase3-round4/post-main-strict/history-cumulative-A8-undo.png), [control Undo](../../artifacts/video-parity-phase3-round4/w14-r19-control/history-cumulative-A8-undo.png).                                                                                                                                                                                                                                                                                                                                                       |

The adapter routes are `exact-direct-edit-ops.ts:2030` (blend resize),
`exact-direct-edit-ops.ts:2205` (boss resize) and
`exact-prepared-group-edit.ts:48` (capability/refusal fallback). Blend handle
eligibility is in `apps/web/src/lib/interaction/filletFaceEdit.ts:86`.
The exact worker errors, census and latency for every alternate attempt remain
in its JSON/matrix. No unsupported step was replaced with an adapter-authored
success and presented as UI parity.

The fast display-only preview can show the R1.5 candidate before canonical
quality checks refuse it. That is a preview/commit mismatch in the user flow,
not evidence that the requested edit succeeded. The raw control runs with
canonical quality enabled; no failed quality gate was bypassed for acceptance.

## Release and pointer performance

Round 3 used the combined local kernel; round 4 uses released main a4ca542.
This is a cross-round comparison, not a controlled app-only speedup claim.
Four warm positions after the initial frame form each median. Enclosing stages
overlap children; component medians must not be added together. The final
captures identify merged source `69842c0b` and use the same isolated STEP +
R1-rim source as round 3, not the failed cumulative body. Earlier round-4
`source-key-*` captures are retained in the summary for variability/provenance;
the table below uses the later `post-main-*` qualification.

| Stage, ms                                       |    A2 round 3 → round 4 |    A7 round 3 → round 4 |
| ----------------------------------------------- | ----------------------: | ----------------------: |
| Warm pointer → matching frame, traced           |       104.1 → **125.4** |       211.6 → **187.1** |
| Warm pointer → matching frame, normal Chrome    |        105.5 → **82.6** |       222.3 → **190.6** |
| Warm worker request                             |             76.9 → 81.7 |           179.6 → 151.3 |
| `previewPreparedGroupEdit`                      |             41.0 → 43.3 |             71.0 → 74.3 |
| Preview tessellation                            |             27.6 → 29.3 |             79.4 → 47.2 |
| Face area                                       |               0.2 → 0.1 |             17.0 → 14.5 |
| Other worker JS/yields                          |               5.2 → 5.7 |               4.4 → 5.3 |
| Install / render                                | 17.2 / 1.4 → 32.9 / 1.5 | 15.2 / 1.8 → 17.3 / 2.2 |
| **Drag release → canonical frame**              |     **4075.4 → 3535.1** |     **4838.7 → 2545.1** |
| Canonical worker                                |         3899.0 → 3380.6 |         4694.6 → 1627.5 |
| Kernel journaled commit                         |         2266.9 → 2290.4 |         1303.6 → 1487.1 |
| Kernel validation                               |           778.8 → 807.9 |               4.2 → 0.0 |
| Kernel volume                                   |           180.4 → 160.9 |               5.8 → 7.7 |
| App-requested planar capability proofs          |               0 → **0** |          2730.8 → **0** |
| Final-quality tessellation in canonical request |        528.8 → **22.7** |        562.1 → **29.4** |
| Everything outside canonical worker             |           176.4 → 154.5 |           144.1 → 917.6 |
| Active speculative warm-up after release        |        not marked → 0.0 |  not marked → **742.3** |

**The overall pointer and release targets remain unqualified.** Normal-mode A2
meets 100 ms in this four-frame warm median, but traced A2 and both A7 captures
do not. Native A7 preview + tessellation + area totals about 136 ms before
installation. Commit plus validity/volume costs 3259 / 1495 ms. No commit-cost
workaround or validation omission was introduced.

The new `oz:edit.refine` marks explain the release remainder. A7's second
gesture warm-up starts 74.9 ms before release and ends 742.3 ms after it;
its 817.7 ms includes 749.2 ms of native full-quality tessellation and 48.7 ms
of prepared preview. Thus 742.3 of the 917.6 ms outside the canonical request
is an already-running speculative job; the other 175.3 ms covers dispatch,
installation and frame scheduling (canonical installation alone is 131.7 ms).
A2's warm-up ends 703.8 ms **before** release; its outside-request remainder
is 154.5 ms (81.8 ms installation). Warming moves expensive mesh work earlier,
but it does not eliminate it. An executing synchronous WASM call cannot be
preempted by a newer message. That app scheduling limitation is disclosed,
separately from native tessellation cost, and is not a completed release target.

Cold first-frame times are 1192.2 / 3106.4 ms and are not hidden in the warm
median. Cancel, real drag release, canonical acceptance and Undo pass in both
traced and normal captures. Earlier captures with repeated warm-ups or the
unstable candidate-ID key are intermediate experiments, not final qualification.

Warm per-frame queueing is zero; transport is 1.3 / 0.8 ms, mesh extraction
about 0.1 / 0.05 ms, restore 0.15 / 0.05 ms and worker post 0.05 / 0 ms.
There are no per-frame journal serialization/parsing, checkpoint creation,
capability-proof or canonical-replay calls in these measured frames; relaxed
validation costs 0.1 / 0.05 ms. Normal-mode release polling reads 4274.3 /
3186.5 ms and is not substituted for the actual trace-derived canonical frame.

Raw evidence: [A2 pointer](../../artifacts/video-parity-phase3-round4/post-main-perf/step-blend-pointer.json),
[worker](../../artifacts/video-parity-phase3-round4/post-main-perf/step-blend-worker.json),
[Chrome trace](../../artifacts/video-parity-phase3-round4/post-main-perf/step-blend-chrome.json),
[A7 pointer](../../artifacts/video-parity-phase3-round4/post-main-perf/step-cylinder-pointer.json),
[worker](../../artifacts/video-parity-phase3-round4/post-main-perf/step-cylinder-worker.json),
[Chrome trace](../../artifacts/video-parity-phase3-round4/post-main-perf/step-cylinder-chrome.json),
[normal-mode results](../../artifacts/video-parity-phase3-round4/summary.json).

The separate same-host axial comparison on app commit `50df06f2` also finds a
native regression: 21 `moveFacesJournaledWithQuality` calls take **106.9 →
28384.3 ms**, about 99% of the matched cold-sync increase. Fillet replay is
335.1 → 473.4 ms, tessellation 618.8 → 629.2 ms and validation about 1 ms.
Both pins pass 10/10 tests and produce the same 15-face profile result and volume.
No individual cold replay exceeds 120 s; the functional tests repeat many
cold oracles. [Every cold/idle/cached measurement](../../artifacts/video-parity-phase3-round4/axial-pin-compare/report.md),
[CSV](../../artifacts/video-parity-phase3-round4/axial-pin-compare/comparison.csv),
[old profile](../../artifacts/video-parity-phase3-round4/axial-pin-compare/old-profile.json),
[new profile](../../artifacts/video-parity-phase3-round4/axial-pin-compare/new-profile.json).
The larger unit timeouts are a stopgap, not a kernel performance fix or a size-budget change.
The measured quality moves enter through `exact-direct-edit-ops.ts:1913` and
`exact-face-distance.ts:183` (`journaledMove`, quality permission with 256 corner
stations). This probe attributes binding time; it does not resolve Rust
subroutines inside that entry point.

The app defers unrelated opposing-planar-face capability proofs after radius
and diameter edits. This does not skip canonical construction, validity or
mass properties. Explicit foreground face analysis still requests fresh proofs;
its cache entry is distinct from deferred capability discovery.

Prepared source face measurements are cached by the kernel's exact content
digest, not recycled face handles. Disposable pointer meshes use a 12× linear
and 0.24 angular display tolerance; canonical display quality is unchanged.
After a preview rests for 150 ms, the worker warms full-quality face meshes
without committing a journal or publishing another body. New input invalidates
queued work. Warming is limited to once per source history/gesture: candidate
feature IDs can change every frame, and using those IDs caused repeated
non-preemptible warm-ups. A warm-up already executing synchronous WASM can still
delay new input. That limitation and cold preparation are included in evidence,
not hidden by successful warm samples.

No kernel package or source was modified, and no guessed solid, validation
bypass or substituted canonical mesh was used to meet a timing target. Remus
commit-cost work is owned separately by the kernel maintainer.

## Evidence and reproduction

Local artifact root: `artifacts/video-parity-phase3-round4/`. `post-main-strict/`
contains the final merged-source R1.5 run, `w14-r19-control/` the separately labelled R1.9
comparison, and `post-main-perf/` / `post-main-normal/` the final traced and
normal-mode pointer qualification. Each matrix JSON references screenshots,
per-step health and pointer traces; `committed-v*.json` preserve the actual UI
history. Runtime JSON records fetched wasm hashes and build provenance.

```powershell
pnpm.cmd install --frozen-lockfile
# Clear both local overrides before building.
Remove-Item Env:REMUS_WASM_PKG,Env:REMUS_WASM_IO_PKG -ErrorAction SilentlyContinue
$env:VITE_E2E='1'
$env:VITE_E2E_FULL_RENDER='1'
pnpm.cmd build
pnpm.cmd --filter @openzcad/web preview --host 127.0.0.1 --port 25349
# In a second shell, using the read-only supplied fixture location:
$env:VIDEO_PARITY_INPUT='<generated R1-rim fixture directory from round 2>'
$env:VIDEO_PARITY_ROUND2='1'
$env:VIDEO_PARITY_ROUND4='1'
$env:VIDEO_PARITY_CHROME='1'
$env:VIDEO_PARITY_OUT='artifacts/video-parity-phase3-round4/reproduce'
$env:VIDEO_PARITY_EXPECT_CORE='fdf4bfb484dee781cfb0a8ad614556f628391b1e18ebf54752a41115c3ef7301'
$env:VIDEO_PARITY_EXPECT_IO='39b00df6be2754447c165ca4ee17b044ec32fe1e4394a7dba7ea14f14c3e028c'
pnpm.cmd exec playwright test --config test/perf/video-parity-wiring.playwright.config.ts --grep 'history cumulative'
# W14 comparison only: VIDEO_PARITY_CONVEX_TARGET=1.9 and VIDEO_PARITY_EXPAND_A4=1.
# A2/A7 performance: unset ROUND4, set PROFILE=1 and use a fresh OUT.
# The complete environment names are VIDEO_PARITY_ROUND4 / VIDEO_PARITY_PROFILE.
pnpm.cmd exec playwright test --config test/perf/video-parity-wiring.playwright.config.ts --grep 'step (blend|cylinder) pointer'
node scripts/report-video-parity-round3.mjs artifacts/video-parity-phase3-round4 source-key-perf source-key-normal
```

For the axial comparison, run each committed package pair sequentially in the
same checkout. The old pair was extracted from immutable commit `58241a97`;
the new pair is the installed a4ca542 pin. Clear both overrides for the installed
pair. The opt-in probe changes no geometry operations:

```powershell
$env:AXIAL_REUSE_TIMINGS='1'
$env:REMUS_WASM_PKG='<read-only extracted old pair>/crates/wasm/pkg'
$env:REMUS_WASM_IO_PKG='<read-only extracted old pair>/crates/wasm-io/pkg'
pnpm.cmd exec vitest run test/axial-extent-reuse.test.ts --maxWorkers=1
$env:AXIAL_PROFILE_OUT='artifacts/axial-pin-compare/old-profile.json'
$env:AXIAL_PIN='58241a97'
pnpm.cmd exec vitest run test/perf/axial-pin-profile.test.ts --maxWorkers=1
# Repeat with both overrides unset and a fresh profile path / AXIAL_PIN=a4ca542.
```

## App changes and validation

- `packages/kernel-adapter/package.json:23`, `pnpm-lock.yaml` and
  `remus-checksums.json`: paired immutable main refresh and verified artifacts.
- `packages/kernel-adapter/src/exact.ts:3624`: defer unrelated planar proofs
  after a dimension edit, with a separate explicit-analysis cache entry.
- `exact.ts:3117` and `apps/web/src/worker/geometryWorker.ts:649`: speculative
  display refinement without journal commit or UI publication. The 150 ms timer
  is at `geometryWorker.ts:776`, with cancellation/source keys at `:1421`.
- `packages/kernel-adapter/src/exact-direct-edit-ops.ts:136`: immutable source
  face measurement reuse by exact digest. `display-tessellation.ts:18` changes
  only disposable pointer projection quality; normal display quality remains.
- `test/exact-dimension-proof-demand.test.ts` proves fresh foreground capability
  discovery without release-time proof calls. Prepared adapter tests compare
  canonical mesh bytes and volume against independent replay after refinement.
  Worker tests cover newer input cancelling queued warm-ups and regenerated
  candidate feature IDs. `test/perf/axial-pin-profile.test.ts` reproduces the
  matched native-call comparison without changing model operations.

The pre-main-merge app qualification passes the full web suite (512 files /
5,592 tests), lint (18 existing warnings), TypeScript, the parity corpus (92
passed / one existing skip), 16 focused adapter tests, both raw cumulative
controls, and root builds including wasm verification and bundle budgets.
The strict and alternate matrix collectors pass preservation/Undo assertions;
their successful test exit is **not** a full geometry pass. Four final isolated
Chrome pointer/cancel/commit/Undo cases pass. Full root `pnpm test` still fails
in the known local Windows Vite collection path with
`TypeError: code.charCodeAt is not a function`; this is not reported as a green
full root-unit gate.

The earlier `strict-final` capture used the CAD source later committed as `4b2375e3` (its build
metadata names the prior head plus a dirty source tree). The corrected R1.9 and
final performance builds identify `4b2375e3`. Main merge `948312bd` adds hover
styles and the cloud document limit, with no CAD operation implementation
change. Subsequent qualification is recorded separately rather than rewriting
those historical timings.

PR #1279 carries the related pin-expectation and typed-policy fixes at
`50df06f22022d6d37fb3a890e3dfc9241d2bcbfd`: clear exact-only reblend copy,
preserved reproduction classification, no futile waypoint retries, closed valid
torus-band removal and retained axial oracles with longer functional timeouts.
It was pushed with all requested pre-push gates and privacy guard passing;
the owner subsequently merged it as `b911ea9d815f28c14e9962e7d61aa1e09af4162d`.
Its unit, validate, e2e and Cloudflare verify checks were successful when read.
Main was merged into #1276 as `d451b610`; both the diameter-fit message and the
new exact-only reblend message were retained when resolving the copy conflict.
No merge was performed by this session. Size budgets were not changed.

Final merged CAD source is `69842c0b5f24708bc6f35416ea48ba3432092258`.
The later report commit changes documentation only. On this frozen source:

- Full web suite: **512 files / 5,595 tests passed**
  (`artifacts/round4-merged-web.log`).
- Full lint passed with 18 existing warnings; TypeScript passed.
- Parity corpus: 92 passed / one existing skip. Focused proof/display/prepared
  adapter coverage: 27 tests in five files passed.
- Root build passed, including immutable paired wasm verification and bundle
  budgets (`artifacts/round4-69842-build.log`).
- Four isolated Chrome pointer/cancel/drag-release/Undo cases passed; the
  `post-main-perf` and `post-main-normal` runtime files identify this source
  and assert both fetched wasm hashes. Their timing variability is retained.
- The final merged-source one-body collector passes in 8.7 minutes, with all
  17 attempts recorded and Undo restoring the original fingerprint. This
  qualifies preservation, not the refused geometry operations.
- Roadmap fragments validate. Privacy guard verifies approved identities,
  commit/push hooks and the private denylist; no protection was bypassed.

The full root-unit local collection limitation above remains. These are local
checks, not a claim about hosted checks or production deployment. The PR stays
on hold, with auto-merge disabled.

## CI follow-up: preserve single-edge chamfer intent

Shard 4 on `db6665f7` exposes an app selection regression, not a slow native
commit: ordinary Chamfer expanded the rounded-box fixture's picked edge to
three edges. A distance of 2.1 is valid for the original edge but refused for
that run; the browser waited on disabled Apply until its 180-second deadline
on all three attempts. The same failure reproduces locally. CI evidence is
run `42417216140`, job `128537803398`; local reproduction is
`artifacts/round4-chamfer-repro.log`.

Ordinary **Chamfer** now retains the explicitly selected edges. A qualified
single bottom-edge pick additionally offers **Chamfer tangent chain**, which
selects its smooth run and uses the same `chamferV2` route. A6 still starts from
one geometric pick; choose that named action. This avoids silently changing
the geometry the ordinary command targets and preserves older-kernel behavior.
The earlier cumulative matrix records the old automatic action on its stated
source; its geometry and performance measurements are retained as historical
evidence, rather than relabelled as new captures.

The existing smoke regression is strengthened to verify three edges through
the chain action, cancel, then one edge through ordinary Chamfer. Its original
2.1-mm volume, STEP validity, cylinder census, Undo/Redo and reload assertions
are retained; the complete browser journey passes locally in 24.6 seconds.
Standalone A6 native-history and imported-STEP tests both pass with the named
action: seven selected edges, accepted 0.8-mm chamfer and preserved Undo.
Screenshots, runtime hashes and JSON are in
`artifacts/video-parity-phase3-round4/chain-choice/`; the single-edge journey's
screenshots and trace are under `single-edge-regression/` there. These are
functional reruns, not replacement performance captures.

Code: `apps/web/src/App.tsx:8730` exposes the qualified choice, and `:25317`
dispatches it separately. `selectionCallout.ts:317` names the action;
`SelectionRail.tsx:49` supplies its icon. Focused selection/rail/capability tests
pass (79 tests), the three chamfer adapter suites pass (seven tests), and
TypeScript and the root build pass. The complete web suite passes 512 files /
5,596 tests (`artifacts/round4-chain-web-full.log`); full lint passes with 18
existing warnings (`artifacts/round4-chain-lint.log`). Geometry, dependency pins,
timeouts and all original exported-volume assertions are unchanged.
