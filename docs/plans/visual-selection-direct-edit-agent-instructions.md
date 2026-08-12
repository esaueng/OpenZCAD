# Agent Instructions — Implement Visual Selection & Direct-Edit Interaction

You are implementing the visual selection / direct-edit interaction upgrade. The
authoritative plan is `docs/plans/visual-selection-direct-edit-plan.md` in this repo —
read it in full before writing any code. It contains the findings inventory (what already
exists and must NOT be rebuilt), the architecture decisions D1–D6, and the phase
definitions. This document tells you how to execute it: order, constraints, gates, and
the traps specific to this codebase.

## Repo, branch, PRs

- `esaueng/OpenZCAD` only. No brepkit changes — every phase runs on data already
  exported by the pinned `brepkit-wasm` package. If you believe you need a kernel
  change, stop and report instead of pushing to brepkit.
- One feature branch **per phase** (e.g. `claude/vsel-phase0-data-plumbing`), one PR per
  phase, normal ready-for-review PRs (never `--draft`). PRs in this repo merge fast:
  never push follow-up commits to a branch whose PR may already be merged — start a new
  branch on fresh `main` for each batch.
- Conventional-style descriptive commit messages, as in recent history.

## Execution order

**Phase 0 → 1 → 2 → 4 → 5 → 6 → 3 → 7.** Phase 3 (pick list) only depends on Phase 0's
labeling vocabulary and can be reordered if blocked. Do not start a phase until the
previous one's gate passes. Rebase each phase branch on `main` after the previous PR
merges.

## Ground rules (non-negotiable)

- **Do not rebuild what exists.** Phase 1's "already working" list in the plan (full-face
  hover via triangle ranges, depth cycling, drag rigs, chip/keypad, LivePreview,
  interaction machine) is verified fact with file:line references. Extend those seams.
- **Package boundaries are strict.** `@openzcad/viewport` never imports React and never
  touches document or kernel state — it renders and emits intent. Selection state stays
  in the app shell (`apps/web/src/App.tsx`). New payload fields go in
  `@openzcad/shared` (types) + `@openzcad/kernel-adapter` (producer). No viewport
  concepts in document-core or kernel-adapter.
- **Additive payload only.** `FaceGeometry.center` and every existing field are ADR-011
  witness inputs or consumers thereof — never change their semantics, units, or
  tolerances. New fields (`featureType:'blend'`, `blendRadius`, torus/cone params) are
  strictly additive and optional.
- **Units and tolerances:** compare floats through the existing tolerance helpers
  (`GEOMETRY_LINEAR_TOLERANCE` etc.), never `==`. All lengths are mm end to end.
- The app is **Z-up everywhere**. Never grep-replace up-vectors; any new camera/overlay
  math must respect the existing conventions in `packages/viewport/src/render/scene.ts`.
- New behavior that changes interaction defaults goes behind the existing
  `experiments.directManipulation` flag (`apps/web/src/lib/appSettings.ts:281-283`),
  matching how face/edge arming is gated in `App.tsx:6234-6312`. Pure rendering
  improvements to already-shipped states (Phase 1 shading) need no new flag.

## Per-phase notes and gates

Common gate for every phase: `npx vitest run` green, `pnpm build` green (watch the entry
chunk — see Traps), lint clean, plus the phase-specific checks below. Leave pre-existing
failures alone and list them in the PR description.

### Phase 0 — data plumbing
- Producer changes live in `packages/kernel-adapter/src/exact.ts`
  (`measureFaceGeometry` :3195, `measureOwnedFaceGeometry` :3462, `isBlendFace` :812).
  Types in `packages/shared/src/index.ts` (`FaceGeometry` :697).
- `boundaryEdgesOfFace` helper goes in `@openzcad/viewport` (pure function over
  `BodyTopology`), unit-tested against a bored boss fixture: exactly two circular rims
  for the bore wall.
