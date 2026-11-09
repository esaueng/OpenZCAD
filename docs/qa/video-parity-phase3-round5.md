# Video parity: Phase 3, round 5

Final qualification against `ACCEPTANCE_SPEC.md`: **not a complete video-parity
pass**. This document distinguishes the cumulative imported-STEP sequence from
the native-history control and from the isolated performance fixture. PR #1276
stays on hold; no merge or deployment is claimed.

## Executable identity and method

The QA branch was refreshed without rewriting its history, merging main
`50cf1ab9` in `6f61961f`. Main had already advanced past the requested package
refresh: its paired pin was `233ec6b0d0364293c5563a0f085f81b0f8f3cc19`
(2026.1.128). To test the requested kernel rather than silently substitute it,
this round used the existing paired local-package override against a clean
read-only sparse checkout of
`0c6729812c8be6189e0d2ab1bf2a00abb49d2aee` (2026.1.127).
The final refresh additionally merges main `380574b4` in `9764f6de`, including
its outline-performance fix. The manifest, lockfile and installed-package
checksum manifest therefore keep main's newer `087d6360` pin. The standalone
app-fix branch starts from `bc37f84a` and does not change that pin either.

The browser independently hashes the actual core and IO response bodies:

| Module | Browser SHA-256                                                    |
| ------ | ------------------------------------------------------------------ |
| Core   | `b58aa96b4b9652eb2df4f7da62f7a4ce243d386d16c0184846bf884283cb93ce` |
| IO     | `a31d2ff2ca424a9547257b5577e83d91a862ca018251dd68b3f3ef0e7c07bbe7` |

The complete STEP run imports the supplied 15-face `Gentle-Gecko-W-Fillet.step`,
then adds the R1 cap rim through the Fillet UI. It qualifies the loaded original
fillets and the new interactive rim, not recreation of the original fillets
from the unfilleted eight-face part. All subsequent attempts use one surviving
body: cap z61.2 then z26; convex R1.5; opposite **y=0 concave seam R2**; A3 R1
on the x=0/y=18 vertical edge; A4 free-end fillets and chamfers; A5; A6; A7; A8.
The adjacent x=0 concave seam is not substituted: upstream #1610 explicitly
expects that seam to refuse after the unequal convex edit.

Playwright drives production selection, pointer movement, keypad entry, Apply,
cancel and Undo. Selection helpers locate/project geometry but do not author
features or perform adapter edits. The A4 free-end chamfer uses an explicit
double-click five-edge chain; this is disclosed rather than credited as the
reference's automatic one-pick propagation. A6 automatically propagates one
bottom pick to the closed 12-edge outline at 0.8 mm. The UI serializes this as
an equal-distance chamfer; a separate diagnostic replay through chamferV2
produces the same source volume/face count and the same later A7 refusal.

A4 R1.5 is previewed/cancelled, R3.7 is committed then undone, and chamfer 5 is
refused before retaining chamfer 0.7. These are deliberate reversible attempts
on the same cumulative body, as in the reference. Diameter attempts remain on
the post-A6 body when refused; they are not represented as successful prefixes.

For each attempt a read-only replay checks the document captured at the worker
boundary: strict/detailed validity, one solid, analytic surface census and
volume at deflections 0.005/0.02/0.1. The actual UI mesh is checked for boundary,
non-manifold and winding edges. Health after refusal/cancel describes the
**preserved body**, not acceptance of a rejected candidate. The original fitted
corner patches remain disclosed, and the permitted A1 sampled cap rejoin adds
fitted patches; analytic planes/cylinders/tori are counted separately.

The final matrix and final profiles run the production app built at
`9764f6de`; subsequent evidence/scaffold commits do not change its app code.
The matching viewer WebGL render is the frame proxy, not physical scanout.
Cumulative pointer probes are cold single frames followed by cancel; Apply
release-to-canonical is measured separately. These are not warm drag medians.
Matched isolated A2/A7 probes below use actual pointer release. Main's newer
outline/AO rendering also differs from round 4, so cross-round deltas are not a
controlled estimate of kernel-only acceleration. Raw inputs, documents, meshes,
screenshots, traces and journals remain ignored local artifacts.

## Acceptance matrix

