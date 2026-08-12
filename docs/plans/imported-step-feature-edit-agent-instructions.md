# Agent Instructions — Implement Imported STEP Feature Editing

You are implementing select-to-edit for features on imported STEP bodies. The
authoritative plan is `docs/plans/imported-step-feature-edit-plan.md` in this repo —
read it in full before writing any code. It contains the findings inventory (what
already exists and must NOT be rebuilt), the architecture decisions D1–D8, and the phase
definitions. This document tells you how to execute it: repos, order, constraints,
gates, and the traps specific to these codebases.

## Repos, branches, PRs

- **Two repos.** UI/schema/adapter phases (A, B, C, D, E) go to `esaueng/OpenZCAD`;
  kernel phases (K1, K2) go to `esaueng/brepkit`. Never mix repos in one PR. Work in
  local checkouts of both; do not assume two checkouts of a repo are in sync — check
  `git status`/`git log` first.
- One feature branch **per phase**, one PR per phase, normal ready-for-review PRs
  (never `--draft`; if one is accidentally a draft, `gh pr ready` immediately). PRs in
  these repos merge fast: never push follow-up commits to a branch whose PR may already
  be merged — start a new branch on fresh `main` for each batch.
- Conventional-style descriptive commit messages, as in recent history of each repo.
- **Never hand-edit the brepkit-wasm SHA in `pnpm-lock.yaml`.** The pin bump in Phase B
  goes through `.github/workflows/update-brepkit.yml` (lockfile-only diff). If the
  workflow can't be triggered, stop and report; do not simulate it by editing the
  lockfile.

## Execution order

**K1 → K2 → B → C → E, with D floating independently.** Phase A is complete on
OpenZCAD `main`. Do not start a phase until the previous one's gate passes and its PR is
merged. Phase C requires the Phase B pin bump to
be merged; feature-detect the new kernel bindings anyway so a stale kernel degrades to
today's read-only behavior instead of crashing.

## Ground rules (non-negotiable)

- **Do not rebuild what exists.** The plan's "already working" list is verified fact
  with file:line references — STEP import, blend classification/radius display, the
  entire vsel Phase 6 interaction stack (capabilities → machine → handle → chip →
  LivePreview → validate-then-commit), and the ADR-010 direct-edit pattern. Extend those
  seams. If a seam looks absent, re-read the plan's references before writing a new one.
- **Fail closed, everywhere.** No operation may produce approximate geometry or guess a
  parameter. Kernel ops refuse with typed reasons; adapter rebuild arms refuse when
  fingerprints mismatch; UI resolution returns null on ambiguity. A refusal shown to the
  user with a reason is success; a silently wrong solid is the worst possible outcome.
- **Additive payload only.** `FaceGeometry` fields are ADR-011 witness inputs or their
  consumers — never change existing semantics, units, or tolerances. All new fields are
  optional and additive. Schema changes normalize old documents forward unchanged
  (follow the ADR-010 v3 precedent).
- **Units and tolerances.** All lengths are mm end to end in the kernel and adapter
  (imported-step cache is mm; documents rescale). Compare floats through the existing
  tolerance helpers (`GEOMETRY_LINEAR_TOLERANCE`, `BLEND_TANGENCY_TOLERANCE`, kernel
  tolerance types) — never `==`, and never invent a new tolerance constant without
  calibrating against the parity corpus first.
