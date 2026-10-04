# Reference workflow plan — closing the modelling-loop gaps (2026-10-04)

Status: decided 2026-10-04 (all §6 recommendations accepted); Phase 0 in progress
Source: the 2026-09-01 reference recording, re-reviewed 2026-10-04 at workflow level.
Frame-level facts live in
[reference-cad-interaction-2026-09-01.md](../reference/reference-cad-interaction-2026-09-01.md);
this plan does not repeat them. Citations below are to `main` at `d35b2ff9`.

## 1. What the recording teaches, as rules

The recording is a complete loop: sketch → extrude → sketch on a face → cut
by direction → face offset / fillet → text → engrave → mirror → union. Behind
the chrome it follows seven rules, and these are what OpenZCAD should carry
over. Nothing below asks for the reference's layout.

1. **Selection is the command.** Hover shows, click arms. The handle lives at
   the click point, never at a centroid or in a panel.
2. **One number, one place.** The live value sits on the handle's axis; the
   keypad opens from it; a history row is the only other owner.
3. **Direction decides add versus cut.** The sign is shown, never chosen.
4. **Multi-select, then one drag.** Seven glyphs, seven edges, two
   rectangles: one handle moves all of them by the same value.
5. **Modal tools show the evaluated result before Done.** Mirror's green
   ghost, text's live outline. Each has exactly Done and Cancel.
6. **Starting values are the model's current dimension.** A face drag edits
   the wall (6 → 8.4 mm total), not an offset from zero.
7. **Only chrome animates.** State changes are hard cuts; cards and panels
   take 120–400 ms and close faster than they open.

## 2. Where OpenZCAD already matches (no work)

| Rule                                                                                                  | Evidence on `main`                                                   |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Sketch entry via ghost planes or a picked face, camera glide, body recede                             | PRs #97, #98, #104                                                   |
| Region hover fill, click arms Extrude at the pick point, exact rebuild per drag frame                 | #173, #176, #177                                                     |
| Cut by direction, no add/cut picker                                                                   | #100, #101, #186                                                     |
| Extrude stays open after commit, handle re-arms on the cap                                            | #193                                                                 |
| Refusal keeps the handle live, model untouched, `Keep <value>`                                        | #180, #197                                                           |
| Offset Face arms with the current span (`Total` mode, `totalBaseline`)                                | #368; `ModelViewer.tsx:4945`                                         |
| Keypad from the chip, one-frame commit                                                                | `lib/keypad.ts`                                                      |
| Double-click face → body, X-ray for occluded selection, pointer-anchored orbit and zoom               | `ModelViewer.tsx:6160`; `render/semantics.ts`; `CameraController.ts` |
| Text as a sketch object, glyph regions with counters, emboss and engrave through the ordinary extrude | `text-feature-plan.md` (shipped); `profileReferences.ts`             |

## 3. Gaps this review found

Each gap names the reference behaviour, what the code does today, and how
confident the finding is. **Phase 0 verifies every one of these live before
any implementation PR opens.**

### G1. Text authoring is field-first, not canvas-first — confirmed in code

- Reference (05:06–05:25): Text tool opens a small card (string, font,
  capital height, alignment, `Continue` disabled while empty). Every
  keystroke redraws the orange outline on the canvas. `Continue` hands over
  to a Transform gizmo (move square, pivot ring, X/Y arrows, scale arrow)
  with the rail replaced by `Done` / `Cancel`. `Done` converts to curves.
- OpenZCAD: `T` + click places a placeholder reading `Text` at the click
  ([ModelViewer.tsx:6899](../../apps/web/src/components/ModelViewer.tsx),
  [session.ts:223](../../apps/web/src/lib/sketch/session.ts)), auto-selects
  it, and the sketch card shows a form
  ([SketchEntityEditor.tsx](../../apps/web/src/components/SketchEntityEditor.tsx))
  whose string, family, style, size, rotation, X and Y apply on form submit
  (`submit` at line 307), not per keystroke. The canvas shows the word only
  after Apply. Position is typed, never dragged.

### G2. No drag-move for any sketch object — confirmed in code

- Reference: the Transform Text gizmo is a drag; rectangles carry vertex
  handles.
