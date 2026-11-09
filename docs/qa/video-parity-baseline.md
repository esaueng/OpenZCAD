# Reference direct-edit workflow baseline — 6 November 2026

This is a local measurement of the supplied Gentle-Gecko fixtures against the
reference acceptance steps A0–A8. It changes no app feature or kernel code and
does not qualify a release. Roadmap owner: K10; supporting specification:
[kernel robustness](../plans/kernel-robustness-plan-2026-11-05.md).

The full attempt ledger, exact diagnostics, face/surface counts, timings,
screenshots, cancel/undo checks and geometry checks are in
[the generated measurements](video-parity-measurements.md). Raw evidence remains
under `artifacts/video-parity/` in this worktree. Fixture bytes, machine-specific
paths and screenshots are not committed.

Adapter rows link the matching UI attempt's screenshot. The extra opposite-side
A2 adapter probes use a representative selected face from the same band class;
they are not screenshots of the opposite face. A0 and its supplemental rim are
adapter reconstruction probes; the browser loads the supplied saved R4 result.

## Identity and override

App source: `45ecfcad0aa15ea6c4ca88cce6f5a9f741818e9f`.
The manifests and lockfile still pin paired Remus commit
`58241a97109de3f9caf62d2c1d269cb90a7cf529`. No dependency files were edited.
The existing Vite and Vitest local-package overlays were used:

```powershell
$env:REMUS_WASM_PKG = '<read-only Remus checkout>/crates/wasm/pkg'
$env:REMUS_WASM_IO_PKG = '<read-only Remus checkout>/crates/wasm-io/pkg'
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = '<read-only Remus checkout>'
```

The process-local Git exception allows `localRemusPackages` to inspect provenance
under the sandbox account; it does not edit that checkout or global Git config.
The packages are committed, clean, version `2026.1.124`, source
`f4b5d747cc20486cc7b587a68920a679bc4999df`. The actual browser HTTP responses
for both wasm assets were hashed and match the read-only package files:

- Core: `d53511bc1c9b6170e257cc057bd14bb2cc10521eeffaa7afc5d4fbfc3159168c`.
- Translator: `e20a740249fb3382b1100170e13ddabaed51b1cbe9af304797b92137f76e0df2`.

The installed pinned wasm files have **the same two SHA-256 hashes**. Kernel
manifest/glue/type files also match after CRLF normalization. The different Git
commit labels therefore do not identify different compiled kernels in these
inputs. The requested override was exercised, but there is no binary upgrade or
speedup to measure between this pin and these committed local packages.

`build-meta.json` independently records the same pair. The installed-artifact
checker in the root build checks the unchanged **installed pinned** binaries;
the browser response hashes prove that the **local overlay** actually ran.
These are separate checks. No stale-wasm inference is based on version text alone.

## Scope and fixture discrepancy

Both saved native history and imported STEP were tested. Every isolated A1–A7
attempt starts from the original W-Fillet fixture, avoiding conclusions that
depend on a preceding failed edit. Therefore this is not proof that the complete
cumulative video workflow works: A2 and A6 prevent that sequence today.

The supplied W-Fillet part has 15 faces: 7 planes, 5 cylinders (boss R6 and four
R4 bands), 1 torus, and 2 B-spline corner patches. Its boss cap is a full sharp
R6 circle at Z36. **There is no cap-rim fillet in this fixture.** A1 cannot prove
the reference video's rim-following behavior on it. The two convex R4 bands run
along X and Y on adjacent block sides; the two other R4 cylinders are concave
vertical seams. The block is 30 × 18 × 24 mm. A1 uses Total 22 (into the shoulder),
61.2 (+70%), and -4 (invalid), rather than copying the video's absolute heights.
A2 uses R1.5 convex and R2 concave.

A0 reconstructs the saved five-edge R4 recipe on the supplied unfilleted native
project. A supplementary R1 cap-rim probe is recorded separately; that variant
does not silently replace the required W-Fillet baseline.

The supplementary rim succeeds with 16 faces (7 planes, 5 cylinders, 2 tori,
2 B-splines). The native diameter sequence 12 → 14.6 → 17, preview 21.1, cancel
to 17, then commit 14.7 also passes on the original W-Fillet body. Three Undo
operations restore its original fingerprint. This sequence cannot include the
reference's failed A2 radius edits or A6 bottom-chain chamfer.

## Gap assessment

“Pass” below is bounded to the supplied geometry and attempted operation.
“Partial” means some behavior works but a stated requirement or evidence is
missing. Accepted candidates were also exported/reimported in a separate arena,
validated, measured at three deflections, and inspected for mesh closure. That
round trip uses Remus again; it is not an independent geometry implementation.