- Required tests: blend classification positives (filleted box → cylinder blend;
  filleted cylinder rim → torus blend with `blendRadius === minor_radius`) and the
  negative (plain cylinder boss tangent to a wall must NOT get the edit affordance path —
  classification may say blend, but Phase 6 gates editing on the producing feature).
- **Gate: `npx vitest run` AND `pnpm test:parity-corpus`.** The corpus alone is not
  sufficient and vitest alone is not sufficient; payload-shape changes sit on the same
  seam as a kernel pin bump. Also run `test/topology-lineage-spike.test.ts` explicitly.

### Phase 1 — shaded selection + boundary rims
- Modify `SelectionManager` (`packages/viewport/src/selection/SelectionManager.ts`) and
  the app-side selected-face overlay (`ModelViewer.tsx:4998-5036`); both must move to the
  shaded tinted material. Keep `toneMapped:false`, polygonOffset, and the
  `VIEWPORT_RENDER_ORDER` slots exactly as they are.
- The overlay index slice already shares the body geometry's normals — if it does not in
  some path, copy normals, do not recompute them.
- Boundary rims render through a new tier in `BodyEdgeOverlay`
  (`packages/viewport/src/render/edgeOverlay.ts`); the new batch must set
  `raycast = () => undefined` like the hover/selected batches so picking stays
  single-sourced.
- Smooth-edge hover runs reuse `edgeRunFrom` (`packages/viewport/src/pick/edgeChain.ts`)
  — call it from the hover path only for smooth edges, and keep it off the rAF hot path
  (compute on candidate change, not per frame).