| Attempt        | UI outcome                                                                                                                                                                                                      | Health                               | Analytic census                                  |   Volume mm³ | Pointer → frame ms | Apply release → canonical ms | Screenshot                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------ | -----------: | -----------------: | ---------------------------: | ------------------------------------------------------------------------------------------------------------------- |
| A0-rim         | Pass: Accepted                                                                                                                                                                                                  | closed / manifold / valid; ΔV=0.0e+0 | plane 7, cylinder 5, torus 2, bspline 2          | 16339.872377 |              817.3 |                        288.0 | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A0-rim-committed.png)        |
| A1-long        | Pass: Accepted                                                                                                                                                                                                  | closed / manifold / valid; ΔV=0.0e+0 | plane 7, cylinder 5, torus 2, bspline 2          | 19189.923511 |             1054.1 |                        836.1 | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A1-long-committed.png)       |
| A1-short       | Pass: Accepted                                                                                                                                                                                                  | closed / manifold / valid; ΔV=0.0e+0 | plane 7, cylinder 5, torus 3, bspline 4          | 15207.725299 |             1348.3 |                       1448.4 | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A1-short-committed.png)      |
| A2-convex      | Pass: Accepted                                                                                                                                                                                                  | closed / manifold / valid; ΔV=0.0e+0 | plane 7, cylinder 5, torus 4, bspline 4          | 15244.991783 |             3734.7 |                       4099.8 | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A2-convex-committed.png)     |
| A2-concave     | Pass: Accepted                                                                                                                                                                                                  | closed / manifold / valid; ΔV=0.0e+0 | plane 7, cylinder 5, torus 4, bspline 4          | 15216.711978 |             5356.1 |                       6215.3 | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A2-concave-committed.png)    |
| A3             | Pass: Accepted                                                                                                                                                                                                  | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 7, torus 4, bspline 5          | 15205.179396 |             1567.7 |                        304.6 | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A3-committed.png)            |
| A4-fillet-1.5  | Pass preview/cancel: no canonical commit at R1.5                                                                                                                                                                | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 7, torus 4, bspline 5          | 15205.179396 |             7239.3 |                            — | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A4-fillet-1.5.png)           |
| A4-fillet-3.7  | Pass: Accepted                                                                                                                                                                                                  | closed / manifold / valid; ΔV=0.0e+0 | cylinder 10, plane 7, torus 5, bspline 6         | 15085.775463 |             6205.2 |                       2029.4 | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A4-fillet-3.7-committed.png) |
| A4-chamfer-5   | Refuse (kernel): Distance; mm; Not built; Distance too large; Solid unchanged; Try 0.625 mm; Why?                                                                                                               | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 7, torus 4, bspline 5          | 15205.179396 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A4-chamfer-5.png)            |
| A4-chamfer     | Pass: Accepted                                                                                                                                                                                                  | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 10, torus 4, bspline 5, cone 2 | 15189.713843 |              289.0 |                        183.9 | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A4-chamfer-committed.png)    |
| A5-negative    | Pass rejection: Rejected: Radius should be positive                                                                                                                                                             | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 10, torus 4, bspline 5, cone 2 | 15189.713843 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-A5-negative.png)                        |
| A6             | Pass: Accepted                                                                                                                                                                                                  | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 16, torus 4, bspline 5, cone 6 | 15155.197658 |              291.4 |                        169.2 | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A6-committed.png)            |
| A7-D14.6       | Fail: Refused: Diameter; mm; Not built; That diameter does not fit the existing supports and fillets. Try a smaller diameter.; Solid unchanged; Why?; Ø Diameter; R Radius                                      | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 16, torus 4, bspline 5, cone 6 | 15155.197658 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A7-D14.6.png)                |
| A7-D17         | Fail: Refused: Diameter; mm; Not built; That diameter does not fit the existing supports and fillets. Try a smaller diameter.; Solid unchanged; Why?; Ø Diameter; R Radius                                      | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 16, torus 4, bspline 5, cone 6 | 15155.197658 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A7-D17.png)                  |
| A7-D21.1       | Fail: Refused: Diameter; mm; Not built; That diameter does not fit the existing supports and fillets. Try a smaller diameter.; Solid unchanged; Why?; Ø Diameter; R Radius                                      | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 16, torus 4, bspline 5, cone 6 | 15155.197658 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A7-D21.1.png)                |
| A7-D14.7       | Fail: Refused: Diameter; mm; Not built; That diameter does not fit the existing supports and fillets. Try a smaller diameter.; Solid unchanged; Why?; Ø Diameter; R Radius                                      | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 16, torus 4, bspline 5, cone 6 | 15155.197658 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A7-D14.7.png)                |
| A7-D60         | Refuse safely; oversize-specific limit unqualified: Diameter; mm; Not built; That diameter does not fit the existing supports and fillets. Try a smaller diameter.; Solid unchanged; Why?; Ø Diameter; R Radius | closed / manifold / valid; ΔV=0.0e+0 | cylinder 7, plane 16, torus 4, bspline 5, cone 6 | 15155.197658 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A7-D60.png)                  |
| A8 cancel/Undo | Pass: Accepted                                                                                                                                                                                                  | closed / manifold / valid; ΔV=0.0e+0 | plane 7, cylinder 5, torus 1, bspline 2          | 16347.661490 |                  — |                            — | [PNG](../../artifacts/video-parity-phase3-round5/final-step-spec-order/step-cumulative-A8-undo.png)                 |

