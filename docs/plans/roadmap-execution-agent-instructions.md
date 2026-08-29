# Agent Instructions — Executing the Roadmaps

You are working through the 2026-08-29 roadmaps. The authoritative plans are
`docs/kernel-roadmap-remus.md` (kernel) and `docs/cad-feature-roadmap.md`
(product) in this repo — read the one your item comes from in full before
writing any code. This document tells you how to execute them: how to pick an
item, where each kind of work goes, the acceptance bar, and how to report so
the plans cannot rot.

## Repos, and where each kind of work goes

- `esaueng/OpenZCAD` — the app. All product-roadmap work and the app side of
  kernel-roadmap items (adapter adoption, worker changes, UI exposure).
  Follow `CLAUDE.md` and `AGENTS.md` at the repo root; run the full
  verification gate before any push.
- `esaueng/remus` — the kernel. All kernel-roadmap items marked "kernel".
  Read `/CLAUDE.md` and `docs/kernel-maturity/` at the remus root first and
  follow the doctrine exactly: layer boundaries
  (`scripts/check-boundaries.sh`), no unsafe/unwrap/panic, conventional
  commits, typed refusals, oracle-verified promotion, `approx_census` diffed
  on any boolean-adjacent change, capability-matrix/stability-matrix
  bookkeeping in the same PR, WASM binding + `executeBatch` companion +
  contract tests inside the same change.
- **Never mix kernel and app changes in one commit stream.** One PR per repo
  per item.
- **Kernel pin updates** reach OpenZCAD only through the manual
  `update-remus.yml` dispatch (lockfile-only diff, `automation/remus-*`
  branch). Never hand-edit the resolved SHA in `pnpm-lock.yaml`; CI's
  unannounced-kernel-bump guard will reject it. A kernel fix is not "done"
  for the product until a pin bump lands with the full CI matrix green,
  including `pnpm test:parity-corpus`.

## Picking an item

1. Check open PRs in the repo you'd touch (`list_pull_requests` / the PR
   list) so you don't collide with in-flight work. An item with an open PR is
   owned; pick another.
2. Pick **one bounded item** per session, in this priority order unless your
   operator says otherwise:
   - Kernel Track S items (S5 hygiene → S1 defects → S3 cancellation → S4
     infra → S2 measurement) before kernel capability items.
   - Product Phase 1 items (all kernel-independent) any time, in parallel
     with kernel work.
   - Capability items (kernel C1–C7, product Phases 2+) only when their
     stated dependency rows are green.
3. Prefer the smallest item that closes a measured gap over a large item you
   can only start. A finished S is worth more than a stranded L.
4. If an item turns out bigger than its roadmap estimate, stop, record what
   you learned as a disposition note (see Reporting), and either re-scope or
   pick another item. Do not silently widen the diff.

## Ground rules (both repos)