- Gate: screenshot pass on the QA part (plan Phase 7's boss+bore+fillet part) from two
  oblique angles showing planar vs cylindrical vs blend legibility; attach to the PR.

### Phase 2 — x-ray + analytic ghost
- Hidden-portion pass per plan D2 (`depthFunc: THREE.GreaterDepth`, `depthWrite:false`).
  Both passes are index-slice clones — share the position/normal buffers, never copy the
  full body geometry.
- Ghost cylinder per D3 from `FaceGeometry.axisStart/axisEnd/radius`; green/gray
  reference styling (it must not read as committable material or as selection cyan).
- Verify against sketch-mode receded solids (opacity 0.35): if the hidden pass
  misrenders through them, disable it while sketch mode is active — that fallback is
  pre-approved in the plan.
- Gate: Playwright probe asserting cyan-tinted pixels in a region where the bore wall is
  strictly behind the outer wall, plus a probe that the same region is NOT tinted when
  the top annulus is selected instead.

### Phase 4 — labels
- Chip formatting lives in `updateOffsetChip` (`ModelViewer.tsx:2551-2652`); keypad in
  `apps/web/src/components/NumericKeypad.tsx`. Ø/R is a display+entry mode; the commit
  path normalizes to radius internally — assert a round-trip test: type `Ø17.4`, commit,
  `FaceGeometry.diameter === 17.4`.
- `Total` label rides the `cylinderPrimitiveAncestry` retarget path (App.tsx:7298-7318).
- Dashed measurement line: generalize `createDimensionGraphic`
  (`packages/viewport/src/annotation/dimensionGraphic.ts`) for the offset rig; do not
  fork a second dimension-drawing implementation.

### Phase 5 — preview upgrades
- New `LivePreview` instance for planar offsets mirrors the edge preview wiring
  (App.tsx:7412-7425), 150 ms throttle from the viewport side (mirror
  `ModelViewer.tsx:3442-3446`), `continueAfterSlow:false`.
- Preview results publish through `previewDoc` only. **Never write preview or fixup
  state into the document** — any non-user rewrite of the document reads as `diverged`
  in storage. previewDoc → `setPreviewDoc(null)` on commit/cancel is the existing
  contract; keep it.
- Invalid-preview visuals render the machine's existing `validating`/`failed` phases
  (`apps/web/src/lib/interaction/machine.ts`) — add no new machine states.
- Cyan-in-preview re-resolution extends `renderedSelectedTopology`
  (App.tsx:2272-2331); follow its existing rung order (topologyId → hash → operation-
  specific analytic fallback).

### Phase 6 — fillet select-to-edit
- Arming: blend face + `reference.producingFeatureId` resolving to a
  `featureKind:'fillet'` feature. Commit through the feature radius param (same path as
  Inspector's `EdgeModifierForm` and `set_feature_dimension`), never a direct-edit op.
- **Reselection trap:** fillet faces re-hash on every radius change (closed-edge hashes
  embed 2πr). After preview/commit, re-resolve the selected face via
  `producingFeatureId` + blend classification — never by hash. Add a regression test
  that drags a fillet radius twice in a row without reselecting.
- New-blend-face preview tint: diff previewDoc topology vs base document face hash sets;
  faces only in the preview get the cyan tint. This diff runs on preview publish, not
  per frame.
- Removal: radius→0 / explicit action deletes the producing feature; imported-body
  fallback is `remove-face-feature` only where its planar-neighbor gate allows
  (exact.ts:5873-5885); otherwise hide the action.

### Phase 3 — pick list
- Build on `pickAll()`'s ordered dedup stack and `HudLayer`
  (`packages/viewport/src/scene/HudLayer.ts`), following the measure-preview-chip
  pattern (ModelViewer.tsx:1715, :2473-2502). Row hover drives
  `SelectionManager.applyHover`; the popup must not advance the click path's
  `depthCycle` state (the measure preview already shows how: use the stack, discard the
  cycle).
- Entity labels share one formatting helper with the measurement vocabulary — do not
  invent a second naming scheme.
- Keep depth cycling fully working; the list is additive.

### Phase 7 — acceptance suite
- One Playwright spec covering the plan's 10 checks; seed the boss+bore+fillet document
  through the app's seeded-document path, not by clicking through modeling UI.
- Topology-payload asserts are the oracle (committed diameters, face/edge identity,
  selection state); screenshots are secondary evidence. Two oblique camera angles
  minimum for the visual checks.
- The suite must pass headless in CI; no timing-based waits — wait on app state.

## Traps (all have bitten before; do not rediscover them)

- **Entry chunk ceiling:** the eager bundle has ~400 bytes of slack. All new UI (pick
  list, chip modes) must land in lazy chunks. Run the production build in Phase 0 to
  learn the gate, and check it every phase — a rolldown mis-chunk fails the build.
- **StrictMode double-mount:** viewer "already installed" state kept in a `useRef` gets
  blanked by the dev double mount — keep any new install-once caches on SceneContext,
  matching the existing pattern.
- **Prop identity vs drag rigs:** the arming effects (`ModelViewer.tsx:5408-5548`) guard
  on `*DragActiveRef` so rigs never rebuild mid-drag; preserve that guard for any new
  rig or overlay effect, and beware new props with unstable identities re-triggering
  those effects.
- **HMR ghosts:** overlay groups added to the scene must be disposed in effect cleanup
  or they duplicate on hot reload.
- **Seam edges** are excluded from picking and wireframe (`displayRole:'seam'`); the
  boundary-rim tier and hover runs must filter them the same way.
- **Sphere faces are unpickable** (two hemispheres, identical hashes) — documented
  limitation; do not attempt to fix it in this work.
- **Never use `git stash`** in this repo's worktrees (shared refs/stash across
  worktrees); commit to the branch instead.
- Dev-server verification: the app 500s on every cloud save when local D1 is
  unmigrated — run migrations first or test with local-only documents; do not
  misread those 500s as your bug.

## Reporting

Per phase PR: what changed, what passed/failed (with output, not summaries), screenshots
for visual phases, deviations from the plan flagged prominently. Final report separates
working features / stubs / risks / next milestones.
