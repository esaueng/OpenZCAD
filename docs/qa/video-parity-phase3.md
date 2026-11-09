# Reference direct-edit workflow — Phase 3

This qualifies the supplied Gentle-Gecko native project and STEP part locally
against Remus **2026.1.125**, then wires the app paths the first baseline could
not reach. It is K10 evidence against the
[kernel robustness plan](../plans/kernel-robustness-plan-2026-11-05.md).
No Remus source, package bytes, dependency pin, or lockfile is changed.

Read the [before/after attempt ledger](video-parity-phase3-comparison.md) for
each native/STEP UI attempt, preview/commit latency, screenshot, cancel and Undo
result. The [full adapter and browser measurements](video-parity-phase3-measurements.md)
retain exact diagnostics, surface counts, approximation checks and raw controls.
The [original baseline](video-parity-baseline.md) remains the 124 comparison.
Evidence links address ignored local artifacts; fixture bytes and screenshots
are not published in Git.

## Kernel identity and scope

The paired override uses the supplied read-only PR #1582 package directories.
Both manifests report 2026.1.125. Browser HTTP response bodies, rather than
version labels alone, are checked against:

- Core SHA-256: `10849a4e68ba18b01c181cc42cc7fcd444175c54093645791ac1ab2641d422f3`.
- IO SHA-256: `edcaeff920f443eb80ece4239d290c63f76f0a4b76f4560a6dd2cab5b4fed07a`.

Build metadata reports Remus checkout HEAD
`234625d33bae31266fc7d0c5f6152392b8ddb78f`, **dirty: true**. The supplied
binary hashes identify this qualification; it is not a claim that a clean build
of that Git commit produces these bytes. The package directories were read-only
throughout. The PR keeps the paired 124 pin
`58241a97109de3f9caf62d2c1d269cb90a7cf529` unchanged. Kernel-dependent UI
expansion is guarded by the build's package version, with unknown/older builds
retaining the previous native handle and single-edge behavior.

The pre-wiring run uses baseline scaffolding commit
`0c55c6b147e50388cde2767e044d3827ae6c510f`. The final app implementation is
`f91aeb8884007aed5375637ca62658c57a0f879b`; final wiring captures and the adapter
rerun identify that commit. Earlier post-wiring attempts identify the baseline
plus the app patch; their asset lists distinguish build iterations. The full
matrix was collected, then affected routes and the transient R3.7 entry failure
were rechecked after the final app changes. Subsequent changes are reports and
probe improvements. This is local browser qualification
with the real app worker and renderer, offline API stubs, and a 1440×1000
viewport. It does not qualify cloud persistence, deployment, or desktop hosts.

The original fixture discrepancy still applies: W-Fillet has 15 faces, with
7 planes, 5 cylinders, 1 torus and 2 B-spline corner patches. Its boss has a sharp
R6 cap at Z36, with **no cap-rim fillet**. A0 separately reconstructs the saved
five-edge R4 recipe and probes an added R1 rim; A1–A8 use the supplied W-Fillet
part. A1 targets are 22, 61.2 and invalid −4; A2 targets are convex R1.5 and
concave R2. Results after rejected steps are surviving branches, not completion
of the entire reference sequence.

## Before/after assessment

“Pass” is bounded to the attempted geometry. Surface census and validation do
not prove analytic exactness of inherited B-spline corners. Latencies are
individual samples on a shared Windows host, including automation and polling;
the runs overlap other checks and establish no speedup claim. A convex preview
is timed until the requested radius appears in rendered topology. Cumulative
`previewMode` distinguishes a rendered target from a worker completion without
a changed target; the latter is an observation of the pipeline, not proof of a
requested frame being installed. The keypad's “Exact entry” phase alone says
nothing about whether preview ran. Apply/refusal is judged separately against
the app's existing persisted operation journal.

