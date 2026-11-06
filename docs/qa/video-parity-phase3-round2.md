# Video parity: Phase 3, round 2

This qualifies the combined local Remus package against the real application.
The released dependency pins remain unchanged. PR #1276 stays on hold and must
be reverified after the paired Remus refresh. The supplied CAD and Remus
checkout are read-only; generated fixtures, screenshots and raw journals stay
in ignored `artifacts/video-parity-phase3-round2/`.

## Identity and corrected scope

The package version is still `2026.1.125`; it cannot distinguish these builds.
The browser harness hashes the bytes of the actual wasm responses and asserts:

| Module | SHA-256                                                            |
| ------ | ------------------------------------------------------------------ |
| Core   | `6746f551bdb76a5953c85ae56c6d9ca8331fc692b019e6f0461311e4f8d4ba23` |
| IO     | `e4f40290debc91ab9734680316a130909ef6dc8202ba6fb4c28bcf26fc9ff250` |

Both match the supplied files. `history-runtime.json` and `step-runtime.json`
also retain build asset names and provenance. This local checkout reports a
dirty source tree; the measured package hashes, rather than that checkout's
commit or version alone, identify the executable kernel.

Round 2 adds the missing R1 cap rim before opening the native/STEP test parts
(16 faces instead of 15). A1 shortening is cap z26, strictly inside the
24–29 shoulder interval. A2 selects the convex band along x=0, and A3 selects
the x=0/y=18 vertical edge. Round 1 used z22, the other convex band, and a
different A3 edge. The [complete before/after ledger](video-parity-phase3-round2-measurements.md)
preserves those differences; timings are individual shared-host samples, not
a controlled performance comparison.

## Before/after assessment

“Pass rejection” means the invalid value is refused clearly and the committed
body remains unchanged. “Partial” identifies a quality or workflow limitation.
Successful collection of an expected refusal is not a geometry pass.

| Step / sub-attempt                   | Round 1                                                     | Round 2                                           | Evidence / remaining gap                                                                                                                                                                               |
| ------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A0 saved R4 network + R1 cap rim     | Partial; rim separate                                       | Partial; rim included throughout                  | 16 faces; original fitted corner surfaces remain approximate. `A0-rim.json`, adapter A0/R1 control.                                                                                                    |
| A1 lengthen to z61.2                 | Partial; rim absent                                         | Pass with rim                                     | 16 faces; cap and R1 rim follow the edit.                                                                                                                                                              |
| A1 shorten into shoulder             | Fail at z22                                                 | Pass at z26 with permitted sampled reconstruction | 19 faces. Diagnostics explicitly says “The upper rim was rebuilt with approximate corner surfaces.” [Quality screenshot](../../artifacts/video-parity-phase3-round2/A1-quality.png).                   |
| A1 invalid Total −4                  | Pass rejection                                              | Pass rejection                                    | Cancel restores the original fingerprint.                                                                                                                                                              |
| A2 convex R4→1.5→1.9                 | Pass through UI; slow full previews                         | Pass isolated; prepared drag frames               | Native and STEP retain the other R4 bands. Pointer and canonical commit checks are separate.                                                                                                           |
| A2 concave seams R4→2                | Fail, safe refusal                                          | Fail, safe refusal                                | Kernel: exact removal/reconstruction of this concave network remains unsupported.                                                                                                                      |
| A3 R1 into an earlier blend          | Pass on different edge                                      | Pass isolated on corrected vertical edge          | 19 faces; cumulative after A2 has a disclosed sampled turn and is assessed separately.                                                                                                                 |
| A4 free-end R1.5                     | Pass isolated                                               | Builds isolated                                   | Result counts, surface census and export/reimport volumes are in the ledger.                                                                                                                           |
| A4 free-end R3.7                     | Partial                                                     | Partial                                           | Approximate junction and deflection-sensitive volume remain kernel quality limitations.                                                                                                                |
| A4 free-end chamfer 0.7 / 5          | Pass isolated                                               | Pass isolated                                     | After A2/A3, use the existing double-click five-edge tangent chain; a single end edge is refused by both kernel APIs. Automatic propagation here remains an app UI gap.                                |
| A5 new fillet −1 / 0                 | Pass rejection after round-1 fix                            | Pass rejection                                    | Visible positive-radius error; Apply disabled; valid input recovers.                                                                                                                                   |
| A6 bottom chamfer 0.8                | Pass single-pick propagation                                | Pass single-pick propagation                      | One pick selects seven edges, producing 21 faces on the rim-equipped part.                                                                                                                             |
| A7 isolated Ø14.6 / 17 / 21.1 / 14.7 | Partial workflow; isolated builds                           | Isolated builds                                   | Native uses direct group resizing rather than primitive ancestry replay.                                                                                                                               |
| A7 oversize Ø60                      | STEP clear; native stale-selection message                  | Pass rejection for both                           | Clear smaller-diameter message; unchanged body.                                                                                                                                                        |
| A8 live preview, cancel and Undo     | Typed cancel/Undo passed; pointer frame evidence incomplete | Prepared frames measured separately               | See pointer table in the ledger; remaining end-to-end latency is an app performance gap.                                                                                                               |
| Full order including A1 shortening   | Stops / survives refusals                                   | Fail full workflow                                | A2 refuses the sampled A1 end surface. Subsequent rows are the surviving branch, not completion of the full sequence.                                                                                  |
| Finishing chain without A1           | A4 single edge refused                                      | Partial                                           | A2→A3→A4 (five edges) works. A6's current 12-edge closed run is refused. After cancelling A6, Ø14.6→17→21.1 preview/cancel→14.7 works and retains A4. This is not proof that both chamfers survive A7. |