Undo to original: true; final health valid: true.

The table’s R1.5 health/census/volume qualify the preserved A3 body after cancel.
The raw candidate control independently validates the R1.5 result (volume
15180.980415792 mm³). The negative-radius and refused attempts have no accepted
pointer or canonical frame. Their numeric-entry settling times are:

| Attempt      | Entry → preview/refusal ms | Committed body unchanged |
| ------------ | -------------------------: | ------------------------ |
| A4-chamfer-5 |                     1572.4 | yes                      |
| A5-negative  |                          — | yes                      |
| A7-D14.6     |                     6504.6 | yes                      |
| A7-D17       |                     6592.9 | yes                      |
| A7-D21.1     |                     8184.2 | yes                      |
| A7-D14.7     |                     6525.9 | yes                      |
| A7-D60       |                     6791.4 | yes                      |

These are cold single-frame observations, not warm medians. The earlier
`fixed-step-spec-order` capture overlapped validation work and is excluded
from this final table. The final sequence and following profiles run
sequentially without task-owned CPU-heavy checks. A4 R1.5 has a visible fine
certificate cost; no latency target is claimed for the lowered-cap cumulative
sequence.

A3 carries the kernel warning: “This fillet is approximate: its blend surface
is a NURBS fit within modeling tolerance, not an exact fillet surface.” Its
seven planes, seven cylinders and four tori remain analytic; the new corner
patch raises the B-spline count from four to five. The build and health checks
pass, but the fitted patch is **not qualified as an exact fillet surface**.

## Native-history control and failure attribution

### Outcomes versus round 4

Round 4's strict matrix used regenerated native history and continued after
its failed convex edit. The final round-5 primary matrix uses the supplied
STEP and completes both A2 edits. These are workflow comparisons, not matched
performance experiments. Cold latency pairs below are pointer / Apply release
milliseconds; the isolated matched experiment is reported separately.

| Attempt                    | Round 4                                  | Round 5                                     | Cold pointer / Apply ms, R4 → R5 |
| -------------------------- | ---------------------------------------- | ------------------------------------------- | -------------------------------- |
| A0                         | Rim already loaded                       | R1 rim added in UI; original fillets loaded | — → 817 / 288                    |
| A1 lengthen                | Pass                                     | Pass                                        | 845 / 732 → 1054 / 836           |
| A1 shorten                 | Pass, sampled rejoin                     | Pass, sampled rejoin                        | 1562 / 652 → 1348 / 1448         |
| A2 convex R1.5             | Refused non-manifold reconstruction      | Pass                                        | 5468 / — → 3735 / 4100           |
| A2 concave R2              | Pass on surviving body                   | Pass after convex edit                      | 2156 / 6067 → 5356 / 6215        |
| A3 R1                      | Pass on surviving body                   | Pass after both A2 edits                    | 1680 / 147 → 1568 / 305          |
| A4 R1.5                    | Refused                                  | UI preview/cancel passes after app fix      | — → 7239 / —                     |
| A4 R3.7                    | Refused                                  | Commit and Undo pass                        | — → 6205 / 2029                  |
| A4 chamfer 5               | Accepted on different surviving geometry | Clean refusal on full chain                 | No comparable accepted frame     |
| A4 chamfer 0.7             | Pass                                     | Pass, explicit chain                        | 244 / 108 → 289 / 184            |
| A5 negative radius         | Clear rejection, preserved               | Clear rejection, preserved                  | No accepted frame                |
| A6 0.8                     | Pass                                     | Pass, one-pick closed outline               | 289 / 124 → 291 / 169            |
| A7 14.6 / 17 / 21.1 / 14.7 | Refused                                  | Refused on post-A6 body                     | No accepted frame                |
| A8 cancel / Undo           | Preserved / restored                     | Preserved / restored                        | See per-attempt captures         |