| Step / sub-attempt                       | 124 baseline              | 125 before app wiring             | 125 with app wiring                 | Remaining ownership                                                                                                                          |
| ---------------------------------------- | ------------------------- | --------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A0 saved R4 network; supplemental R1 rim | Partial                   | Partial                           | Partial                             | Kernel/fixture: 15-face saved network retains approximate corners; separate rim gives 16 faces.                                              |
| A1 shorten 36→22                         | Fail                      | Fail                              | Fail                                | Native replay loses an edge identity; direct kernel control refuses swept contact with the shoulder. PR #1581 is outside these packages.     |
| A1 lengthen 36→61.2                      | Partial                   | Partial                           | Partial                             | Works, retaining 15 faces; no fixture rim exists to qualify rim following.                                                                   |
| A1 invalid Total −4                      | Pass rejection            | Pass rejection                    | Pass rejection                      | Preserved geometry.                                                                                                                          |
| A2 convex X R4→1.5                       | Fail                      | Native UI fail; STEP/adapter pass | Pass                                | Native/imported Edit Fillet uses the new resize route; 15 faces.                                                                             |
| A2 convex Y R4→1.5                       | Fail                      | Adapter pass                      | Adapter pass                        | Opposite band is an adapter control, with a representative band-class screenshot.                                                            |
| A2 same convex handle R1.5→1.9           | Unavailable               | Append fails                      | Pass via replay                     | Re-edit the handle's own latest resize feature using its original pins. Kernel still cannot append a resize to this already resized network. |
| A2 concave X/Y R4→2                      | Fail                      | Fail                              | Fail, safe refusal                  | Kernel research gap: blend-group re-fillet cannot trim the concave configuration.                                                            |
| A3 sharp top/back R1                     | Pass isolated             | Pass isolated                     | Pass isolated                       | Cumulative results are reported separately below.                                                                                            |
| A4 free-end R1.5                         | Pass isolated             | Pass isolated                     | Pass isolated                       | 18 faces.                                                                                                                                    |
| A4 free-end R3.7                         | Partial                   | Partial                           | Partial                             | Approximate additional B-spline patch and deflection-sensitive volume remain.                                                                |
| A4 free-end chamfer 0.7 / 5              | Pass isolated             | Pass isolated                     | Pass isolated                       | 17 faces.                                                                                                                                    |
| A5 new fillet R−1 / 0                    | Partial; silent no-op     | Partial; silent no-op             | Pass rejection                      | Visible “Radius should be positive.”; Apply disabled; geometry preserved; valid input recovers.                                              |
| A6 single bottom pick, 0.8               | Partial; local edge only  | Partial; local edge only          | Pass                                | One pick expands the seven-edge mixed tangent run, yielding 20 faces.                                                                        |
| A6 explicit seven-edge chain, 0.8        | Fail                      | Pass                              | Pass                                | New kernel builds the previously refused chain.                                                                                              |
| A7 Ø14.6 / Ø17 / Ø21.1 preview / Ø14.7   | Native partial; STEP fail | Partial; isolated edits pass      | Partial; isolated edits pass        | Full cumulative retention is a separate qualification.                                                                                       |
| A7 oversize Ø60                          | Partial rejection         | Typed direct refusal available    | STEP pass rejection; native partial | STEP shows a specific smaller-diameter message. Native source replay still reports changed/stale selection. Both preserve the body.          |
| A8 typed cancel / Undo                   | Pass exercised paths      | Pass exercised paths              | Pass exercised paths                | Fingerprints verify restoration, not merely dialog dismissal.                                                                                |
| A8 pointer drag / reversal / cancel      | Partial                   | Partial                           | Partial                             | Real pointer motion and cancellation measured; authoritative exact-frame latency remains unproved.                                           |

## Cumulative branch

Both native and STEP runs take the same surviving branch. Shortening to 22 is
refused and cancelled. Extending to 61.2, resizing the convex band to R1.5, and
adding the A3 R1 fillet succeed (15, 15, then 18 faces). The concave R2 edit is
refused. The subsequent A4 end chamfer at 0.7 fails with: “The modeling engine
could not join this chamfer to the existing fillet or chamfer. Smaller distances
were refused too.” Cancelling that candidate allows the A6 seven-edge bottom
chamfer to succeed, producing **25 faces** on this branch. A7 diameter 14.6 then
refuses the curved-support configuration. Every rejected/cancelled candidate
preserves the prior fingerprint, and Undo of all accepted operations restores
the original fingerprint in both modes.

This does not prove A7 retention of an accepted A4 end chamfer: that chamfer
never entered history. The complete reference sequence remains partial.
The STEP cumulative concave refusal appeared in status/journal without the
compact refusal card. This is an additional app presentation gap; the body and
history stayed unchanged. It does not affect the isolated typed oversize message.

## App changes and limits

- `App.tsx:24332` and `App.tsx:24538` validate non-positive **new** fillets before preview/commit, send
  a structured visible headline, and recover on the next valid size. Zero
  remains a valid removal value when editing an existing fillet.