## App changes

Implementation pointers: prepared lifecycle
`packages/kernel-adapter/src/exact-prepared-group-edit.ts:31`; construction
provenance `:78`; resize calls
`packages/kernel-adapter/src/exact-direct-edit-ops.ts:2005` and `:2188`;
source restoration `packages/kernel-adapter/src/exact.ts:4959`;
serialized release `apps/web/src/worker/geometryWorker.ts:627` and
`apps/web/src/hooks/useGeometryWorker.ts:1089`; native boss routing
`apps/web/src/App.tsx:23806`; symmetric lower-chain V2 routing `:24572`;
quality-aware circular cap routing `:25431`.

- `exact-prepared-group-edit.ts` retains one preparation per kernel/source and
  falls back when bindings are absent or preparation refuses. The first changed
  drag frame prepares; subsequent frames reuse it. History restores the source
  checkpoint before each frame. Canonical release uses the journaled commit;
  cancel restores the checkpoint and releases the handle.
- `exact.ts`, `exact-feature-builders.ts` and `exact-direct-edit-ops.ts` extend
  the existing face-move preview lifecycle to blend and cylinder group edits.
  Full acceptance, measurement and persistent lineage stay on commit. A unique
  measured resized band retains its display role without claiming construction
  lineage during a preview.
- A journal that reports construction origin also obtains its real V1
  construction relations on commit. This keeps ordinary imported-band identities
  identical on commit and fresh replay; inferred group journals stay inferred.
  `filletFaceEdit.ts` keeps source revision limited to inferred networks so
  ordinary single-band edits retain append history.
- `useGeometryWorker.ts` and `geometryWorker.ts` queue an explicit release
  behind in-flight geometry work. Cancelling an idle tool does not load wasm.
- `App.tsx` routes blended native bosses through the direct diameter edit and
  streams the new group frames. Older package versions retain their existing
  native paths. Negative moves of a shouldered cap with a rim use the local
  quality-aware move route; the kernel tries its exact route before sampled
  reconstruction, and the existing Diagnostics panel exposes its advisory.
  The qualified lower chain requests equal first/second distances explicitly,
  selecting `chamferV2` on the new kernel; the installed pin retains its path.
- `ModelViewer.tsx` traces actual blend/radius pointer inputs. Test-only pin
  coordinates use the shaft and the same travel scaling as the real drag.

## Remaining gaps and boundaries