The original `.openzcad` history is tested separately at the same requested
values and correct y=0 concave seam. Convex R1.5 now commits after A1 shortening.
Concave R2 refuses with `plane/cylinder support contacts are not full closed
loops`. Both prepared and unprepared raw kernel controls reproduce the refusal;
preparation reports `blend-cluster-not-prepared`. The remaining steps are
attempted on the surviving native body and are not evidence of a complete
prefix. The STEP sequence is therefore the primary cumulative matrix, with
the native-history limitation retained as a kernel gap.

The post-A6 STEP body has 38 faces and volume about 15155.197658 mm³; the earlier
diagnostic replay measures 15155.197656794 mm³ (within 0.000002 mm³). Raw
`commitPreparedGroupEditJournaled` at diameter 14.6 also refuses with
`cylinder-diameter-unbuildable`: re-filleting the blend group fails while
rebuilding the two chamfers (trimming failure, then alternate orders including
an unsupported two-stripe vertex blend). Both legacy and V2 chamfer diagnostic
replays reproduce it with the same source volume and face count. No geometry
substitution, lowered canonical mesh quality or app bypass is used to claim
success. Later diameter refusals do not independently certify the intended
oversize limit after an otherwise successful diameter sequence.

Local raw controls:

- [Final captured A7 body](../../artifacts/video-parity-phase3-round5/final-a7-kernel-control.json)
- [Native concave](../../artifacts/video-parity-phase3-round5/concave-after-convex-kernel-control.json)
- [STEP A7, legacy chamfer](../../artifacts/video-parity-phase3-round5/step-a7-legacy-control.json)
- [STEP A7, V2 chamfer](../../artifacts/video-parity-phase3-round5/step-a7-v2-control.json)
- [A4 raw/adapter comparison](../../artifacts/video-parity-phase3-round5/step-a4-control.json)
- [A4 per-face envelope](../../artifacts/video-parity-phase3-round5/step-a4-face-bounds.json)

## App fix

The old A4 R1.5 envelope guard rejects a valid trimmed fillet because the
untrimmed spline control hull reaches x30.000261736 although a fine face mesh
reaches x29.999999999999993. Raw plain/detailed/evolution fillet calls all
produce a strictly valid, closed/manifold result with volume
15180.980415792 mm³, while the adapter previously returned null.

`fillet-envelope.ts` now certifies only faces whose sheet box exceeds the source
envelope, using a quarter of the existing linear tolerance as chord deflection
plus a conservative Float32 rounding margin. It restores temporary sheet
allocations. Missing bindings, a work limit or a genuinely out-of-bounds surface
still refuse. Existing envelope tolerance, volume-change and blend-band guards
remain. Whole-body very fine tessellation was rejected as an implementation:
the kernel's existing million-point face work limit is unchanged.