- `interaction/filletFaceEdit.ts:226` permits measured native analytic bands on
  kernel 125 without inventing a native Fillet feature identity. Repeated edits
  revise only the selected inferred cylinder band's own latest resize
  (`filletFaceEdit.ts:23`, `App.tsx:24430`), retaining the original seed pins.
  A downstream feature or a construction-backed role prevents that revision;
  ordinary imported edits retain their existing three-feature history. Inferred kernel
  journals remain `unavailable` evolution; the adapter assigns its own measured
  semantic band role only when the output band is unique.
- `interaction/chamferChain.ts:8` and `App.tsx:25251` reuse the existing edge run selector. Automatic
  expansion requires a common downward planar support, so it covers this lower
  outline while top/end picks and explicit edge sets retain their behavior.
  It reads the displayed body's topology, including STEP geometry ahead of
  completed analysis. General propagation on arbitrary oriented supports is
  outside this change. The existing adapter cascade at
  `exact-edge-modifiers.ts:314` retains evolution through `chamferWithEvolution`;
  Remus `bindings/operations.rs:698` → `helpers.rs:577` reaches `chamfer_v2`
  for the mixed run. No parallel chamfer binding was introduced.
- The existing typed cylinder binding already calls the new Remus route before
  the conservative reblend fallback. A typed `cylinder-diameter-unbuildable`
  result is now final and keeps its classification through preview validation.
  The control says: “That diameter does not fit the existing supports and
  fillets. Try a smaller diameter.” Raw kernel detail is retained in the adapter ledger. Other refusal
  codes retain the legacy fallback. Relevant boundaries are
  `exact-direct-edit-ops.ts:2241`, `exact-direct-edit-refusal.ts:58`,
  `interaction/offsetPreview.ts:77`, and `App.tsx:4391`.

Edit Fillet, cylinder diameter entry, explicit chain selection, Fillet/Chamfer,
previews, cancellation and Undo exist. Remaining app limitations include native
source-replay identity failures and the limited automatic propagation scope.
There is no separately qualified general NURBS/freeform Offset Face radius edit.
The native/imported analytic-band path here is Edit Fillet.

Kernel failure pointers in the supplied Remus checkout include
`crates/operations/src/push_pull.rs:734` (swept nonadjacent contact),
`crates/operations/src/error_payloads.rs:265` (blend-group re-fillet refusal),
and `error_payloads.rs:277` (typed diameter refusal). OpenZCAD routes and guards
are in `App.tsx`, `interaction/filletFaceEdit.ts`, `interaction/offsetPreview.ts`,
`exact-direct-edit-ops.ts` and `exact-direct-edit-refusal.ts`.

| Remaining failure                                               | Classification                                                     | Boundary / evidence                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 shoulder shortening                                          | Kernel limit plus app/adapter replay identity gap                  | Remus `push_pull.rs:734`; OpenZCAD `cylinderPrimitiveAncestry.ts:574`, `App.tsx:25356`, `exact-reference-resolution.ts:213`. Native replay reports stale edge lineage; direct control independently refuses swept contact.                                                                  |
| A2 concave R2                                                   | Kernel limit                                                       | Isolated group refusal: Remus `blend_cluster/reblend.rs:252`; after convex resize, legacy contact guard at `resize_blend.rs:5270`.                                                                                                                                                          |
| Appending a second resize after this inferred group was resized | Kernel limit, bounded app route supplied                           | Remus curved-carrier limitation near `resize_blend.rs:3741`; [append versus replay control](../../artifacts/video-parity-phase3/post/sequential-blend.json). Replay works only for the latest owned inferred band.                                                                          |
| A4 R3.7 strict exactness                                        | Kernel approximation                                               | `exact-edge-modifiers.ts:457` exposes the advisory. Exported volume range remains 0.101379644 mm³ across the three deflections.                                                                                                                                                             |
| Cumulative A4 chamfer and A7 after bottom chamfer               | Kernel geometry-domain limits through the existing adapter cascade | A4 exact chamfer/join ladder (`exact-edge-modifiers.ts:314`); A7 typed cylinder boundary (`exact-direct-edit-refusal.ts:58`) and conservative curved-support fallback (`exact-direct-edit-ops.ts:2241`). Journal diagnostics and exact attempted history are in both cumulative JSON files. |
| Cumulative STEP refusal without compact card                    | App presentation gap                                               | `App.tsx:4919` routes a failure to status if the operation no longer owns the pick. The observed run records `refusalSurface: status-only`; it does not establish which ownership condition changed.                                                                                        |

No additional missing adapter/binding method was demonstrated for the four
requested paths. Unsupported geometry is retained as a refusal, not relabelled
as an absent tool.

## Verification

- New-kernel full baseline: 38 browser cases collected; one R3.7 re-entry driver
  timeout was rechecked successfully with the six affected cases (7/7 passed).
  “Passed” here means evidence collection completed, including intended refusals.
