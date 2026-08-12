# Visual Selection & Direct-Edit Interaction Plan

Status: planned, not started
Repos involved: `esaueng/OpenZCAD` only (all gaps close with data already in, or derivable from, the pinned brepkit-wasm; no kernel PRs required)
Spec: viewport must communicate exactly which B-Rep entity is selected — including internal
and occluded geometry — and support on-model direct editing with live dimension feedback.

## Summary of findings — what already exists vs. what is missing

The direct-manipulation work (PR #29 and successors) already delivers a large fraction of
the spec. The plan below is therefore mostly **gap-filling**, not greenfield.

**Already working (verify, don't rebuild):**

- Hover pre-highlights the **complete analytic face**, not the triangle under the cursor:
  `topologyCandidate` maps `hit.faceIndex` → the face's whole `triangleStart/triangleCount`
  range (`packages/viewport/src/pick/PickService.ts:389-397`), and `SelectionManager`'s
  hover film rebuilds its index buffer from that full range
  (`packages/viewport/src/selection/SelectionManager.ts:181-223`). Hover (0x8fc8ff @ 0.3)
  is already lighter than selection (0x4da3ff @ 0.5).
- A closed circular edge is **one** topological edge, so clicking it already highlights the
  full loop; tangent-continuous runs come from double-click edge chains
  (`packages/viewport/src/pick/edgeChain.ts`).
- Depth cycling on repeated clicks (`packages/viewport/src/pick/depthCycle.ts`) — occluded
  entities are reachable; raycast ordering already prevents selecting an internal face
  through an exterior one (nearest-hit precedence in `PickService.pickAll`).
- On-model handles: planar face offset arrow with dashed leader + translucent face ghost,
  cylinder radial arrow with a real drawing-style dimension callout, edge fillet/chamfer
  sphere+ring handle (`packages/viewport/src/gizmo/rigs.ts`). All screen-space-scaled per
  frame and `depthTest:false`, so they are never hidden by the solid.
- Dimension chip + click-to-type keypad with Enter/Escape, unit switching, and parameter
  expressions (`apps/web/src/components/NumericKeypad.tsx`, chip at
  `apps/web/src/components/ModelViewer.tsx:1718-1737`, `updateOffsetChip` :2551-2652).
- Live exact previews through the kernel worker with newest-wins coalescing
  (`apps/web/src/lib/livePreview.ts`), plus the radial transform proxy for boss cylinders
  (`packages/viewport/src/gizmo/cylinderRadiusPreview.ts`).
- Transaction machine with armed/dragging/exact-entry/validating/failed phases, Escape
  ladder, and validated commits that reject before touching history
  (`apps/web/src/lib/interaction/machine.ts`, `apps/web/src/hooks/useDirectEditCommit.ts`).
- Kernel data already published per face: `surfaceType`, cylinder `radius/diameter/
  axisStart/axisEnd/axialLength`, `featureType:'through-hole'`,
  `editableDimension:'diameter'` (`FaceGeometry`, `packages/shared/src/index.ts:697-741`);
  per edge: `curve.circle {center, axis, radius}`, `adjacentFaceHashes`, `vertexIds`.

**Missing (the actual work):**

1. Selected-face rendering is a flat unlit cyan film — curvature is illegible (spec §2).
2. No boundary-edge emphasis on the selected face (spec §2, §3).
3. No occluded-portion (x-ray) rendering and no analytic-extent ghost cylinder — a bore
   selection reads as a sliver, not a full 360° wall with visible axis/depth (spec §3).
4. No pick-list UI; depth cycling is invisible and undiscoverable (spec §4).
5. No Radius↔Diameter toggle; bores should read `Ø17.4 mm` (spec §6). No "Total" label
   for height edits (partial: cap drags already retarget to primitive height).
6. Planar offset drags stream **no** kernel preview — only the ghost moves (spec §7).
7. No invalid-preview visual state (warning color / disabled commit) — validation failure
   is only reported after release (spec §7, §9).
8. **Selecting an existing fillet face does nothing special.** No blend-face recognition
   reaches the viewer, no `Edit Fillet` affordance, no radius display, no removal preview
   (spec §8). The kernel-adapter has `isBlendFace` (`packages/kernel-adapter/src/exact.ts:812-891`)
   but uses it only for diagnostics text; torus/cone analytic params are parsed for
   nothing (`measureFaceGeometry` reads analytics only for plane/cylinder/sphere,
   `exact.ts:3232`).
9. During fillet creation the preview fillet face is not highlighted cyan (spec §8).
10. No visual acceptance test suite for any of this (spec §10).

**Known limitation to carry, not fix:** sphere face picks are unavailable because BrepKit
models a sphere as two hemispheres with identical ADR-011 hashes
(`packages/shared/src/index.ts:759-786`). Out of scope here.

---

## Architecture decisions

### D1. All new render states are overlay geometry, no postprocessing

The viewport has no compositor/outline pass and gains none. Every new state (shaded
selection, hidden-portion tint, analytic ghost) is a `THREE.Mesh`/`Line2` overlay slotted
into `VIEWPORT_RENDER_ORDER` (`packages/viewport/src/render/scene.ts:252-260`). This keeps
the change local to `@openzcad/viewport` and avoids touching the render loop.

### D2. Occlusion classification via depth-function trick, not raycasts

The hidden-portion pass is the same face-range index slice rendered twice:

- **visible pass** — current behavior: `depthTest:true`, bright cyan, opacity ~0.5,
  `polygonOffset` to win z-fighting against the base mesh;
- **hidden pass** — same geometry, `depthFunc: THREE.GreaterDepth`, `depthWrite:false`,
  cyan at opacity ~0.16, rendered just below the visible pass.

Fragments that fail the normal depth test are exactly the occluded ones, so the bore wall
reads through the outer wall without any CPU-side visibility computation. This composes
with the existing `SelectionManager` film (hover gets the same treatment at lower opacity).

### D3. Analytic-extent ghost from published `FaceGeometry`, not the kernel

For a selected cylindrical face, the translucent green/gray reference cylinder is built
client-side from `axisStart`, `axisEnd`, `radius` — data already in the payload. Open
cylinder segments (sweep < 2π) still get the full closed ghost; that is the point of the
"analytic extent" affordance. Planar faces get no ghost (the offset rig's face ghost
already covers them). No new worker RPC.

### D4. Fillet recognition is baked into the tessellation payload

The viewer never talks to the kernel (the geometry worker speaks only `sync`/`export`),
so fillet-face recognition must ride `FaceGeometry`. Extend `measureOwnedFaceGeometry`
(`packages/kernel-adapter/src/exact.ts:3462-3478`) to publish:

```ts
featureType?: 'through-hole' | 'blend'
blendRadius?: number          // cylinder radius, or torus minor_radius
```

using the existing `isBlendFace` tangency test for cylinders and a new torus branch
(parse `getAnalyticSurfaceParams` for torus: `minor_radius` **is** the fillet radius —
most edge fillets on curved rims are tori, currently published as bare `surfaceType`).
`FaceGeometry.center` stays frozen (ADR-011 witness input) — new fields are additive only.

### D5. Editing an existing fillet = editing its producing feature

No new kernel op. A selected blend face carries
`reference.producingFeatureId`; when that feature is `featureKind:'fillet'`, the radius
handle commits through the existing feature-parameter path (same one Inspector's
`EdgeModifierForm` and the AI `set_feature_dimension` use), so history replay regenerates
downstream features. Fillet **removal** previews and commits as feature deletion when the
producing feature is a fillet; `remove-face-feature`/defeature stays the fallback for
imported bodies with no history. Blend faces whose producer is not a fillet feature (e.g.
imported STEP) show radius read-only in v1.

### D6. Package boundaries unchanged

`@openzcad/viewport` stays React-free and emits intent only; selection state stays in the
app shell; document/kernel packages gain no viewport concepts. New payload fields go in
`@openzcad/shared` + `@openzcad/kernel-adapter`.

---

## Phases

Each phase is independently landable behind the existing
`experiments.directManipulation` flag where behavior changes, and each ends green on
`npx vitest run` + the relevant Playwright specs.

### Phase 0 — Data plumbing (kernel-adapter + shared)

- Parse `getAnalyticSurfaceParams` for **torus** (center, axis, major/minor radius) and
  **cone** (apex, axis, half-angle) in `measureFaceGeometry`; publish minimal fields on
  `FaceGeometry` (torus: `blendRadius` candidates; cone: nothing user-facing yet).
- Publish `featureType:'blend'` + `blendRadius` per D4 (cylinder tangency test + torus
  minor radius). Unit tests: filleted box (torus-free), filleted cylinder rim (torus),
  cylinder boss that is NOT a fillet (tangency test must reject).
- Viewer-side derivation helper (no kernel change): `boundaryEdgesOfFace(bodyTopology,
  faceHash)` = edges whose `adjacentFaceHashes` contains the hash. For a bore this yields
  exactly the two circular boundary rims the spec asks for.
- Gate: pin-bump-style regression run — `npx vitest run` **and**
  `pnpm test:parity-corpus` (payload shape changes touch the same seam as a pin bump).

### Phase 1 — Selected/hover face appearance (spec §1, §2)

- Replace the flat `MeshBasicMaterial` selection film with a **shaded** highlight: a
  Lambert-style tinted material (base mesh normals are already in the overlay geometry
  slice) so planar vs. cylindrical vs. blend curvature stays legible under the cyan.
  Same for the hover film at lower intensity. Keep `toneMapped:false`,
  `polygonOffset`, render-order slots.
- Draw the selected face's boundary edges via `boundaryEdgesOfFace` through the existing
  `BodyEdgeOverlay.setSelected` batch (a second, brighter width tier for boundary rims).
- Unselected geometry keeps the normal material (already true — assert it in tests rather
  than change anything).
- Hover for a tangent-continuous edge run: reuse `edgeRunFrom` on hover **only when the
  hovered edge is smooth** (cheap: `adjacentFaceHashes` + the existing 50° tangency cone),
  so hovering a fillet rim pre-highlights the loop the double-click would select.

### Phase 2 — Occluded selection & analytic ghost (spec §3)

- Hidden-portion pass per D2 for selected faces and selected edges (edges: second
  `LineSegments2` batch with `depthFunc: GreaterDepth`, dimmer color). Hover gets the
  hidden pass at hover opacity.
- Analytic-extent ghost per D3: translucent gray-green closed cylinder
  (`opacity ≈ 0.18`, `depthWrite:false`, `DoubleSide`, render order just under
  HOVER_HIGHLIGHT) spanning `axisStart→axisEnd`, plus a thin dashed axis line
  (reuse `dimensionGraphic` dash material). Shown while a cylindrical face is selected;
  also drawn for outside cylindrical faces (spec explicitly wants it there too).
- Acceptance: bore axis, diameter, and depth are readable from an oblique view with no
  section view — the two rim circles (Phase 1) + ghost + hidden pass together carry this.

### Phase 3 — Disambiguation pick list (spec §4)

- Keep depth cycling as the fast path. Add a **pick list**: `pickAll()` already returns
  the ordered deduped stack; surface it as a small HUD popup (HudLayer, like the measure
  chip) on long-press / right-click / a keyboard trigger, rows labeled from topology
  ("Top face", "Outer wall Ø40", "Bore Ø17.4", "Edge R4", …) using `FaceGeometry` +
  `EdgeCurve`. Row hover drives `SelectionManager.applyHover` so the candidate flashes in
  the viewport; click selects.
- Labeling helper shared with the measurement preview chip formatting (App.tsx
  `previewMeasurement`) — one vocabulary for entity naming.
- Verify (test, not code): selection persists while the pointer travels to the handle,
  chip, and keypad — rigs are armed off selection state, so this should already hold;
  lock it in with a regression test.

### Phase 4 — Dimension labels & handle polish (spec §5, §6)

- **Ø by default for bores/cylindrical faces**, `R` for fillet handles; chip toggle
  (click the Ø/R prefix or a keypad chip) switches display *and* entry mode; commit path
  always normalizes to radius internally. Wire through `updateOffsetChip` and
  `NumericKeypad` (`unitKind` gains a `dimensionMode`).
- `Total 55.7 mm` label when a cap drag retargets to primitive height
  (`cylinderPrimitiveAncestry` path) — the total extent is what the user is editing, so
  say so.
- Offset rig gains the dashed measurement line through the geometry (cylinder rig's
  `createDimensionGraphic` generalized), replacing the plain leader.

### Phase 5 — Live preview upgrades (spec §7, §9)

- **Planar offset drags stream an exact preview** through a new `LivePreview` instance
  (same 150 ms throttle as edge previews; `continueAfterSlow: false` so heavy models
  degrade to ghost-only exactly as today). The existing ghost stays and becomes the
  "original position" reference; previewDoc supplies the healed B-Rep result, so
  adjoining faces/fillets update live.
- Ghost color moves from cyan-tinted to the spec's green/gray for anything that is
  *reference* rather than *selection* (offset face ghost, analytic cylinder ghost) so
  ghost ≠ committable material is unambiguous.
- **Invalid-preview state**: when `LivePreview` derive returns kernel warnings (or the
  validating phase fails), tint the armed handle + chip with the warning color, disable
  keypad commit, keep Escape-to-restore. The machine already has `validating`/`failed`
  phases — this is rendering them, not new state.
- Keep the actively edited face bright cyan **in the preview mesh**: re-resolve by
  hash/axis in `renderedSelectedTopology` (App.tsx:2272-2331 already does this for
  cylinder resizes; extend the fallback to offset previews).

### Phase 6 — Fillet select-to-edit (spec §8)

- Selecting a face with `featureType:'blend'` arms a fillet-edit interaction:
  chip shows `R4 mm` + `Edit Fillet`; handle is the edge-radius sphere/ring oriented
  along the blend's radial direction.
- Commit per D5 through the producing fillet feature's radius param; full-history replay
  regenerates downstream geometry. Live preview via the existing `edgePreview`-style
  `LivePreview` (build a candidate doc with the updated feature radius).
- **Fillet removal**: radius→0 or an explicit action deletes the producing feature;
  preview shows the recovered sharp intersection (the replay result *is* the extended
  supporting faces — no separate surface-extension math needed when history exists).
  Imported bodies fall back to `remove-face-feature` where its planar-neighbor gate
  allows, else the action is hidden.
- **Fillet creation preview highlight**: while an edge fillet preview is active, diff
  `previewDoc` topology against the base document — faces present only in the preview are
  the new blend faces; tint them cyan in the preview render. After commit, normal
  material returns automatically (selection clears via `onCommitted`).
- Selection persistence across the radius edit: fillet faces re-hash on every radius
  change (the closed-edge/2πr lesson from #155), so re-selection after preview/commit
  must resolve via `producingFeatureId` + blend classification, **never** via hash alone.

### Phase 7 — Visual acceptance suite (spec §10)

Playwright spec (`playwright.config.ts` harness exists) building the spec's reference
part — a boss with a through-bore and a rim fillet — via the seeded-document path, then
walking the 10 acceptance checks from ≥2 oblique camera angles:

1. hover top annulus → only that face films; 2. select outer wall → full cylinder;
3. select bore → full inner face incl. hidden-pass pixels (screenshot assert on a probe
   region behind the outer wall); 4. bore vs. annulus disambiguation (pick list rows);
5. drag bore handle → chip value monotone + previewDoc updates; 6. type 17.4 → committed
   `FaceGeometry.diameter === 17.4`; 7. outer circular edge → full loop; 8. fillet
   creation preview face is cyan; 9. select existing fillet → whole blend face + radius
   chip; 10. orbit mid-selection → overlays and chip anchors track (compare projected
   anchor vs. expected world point).

Numeric asserts run against the document/topology payload; screenshots are secondary
evidence, not the oracle, to keep the suite un-flaky.

---

## Risks / open questions

- **Shaded highlight material**: Lambert-tint may look muddy on dark faces; may need a
  small custom shader (tint mixed over N·L). Budget one iteration with screenshots.
- **`GreaterDepth` pass vs. transparent bodies**: sketch-mode receded solids
  (opacity 0.35) write depth; verify the hidden pass doesn't light up through them
  incorrectly. Fallback: disable hidden pass while sketch mode recedes solids.
- **Blend recognition false positives**: a real cylindrical boss tangent to a wall passes
  the `isBlendFace` test. Mitigate: require the producing feature to be a fillet for the
  *edit* affordance; bare `blend` classification without a fillet producer only changes
  the label, never the commit path.
- **Offset live preview cost**: pushPull rebuilds on big imported bodies can exceed the
  400 ms slow-frame budget; `continueAfterSlow:false` keeps today's behavior as the
  degraded mode. Measure before tuning.
- **Entry chunk ceiling**: the eager bundle has ~400 bytes of slack; new UI (pick list,
  chip modes) must stay inside the lazy viewport/app chunks. Check the build gate early,
  not at the end.
- **Top bar untouched**: nothing in this plan adds top-bar controls (no space budget).

## Suggested increment order & sizing

0. Phase 0 (S) → 1 (M) → 2 (M) → 4 (S) → 5 (M) → 6 (L) → 3 (M) → 7 (M).
   Phase 3 (pick list) floats — it has no dependencies beyond Phase 0 labels.
   Phases 1+2 together deliver the spec's headline bore-selection experience and are the
   first thing worth a QA screenshot pass.