- OpenZCAD: the sketch interaction machine has no move action
  (`sketch-tool`, `sketch-drawing`, `sketch-select-object`,
  `sketch-constraint-*`, `sketch-edit-*` only;
  [machine.ts:211–222](../../apps/web/src/lib/interaction/machine.ts)).
  The text baseline origin is a snap _target_ and nothing else
  (`session.ts:652`). G1's placement step depends on this.

### G3. Region selection holds one region — confirmed in code

- Reference (02:10, 05:27–05:42): two rectangles, then seven glyphs, each
  picked with a plain click; the status pill counts them; one drag moves
  all; only the grabbed handle keeps a chip.
- OpenZCAD: `mode: 'region'` carries one `RegionTarget`
  ([machine.ts:184, 809](../../apps/web/src/lib/interaction/machine.ts),
  `count: 1`). The persistence side already accepts many
  (`profileReferencesForSelection(profiles: readonly RegionPickData[])`),
  and a text pick already collapses to the whole entity, so for text one
  glyph click probably extrudes the whole word — better than the reference,
  but unverified (V1).

### G4. Hover and selection tints ease; the reference cuts — confirmed, decision pending

- `easeToward` with τ = 60 ms on face film, hidden-face pass and edge tint
  ([SelectionManager.ts:172–177, 620](../../packages/viewport/src/selection/SelectionManager.ts);
  [motion.ts:33](../../packages/viewport/src/motion.ts)). The reference is
  a one-frame cut on and off with no dwell. Section 4 of the reference doc
  called this "small, opposite choice". It is a one-line policy change with
  a visible feel difference; §6 asks for the call.

### G5. Orbit coast up to 800 ms; the reference never exceeds ~200 ms — confirmed, decision pending

- `ORBIT_GLIDE_MAX_MS = 800`
  ([CameraController.ts:64](../../packages/viewport/src/camera/CameraController.ts)).
  Reference stops: dead stop in one frame or a 10–12 frame decay
  (τ ≈ 75 ms). §6 asks for the call.

### G6. Drag value snapping — deliberate divergence, keep

- The move gizmo's zoom-adaptive 1-2-5 ladder
  ([move.ts:34–51](../../packages/viewport/src/gizmo/move.ts)) has no
  counterpart in the reference, which shows 0.1 mm raw projections. This
  is the handle-pin design approved in #368. No change; record the
  decision in `docs/interaction-design.md` so it stops resurfacing.

### G7. Additive selection is Shift+click, the reference adds on plain click — convention, keep

- Faces and edges keep Shift (`ModelViewer.tsx:4273, 4527`). G3 should use
  the same modifier for regions so one rule covers all three.

### Unverified against the live app (Phase 0 items)

- **V1** Engrave: sketch on a face → `T` → word → exit → click one glyph →
  drag into the body. Expect: whole word cuts, counters survive, preview is
  per frame, chip reads negative. Then edit the string and confirm the cut
  rebuilds (the entity-wide reference, `App.tsx:6223`).
- **V2** Two rectangles in one sketch → one handle. Expect today: only one
  extrudes (G3).
- **V3** Mirror: does OpenZCAD show an evaluated ghost before commit, and
  does it offer only datum planes plus Done/Cancel? Not read this session.
- **V4** Union: explicit command, no silent merge of overlapping bodies.
  Expected to match (`docs/interaction-design.md:42–47`).
- **V5** Text size semantics: OpenZCAD stores an em size; the reference
  uses capital height. Measure what an 8 mm setting produces in each.

### Phase 0 findings (2026-10-04)

Driven in the dev app on `d35b2ff9` (kernel `74422f0`, matching the lockfile)
in a new millimetre project: a 62 × 50 × 10 mm slab, a face sketch holding
the text `Boa` (Open Sans, size 8), and a second face sketch with two
rectangles and a circle. Screenshots and probe logs are in the session
scratchpad `phase0/` folder, named below; they are not committed. Section 4
of the reference doc carries the per-behaviour detail and citations.

- **G1 confirmed.** The tool drops a placeholder `Text` and opens the entity
  editor; typing `Boa` changed nothing on the canvas until Apply.
  `05-g1-text-placed-editor`, `06-g1-typed-Boa-canvas-still-Text`.
- **G2 confirmed.** A drag on a selected circle's centre orbited the sketch
  camera; Center X/Y stayed −15 / 20. `20-g2-circle-selected-before-drag`,
  `21-g2-drag-circle-centre-orbits-camera-circle-unmoved`.