| Finding                                                                     | Classification                                             | Code / evidence                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concave R4→2 reconstruction refused                                         | Kernel                                                     | `exact-direct-edit-ops.ts` resize-blend route; isolated adapter warnings and browser journal.                                                                                                                                                                                                                                     |
| Convex A2 after sampled A1 meets a NURBS end surface                        | Kernel                                                     | Exact message in both cumulative JSON files: curved-carrier sharp termination / curved wire recut is not implemented.                                                                                                                                                                                                             |
| Single-pick free-end A4 does not auto-expand its chain                      | App UI                                                     | `App.tsx` selection action and `interaction/chamferChain.ts` only automatically expand the qualified bottom support. Existing double-click selects the five-edge chain. `chamfer-route.json` compares single-edge refusals with successful chain calls.                                                                           |
| A6 after the propagated A4 chamfer refuses the generated 12-edge closed run | Kernel for this selection; app selection qualification gap | The adapter and both bare APIs refuse `trimming-failure: blend: trimming failure on face Id(15)`. The app has not demonstrated the exact G1 selection used by Remus's native regression; no missing binding is inferred from that difference. `finish-adapter.json` and both finishing-chain browser journals retain the attempt. |
| Kernel-only prepared calls are faster than displayed frames                 | App performance                                            | Real pointer → publish → installation → first presented WebGL frame, retained in the pointer JSON traces. No 20–35 ms browser claim is made.                                                                                                                                                                                      |
| Full cumulative chain                                                       | Kernel / app qualification boundary                        | Separate `cumulative` and `finish-chain` rows in the ledger preserve the precise history and refusals. A refused step is never silently skipped in a claimed pass.                                                                                                                                                                |

No new standalone missing binding was found for prepared group edits or the
quality-aware cap route. General chamfer propagation on arbitrary supports is
still absent; the qualified bottom-outline behavior is narrower.

Failure boundaries in this worktree: A2 goes through
`packages/kernel-adapter/src/exact-direct-edit-ops.ts:2030`, A6 V2 through
`packages/kernel-adapter/src/exact-edge-modifiers.ts:264`, and A7 journaled
resizing through `packages/kernel-adapter/src/exact-direct-edit-ops.ts:2210`.
Automatic chain scope is in `apps/web/src/App.tsx:25303` and
`apps/web/src/lib/interaction/chamferChain.ts:7`. After sampled A1, A7 reports
an unsupported adjacent NURBS move boundary in both inputs; that is a kernel
domain refusal, not the fixed imported-STEP conservative routing gap.

The R1 rim's reimport validation reports zero errors and a periodic-seam
warning. Display mesh closure and numerical volume checks are recorded
separately. R3.7's reimport volume changes from 16225.090240 to 16225.209255
mm³ across the tested deflections, so it remains Partial.

## Reproduce

Use the same worktree and branch as PR #1276. Substitute the supplied read-only
checkout and input locations; do not change manifests or install the packages.

```powershell
$env:REMUS_WASM_PKG = '<combined Remus checkout>/crates/wasm/pkg'
$env:REMUS_WASM_IO_PKG = '<combined Remus checkout>/crates/wasm-io/pkg'
# If required for local provenance inspection only:
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = '<combined Remus checkout>'
$env:VIDEO_PARITY_INPUT = '<supplied read-only fixture directory>'
$env:VIDEO_PARITY_OUT = 'artifacts/video-parity-phase3-round2'
pnpm.cmd exec vitest run test/perf/video-parity-round2-fixture.test.ts
$env:VIDEO_PARITY_INPUT = (Resolve-Path artifacts/video-parity-phase3-round2/input).Path
$env:VIDEO_PARITY_ROUND2 = '1'
$env:VIDEO_PARITY_EXPECT_CORE = '6746f551bdb76a5953c85ae56c6d9ca8331fc692b019e6f0461311e4f8d4ba23'
$env:VIDEO_PARITY_EXPECT_IO = 'e4f40290debc91ab9734680316a130909ef6dc8202ba6fb4c28bcf26fc9ff250'
$env:VITE_E2E = '1'
$env:VITE_E2E_FULL_RENDER = '1'
pnpm.cmd build
pnpm.cmd --filter @openzcad/web preview --host 127.0.0.1 --port 25349
# Second shell with the same VIDEO_PARITY_* settings:
$env:VIDEO_PARITY_OUT = 'artifacts/video-parity-phase3-round2/matrix'
pnpm.cmd exec playwright test --config test/perf/video-parity.playwright.config.ts
pnpm.cmd exec vitest run test/perf/video-parity-baseline.test.ts
$env:VIDEO_PARITY_OUT = 'artifacts/video-parity-phase3-round2/wiring'
pnpm.cmd exec playwright test --config test/perf/video-parity-wiring.playwright.config.ts
$env:VIDEO_PARITY_SKIP_A1 = '1'
pnpm.cmd exec playwright test --config test/perf/video-parity-wiring.playwright.config.ts --grep cumulative
Remove-Item Env:VIDEO_PARITY_SKIP_A1
$env:VIDEO_PARITY_OUT = 'artifacts/video-parity-phase3-round2'
pnpm.cmd exec vitest run test/perf/video-parity-prepared-groups.test.ts test/perf/video-parity-chamfer-route.test.ts
node scripts/report-video-parity-round2.mjs
```