| Step / sub-attempt                 | Assessment              | Evidence-backed gap / owner                                                                                                                                                                                                                           |
| ---------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A0 saved R4 network                | Partial                 | Rebuilds the 15-face network; two corner surfaces are approximate B-splines. The supplied recipe omits the cap rim.                                                                                                                                   |
| A1 shorten 36→22                   | Fail                    | Native UI reports stale edge lineage during source-height replay; direct adapter/kernel offset independently refuses swept contact with the shoulder. App replay/binding gap plus kernel topology-change limit.                                       |
| A1 lengthen 36→61.2                | Partial                 | Changes the cap and wall, retains 15-face analytic census. No cap rim exists to prove it follows.                                                                                                                                                     |
| A1 invalid Total -4                | Pass for rejection      | Body remains unchanged; UI says “Not built / Can’t move this face here”.                                                                                                                                                                              |
| A2 convex X R4→1.5                 | Fail                    | Native face has no editable handle; imported band and raw `resizeBlend` refuse its NURBS end patch.                                                                                                                                                   |
| A2 convex Y R4→1.5                 | Fail                    | Same refusal on the second corner patch; adapter/raw evidence covers the opposite band.                                                                                                                                                               |
| A2 concave X R4→2                  | Fail                    | Native face has no editable handle; imported band and raw kernel refuse because plane/cylinder support contacts are not full closed loops.                                                                                                            |
| A2 concave Y R4→2                  | Fail                    | Same open-contact limitation on the other vertical seam.                                                                                                                                                                                              |
| A3 sharp top/back edge R1          | Pass in isolation       | 26 mm selected edge reaches an existing round; creates 18 faces including analytic cylinder/torus additions. Earlier A2 edits are unavailable, so cumulative-video parity is unproved.                                                                |
| A4 free-end R1.5                   | Pass in isolation       | 14 mm selected top/end edge; creates 18 faces, with no extra B-spline fallback.                                                                                                                                                                       |
| A4 free-end R3.7                   | Partial                 | Creates 18 faces but adds a B-spline patch and approximation warning. Exported volume changes by 0.101379644 mm^3 at deflection 0.001 versus 0.01/0.1; strict acceptance is unmet.                                                                    |
| A4 free-end chamfer 0.7            | Pass in isolation       | 17 faces; new bevel faces are planar, earlier analytic surfaces retained.                                                                                                                                                                             |
| A4 free-end chamfer 5              | Pass in isolation       | 17 faces; large bevel succeeds against the existing corner round.                                                                                                                                                                                     |
| A5 typed R-1                       | Partial                 | UI leaves the body unchanged but silently closes/no-ops without the required positive-radius error. Adapter says “Edge modifier size must be greater than zero.” Raw kernel says “invalid input: radius must be positive, got -1”. UI validation gap. |
| A6 single bottom edge, 0.8         | Partial                 | Chamfers only the selected straight edge (17 faces), not the mixed perimeter.                                                                                                                                                                         |
| A6 double-click tangent chain, 0.8 | Fail                    | UI selects 7 edges / 62.28 mm; complete chamfer is refused and body preserved. Kernel blend/trim limitation, not a missing chain-selection tool.                                                                                                      |
| A7 Ø14.6                           | Partial                 | Native source-radius replay succeeds and retains the R4 network; imported direct resize refuses an adjacent NURBS face. The retained bottom chain is unavailable.                                                                                     |
| A7 Ø17                             | Partial                 | Native replay succeeds after diameter 14.6; imported direct edit fails at the NURBS boundary.                                                                                                                                                         |
| A7 preview Ø21.1                   | Partial                 | Native source replay produces the large preview from diameter 17; cancel restores diameter 17. Imported direct edit is refused and preserves the original.                                                                                            |
| A7 Ø14.7                           | Partial                 | Native replay succeeds after diameter 17 in the sequential UI test; imported direct edit fails. The complete preceding reference sequence cannot be built.                                                                                            |
| A7 oversize Ø60                    | Partial                 | Native replay is safely rejected at a stale fillet reference; imported direct edit is rejected at unsupported NURBS adjacency. Both preserve the body; neither provides a geometric diameter-limit explanation.                                       |
| A8 typed preview/cancel and undo   | Pass on exercised paths | Per-attempt mesh/topology fingerprints verify restoration. UI refusal behavior and approximation limits remain as above.                                                                                                                              |
| A8 pointer drag/reversal/cancel    | Partial                 | Real pointer offsets +2,+5,-2,+3 were exercised and cancel restores geometry. Recorded pointer timings include label/read/screenshot work; authoritative exact-frame latency is not established by those numbers.                                     |

### Failure ownership and code pointers

- Native fillet edit handle: `apps/web/src/lib/interaction/filletFaceEdit.ts:86`
  requires unique verified evolution lineage. `apps/web/src/App.tsx:17844`
  chooses native history or the imported-only band fallback. These native
  blend faces have no matching evolution identity, so the handle is absent.
  The adapter supports `resize-blend` at
  `packages/kernel-adapter/src/exact-direct-edit-ops.ts:1933`; the four raw
  calls reproduce the kernel refusals after bypassing the UI gate.