The fix is [PR #1309](https://github.com/esaueng/OpenZCAD/pull/1309), head
`bc814da599e005046768afd53c4d6cf98551a5d7`, held with auto-merge disabled.
Six regression cases cover acceptance, true expansion, a work-limit refusal,
resource restoration, volume duplication, absent bands and older bindings.
This change is delivered in its own held PR, and the same commit is carried on
the QA branch for the final UI rerun. Geometry generation and final display
quality are unchanged. The binding guard is in
`packages/kernel-adapter/src/exact-edge-modifiers.ts:384`, with the bounded
certificate in `packages/kernel-adapter/src/fillet-envelope.ts:9`.

## Matched latency comparison with round 4

Same isolated STEP+rim fixture as round 4: A2 actual drag to R1.9 and A7
actual drag to diameter 14.6. These successful commits do **not** qualify the
cumulative post-A6 body. Four warm frames follow one cold frame; each capture
is a single gesture, not a population estimate. No task-owned CPU-heavy checks
ran during the final captures. Both traced/untraced commits have matching
fingerprints, and cancel/Undo preserve their source fingerprints.

| Stage (ms)                      |      A2 R4 → R5 |      A2 delta |      A7 R4 → R5 |        A7 delta |
| ------------------------------- | --------------: | ------------: | --------------: | --------------: |
| Normal warm pointer → frame     |    82.6 → 172.2 | 89.6 (108.5%) |   190.6 → 198.2 |      7.6 (4.0%) |
| Traced warm pointer → frame     |   125.4 → 169.3 |  43.9 (35.0%) |   187.1 → 214.1 |    27.0 (14.4%) |
| Kernel prepared preview         |     43.3 → 57.7 |  14.3 (33.0%) |     74.3 → 76.7 |      2.3 (3.2%) |
| Kernel tessellation             |     29.3 → 40.3 |  10.9 (37.4%) |     47.2 → 49.5 |      2.3 (4.9%) |
| Main-thread scene install       |     32.9 → 32.4 |  -0.5 (-1.5%) |     17.3 → 35.9 |   18.6 (106.9%) |
| Render                          |       1.5 → 1.6 |    0.1 (3.3%) |       2.2 → 2.8 |     0.6 (27.9%) |
| Checkpoint restore              |       0.2 → 0.3 |   0.1 (66.7%) |       0.0 → 0.1 |    0.0 (100.0%) |
| Per-frame serialization         |       0.0 → 0.0 |           0.0 |       0.0 → 0.0 |             0.0 |
| Release → canonical frame       | 3535.1 → 3672.0 |  136.9 (3.9%) | 2545.1 → 2093.9 | -451.2 (-17.7%) |
| Kernel journaled commit         | 2290.4 → 2396.5 |  106.1 (4.6%) | 1487.1 → 1334.3 | -152.8 (-10.3%) |
| Canonical validation            |   807.9 → 748.6 | -59.3 (-7.3%) |       0.0 → 0.2 |             0.2 |
| Canonical capability proofs     |       0.0 → 0.0 |           0.0 |       0.0 → 0.0 |             0.0 |
| Canonical volume                |   160.9 → 163.5 |    2.6 (1.6%) |      7.7 → 26.0 |   18.3 (237.7%) |
| Final full-quality tessellation |     22.7 → 21.0 |  -1.7 (-7.5%) |     29.4 → 73.1 |   43.7 (148.6%) |

Medians of individual stages do not add exactly to the median whole frame.
The CDP trace supplies actual pointer-up → canonical render; the separate
poll-based Playwright completion measure includes polling delay. The 100 ms
pointer and 1.5 s canonical-frame targets remain unqualified wherever the
measurements exceed them. Main’s outline/AO changes and host variation limit
any claim that a delta comes from one kernel optimization.

[Raw summary](../../artifacts/video-parity-phase3-round5/summary.json);
[Chrome A2 trace](../../artifacts/video-parity-phase3-round5/final-perf/step-blend-chrome.json);
[Chrome A7 trace](../../artifacts/video-parity-phase3-round5/final-perf/step-cylinder-chrome.json).

## Remaining gaps

- **Kernel:** the actual cumulative post-A6 STEP body refuses all A7 requested
  diameters. Raw prepared commit reproduces the refusal; changing the app's
  chamfer binding route does not make it build.
- **Kernel:** native regenerated history cannot complete concave R2 after the
  lowered cap and convex R1.5, although the STEP form can.
- **Kernel quality:** A3 builds a new fitted corner and reports an approximate
  fillet warning. Its health passes and existing analytic supports remain
  analytic; exact qualification of that new patch remains open.
- **Kernel:** the full free-end chain chamfer at 5 mm refuses. It has a clear
  distance-too-large message and preserves the valid committed body; the
  requested geometry is still unavailable.
- **App:** A4 free-end automatic one-pick chain propagation is still absent;
  explicit chain selection is required. A6 one-pick closed-outline propagation
  is qualified separately.
- **Kernel performance:** isolated journaled commits still take 2396.5 ms for
  A2 and 1334.3 ms for A7. Preview/tessellation medians are 57.7/40.3 ms for A2
  and 76.7/49.5 ms for A7. The expected across-the-board 20–40% commit speedup
  is not observed on this matched fixture.
- **App performance:** canonical A2 validation requests cost 748.6 ms; scene
  installation costs about 32–36 ms per traced frame. Capability proofs and
  per-frame journal serialization are zero. End-to-end targets remain unmet;
  no validation bypass or geometry-changing workaround was introduced.
- **App test coverage:** A0's original fillets are supplied inputs, not rebuilt through
  the UI. No complete successful A7 preview-21.1/cancel sequence is claimed on
  the cumulative body. Cancel/Undo preservation is independently checked.

## Reproduce and validation

Use a clean read-only checkout of the requested Remus commit and the supplied
read-only input directory. From the repository root in PowerShell:

```powershell
$env:REMUS_WASM_PKG = '<remus-0c67298>/crates/wasm/pkg'
$env:REMUS_WASM_IO_PKG = '<remus-0c67298>/crates/wasm-io/pkg'
$env:VITE_E2E = '1'
$env:VITE_E2E_FULL_RENDER = '1'
pnpm build
# Serve apps/web/dist on 127.0.0.1:25349 using the existing preview command.
$env:VIDEO_PARITY_INPUT = '<supplied-video-parity-inputs>'
$env:VIDEO_PARITY_ROUND2 = '1'
$env:VIDEO_PARITY_ROUND5 = '1'
$env:VIDEO_PARITY_CHROME = '1'
$env:VIDEO_PARITY_EXPECT_CORE = 'b58aa96b4b9652eb2df4f7da62f7a4ce243d386d16c0184846bf884283cb93ce'
$env:VIDEO_PARITY_EXPECT_IO = 'a31d2ff2ca424a9547257b5577e83d91a862ca018251dd68b3f3ef0e7c07bbe7'
$env:VIDEO_PARITY_OUT = 'artifacts/video-parity-phase3-round5/final-step-spec-order'
pnpm exec playwright test --config test/perf/video-parity-wiring.playwright.config.ts --grep 'step cumulative'
# Replace the grep with 'history cumulative' for the native-history control.
```

For matched profiles use the same round-2 STEP+rim fixture as round 4, unset
`VIDEO_PARITY_ROUND5`, set `VIDEO_PARITY_PROFILE=1` for CDP/worker tracing and
run `--grep 'step (blend|cylinder) pointer'`; repeat without profiling. Do not
run CPU-heavy checks concurrently with those timing captures.

The standalone fix's exact head `bc814da5` has green hosted unit, quality,
validation, all six browser shards, validate/e2e aggregate checks, privacy and
Cloudflare verify. [CI run](https://github.com/esaueng/OpenZCAD/actions/runs/42593904809).
It is mergeable, has no unresolved review threads, retains `hold`, and has no
auto-merge request. No merge was performed.

Local validation:

| Check                                                          | Result                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| Envelope regression                                            | Red before fix (2 failed / 4 passed), green after (6 passed) |
| Related adapter/volume regressions                             | 5 files / 39 tests passed                                    |
| Full web unit suite                                            | 510 files / 5,584 tests passed                               |
| Parity corpus                                                  | 92 passed / 1 skipped                                        |
| Fix-branch lint                                                | 0 errors / 18 existing warnings                              |
| Fix-branch and QA scaffold typecheck                           | Passed before final upstream refresh                         |
| Production build / paired artifact verification / size budgets | Passed, including final refresh; no budget change            |
| Final cumulative UI and matched profiles                       | See the matrix and raw captures above                        |

After the final upstream refresh, focused lint for all changed adapter/test
sources and the complete root typecheck pass again. The final cumulative
collector passes in 9.1 minutes; the two traced and two normal matched-pointer
cases also pass. A passing collector means all attempts/preservation checks
were recorded, not that refused geometry passed acceptance. The QA PR's fresh
hosted run is reported separately from the fix PR's green run.

The required global post-install privacy-hook audit eventually completed:
283 repositories/worktrees audited, zero needing attention. The task checkouts'
local hook chaining/identity audits and pre-push privacy verifications pass.
No protection, size budget or hook was bypassed.