- **G3 re-scoped (mostly refuted).** Shift+click on a second rectangle added
  it ("2 selected profiles"); one drag previewed both pockets and Create cut
  both, because the commit reads the App's profile list, not the machine's
  single target. Left over: the machine still reports `count: 1`, only the
  last region gets an arrow, and no inference-agreement refusal exists.
  `22-v2-shift-click-two-profiles-selected`,
  `23-v2-one-drag-cuts-both-rectangles-minus6`, `24-v2-two-pockets-committed`.
- **G4 confirmed.** Pixel reads inside each frame show a ~150 ms on-ramp and
  ~200 ms off-ramp on the face film. A 60 ms dwell between targets has also
  shipped (`hoverDwell.ts:16`). `g4-hover-pixel-samples.txt`.
- **G5 confirmed.** After a fast Shift+drag orbit release the viewport kept
  drawing for 781 ms, then went idle (draw calls counted per frame).
  `g5-orbit-coast-draw-frames.txt`, `35-g5-after-shift-drag-orbit`.
- **V1 re-scoped, and blocked at the kernel.** Hover fills one glyph, the
  click arms one glyph, and the proxy shows that glyph with its counters
  open. The stored reference is entity-wide, so Create builds the whole word:
  as a new body `Boa` came out 12.99 × 5.79 × 2 mm, and editing the string to
  `Bob` rebuilt it as 13.65 × 6.16 × 2 mm. But cutting the word into the slab
  (−2, −5), embossing it (+2), and an explicit Union of the text body with
  the slab are all refused by the exact kernel. Rectangle cuts on the same
  face work, so the refusal is specific to glyph solids. The chip read
  `Total ⚠ 5 mm` instead of `−5`: the region rig inherits the last face
  offset's chip mode and span (`ModelViewer.tsx:9011-9017, 9376`).
  `08-v1-hover-fills-one-glyph-o`, `10-v1-click-o-selects-one-profile`,
  `12-v1-mid-drag-proxy-one-glyph-chip-total5`,
  `15-v1-explicit-cut-o-subtract-refused`, `18-v1-B-emboss-plus2-failed`,
  `31-v1-commit-builds-whole-word-Boa-12.99x5.79x2`,
  `33-v1-string-edit-Bob-rebuilds-13.65x6.16`,
  `34-v1-union-text-body-with-slab-refused`.
- **V2 refuted.** Two rectangles extrude from one handle today; see G3.
- **V3 confirmed (gap).** Mirror shows no ghost before Create; the card says
  the check "draws no preview". The plane is Top/Front/Right chips plus free
  origin and normal fields, not datum planes only. Controls are
  `Create mirror` / `Cancel`. `25-v3-mirror-card-no-ghost`,
  `26-v3-mirror-origin-x40-still-no-ghost`.
- **V4 confirmed.** An overlapping box stayed a separate body at its full
  12 960 mm³; Union is an explicit command with a pick-order card.
  `27-v4-overlapping-box-separate-body-full-volume`,
  `28-v4-union-card-explicit-pick`, `29-v4-united-bodies`.
- **V5 settled.** Size is the em size (`layout.ts:121`). Open Sans cap height
  is 1462/2048 = 0.714 em, so size 8 gives a 5.71 mm capital; the sketch
  measured 5.6–5.8 mm and the built `Boa` 5.79 mm tall. A reference "8"
  (capital height) equals an OpenZCAD size of 11.2. `07-v5-text-Boa-size8`.
- **Offset arming re-scoped.** `Total` with the current span arms only on a
  face whose feature sets its dimension (the extrude cap read `Total 10 mm`).
  A side face armed at `Offset +0 mm`; its `Total 62 mm` is one click away on
  the tag. `02-slab-top-face-offset-total-10`,
  `03-side-face-offset-plus0`, `04-side-face-tag-total-62`.

What this changes in §4:

- **Phase 3 shrinks for rectangles and changes for text.** Shift-additive
  regions and one-drag extrusion already work. What is left is the count,
  per-region arrows, the inference-agreement refusal, and making text pick
  and preview whole-entity so they match the entity-wide commit.
