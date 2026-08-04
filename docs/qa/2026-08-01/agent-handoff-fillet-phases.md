# Agent instruction: complete the BrepKit fillet phases (1a → 1b → 2 → 3)

You are taking over a partially-completed, multi-phase effort to make fillets
work on boolean-result bodies in OpenZCAD. Execute the remaining phases of
`kernel-fillet-plan.md` (same directory) in order. This document is
self-contained: read it plus the two companion docs before writing code.

## Mission

On any boolean-result solid (canonical case: a plate 80 × 60 × 6 mm with
⌀4.5 holes), the BrepKit kernel currently fillets only one isolated straight
edge per feature. You will make the following work, in this order:

1. **Phase 1a** — multi-edge/corner fillets on holed prisms (quick win).
2. **Phase 1b** — vertex blends in the walking builder (durable fix, removes
   the prism-only restriction entirely).
3. **Phase 2** — fillet/chamfer on closed hole rims (concave rims on inner
   loops).
4. **Phase 3** — roll everything into OpenZCAD (pin bump, typed error
   messages, test flips).

Definition of done: on the plate model, a corner-pair fillet, a whole
top-perimeter fillet, a second fillet after an existing one, and a hole-rim
fillet all succeed as watertight exact B-rep solids; OpenZCAD shows correct
geometry and correct messages; all listed test suites pass.

## What is already done (do not redo)

- **Investigation** (`plate-second-fillet-investigation.md`): root cause
  traced engine-by-engine. Read it first.
- **Plan** (`kernel-fillet-plan.md`): the phase definitions you are
  executing. Read it second.