The adapter matrix is an evidence collector with a 600-second aggregate limit.
Use `VIDEO_PARITY_CASE` and `VIDEO_PARITY_REPORT` for targeted rechecks without
overwriting the main ledger. The A6 ordering correction uses `A6` and
`adapter-A6.json`. Unset both Remus variables and rebuild for the unchanged
installed-pin comparison. Full root builds include wasm verification and bundle
budgets; filtered Vite builds alone do not establish that gate.

For all 25 raw controls without repeating the slow adapter/export matrix,
set `VIDEO_PARITY_RAW_ONLY=1`, `VIDEO_PARITY_REPORT=adapter-raw.json`, and
`VIDEO_PARITY_OUT=artifacts/video-parity-phase3-round2/matrix`, then rerun the
baseline Vitest probe. Clear the raw-only flag before adapter rechecks. The
oversize recheck uses `VIDEO_PARITY_CASE='A7 diameter 60'` and
`VIDEO_PARITY_REPORT=adapter-oversize.json`.

## Validation

- All 38 browser matrix collectors completed after camera/build-completion
  driver corrections. Final A1 and A6 route checks are retained separately.
- Four real-pointer cases pass (native/STEP × blend/boss), each checking
  actual measured geometry, cancel, release commit and Undo. Warm medians:
  blend 645.7 / 614.1 ms; boss 1090.7 / 1094.9 ms (native / STEP). The STEP
  boss includes a 5776.7 ms warm outlier. First frames take 1.84–3.07 seconds;
  release-to-canonical completion takes 4.99–7.84 seconds. No interactive
  performance parity is claimed.
- All 40 adapter attempts are covered by the main collector plus targeted
  A6/oversize completion; A0/rim and all 25 raw controls run separately. The
  original aggregate collector timed out at its final attempt, which remains
  visible in its log. Discard, mesh closure, surface census and three
  deflection-volume results are in the ledger.
- Both paired kernels pass the same 48 named direct-edit/history regressions
  and 92 parity cases (one existing skip). The combined kernel additionally
  passes eight prepared-lifecycle, metadata and construction/replay checks.
- The installed pin passes six native/imported/invalid-radius browser
  regressions. On the combined kernel, final native/STEP network re-edit and
  simple imported-band checks pass 3/3 after the construction-lineage repair.
- Worker/controller checks pass 95 tests. The full web suite passes 512 files
  and 5,588 tests with two workers. The initial full run's one affected history
  test failure was repaired and the whole suite rerun successfully.
- Root builds, wasm checks and bundle budgets pass with the combined pair and
  the installed pin. Lint and TypeScript checks pass; lint retains 18 existing
  hook warnings. Roadmap fragment validation passes.
- Full root `pnpm test` still fails during local Vite collection with
  `TypeError: code.charCodeAt is not a function`, matching the earlier pinned
  baseline. Named root tests, parity and the separate full web suite run;
  this is not a passing full root-unit gate.

No production deployment or merge is performed. Hosted CI is distinct from
these local checks. Reverify the held PR after the paired Remus refresh.