- **Text engrave needs kernel work first.** The engrave step in Phase 2's
  e2e cannot pass until the exact kernel accepts a boolean between glyph
  solids and their host body. That is a Remus item and should be filed before
  Phase 2.3 starts.
- **One defect to fix on its own:** the region chip's stale `Total` state.
- Decision 2 (size semantics) has its number: capital height is 0.714 of
  the stored size for the default font.

Harness traps hit: the dispatched-wheel zoom accelerates far past the burst
(re-fit before trusting a view); a synthetic pointer-down that misses the
arrow starts a box select, and its release can clear the selection; region
picks on a small glyph need an exact hit (scan the status text for "Closed
sketch profile"); the default Create button may move as the card reflows.

### Kernel finding behind V1 (2026-10-04, probe matrix)

A disposable Vitest probe (archived in the session scratchpad as
`probe-text-engrave.test.ts`, built from the helpers in
`test/text-kernel-build.test.ts`) reproduced the live refusal against the
pinned kernel (`74422f0`) and isolated the trigger. Slab 62 × 50 × 10 mm,
Open Sans `Boa` at size 8, `{ all: true }` text profiles, explicit boolean:

| Case                                                                 | Result                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------- |
| Text sketched on the top face (plane z = 10), cut −2 / −5, emboss +2 | **refused**: `exact_only_unattainable (quality_refused)` |
| Same, size 20; same with `Bo`                                        | refused                                                  |
| Plane 1 µm above the face, cut −2.001                                | refused (near-coplanar counts)                           |
| Plain rectangle on the same face, cut −2                             | cuts                                                     |
| Same text, flattened glyph walls (`setBezierProfileEdges(false)`)    | cuts, volume exact                                       |
| Same text, tool pierces the face: `backDistance` 0.5 or **0.01**     | cuts and embosses, volume exact                          |
| Text plane sunk 0.5 mm into the slab                                 | cuts                                                     |

Reading: the exact boolean fails when a **bezier-walled prism's planar cap
lies on (or within tolerance of) the target's planar face**. That is the
default geometry of every sketch-on-face engrave and emboss, so the shipped
text feature cannot do the recording's 05:27 step today. The existing unit
tests pass because they bury the text 2 mm below the slab top.

Consequences for the plan:

- **New PR K (app side, small, before D):** when a region extrude is an add
  or cut against the carrier face the sketch sits on, build the kernel tool
  with a hair of extra travel across that face (into air for a cut, into the
  body for an add). The exact result is unchanged by construction, the
  stored feature keeps the user's distance, and the probe shows 0.01 mm is
  enough. Regression: extend `test/text-kernel-build.test.ts` with the
  on-face case. Phase 2's engrave e2e then becomes runnable.
- **Remus item filed:** [esaueng/remus#953](https://github.com/esaueng/remus/issues/953),
  exact boolean with a coplanar bezier-walled cap. Repro is the probe's
  first row; the flattened-wall and pierced-tool rows show it is the
  coplanar curved-wall seam, not the glyph topology.
- **Two secondary defects seen on the way**, each a small PR or a note in
  PR K: (1) the region rig inherits the previous face offset's chip mode and
  span, so a −5 mm region drag read `Total ⚠ 5 mm` (`ModelViewer.tsx:9011-9017,
9376`); (2) the union preflight reports "4 disconnected groups" for a
  text prism that does overlap the slab, while the kernel then unites it
  correctly (probe row `emboss +2 back 0.5`), so the connectivity check
  misreads glyph solids.
- Phase 3 for text shrinks to making hover and the drag preview show the
  whole word (the commit already does; see Phase 0 findings, V1).

## 4. Plan

Phases are ordered by dependency and by how much of the recording's loop
they unlock. Each is one PR unless stated; every PR runs the five root
gates and the Playwright shard its spec lands in.

### Phase 0 — Live baseline (read-only, docs PR)

Drive the recording's loop in the dev app (`preview_start`, hidden-pane
recipes from the review-harness notes), one evidence sheet per step, and
settle V1–V5 and G1–G5. Deliverable: refresh §4 of the reference doc so
every row cites `main` today instead of `349763c0`, and append this plan's
findings. No code.

Exit: every G and V above is marked confirmed, refuted or re-scoped.

### Phase 1 — Sketch object drag-move (unblocks Phase 2)

- Add a `sketch-move` interaction: pointer-down on a selected object's grab
  point (circle/rectangle/polygon centre, text baseline origin, any point
  on a line or arc), drag with the existing snap targets and inference
  guides, commit on release through `handleUpdateSketchEntity`, Escape
  cancels the drag and keeps the selection per the U01 contract. The object
  moves rigidly during the drag; the solver runs on commit (a per-frame
  solver preview is a later refinement, not part of this phase).
- Rotation only for text (drag on a ring around the origin), stored in the
  existing `rotation` field. **No scale gesture**: text size stays a field
  in the entity editor, and Phase 2 must not expose a scale handle.
- Files: `lib/interaction/machine.ts` (state + events), `ModelViewer.tsx`
  sketch pointer path next to the drawing path, `lib/sketch/session.ts`
  (grab points beside `snapTargets`), one new overlay for the grab handles.
- Tests: machine unit tests for the new transitions; `test/e2e/sketch-move.spec.ts`
  dragging a circle onto a snap and a text origin, asserting the stored X/Y.
- Risks: solver churn per frame on constrained sketches (reuse the
  `sketchSolving` gate); the e2e canvas-hook starvation trap (gate on a
  render-loop-owned node, not a timeout).

### Phase 2 — Type-first text authoring

2.1 **Text card.** Pressing `T` opens the text card at once (string, family,
style toggles, `Size (em)`, alignment, `Place` disabled while the string is
empty). Reuse `TextObjectFields`; the card is the command slot of the left
command card, not a modal. Lazy-loaded: the entry chunk is full (56 B under
its budget on main), so the card must make its own room.

2.2 **Live outline.** Every keystroke renders the glyph outlines on the
sketch plane through the existing `objectPolylines` + text budget path,
anchored at the pointer until placed. This is the same overlay the rubber
band uses; nothing is written to the document until the placing click.

2.3 **Place, then transform.** One ordering, matching §6.1: the placing
click is the only step that creates a document object. It writes the typed
object at the click point, returns the tool to Select with the object
selected, and that selection shows the Phase 1 move and rotate handles.
There is no `Continue → Done` modal and no scale handle; `Place` in the
card is a keyboard equivalent with a deterministic anchor: the outline's
current plane position when the pointer has reached the plane, otherwise
the sketch origin (so `T` → type → `Place` with no pointer movement is
valid and covered by the e2e flow).
Escape while composing closes the card and leaves no object; Escape during
a later drag cancels that drag only. Enter in the string field is not
placement.

2.4 **Re-entry and the single owner.** Selecting an existing text object
shows the same handles. Its string, family, style, size, rotation and
position have exactly one owner, the entity editor's state and submit path
(`nextData` → `handleUpdateSketchEntity`); the card exists only for a
not-yet-placed draft and shares `TextObjectFields` and that same commit
path, never a second draft of a placed object. Escape during a re-entry
drag restores the object's stored values; it never deletes persisted text.

- Files: new `components/TextCard.tsx` (or fold into the sketch command
  card), `ModelViewer.tsx` text branch at 6899, `machine.ts` (`text` tool
  gains `composing` and `placing` phases), `App.tsx` `selectIfText`
  (replaced by the phase handoff).
- Tests: `test/e2e/text-authoring.spec.ts` covering the disabled `Place`
  on an empty string, per-keystroke outline presence, click places the typed
  string (the placeholder `Text` never reaches the document), Escape while
  composing leaves no object, a drag on the placed object then Escape
  restores it, re-entry on an existing object edits through the editor's
  path, and the engrave from V1 end to end once PR K is in. CSS class
  coverage and glyph coverage tests will flag new classes or symbols.

### Phase 3 — Multi-region selection, one drag

- `mode: 'region'` carries `targets: RegionTarget[]`; Shift+click adds or
  removes a region (same modifier as faces/edges); the selection chip
  counts them.
- The region rig draws one arrow per region; dragging any arrow moves all
  by the same value; only the grabbed arrow carries a chip. Preview and
  commit pass all profiles through `profileReferencesForSelection`, which
  already dedupes entity-wide (text) sources. That helper only shapes the
  persisted references, so the viewport side must expand too: a pick on one
  glyph of a text object expands to every region of that object for hover,
  selection, the rig and the drag preview, so what the preview shows is
  what the entity-wide reference commits (Phase 0 V1 mismatch); the text
  extrude regression covers it.
- Add/cut inference runs per region against its own carrier, and every
  region must agree on both the operation and the target body (one extrude
  stores one `targetBodyId`); two regions over different bodies, or a mixed
  add/cut result, are refused with a plain sentence, not silently split.
- Files: `machine.ts` region state and capabilities (`count`), `rigs.ts`
  region rig, `App.tsx` `regionExtrudeInputFor` (array), `extrudeInference.ts`.
- Tests: machine tests for add/remove/clear; `test/e2e/multi-region-extrude.spec.ts`
  with two rectangles from one handle, the mixed add/cut refusal, two
  regions over separate bodies refused, and a text-pick preview case: one
  glyph click must hover, select, arm and preview every region of the word
  (asserted on the selection count and the preview, not only on the commit).

### Phase 4 — Feel decisions (each a small PR, only if §6 says yes)

- 4.1 Hover and selection as cuts: tint changes apply in one frame; keep
  `easeToward` for chrome and the hidden-face pass if it reads as flicker.
  Guard with the existing SelectionManager tests plus a per-frame probe
  in the software-GL e2e harness.
- 4.2 Cap the orbit glide near 150–200 ms (τ ≈ 75 ms), no change to the
  pointer-anchored pivot. Re-run the interaction-feel audit scenarios.
- 4.3 Record G6 and G7 as kept conventions in `docs/interaction-design.md`.

### Phase 5 — Ledger

- **Master-ID mapping, registered in ROADMAP by PR A (this plan's PR), not
  deferred:** K, B, C, D and E belong to U01 (one owner across handle, chip,
  keypad and fields; displayed value = committed geometry) and, for the
  command-card contents of C and D, U04; F and G belong to U03 (motion
  audit). No new master ID is needed. ROADMAP rows U01, U03 and U04 name
  this plan as their active execution record together with the PR numbers.
- Each implementation PR adds one evidence sentence to its owning row when
  it is revised after this mapping lands; PRs already green at that point
  keep their CI result and PR H adds their evidence with merge commits. H
  also flips status columns and closes the record.
- Reference doc §4 refreshed in Phase 0; §6 open questions 1, 2 and 11
  stay open (they need a second recording).

## 5. Order and sizing

| PR  | Content                                                              | Depends on | Size         | Status (2026-10-04)           |
| --- | -------------------------------------------------------------------- | ---------- | ------------ | ----------------------------- |
| A   | Phase 0 baseline + doc refresh                                       | —          | S, docs only | open #582                     |
| B   | Phase 1 sketch move                                                  | A          | M            | open #585                     |
| K   | Pierce-the-face tool for on-face text add/cut, region-rig chip reset | A          | S            | **merged** #583 as `1344a52f` |
| C   | Phase 2.1–2.2 text card + live outline                               | A          | M            | open #587                     |
| D   | Phase 2.3–2.4 place/transform/re-entry                               | B, C, K    | M            | not started (after B, C)      |
| E   | Phase 3 multi-region                                                 | A          | M            | open #588                     |
| F   | Phase 4.1 hover cuts                                                 | decision   | S            | **merged** #586 as `57bd6aca` |
| G   | Phase 4.2 glide cap                                                  | decision   | S            | open #584                     |
| H   | Phase 4.3 + Phase 5 ledger                                           | all        | S, docs      | not started (last)            |

B, C and E are independent and can run in parallel sessions; branch per
PR off `origin/main`, never stack (stacked PRs keep a stale base here).

## 6. Decisions (taken 2026-10-04: the recommendation in each item)

1. **Text entry order.** Recommended: card first on `T`, outline follows
   the pointer, click places (the recording's order). Alternative: click
   first, then the card at the click point.
2. **Text size semantics.** Recommended: keep the stored em size for schema
   stability and label the field `Size (em)`; add `Cap height` as a derived
   display only if V5 shows the two differ by more than users will accept.
3. **Hover/selection cuts (4.1).** Recommended: yes for the tint itself;
   keep easing for the x-ray pass.
4. **Orbit coast cap (4.2).** Recommended: cap at 200 ms; the 800 ms coast
   was tuned for low frame rates and the audit now measures every scenario
   at the vsync floor.
5. **Region additive modifier.** Recommended: Shift, matching faces and
   edges, even though the reference uses plain click.