- **Rust (brepkit):** typed error enums (`thiserror`), no `unwrap`/`expect`/`panic!` in
  production code, clippy pedantic clean. New public ops need doc comments in the house
  style (see `defeature`'s heal-or-refuse contract doc) and a stability-matrix row.
- **TypeScript boundaries:** `@openzcad/viewport` never imports React and never touches
  document/kernel state. Capability + commit logic stays in the app shell. Types in
  `@openzcad/shared`, producers in `@openzcad/kernel-adapter`.
- **Never write preview or fixup state into the document.** Preview results publish
  through `previewDoc` only; any non-user rewrite of the document reads as `diverged`
  in storage.
- The app is **Z-up everywhere**. Never grep-replace up-vectors.

## Per-phase notes and gates

Common OpenZCAD gate: `pnpm lint`, `pnpm typecheck`, `npx vitest run`, `pnpm test:web`,
`pnpm build` (watch the entry chunk) green; leave pre-existing failures alone and list
them in the PR description. Common brepkit gate: `cargo fmt --all -- --check`,
`cargo clippy --all-targets --all-features -- -D warnings`, `cargo test` green.

### Phase A — evolution-payload fillet attribution (OpenZCAD, complete)
- Landed through #305 and #307. Treat the current implementation and tests as the
  baseline; do not repeat this phase.
- Work in `packages/kernel-adapter/src/exact.ts` fillet/chamfer replay arm
  (`:5741-5822`) and the lineage modules (`brepkit-lineage.ts`, `topology-lineage.ts`).
  The wasm bindings `filletWithEvolution`/`chamferWithEvolution` already exist in the
  pinned package (`brepkit docs/wasm-face-evolution.md` describes the payload) — no
  kernel change, no pin bump.
- Evolution data is **candidate evidence** under ADR-013: every published reference
  still passes carrier-witness + uniqueness checks; mismatch → hash-only fallback, never
  an error. Keep `rederiveCylinderModifierLineage` as fallback; do not delete it.
- Required tests: fillet-on-box blend face gets `producingFeatureId` + the Edit Fillet
  affordance (extend `filletFaceEdit.test.ts` / `capabilities.test.ts`); duplicate-
  geometry uniqueness rejection falls back cleanly; the existing
  `test/e2e/visual-selection-fillet-edit.spec.ts` stays green unmodified.
- **Gate: common gate + `pnpm test:parity-corpus`** (lineage changes sit on the same
  seam as a pin bump) + that e2e spec.

### Phase K1 — `resize_blend` (brepkit)
- New module in `crates/operations` (sibling to `blend_ops.rs`/`push_pull.rs`). Reuse:
  `g1_chains`/`expand_g1_chain` for band walking, the analytic coverage matrix in
  `crates/blend/src/analytic.rs` as the inverse mapping (band surface ↔ support pair),
  the snapshot/rollback pattern from `crates/wasm/src/helpers.rs::try_fillet`
  (`restore_preserving_handle_slots`) so a refusal is a true no-op with valid handles.
- The op re-derives band membership, supports, and current radius from exact topology
  and compares against the caller's `expected_radius` through tolerance (plan D1). It
  must never trust caller-supplied classification.
- Validate with `validate_solid` before returning; a result carrying validation errors
  is a refusal (the `defeature` contract). Volume sanity check like
  `applyEdgeModifier`'s acceptance test.
- Stable refusal reason codes following `blend_failure_code`; every code needs a test
  that reaches it.
- **Fixtures:** commit real exporter STEP files under `crates/io/tests` fixtures. Ask
  Peter for the "Walking Stick Foot v3.step" file (session sandboxing may block
  `~/Downloads` — have him copy it into the repo) plus at least one other real-exporter
  part; also build parametric fixtures in-test (box fillet, cylinder rim fillet). Cover:
  grow, shrink, radius→0, radius-too-large refusal, band-touches-freeform refusal.
- WASM: `resizeBlend` binding + face-evolution payload for the produced band, following
  the existing `FaceEvolutionPayloadV1` versioning rules — extend, don't fork.
- Keep `crates/wasm/pkg` build artifacts out of commits.
- Gate: common brepkit gate; stability-matrix row; A/B the parity corpus in OpenZCAD
  against a locally built wasm before merging (expect the 3 known pre-existing
  boss-crossing-a-wall failures; anything else is yours).

### Phase K2 — hardening + `describeBlendBand` (brepkit)
- Broaden validated support pairs per plan; variable radius is out of scope — refuse it.
- `describeBlendBand(solid, face)` is read-only and must share the band-walk code with
  `resize_blend` (one implementation, two entry points), so the UI's "editable?" answer
  can never disagree with the op.
- Gate: common brepkit gate; refusal-path coverage assertion (every reason code hit).

### Phase B — pin bump + schema + adapter arm (OpenZCAD)
- Pin bump first, in its own commit via the updater workflow; full CI matrix including
  `pnpm test:parity-corpus` and `pnpm test:e2e` before anything else lands on top.
- Schema: mirror `resize-through-hole` end to end — `packages/shared` operation variant
  (plan D3 field list), `document-core` acceptance, `command-system` factory + replay
  dispatch. Unknown-kind commands must remain skipped-not-fatal.
- Adapter arm: resolve the deterministic face ordinal, re-measure, fail-closed checks on
  surface class / radius / center+axis (reuse `removeFaceFeature`'s tolerance choices,
  `exact.ts:6186-6268`), call `resizeBlend`, map kernel refusals to build warnings
  carrying the stable reason code.
- Required tests: replay determinism (build → serialize → rebuild ×2: identical
  topology counts + volume through the tolerance helper); fingerprint mismatch fails
  closed with the named error; radius→0; a non-mm document (units rescale seam,
  `exact.ts:5113-5122`).
- Gate: common gate + `pnpm test:parity-corpus`.

### Phase C — UI wiring (OpenZCAD)
- Capability seam: `apps/web/src/lib/interaction/capabilities.ts` — imported-body blend
  route arms the same `edit-fillet` interaction but commits through a new
  direct-edit path (`buildEdgeModifierCommand` area, `App.tsx:7988-8045`, gains a
  resize-blend branch); validation targets via `affectedFeatureTargets`.
- **Reselection trap (this has bitten before):** blend faces re-hash on every radius
  change (closed-edge hashes embed 2πr). Re-resolve after preview/commit per plan D5 —
  blend classification + surface class + frozen center distance + the new
  `directEditFeatureId` rung; return null on ties. Never resolve by hash. Regression
  test: drag an imported fillet twice without reselecting.
- Not-editable bands keep the read-only radius and show the reason text in the tool
  card (extend `machine.ts:503-512`); feature-detect `describeBlendBand` and fall back
  to today's read-only behavior when the binding is absent.
- Live preview: candidate document with the direct-edit feature through the existing
  `LivePreview` worker path; `previewDoc` only; the machine's `validating`/`failed`
  phases render kernel refusals — add no new machine states.
- Gate: common gate + screenshots of an imported-fixture edit from two oblique angles
  attached to the PR.

### Phase D — recognition display (OpenZCAD, floats)
- `recognizeImportedFeature` is complete and tested
  (`packages/kernel-adapter/src/imported-feature-recognition.ts`) — wire it, don't
  modify it. New worker RPC (the geometry worker currently speaks only sync/export —
  follow the existing message-type pattern in
  `apps/web/src/worker/geometryWorker.ts`); cache per (checksum, faceOrdinal).
- Inspector display only: recognized kind + dimensions, or the module's typed refusal
  reason. The sole editable path remains the existing through-hole resize. Do not add
  new edit commits in this phase.
- Gate: common gate; keep new UI out of the eager chunk.

### Phase E — acceptance suite (OpenZCAD)
- One Playwright spec per the plan's checklist. Seed via the import path with a
  committed fixture (reuse the K1 fixtures; keep them small — the embedded-source
  fallback caps at 12 MB, and fixtures should be a few hundred KB at most).
- Topology-payload asserts are the oracle; screenshots secondary. No timing waits —
  wait on app state. Follow the `openzcad:e2e-select-blend` hook pattern from the vsel
  Phase 6 spec for driving selection.
- Gate: suite green headless; full common gate.

## Traps (all have bitten before; do not rediscover them)

- **Entry chunk ceiling:** ~400 bytes of eager-bundle slack. All new UI lands in lazy
  chunks; `pnpm build` (with its bundle-size check) every phase — the filtered web
  build is NOT a substitute.
- **Parity corpus scope:** the `.step` fixtures on disk understate coverage — most
  scenarios are generated. Judge kernel changes by running the corpus A/B against the
  new wasm build, not by grepping fixtures.
- **Rust toolchain PATH:** `rustup run` fails in this environment (no proxies in
  `~/.cargo/bin`); prepend the toolchain's bin directory instead.
- **Renaming parity specs:** files under `test/parity/**/*.spec.ts` are intentional;
  renaming to `*.test.ts` silently moves them into the root vitest pool.
- **StrictMode double-mount:** install-once viewer caches go on SceneContext, never in
  a bare `useRef`.
- **Prop identity vs drag rigs:** arming effects guard on `*DragActiveRef` so rigs
  never rebuild mid-drag; preserve that for any new rig/overlay effect.
- **HMR ghosts:** scene overlay groups must be disposed in effect cleanup.
- **`git stash` is forbidden** in OpenZCAD worktrees (shared stash refs); commit to the
  branch instead.
- **Dev-server 500s on cloud save** mean unmigrated local D1, not your bug — migrate or
  use local-only documents.
- **Closed-edge hashes embed 2πr** — the root of every fillet reselection bug. When in
  doubt, resolve by feature id + analytic identity, never hash.

## Reporting

Per phase PR: what changed, what passed/failed (with output, not summaries),
screenshots for visual phases, deviations from the plan flagged prominently —
especially any new dependency, schema change, or anything touching defaults, units,
tolerances, or file formats. Final report separates working features / stubs / risks /
next milestones.
