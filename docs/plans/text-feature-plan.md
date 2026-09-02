# Text Feature Plan — Text on 3D Models (Emboss / Engrave)

> **Historical design record.** The text feature shipped: schema-backed
> sketch text, seven bundled font families, the `T` sketch-text tool, and
> emboss/engrave through the ordinary extrude and boolean flows. The kernel
> named below is the BrepKit-era one; ADR-020 replaced it with Remus. Current
> status lives in [cad-feature-roadmap.md](../cad-feature-roadmap.md) §1.

Status: shipped (see banner)
Repos involved: `esaueng/OpenZCAD` (app, most of the work), `esaueng/brepkit` (kernel, small hardening PRs)
Companion doc: `docs/plans/text-feature-agent-instructions.md` (hand-off prompt for an implementing agent)

## Goal

The user enters a text string, picks a font family, a style (regular / bold / italic /
bold-italic), and a size. This creates a **sketch** containing the text outlines. From that
sketch the existing extrude + boolean flows produce either raised text (extrude → fuse) or
engraved text (extrude → boolean subtract). Afterwards the user can select the text object
and change the string, font, style, or size, and the whole model regenerates.

## Summary of findings

- **The design maps cleanly onto the existing architecture.** Sketch profiles already
  support multiple closed loops with holes (`packages/geometry/src/regions.ts` — the
  counter in an "O" is free), one extrude feature can already own several disconnected
  solids (`packages/kernel-adapter/src/exact.ts` `buildRegionExtrude`), and "cut" already
  exists as extrude + `boolean{operation:'subtract'}`.
- **Text must be a new sketch object kind, not a feature kind.** One document node stores
  the parameters; glyph outlines are derived at rebuild time. Full-history replay then
  regenerates every downstream extrude/boolean automatically on any edit.
- **brepkit changes are not strictly required for an MVP, but three small kernel PRs are
  strongly recommended** (see Phase 0). The kernel already supports bezier (NURBS) edges,
  planar faces with holes, extrude-with-holes producing correct through-hole solids, and
  fuse/cut. The gaps are hardening and exposure, not capability.

## Architecture

```
User types "HELLO", picks font/style/size
        │
        ▼
Text sketch object   (one document node: {text, fontFamily, fontStyle, size, x, y, ...})
        │  opentype.js expands glyphs → closed contours (lines + quad/cubic beziers)
        ▼
Sketch profiles      (outer loop + hole loops per region — 'O' = outer + 1 hole)
        │  existing region-extrude pipeline
        ▼
Extrude feature      → text solids  →  fuse with body        (emboss)
                     → text solids  →  boolean subtract      (engrave)
        │
Edit text/size later → updateSketchObject → version bump → full replay → regenerate
```

## Key design decisions

### 1. Text = sketch object (`objectKind: 'text'`), glyphs = derived geometry

The document stores only `{ text, fontFamily, fontStyle, size, x, y, rotation?, align? }`.
`size` (and position fields) are `ParamValue`, so text size can be driven by a named
parameter expression like any other dimension. Editing is a one-field
`updateSketchObject` command; regeneration re-expands the glyphs. No outlines are ever
persisted.

Rejected alternative: a dedicated `featureKind: 'text'` that owns both outlines and sweep.
Cleaner regeneration semantics but does not compose with the sketch/profile-picking UI,
and `updateFeature` cannot change feature kinds later
(`packages/document-core/src/index.ts:1453`), so the shape must be right from day one.

### 2. Profile references: add an "all regions of entity X" mode (THE critical fix)

Extrude features store `SketchProfileReference` entries (fingerprint + area + sample
point + source entity ids) and resolution is **fail-closed**
(`packages/kernel-adapter/src/region-profile.ts:24`). Changing "HI" to "HELLO" changes
every fingerprint, area, and the region count — a naive implementation breaks the extrude
on exactly the edit this feature exists for.

Fix: a new reference variant meaning `{ sourceEntityIds: [textObjectId], all: true }`
that resolves to *every* profile whose source entities are a subset of the referenced
entity ids. The text object's `EntityId` is stable across edits, so the reference
survives any change to the string, font, style, or size. This is a small, surgical
change to `region-profile.ts` and must land before the UI ships.

### 3. Fonts: bundled OFL set, parsed with opentype.js in the browser

No font tooling exists in either repo today. Ship ~6–8 SIL-OFL families, each with real
Regular / Bold / Italic / BoldItalic files (suggested: Inter, Open Sans, Lora, Roboto
Slab, JetBrains Mono, Oswald, plus one script font such as Pacifico). Bold/italic are
separate font files, not synthetic transforms — that is how correct letterforms are
obtained. A small registry maps family + style → asset URL. The document stores only the
names, so regeneration is deterministic. User-uploaded fonts are out of scope for v1
(future: a `'font'` variant of `ProjectAssetRef`, `packages/shared/src/index.ts:643`).