- A1 source replay and A7 source-radius routing:
  `apps/web/src/lib/interaction/cylinderPrimitiveAncestry.ts:574` and
  `apps/web/src/App.tsx:23680`. A failed source replay is distinct from
  the local direct-edit fallback's domain. Selected cap offset requests on the
  adapter reach Remus; its nonadjacent-face sweep guard is at
  `crates/operations/src/push_pull.rs:734` in the read-only kernel checkout.
- A2 kernel open-contact refusal:
  `crates/operations/src/resize_blend.rs:5134`; curved-end limitation:
  `crates/operations/src/resize_blend.rs:4780` (read-only Remus checkout).
- A5 UI nonpositive-size early return:
  `apps/web/src/App.tsx:24506`. This preserves geometry but does not provide
  the requested error. Adapter guard:
  `packages/kernel-adapter/src/exact-feature-builders.ts:2416` (positive-size check).
- A6 chain selection exists at
  `apps/web/src/components/ModelViewer.tsx:11077` and
  `apps/web/src/App.tsx:18127`. The selected hashes are passed at
  `apps/web/src/App.tsx:24432`; there is no implicit whole-perimeter expansion
  in that commit path. Adapter diagnosis is in
  `packages/kernel-adapter/src/exact-edge-modifiers.ts:792`.
- A7 local resize calls the correct typed binding at
  `packages/kernel-adapter/src/exact-direct-edit-refusal.ts:58`. Its reblend
  fallback at `packages/kernel-adapter/src/exact-direct-edit-ops.ts:2238`
  requires every curved neighbor to be a proven band; freeform corner patches
  do not meet that proof. This is a kernel geometry-domain limit with a
  deliberately conservative adapter fallback, not a missing wasm method.

### App features and missing paths

Edit Fillet, cylinder diameter entry, explicit Fillet/Chamfer selection,
double-click chain selection, previews, cancel and undo **exist**. Neither
“no fillet-radius edit tool” nor “no tangent-chain chamfer UI” describes this app.
The missing paths demonstrated here are editable numeric handles for this native
blend network, automatic single-pick propagation around the mixed bottom outline,
and a visible rejection message for a typed negative new-fillet radius. No
separate general-purpose curved-face Offset Face radius tool was exercised;
analytic-band edits use Edit Fillet. Dragging across zero to switch automatically
between Fillet and Chamfer was not qualified by this probe.

## Reproduce

Use a clean local shell at this worktree's repository root. Substitute the
supplied read-only input directory and local Remus checkout above.

```powershell
pnpm.cmd install --frozen-lockfile
# Run the required git-privacy-guard audit --root . --fix after installation.
$env:VIDEO_PARITY_INPUT = '<supplied fixture directory>'
$env:VIDEO_PARITY_OUT = 'artifacts/video-parity'
$env:VITE_E2E = '1'
$env:VITE_E2E_FULL_RENDER = '1'
pnpm.cmd build
pnpm.cmd --filter @openzcad/web preview --host 127.0.0.1 --port 25349
# In a second shell, with the same fixture variables:
pnpm.cmd exec playwright test --config test/perf/video-parity.playwright.config.ts
# With both local kernel package variables set:
pnpm.cmd exec vitest run test/perf/video-parity-baseline.test.ts
node scripts/report-video-parity-baseline.mjs
```

To compare the installed pin, unset both `REMUS_WASM_*` variables and run the
adapter probe with `VIDEO_PARITY_OUT=artifacts/video-parity/pinned`. It does not
change the browser bundle; rebuilding is required for a pinned **UI** comparison.

The real app geometry worker and renderer run locally with full render quality.
The repo's `stubApi` supplies offline account/API responses. Cloud persistence,
deployment, macOS, and production are outside this baseline. The shared preview
was also opened, imported the native fixture, exercised cap entry/Apply/Undo,
and closed; bulk attempts use the explicitly requested repository Playwright
tooling. Network-captured wasm bytes and both screenshots/JSON remain local.

Broad adapter-suite collection failed at Vitest startup with
`TypeError: code.charCodeAt is not a function` on both latest and pinned
packages. Named integration suites avoid that collection failure. This is
reported as a tooling limit, not a demonstrated new-kernel incompatibility.
The complete build gate and 52 named adapter tests passed with the overlay.
Lint and typecheck pass. The parity corpus passes 92 tests with 1 skipped.
All 37 browser matrix cases complete their evidence checks; eight Apply/negative
entry cases were rechecked with an explicit authoritative-completion wait, and
the separate sequential diameter case passes. Harness success includes observed
modeling refusals and must not be read as acceptance of every CAD operation.
The source-replay and direct-edit fixture probes pass their collection and
source-preservation checks. The pinned control matches all 40 adapter attempt
verdicts and face/surface counts; both wasm binaries are identical as above.
The pinned fixture probe is a capability comparison; its timings are not a
matched performance benchmark. This host was shared with other work.
