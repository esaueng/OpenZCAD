# Agent Instructions — Implement the Text Feature

You are implementing the text-on-3D-models feature. The authoritative plan is
`docs/plans/text-feature-plan.md` in this repo — read it in full before writing any code.
This document tells you how to execute that plan: order, constraints, acceptance criteria,
and verification.

## Repos and branches

- `esaueng/OpenZCAD` — the app; most of the work.
- `esaueng/brepkit` — the kernel; Phase 0 only. Read `/CLAUDE.md` at the brepkit root
  first and follow it (layer boundaries, no unwrap/panic, conventional commits,
  `scripts/check-boundaries.sh` before pushing).

Develop each repo's changes on its designated feature branch. Commit incrementally with
descriptive messages; push and open one PR per repo when a phase is green. Do not mix
kernel and app changes in one commit stream.

## Execution order

Work phases in this order: **0 and 1 in parallel if you can, else 0 → 1**, then
**2 → 3 → 4 → 5**. Each phase has acceptance criteria below; do not start the next phase
until the current one's criteria pass. If a phase is blocked, record why in the PR
description and move to any unblocked work.

## Phase 0 — brepkit (kernel)

1. Bind `polygon_union` / `polygon_boolean` (`crates/math/src/polygon_boolean.rs:108,122`)
   in `crates/wasm/src/bindings/polygon2d.rs` as `polygonUnion2d` / `polygonBoolean2d`
   (flat `[x0,y0,x1,y1,...]` coordinate arrays in and out; result encodes CCW outers +
   CW holes — pick a JSON or length-prefixed encoding consistent with existing bindings).
   Add `executeBatch` arms in `bindings/batch.rs`. Write contract tests via
   `execute_batch()` (direct method tests won't compile off-wasm — `JsError` cannot be
   constructed on non-wasm targets; see the repo's `wasm-bindings` skill).
2. Harden `addHolesToFace` (`crates/wasm/src/bindings/query.rs:1391`): validate hole
   wires are closed, coplanar with the face surface, and contained in the outer wire;
   return typed errors, never panic. Add regression tests that build a face with inner
   wires by hand and extrude it: (a) polygon annulus, (b) an 'O'-like contour whose loops
   mix line and bezier (NURBS) edges. Assert the solid is watertight, has the expected
   face count, and volume ≈ (outer − hole) area × depth.
3. Add `makeFaceFromWires(outerWire, innerWireHandles[])` to `bindings/shapes.rs`
   (validation shared with 2). Optionally add construction ops (`makeLineEdge`,
   `makeNurbsEdge`, `makeWire`, `makeFaceFromWires`) to `executeBatch` dispatch.

Verification gate: `cargo test --workspace`, `cargo clippy --all-targets -- -D warnings`,
`cargo fmt --all`, `./scripts/check-boundaries.sh`, and
`cargo build -p brepkit-wasm --target wasm32-unknown-unknown` all pass.

## Phase 1 — Font module (OpenZCAD)

Create `packages/geometry/src/text/` per the plan: opentype.js, bundled OFL fonts
(Regular/Bold/Italic/BoldItalic files per family — real files, no synthetic bold/italic),
registry, glyph→`TextProfileSet` pipeline (layout, contour extraction as line + bezier
segments, winding normalization to outer-CCW/hole-CW, containment-based hole assignment,
bbox-gated overlap union). Keep the module pure and deterministic; cache by
`(family, style, text, size)`.

Acceptance: unit tests cover a letter with a counter ('O', 'A'), a multi-glyph word,
nested counters, and an overlapping-glyph pair; golden tests snapshot the profile output
for at least two fonts. `pnpm test` (vitest) green.

## Phase 2 — Document model (OpenZCAD)

Add `objectKind: 'text'` and the `{ sourceEntityIds, all: true }` profile-reference mode
exactly as the plan describes. Touch every ripple site listed in the plan (shared,
region-profile, ai-contracts, command-system validator). Bump
`PROJECT_DOCUMENT_SCHEMA_VERSION` additively.

Acceptance: a unit test proves the critical property — create a text object, extrude via
an `all: true` reference, then change the string to a different length and re-resolve:
resolution must succeed and return the new region set. Also test that old documents
without text objects still normalize and replay.

## Phase 3 — Profile analysis + kernel adapter (OpenZCAD)

Implement the text fast path in `regions.ts`, the `'bezier'` curve kind in
`makeRegionFace` (`packages/kernel-adapter/src/exact.ts:3241`) via
`liftCurve2dToPlane(curveType=3)`, the `profilePoints` guard, `objectPolyline` display
sampling, and the post-boolean face-count census. Put the bezier path behind a feature
flag with a flatten-to-polyline fallback.

Constraints that will bite you if ignored:
- `makeWire` welds endpoints at 1e-7 — adjacent segments must share bit-identical
  endpoint doubles.
- Emit outer loops CCW and holes CW even though the kernel tolerates both.
- Arcs (if any reach the kernel path) must be subdivided to ≤90° pieces — see the
  existing comment in `makeRegionFace`.
- Do not send text objects through `buildSubCurves` — that is the O(n²) path the plan
  explicitly avoids.

Acceptance: worker-level test builds "TEXT" extruded 5mm — expect one solid per connected
letter group, watertight, correct hole topology in 'E'-free letters vs holed letters;
editing the string regenerates without a "Broken profile reference" error.

## Phase 4 — UI (OpenZCAD)

Text sketch tool (key T), Inspector create/edit form (font dropdown with in-font
previews, B/I toggles, size as `ExprInput`), placement gesture, live viewport outline,
Emboss/Engrave/Extrude convenience buttons as one `runTransaction`. Follow the existing
tool/form patterns named in the plan — do not invent new UI infrastructure.

Acceptance: Playwright e2e — create text on a box face, engrave 2mm, verify render;
reopen the text object, change size 5→12 and the string, verify the model updates and no
console errors; undo/redo works across the whole flow.

## Phase 5 — Perf + polish

Profile a 20-character string end-to-end; if a text edit takes >~1.5s to regenerate a
simple document, wire `executeBatch` (extrude × N + `fuseAll` with `unifyFaces: true`)
into the adapter. Finish remaining tests per the plan.

## Ground rules

- Read `AGENTS.md` (OpenZCAD) and `CLAUDE.md` (brepkit) and obey them where they don't
  conflict with these instructions; branch instructions here win over "commit on main".
- Never persist glyph outlines in the document — parameters only.
- Fail loudly: no silent fallbacks except the feature-flagged polyline path, which must
  log a warning when used.
- Report at the end: working features, stubs, risks, next milestones — separated.