### 4. Keep beziers exact; bypass the O(n²) region analyzer for text

Two findings argue against flattening glyphs into line segments and feeding them through
the normal sketch machinery:

- `packages/geometry/src/regions.ts` is quadratic in curve count in at least four places
  (`buildSubCurves` ~:780, collinear scan ~:443, self-intersection scan ~:469, endpoint
  degree ~:509) and runs on the UI thread *and* the worker on every edit. A word at
  reasonable fidelity is 1,500–3,000 segments → ~10⁷ pair tests per keystroke.
- brepkit handles glyph beziers natively: a quadratic/cubic bezier is a NURBS edge
  (`liftCurve2dToPlane` with `curveType=3`; params `[degree, n_cp, ...knots, ...xy,
  ...weights]`), the planarity check uses control points so bezier wires produce exact
  `Plane` faces, and extrude builds exact ruled NURBS side walls. Exact curves mean smooth
  text at any zoom and faithful STEP export.

Therefore text objects take a **dedicated fast path**: fonts already encode which contour
is an outer boundary vs. a counter (winding + containment under the nonzero fill rule),
so glyph expansion emits `SketchProfile`-shaped results directly, skipping the half-edge
arrangement. Accepted v1 limitation: text outlines do not participate in intersections
with other sketch geometry drawn over them.

A feature-flagged fallback flattens beziers to polylines through the existing line/arc
pipeline, so shipping is not blocked on kernel edge cases.

## Work plan

### Phase 0 — brepkit hardening (repo: `esaueng/brepkit`; small PRs, parallelizable with Phase 1)

1. **Expose `polygon_boolean` / `polygon_union` to wasm.**
   `crates/math/src/polygon_boolean.rs` (:108 `polygon_union`, :122 `polygon_boolean`) is
   implemented, 25-test-covered, robust to collinear overlap / T-junctions / corner
   touches, and returns CCW outers + CW holes — exactly the outer/inner wire structure
   needed. It has no wasm binding; only the convex-only Sutherland–Hodgman clipper is
   bound in `crates/wasm/src/bindings/polygon2d.rs`. Add `polygonUnion2d` /
   `polygonBoolean2d` bindings + `executeBatch` arms. This merges overlapping glyphs
   (script fonts, tight kerning) in 2D before any topology exists — far cheaper and more
   robust than fusing near-tangent 3D solids.
2. **Validate and test `addHolesToFace`** (`crates/wasm/src/bindings/query.rs:1391`).
   It is the only hole-attaching API, performs zero validation (closedness, coplanarity,
   containment, winding), and has no tests. Add checks + regression tests that extrude
   hand-built faces with inner wires (annulus; an 'O'-like glyph with bezier edges).
   `docs/production-readiness/stability-matrix.md:19` flags exactly this path as unproven.
3. **Add `makeFaceFromWires(outerWire, innerWires[])`** so a holed face is one call
   (today: `makePlanarFaceFromWire` then `addHolesToFace`), and — optional, perf —
   add the construction ops (`makeLineEdge`, `makeNurbsEdge`, `makeWire`,
   `makeFaceFromWires`, `liftCurve2dToPlane` is already batchable) to `executeBatch`
   (`crates/wasm/src/bindings/batch.rs`). Today a 20-character word costs ~1,000
   individual wasm boundary crossings because construction ops are not batchable.

### Phase 1 — Font module (repo: OpenZCAD, `packages/geometry/src/text/`)

- Add `opentype.js`; bundle the font files as static assets with a registry
  (family → style → URL); load + cache parsed fonts.
- Glyph pipeline: layout (advances + kerning) → contour extraction (lines + quadratic/
  cubic beziers) → winding normalization (outer CCW, holes CW) → containment-based hole
  assignment → overlap union for touching glyphs (flatten → `polygonUnion2d` → only
  triggered when adjacent glyph bounding boxes actually overlap; unioned regions fall back
  to polyline loops).
- Output: a `TextProfileSet` — per-region outer loop + hole loops, each loop a list of
  line/bezier segments in sketch-plane 2D coordinates. Pure and deterministic; cache
  keyed by `(family, style, text, size)`.

### Phase 2 — Document model + commands (OpenZCAD)

- `packages/shared/src/index.ts`: `SketchObjectKind` += `'text'` (:38); new
  `SketchObjectData` variant (:284) with the fields above.