- **OpenZCAD adapter messages** (merged into PR
  esaueng/OpenZCAD#89): `edgeModifierFailureMessage` in
  `packages/kernel-adapter/src/exact.ts` diagnoses failure classes
  heuristically (closed rim / shared corner / touches blend / generic).
- **Phase 0** (esaueng/brepkit#35, branch `claude/typed-fillet-errors`):
  `try_fillet` returns typed errors instead of the silent input-handle
  no-op; `blend_ops::blend_failure_code` maps them to stable codes
  (`unsupported-vertex-blend`, `trimming-failure`, `radius-too-large`, …)
  which the wasm `fillet` binding prefixes onto `JsError` messages. CI green.
  **If #35 is merged, branch from main; if not, branch from
  `claude/typed-fillet-errors`** — Phases 1–2 touch the same test files.

## Repos, environment, and gotchas

- **Repos:** `esaueng/OpenZCAD` (app; pnpm workspace) and `esaueng/brepkit`
  (kernel; Rust workspace, wasm via wasm-bindgen). Both private — attach via
  `add_repo` (brepkit needs `access: "push"`). Clone brepkit to
  `/workspace/brepkit`.
- **OpenZCAD install trap:** `pnpm install` fails on the `brepkit-wasm`
  dependency (`github:esaueng/brepkit#main&path:/crates/wasm/pkg`) because
  codeload needs auth the proxy doesn't inject. Workaround: temporarily add
  to root `package.json`:
  `"pnpm": {"overrides": {"brepkit-wasm": "file:/workspace/brepkit/crates/wasm/pkg"}}`
  then `pnpm install --no-frozen-lockfile`. **Never commit that override or
  the resulting lockfile change** — `git checkout package.json pnpm-lock.yaml`
  before committing.
- **Rust:** rustup installs the pinned 1.96.0 toolchain automatically.
- **wasm build tooling** (for `cargo xtask wasm-build` in brepkit):
  `rustup target add wasm32-unknown-unknown`;
  `cargo install wasm-bindgen-cli --version 0.2.126 --locked`;
  `cargo install wasm-pack --locked`. wasm-pack's binaryen download bypasses
  the proxy CA and fails — download
  `binaryen-version_117-x86_64-linux.tar.gz` from the WebAssembly/binaryen
  GitHub releases with curl and copy `bin/wasm-opt` into `~/.cargo/bin/`.
- **brepkit conventions:** conventional commits (commitlint), layered crate
  boundaries enforced by `scripts/check-boundaries.sh` (the wasm crate may
  NOT depend on `brepkit-blend` directly — go through
  `brepkit_operations::blend_ops`, which re-exports `BlendError`). Before
  every push: `cargo fmt --all`,
  `cargo clippy --workspace --all-targets -- -D warnings`, targeted
  `cargo test`, `scripts/check-boundaries.sh`.
- **Committed wasm pkg:** `crates/wasm/pkg` is committed but refreshed by a
  separate `chore(wasm): refresh committed package … [skip ci]` flow. Do NOT
  commit your locally built pkg; `git checkout crates/wasm/pkg` after builds.
- **PR hygiene (both repos):** push with `git push -u origin <branch>`,
  always open a ready-for-review PR, subscribe to PR activity, drive CI to
  green, end every GitHub comment with the Claude Code attribution footer.
  OpenZCAD PR #89's remaining CI red is a **pre-existing** e2e failure
  (`test/e2e/viewport.spec.ts:607`, edge-pick grid scan) that reproduces on
  main — do not mistake it for your regression; it is triaged in a comment
  on #89.

## Verification harness (use at every phase)

- **Ground truth matrix:** `probe-plate-fillet.mjs` (this directory) drives
  the pinned kernel through every failing class. Run with
  `node docs/qa/2026-08-01/probe-plate-fillet.mjs` from the OpenZCAD root
  after (re)installing with the override. NOTE: it was written against the
  pre-Phase-0 no-op contract; once the local pkg carries #35, failures THROW
  (prefixed with the code) instead of returning the input handle — the
  probe prints both, but its final sequential-fillet loop calls `k.fillet`
  unguarded and needs a try/catch when you update it (do update it in
  Phase 3).
- **Native repro (faster inner loop):** write throwaway Rust tests in
  `crates/operations/tests/` building plate = `make_box` −
  `make_cylinder` via `boolean(Cut)`, then calling
  `blend_ops::fillet_v2`, `fillet::fillet_rolling_ball`, `fillet::fillet`
  directly to see each engine's error. (A prior throwaway,
  `diag_openzcad_plate.rs`, demonstrated the pattern; it was deleted —
  recreate as needed.)
- **OpenZCAD end-to-end:** `cargo xtask wasm-build`, reinstall with the
  override, then `pnpm vitest run test/exact-kernel-adapter.test.ts` (46+
  tests) and the probe. Also `pnpm lint && pnpm typecheck`.
- **Analytic volume checks:** plate−holes = 28418.66 mm³ (4 holes) /
  28635.6 mm³ (1 hole at (10,10)); one R2 fillet along an 80 mm top edge
  removes (1−π/4)·r²·L ≈ 68.9 mm³ (28349.75 with 4 holes — matches the
  user's screenshot). A hole-rim fillet of radius r on hole radius a removes
  a torus-corner volume: ΔV = π·(π/2 − ... ) — derive or verify numerically
  against OCCT via OpenZCAD's `OcctStepKernelAdapter` parity tests instead
  of hand-deriving.

## Phase 1a — planar fast path on holed caps (branch: e.g. `claude/holed-cap-corner-fillets`)

**Symptom to fix:** `fillet_v2`'s planar fast path
(`crates/operations/src/blend_ops.rs`, `planar_fillet_result`, which drives
the rolling-ball rebuild in `crates/blend/src/fillet_builder.rs`) closes
multi-edge corner patches on plain prisms but emits an **open shell** on
holed caps, so `try_fillet` falls to the walking builder, which fails fast
on multi-stripe vertices (`UnsupportedVertexBlend`).

**Where to look:** `fillet_builder.rs` ≈ line 971 — the comment "The cap's
holes survive the rebuild unchanged, which is only correct if …" marks the
cap-rebuild path that drops/mishandles inner loops. Diagnose by running the
native corner-pair repro and dumping which edges are free
(`validate_shell_closed` reports the free-edge index).

**Fix:** when rebuilding a trimmed cap wire, carry every inner loop that
does not intersect the blend setback region verbatim; split/retrim the ones
that do. Reject typed (`RadiusTooLarge`-class) when the setback would cross
an inner loop, rather than emitting an open shell.

**Acceptance:** native tests — on plate-with-hole(s): corner 80+60 pair R2/
R0.5 → valid closed solid; full top perimeter R2 → valid; radius that
grazes a hole → typed error, closed input preserved; existing
`try_fillet_openzcad_bracket_corners` and all current suites stay green.
Volume vs analytic within tessellation tolerance. Then wasm-build + OpenZCAD
adapter suite + probe: `corner` and `top perimeter` rows flip from
FAIL/THREW to OK.

## Phase 1b — vertex blends in the walking builder (branch: e.g. `claude/walking-vertex-blends`)

**Symptom to fix:** `BlendError::UnsupportedVertexBlend`
(`crates/blend/src/lib.rs` ≈ line 82): the corner solver computes exact
vertex-blend geometry (esaueng/brepkit#34 derives the corner ball from
face-plane tangency; see `corner.rs`, `spherical_triangle.rs`) but stripes
are not set back and corner faces share no boundary edges with them, so the
assembled shell can never close.

**Fix (in `crates/blend/`):**
1. At each multi-stripe vertex, trim every incident stripe back to its
   tangency circle on the corner ball (the stripe section at the
   ball-contact parameter, computable from the spine — `spine.rs`,
   `stripe.rs`, `section.rs`).
2. Emit the corner patch (`spherical_triangle.rs` for 3+ stripes, two-edge
   fill in `corner.rs` for 2) reusing the set-back boundary edges so
   stripe↔corner adjacency is topological.
3. Extend `trimmer.rs` so base faces around the vertex consume the corner
   patch's remaining boundary arcs when their wires are rewritten.
4. Remove the fail-fast; let `try_fillet`'s closed-shell gate arbitrate.

**Acceptance:** everything from 1a passes WITHOUT the planar fast path
(temporarily disable it in a test to prove the walking builder handles the
plate corner directly); sequential fillet-after-fillet on the plate: with
the first R2 fillet applied, a second fillet on each of the previously
failing straight edges succeeds or fails typed — target ≥ the plain-box
success set; the corner-patch quality regression in OpenZCAD
(`test/exact-kernel-adapter.test.ts`, "keeps all-edges box fillet corners
exact and seam-smooth") still passes with the new assembly.

## Phase 2 — closed hole rims (branch: e.g. `claude/concave-rim-blends`)

**Symptom to fix:** hole-rim fillet fails in all engines: v2
`TrimmingFailure` on the holed plane (`trimmer.rs` cannot retrim a face
whose blended rim is an inner loop), rolling-ball explicitly rejects closed
circular edges, v1 cannot compute. Standalone convex cylinder rims already
work via the analytic rim assembler (`crates/blend/src/analytic.rs` /
`analytic/`; see passing tests `fillet_cylinder_closed_rim_is_valid`,
`chamfer_cylinder_closed_rim_is_valid`).

**Fix:** generalize the analytic rim assembler to concave rims on inner
loops: replace the plane face's inner circle with the setback circle
(radius `r_hole + r_fillet`), set the bore wall back by `r_fillet` axially,
join with a quarter-torus band with curvature flipped versus the convex
case; same assembly for `chamfer_builder.rs` (cone band). Reject typed when
the grown setback circle would cross the face's outer wire or another inner
loop.

**Acceptance:** native — hole rim R0.5/R1/R2 on the plate → valid closed
solid with exactly one torus band face; chamfered rim → one cone band;
volume matches OCCT parity within 0.5 %; rim tangent to a nearby hole →
typed error. OpenZCAD — probe rim rows flip to OK; STEP export of the
rim-filleted plate reimports valid
(`adapter.exportStep` → `adapter.inspectStep`).

## Phase 3 — rollout into OpenZCAD (branch on OpenZCAD: e.g. `claude/kernel-pin-fillet-phases`)

1. In brepkit: land the pkg refresh via the repo's `chore(wasm): refresh
   committed package` flow (or ask the maintainer if it's automated), then
   bump OpenZCAD's `package.json` pin
   (`github:esaueng/brepkit#<merged-commit>`) and refresh `pnpm-lock.yaml`.
   (The lockfile pins by commit hash — mirror how `e21f167` appears today.)
2. Replace the heuristics in `edgeModifierFailureMessage`
   (`packages/kernel-adapter/src/exact.ts`) with the typed codes: parse the
   `code:` prefix off the caught error message (`unsupported-vertex-blend`,
   `trimming-failure`, `radius-too-large`, …) and keep the topology
   heuristics only as fallback for uncoded errors. Only `radius-too-large`
   (and the generic fallback) should ever suggest a smaller radius.
3. Flip test expectations in `test/exact-kernel-adapter.test.ts`:
   - "names the real blocker when fillets fail on a boolean-result plate":
     corner and rim cases become SUCCESS assertions (volume-checked);
     keep typed-message assertions for whatever still legitimately fails.
   - "fillets an edge of an already-filleted body (sequential fillets)":
     tighten the success/failure bounds to the new capability.
   - Update `probe-plate-fillet.mjs` for the typed-error contract (guard the
     sequential loop with try/catch; expect OK rows).
4. Update `plate-second-fillet-investigation.md` status section and
   `kernel-fillet-plan.md` (mark phases done); note anything discovered.
5. Full OpenZCAD gate: `pnpm lint && pnpm typecheck && pnpm vitest run`
   plus `pnpm test:web`. Known pre-existing red: `viewport.spec.ts:607`
   e2e (see above) — unrelated unless your pin bump changes displayed edge
   topology, in which case investigate before dismissing.

## Parallel execution (multi-agent mode)

When run as an orchestrator with subagents, parallelize as follows:

- **Worker A — Phase 1a** (`fillet_builder.rs` cap rebuild, `blend_ops.rs`
  planar path) and **Worker B — Phase 2** (`analytic.rs` rim assembler,
  `chamfer_builder.rs`) start immediately in separate git worktrees on
  separate branches. Their primary files don't overlap; both may touch
  `trimmer.rs` and shared test files — the orchestrator resolves those at
  merge time.
- **Worker C — Phase 1b** (walking-builder vertex blends: `corner.rs`,
  `stripe.rs`, `spine.rs`, `walker.rs`, `trimmer.rs`) also starts
  immediately — it is the longest task and shares no code with 1a's cap
  rebuild. It rebases onto 1a when 1a lands.
- **Worker D — Phase 3 prep** (OpenZCAD side) starts immediately on the
  adapter: parse the `code:` prefix from kernel errors into
  `edgeModifierFailureMessage` (works already against Phase 0), draft the
  test/probe flips gated on capability detection. The pin bump itself waits
  for the kernel phases to merge.
- **Merge order is fixed: 1a → 1b → 2 → 3.** Each worker keeps its branch
  rebased on the latest landed state; the orchestrator owns conflict
  resolution in `trimmer.rs` and the shared test files, runs the full
  verification harness after every merge, and is the only one who pushes to
  the OpenZCAD pin.
- Workers must not touch each other's primary files; if a fix seems to
  require it, they report to the orchestrator instead of editing.
- Every worker follows the per-phase acceptance criteria above; the
  orchestrator additionally runs the cross-phase checks (sequential
  fillet-after-fillet, probe matrix, OCCT parity) before declaring a phase
  done.

## Working style

- One phase per PR, in order; each PR independently green and revertable.
  Small conventional commits in brepkit.
- The blend engines mutate the topology arena in place — preserve the
  snapshot/rollback discipline (`transactional`, `try_fillet`'s snapshot)
  in anything you add; every failure path must leave the input solid
  watertight and untouched (tests assert this).
- Prefer typed `BlendError` variants over new stringly errors; if you add a
  variant, add its code to `blend_failure_code` (codes are append-only API).
- When geometry decisions get ambiguous (e.g. corner patch topology for
  mixed convex/concave stripes at one vertex), stop and ask the user rather
  than guessing — that is design territory, not a bug fix.
- Keep a running log of measured results (volumes, face counts, which matrix
  rows flip) in your PR descriptions the way #35 and OpenZCAD #89 do.