- **The verification gate is not optional.** OpenZCAD: `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, `pnpm test:parity-corpus`, `pnpm build`
  from the repo root, all green locally before push. Remus:
  `cargo test --workspace`, clippy `-D warnings`, `cargo fmt --check`,
  `./scripts/check-boundaries.sh`, wasm target build.
- **Never weaken a test, widen a tolerance, or add a silent fallback to turn
  a red case green.** A red pin you cannot fix stays red with a note.
- **Fail closed, typed, pinned.** Every new capability boundary gets a
  stable, user-explainable refusal and a both-sides test. No
  nearest-face/traversal-order rebinding for lineage, ever (ADR-013).
- **Additive schema only.** Any `ProjectDocument` change bumps
  `PROJECT_DOCUMENT_SCHEMA_VERSION` additively with normalization from every
  prior version, plus a replay test on an old-version fixture.
- **Oracles, not vibes.** Geometry assertions name their ground truth:
  closed-form volume/area, inclusion–exclusion, pinned counts. "Two numbers
  agree" is not an oracle when both come from the same integrator — the
  corpus docs explain why.
- **Merge gate (OpenZCAD):** no status check is *required* by GitHub here,
  so per `CLAUDE.md` you must read the check runs yourself — `validate`,
  the `e2e` aggregate, and `Cloudflare version / verify` green on the PR's
  actual head SHA, with a run confirmed to exist for that SHA. Never
  auto-merge; never dispatch `apple-silicon` or `Cloudflare version`
  manually; `pnpm deploy:beta` is never a validation step.
- Existing pins are law: the parity corpus (`test/parity/`), kernel-seam
  pins, and `corpus-pins.ts` fail on both unpinned divergence *and* repaired
  divergence — when your change fixes a pinned defect, retire the pin in the
  same PR, with the fix as evidence.

## Item playbooks

Concrete starter specs for the front of the queue. Each ends with its
acceptance bar. Items not listed here: derive the same structure from the
roadmap entry before coding, and put that derivation in your PR description.

### K-S5 — Doc and pin hygiene (OpenZCAD, S)

Fix the measured-stale claims:
1. `docs/capability-matrix.md` and `TODO.md` — remove/replace the "Remus
   mirror refuses dense blended/boolean bodies" claim; the tessellation fix
   made mirror volume reflection-equivariant
   (`test/modeling-operation-preflight.test.ts` asserts the opposite now).
   Keep the guard description accurate: it exists, and only a synthetic
   broken kernel can trip it.
2. `TODO.md` release-gates line about "connect the imported-feature proof
   query to live kernel face adjacency" — rewrite to the real remainder:
   exact straight-edge polygon loops on planar faces, planar-floor seed
   enumeration, and boss/pocket/taper coordinated commands.
3. `test/parity/corpus-pins.ts:79` area — the note claiming corner-chain
   fillet cases are "held failing" is stale (they flipped to positive pins);
   correct the comment only, not the pins.
4. `docs/capability-matrix.md` header — either refresh to schema v13 or add
   a dated "superseded by TODO.md + roadmaps" banner like the BrepKit-era
   docs carry.
Acceptance: docs-only diff; `pnpm test` and `pnpm test:parity-corpus` green
(pin-hygiene tests validate comment/pin consistency); every corrected claim
cites its evidence file inline.

### K-S1 — Silent-wrongness defect, one per session (remus, M each)

Pick ONE of the six defects in kernel-roadmap §S1. For each, the shape is:
1. **Reproduce in remus** from the OpenZCAD evidence: pattern overlap →
   `test/overlapping-pattern.test.ts:89` (spacings 3 and 0.5); pushPullFace
   top-cap → the sweep in `docs/kernel-execution-plan.md` §Z6 (r10 h30,
   negative offsets, 65 planar faces); T-vertex cut → same section
   (wall/r_out 0.018–0.088 band); operand drop → the tangent-boss case in
   `boolean-result-validation.ts` docs. Encode the repro as a versioned
   reproduction bundle (`remus_wasm::repro`) — expected *failures* are
   first-class there.
2. **Fix or refuse.** Exact result where the geometry admits one; otherwise
   a typed refusal naming the configuration. Never a silent wrong solid.
   Sweep the parameter band (ratio/scale), not one point — the execution
   plan records how single-point probes lied here twice.
3. **Bookkeeping:** census diff explained, capability-matrix cell moved,
   stability-ledger row updated, CHANGELOG entry.
4. **App follow-up (separate OpenZCAD PR, after pin bump):** flip the
   corresponding held-failing test to positive, retire the workaround it
   blocked (`tryExactCoaxialCylinderCut` / `tryExactAnalyticCylinderCapOffset`
   for their two defects), keep the old workaround test as a kernel
   regression.
Acceptance: the repro bundle fails on baseline and passes on the fix; both
sides of every declared boundary tested; no other census row moved
unexplained.

### P1-S1/S2 — Sketch dimensions and remaining constraints (OpenZCAD, L, splittable)

The solver already supports all 13 constraint kinds
(`packages/kernel-adapter/src/gcs-sketch.ts:232-370`; schema
`packages/shared/src/index.ts:485-509`). The UI exposes 6
(`apps/web/src/lib/sketch/constraints.ts:40-83`, `CONSTRAINT_TOOL_SPECS`).
Split into landable slices:
1. **Slice A — non-dimensional constraints** (perpendicular, equal,
   concentric, midpoint): add tool specs following the existing six exactly
   (icon, applicability predicate, command). No schema change.
2. **Slice B — driving dimensions** (distance, angle; radius already has a
   tool): placement gesture (pick entity/pair → place annotation), value
   editing through the existing `ExprInput`/numeric-keypad patterns, stored
   as the already-schema'd driving constraints. Dimension values accept
   expressions and bind to named parameters.
3. **Slice C — on-canvas rendering**: persistent dimension annotations
   reusing `packages/viewport/src/annotation/dimensionGraphic.ts` (today
   consumed only by drag rigs and the tape); driven-vs-driving visual state;
   hit-testing to reopen the editor.
4. **Slice D — solve feedback**: DOF badge from `gcsDof`,
   over/under-constrained tone, conflict list naming removable constraints
   (surface `gcsSolveDetailed` diagnostics truthfully — no rounding a
   failure into a warning).
Constraints that will bite: constraints attach to line/arc/circle only —
rectangles/polygons/text have no point identity (that is item S-4, a schema
decision; do NOT bolt it into these slices). Keep every mutation one
undoable transaction; keep Tweak-mode read paths working.
Acceptance per slice: unit tests through the command system (add constraint
→ solve → geometry moved as specified; conflicting set → typed diagnostic);
Playwright e2e for the placement gesture (Slice B: draw two lines, dimension
the angle, retype value, geometry updates, undo restores); `pnpm test` +
e2e shard green.

### P1-R1 — Datum planes/axes/points (OpenZCAD, design doc FIRST)

Write `docs/plans/datum-geometry-plan.md` before code: node kinds and
schema (document nodes, not features?), plane definitions
(offset/angled/mid-plane/three-point), axis and point sources, how
`SketchPlaneRef` gains a datum variant alongside `canonical|frame|face`,
lineage rules when a datum derives from topology (ADR-011/013 apply — a
datum on a deleted face fails closed), rendering/selection, and the ripple
list (forms, AI contracts, command validators). Get the plan reviewed via
its own PR before implementing.
Acceptance for the plan PR: covers every ripple site; names its schema bump;
states the fail-closed behavior for every derived-datum breakage case.

### P1-F1 — Extrude end conditions (OpenZCAD, M)

Add `endCondition` to extrude: `blind` (default, today's behavior) |
`through-all` | `to-face` (face reference) | `offset-from-face`. Implement
in the adapter as bounded booleans against the resolved target — no new
kernel API. `to-face` stores a v5 face reference resolved at history
position, failing closed like face sketches do. Form UI follows the
two-sided/`symmetric` precedent in `FeatureForms.tsx` (mutually exclusive
options validated in preflight, not just UI).
Acceptance: schema bump + normalization test; kernel-adapter tests with
closed-form volumes for each condition incl. a to-face target that moves
when upstream edits (re-resolve) and one that vanishes (typed refusal
naming the feature); byte-compat test that legacy extrudes replay unchanged.

### P1-A1 — Full mass properties (OpenZCAD, S)

`BodyMassProperties` already carries the inertia tensor and principal axes
(`packages/shared/src/index.ts:1412-1435`); the Inspector shows only
COM + principal moments. Render the full set with `tabular-nums`, add a
density input (per-body metadata, default 1) scaling mass-dependent rows,
and label provenance the way measurements do.
Acceptance: unit test on the formatting/scaling; no new kernel calls; CSS
class coverage check green (`node scripts/check-css-classes.mjs`).

### P1-AI1 — Close the AI vocabulary gap (OpenZCAD, M)

`CadPatchOperation` (`packages/ai-contracts/src/`) lacks: hole, split,
loft, sweep, helical-sweep, draft, thicken — all shipped features. Add one
op kind per feature following the `add_mirror`/`add_shell` pattern: strict
schema, exact preflight through the same command validators the manual UI
uses, digest binding for topology-referencing ops, and independent rollout
flags per the existing six-family precedent. Do not add imported-geometry
creation (explicitly disabled by policy).
Acceptance: contract tests per op (valid proposal applies as one
transaction; stale-digest and invalid-reference proposals are rejected with
the standard taxonomy); prompt/tool documentation updated in the same PR.

### P1-I1 — Mesh import formats (OpenZCAD, S–M)

The kernel reads 3MF/OBJ/glTF; the UI accepts `.shapr,.stl,.step,.stp`
(`TopBar.tsx:369`, `App.tsx:13541`). Route the three new extensions to the
existing `imported-mesh` path with the same 200k-triangle cap and
sew/unify repair, and the same import-limit errors surfaced as user
messages.
Acceptance: fixture import test per format asserting body count and volume
against the STL-equivalent fixture; oversized/malformed files produce the
typed refusal, not a hang.

## Definition of done — every item

1. The roadmap item's stated acceptance/exit signal is met, with tests.
2. Full verification gate green locally; PR opened (never draft), checks
   read from the actual head SHA before any merge decision.
3. Docs moved in the same PR: capability matrix / TODO.md rows the change
   affects, ADR amendment if a contract changed.
4. **Disposition line added to the roadmap doc itself** — the item's entry
   in `docs/kernel-roadmap-remus.md` or `docs/cad-feature-roadmap.md` gains
   a one-line `— done (PR #N)` / `— partial: <what remains>` /
   `— re-scoped: <why>` marker, the same maintenance rule the remus
   stabilization plan uses. A plan that cannot rot is the deliverable as
   much as the code.
5. Final report separates: shipped and verified / stubbed or flagged /
   risks found / recommended next item.

## What you must never do

Never merge on a passing check *suite* alone; never `gh pr merge --auto`;
never dispatch `apple-silicon` unless the maintainer asked; never run
`pnpm deploy:beta`; never hand-edit the kernel pin; never delete or bypass
the parity corpus, the distrust harness, or a workaround whose blocking
kernel defect is still open (Z6's history shows both `tryExact*` workarounds
are load-bearing until their S1 defects are fixed); never reinterpret
document units or persisted fingerprints; never ship a capability behind a
warning where the roadmap calls for a refusal.