- Committed app: 10/10 wiring and existing native/imported history checks passed;
  all four corrected preview/cumulative probes also pass. Actual rendered convex
  preview samples range from 4.47 to 17.44 seconds in that shared-host two-worker
  run; Apply ranges from 3.48 to 10.91 seconds. These are measured waits, not an
  interactive-performance pass. The A6 single-pick samples are 2.03–2.16 seconds
  for preview and 1.63–5.17 seconds for Apply. Every sample is in the ledger.
- Adapter matrix: 40 attempts, 25 raw controls, A0 reconstruction and R1 rim,
  and eight native source edits. Repeated blend append versus replay has its
  own asserted geometry control.
- Both kernels: the same 20 named direct-edit regressions pass. Both paired
  corpus runs pass 92 cases with one existing skip. The pinned browser smoke
  passes all three invalid-radius/native/imported re-edit cases. A further
  imported-blend deselect/reselect check also passes on the preserved pin bundle.
- Full web suite: 512 files, 5,587 tests pass with `--maxWorkers=2`. The initial
  unbounded run had 10 failures; all six affected files pass separately
  (326 tests), and the complete bounded rerun is green.
- `pnpm lint`, final changed-file lint, and `pnpm typecheck` pass (11 existing
  App hook warnings). Complete root builds and bundle budgets pass with both
  the new overlay and unchanged installed pin.
- `pnpm test` cannot collect the root suite locally: Vite raises
  `TypeError: code.charCodeAt is not a function`. This reproduces the original
  baseline with the installed pin; named root tests, corpus and the separate
  full web project run. This is an unresolved local collector limitation,
  not a passing full root-unit gate or a demonstrated 125 incompatibility.

Logs and raw evidence are under `artifacts/video-parity-phase3/` and
`artifacts/phase3-*.log`. Initial timeouts/probe assumptions are retained in the
logs; the final ledger uses successful collection/rechecks and does not turn a
probe completion into a geometry pass.

## Reproduce the local override

Run from the repository root. Substitute the supplied read-only directories;
no dependency installation or package.json edit is needed in this worktree.

```powershell
$env:REMUS_WASM_PKG = '<PR1582 checkout>/crates/wasm/pkg'
$env:REMUS_WASM_IO_PKG = '<PR1582 checkout>/crates/wasm-io/pkg'
# Only if sandbox ownership prevents provenance inspection:
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = '<PR1582 checkout>'
$env:VIDEO_PARITY_INPUT = '<supplied read-only input directory>'
$env:VIDEO_PARITY_OUT = 'artifacts/video-parity-phase3/post'
$env:VIDEO_PARITY_EXPECT_CORE = '10849a4e68ba18b01c181cc42cc7fcd444175c54093645791ac1ab2641d422f3'
$env:VIDEO_PARITY_EXPECT_IO = 'edcaeff920f443eb80ece4239d290c63f76f0a4b76f4560a6dd2cab5b4fed07a'
$env:VITE_E2E = '1'
$env:VITE_E2E_FULL_RENDER = '1'
pnpm.cmd build
pnpm.cmd --filter @openzcad/web preview --host 127.0.0.1 --port 25349
# Second shell, with the same VIDEO_PARITY_* settings:
pnpm.cmd exec playwright test --config test/perf/video-parity.playwright.config.ts
pnpm.cmd exec playwright test --config test/perf/video-parity-wiring.playwright.config.ts
# Both Remus variables set in the adapter shell:
pnpm.cmd exec vitest run test/perf/video-parity-baseline.test.ts test/perf/video-parity-native-source.test.ts test/perf/video-parity-sequential.test.ts
node scripts/report-video-parity-baseline.mjs artifacts/video-parity-phase3/post docs/qa/video-parity-phase3-measurements.md video-parity-phase3.md
node scripts/report-video-parity-phase3.mjs
```

The second wiring bundle was built into `artifacts/phase3-final-web` and served
on loopback port 25350 to avoid replacing assets under a running baseline.
`VIDEO_PARITY_URL` selects that URL. Every browser context loads fresh assets;
the opt-in wiring tests enforce the exact response hashes above. Unset both
Remus variables and rebuild for the installed 124 comparison. The parity corpus
configuration now honors both overlay variables, avoiding a mixed core/IO pair.

After Remus is merged and OpenZCAD refreshes the paired dependency pin, rerun
the complete matrix and required gates on the refreshed PR head before merging.
This local overlay is not a released-kernel qualification.