- New profile-reference mode `{ sourceEntityIds: [textId], all: true }` in
  `SketchProfileReference` (:345) + resolution in
  `packages/kernel-adapter/src/region-profile.ts:46-91`.
- Ripple sites: `packages/ai-contracts/src/index.ts` (`sketchObjectSchema` :951, runtime
  validator :2153), `packages/command-system/src/index.ts` (`sketchObjects()` expression
  validator :779). No new document-core mutations needed — `addSketchObjects` /
  `updateSketchObject` already cover creation and editing.
- Persistence is forward-compatible (unknown kinds skipped in `replayCommands`,
  `normalizeDocument` is additive); bump `PROJECT_DOCUMENT_SCHEMA_VERSION` following the
  v5→v6 additive pattern.

### Phase 3 — Profile analysis + kernel adapter (OpenZCAD)

- Text fast path: in `computeSketchProfileAnalysis` /
  `computeSketchRegions` (`packages/geometry/src/regions.ts:1599`), text objects are
  expanded via the Phase 1 module into ready-made profiles and appended to the analysis
  result rather than entering `buildSubCurves`.
- `packages/kernel-adapter/src/exact.ts` `makeRegionFace` (:3241): extend `RegionLoop`
  curves with a `'bezier'` kind mapped to `liftCurve2dToPlane(curveType=3)` NURBS edges
  alongside the existing line/arc handling; then `makeWire` → `makePlanarFaceFromWire` →
  `addHolesToFace` (or `makeFaceFromWires` once Phase 0.3 lands) → `kernel.extrude`.
  Emit shared endpoints as bit-identical doubles — `makeWire` welds at 1e-7.
- Guard the legacy path: `profilePoints` (`exact.ts:1104`) must throw for `'text'`.
- `apps/web/src/lib/objectPolyline.ts`: coarse flattened polyline for viewport display.
- After fuse/cut, keep the existing distrust validation and add a face-count census —
  thin glyph stems are the sliver case where brepkit booleans can silently fall back to a
  faceted (all-planar, hundreds-of-faces) result; face count is the only reliable signal.

### Phase 4 — UI (OpenZCAD, `apps/web`)

- New sketch tool **Text (key T)**: `SketchToolId` (`src/lib/interaction/machine.ts:43`),
  `SketchToolRail.tsx` TOOLS entry, placement gesture in `ModelViewer.tsx`, commit via
  `handleSketchCommit` (`App.tsx:3612`).
- Inspector form: text input, font dropdown (each entry rendered in its own font as
  preview), Bold/Italic toggles, size as an `ExprInput` expression field, live outline
  preview in the viewport. Editing reopens the same form via `SketchEntityEditor.tsx`
  (FIELDS :21 + `nextData` :63) → `updateSketchObject` → automatic downstream
  regeneration. This is the "text is too small, bump it" flow — one field edit.
- Emboss/engrave convenience: the existing region-extrude + boolean-subtract flows
  already work; add **Emboss / Engrave / Just extrude** buttons when finishing a
  text-on-face sketch that create the extrude + boolean as one undoable transaction
  (`runTransaction`), since the manual path is three steps for the 90% case.

### Phase 5 — Tests, perf, polish

- Golden tests for glyph→profile output per bundled font (text module is pure —
  goldens are stable).
- Kernel regression (brepkit): extrude of hand-built holed faces (Phase 0.2).
- E2E (Playwright): create text → extrude → engrave into a box → edit string and size →
  assert regeneration and sensible volume changes.
- Perf guardrails: profile a 20-character string end-to-end; if rebuild latency is
  noticeable, wire brepkit's `executeBatch` into the adapter for the modeling phase
  (extrude × N + `fuseAll` with `unifyFaces: true` in one round trip). Cache glyph
  expansion by parameters.

## Build order

Phase 0 and Phase 1 are independent (different repos) and can run in parallel. Then
2 → 3 → 4 sequentially; Phase 4's tool UI can start early against mock profile data.

## Risks, ranked

1. **Profile-reference breakage on text edits** — solved by design decision 2; must be in
   from day one, with a regression test that edits a string under an existing extrude.
2. **Boolean sliver fallback on script fonts / touching letters** — mitigated by the 2D
   pre-union (Phase 0.1 + Phase 1) and the face-count census (Phase 3).
3. **Rebuild latency** — every edit replays full document history; mitigated by glyph
   caching, batching, and the fact that text expansion itself is cheap (the kernel calls
   are the cost).
4. **Weld tolerance** — `makeWire` welds endpoints at 1e-7; adjacent segments must share
   bit-identical endpoint doubles or wires won't close.
