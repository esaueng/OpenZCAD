# OpenZCAD design and interaction review — 12 September 2026

**Revision reviewed:** `origin/main` at `d389726a` (merge of PR #296), web app `@openzcad/web` 0.1.0, schema v13, Remus kernel as pinned in `pnpm-lock.yaml`. The review worktree branch was reset onto that commit before any testing; the local `main` line it started on was 769 commits behind.

**How it was tested:** the Vite dev server (`pnpm --filter @openzcad/web exec vite --port 5199`) with the local D1 migrated, driven from the Claude Browser pane at a 1440×900 emulated viewport, plus checks at 1280×720 and 1024×768. Every observation below comes from one of four sources, named in each finding: **hands-on** (reproduced in the running app), **kernel probe** (a disposable Vitest file that drove `createExactKernelAdapter()` and the document API, deleted afterwards), **code** (a cited file and line), or **agent map** (three read-only code-mapping passes whose claims were spot-checked; those are marked as such). Nothing here has been validated with external users.

**Harness caveats that shaped the evidence:** the browser pane runs hidden, so `requestAnimationFrame` never fires between actions. Render-loop readouts (value chips, HUD labels, hover states, preview geometry) are stale until a screenshot forces a paint, and typed-while-drawing dimensions could not be exercised by hand (the numeric buffer needs a live drag gesture). Those items are marked _not hand-verified_ and rely on the e2e suite. Downloads cannot be observed inside the pane, so export is verified up to the app's own success message.

Three disposable local projects were used: _Review Bracket_ (mounting bracket), _Hole Plate_ (repeated holes, then multi-body and STEP import), and the _Mounting Bracket_ demo for reference. Nothing was changed in application code.

---

## 1. Candid assessment

OpenZCAD already has the bones of a serious tool: an exact B-rep kernel in the browser, a replayable feature history with per-entity undo, validated commits that leave the model intact on refusal, direct manipulation on faces, edges and regions with a live numeric keypad, a selection-driven tool card, named faces and edges everywhere, and a column that tells a new user what each tool needs. The sketch→extrude→fillet happy path on the XY plane takes under a minute and feels close to the reference CAD it is modelled on.

It is not yet a tool an engineer can trust for a full part, for four reasons that compound:

1. **Geometry you build in the obvious way can be poison for the next step.** Extruding _into_ a body with a negative distance, which the form invites, builds a solid with inverted orientation. The Union feature refuses it with "The resulting body wouldn't be valid." while an Add extrude accepts the same solid and ships a 14-face part with a seam. A boolean tool that crosses an outer face (any edge notch or slot) fails outright with a raw kernel sentence. Both are reproducible from primitives in the kernel; both look arbitrary from the user's seat.
2. **Half the features are write-once.** A Hole, Shell, Draft, Pattern, Mirror, Split, Loft, Sweep, Thicken or Offset can be created but never edited: its history row opens a panel with measurements and a Delete. A fillet keeps its radius editable but not its edge set. The parametric promise ("change earlier dimensions and inspect downstream") holds for primitives, extrudes, fillet radii and parameters, and stops there.
3. **The sketch cannot see the model.** Snapping, dimensions and constraints only know the sketch's own entities. A flange drawn on the plate's side face cannot snap to the plate's corner, cannot be dimensioned to its edge, and does not follow when the plate gets wider. Coordinates typed into the entity editor refer to a face frame whose axes are rotated relative to the screen with no glyph to say so. Grid snapping is off by default, so a dragged rectangle is 41.808471716162806 mm wide.
4. **Feedback is plentiful but not authoritative.** A refusal can appear in the tool card, inside the keypad and in the status footer at once, while a failed boolean commits silently with the status "Boolean subtract added." and one Diagnostics line of raw kernel text. Suppressed features count as warnings. The next-step prompt the design relies on is rendered only for assistive technology. Ctrl+Z inside a text field undoes the model.

The good news is that the architecture already contains the pieces of the fix: a single interaction machine, validated-commit hooks, lineage names for faces, a command outcome mapper, one toast host and one keypad. Most of what follows is about routing every feature through the same few mechanisms rather than inventing new ones, plus two kernel-adapter corrections that should land before anything else.

---

## 2. Journeys

Each journey records what a user must do today (as driven), what worked, what broke, and how the same intent should work. Finding IDs refer to section 3.

### J1 — Mounting bracket (plate, upright flange, fillet, two holes, parametric width)

**Today.** Create project → `S` → click the XY ghost plane → `R`, drag a rectangle → select it, retype Width/Height/Center (four fields; the drawn values were 41.808…, 26.130…) → rail **Extrude** → the sketch closes, the camera glides back, an Extrude form opens with Distance 0 and a red "Distance cannot be zero" → type 8, Enter → body "Extrude Body". Flange: `S`, click the plate's side face (camera glides face-on, framed edge-to-edge so there is no room to draw above the plate; zoom out) → drag a rectangle from the plate corner (it does not snap; Center X −0.44) → retype 80×40 at Y 24 → rail Extrude → type −8 → **Automatic** yields a _second_ body, also named "Extrude Body". Select both → `U` → Create → **refused**: "The resulting body wouldn't be valid." Workaround found: open the flange Extrude row, set Operation = Add, target = plate → one body, 57,600 mm³, **14 faces** with a visible seam (C1). Fillet: `Q` ×3 to reach the Edge filter, click within ≈5 px of the top edge, tap the "R 0 mm" chip, type 3, Apply → "Filleted 1 edge at 3 mm." The body turns gold (I14). Holes: `S`, click the plate top (now a fixed plane because the face went through a boolean and a fillet; the caveat sentence is clipped with "…") → `C`, drag two circles → retype each Radius to 3 → rail Extrude → −8 → "Extruded region by −8 mm (cut)." Parameter: add `w = 80`, open Sketch 01, retype Width to `w`, Finish; set `w = 100` → the plate widens, the flange does not (W3). Total: about 60 clicks, 14 fields retyped, one refusal with no diagnosis, one workaround only a developer would find.

**Worked well.** Ghost-plane click, face-on glide, region fill + rail Extrude, typed distance with Enter, extrude staying open on its cap, the in-place keypad, delete toast with dependents count, rollback with one-click resume, parameter rebuild in ~2 s with no warnings, undo/redo naming the command.

**Blocked or broken.** Union of the two extrudes (C1); no snapping to the plate corner (W3); rotated face-frame axes (W4); Automatic new-body for a non-overlapping into-body extrude (W6); raw floats and clipped fields (I1); flange not following `w` (W3).

**Should be.** Draw the plate, pull the region up. Click the side face, draw the flange with its bottom edge snapped to the plate's top corner (or dimensioned to it), pull it inward: the direction says "join", and touching-or-overlapping material is one body. Click the inside corner edge, drag the fillet handle. Click the top face, place two holes with a Hole handle that shows diameter and position, dimension them to the plate edges. Change `w`: the flange and holes move because they were dimensioned to plate geometry, not to a frozen frame.

### J2 — Plate with repeated holes

**Today.** `B` → Box form 100/60/6 → Create (gold body). **Hole** tile → form (target, entry face list or viewport pick, style, diameter, depth, U/V from centre) → click the top face → "Check exact result" → "Create hole" → status "Drill hole". The history row of that hole opens a panel with measurements only: the diameter and position cannot be edited (W1). Patterns duplicate bodies, not features (W2): the only route to six holes is `C` cylinder → `M` Move panel (dX/dY/dZ) → **Grid** pattern (count/axis/spacing ×2) → select plate + pattern → `X` → Create. My first attempt failed because the cylinder straddled the plate edge: "Boolean subtract added.", warnings 1, model unchanged, no toast (C2, C3). With the tool inside the plate the same five forms produced six holes. Nothing is previewed until the final Create.

**Worked well.** Named face list in the Hole form, viewport face pick marking the list row, exact preflight before creation, selection chip offering `U/X/I` for two bodies, box select.

**Should be.** Place one hole on the face with a handle (diameter chip, position dimensions to two edges), then _pattern the hole_ with an on-canvas count/spacing handle. Six holes in four gestures, editable afterwards from the hole itself.

### J3 — Multi-body (cylinder, move, mirror, split, booleans)

**Today.** Move: gizmo plus a "Move / Rotate · direct edit" panel with dX/dY/dZ and rX/rY/rZ; typed values commit on Apply. Mirror: form with plane chips and origin/normal fields; two-stage commit; result "Cylinder Body mirror" in purple. Split with the default plane (Right, through the world origin) on a corner-origin plate: "Exact preflight refused: … the cutting plane contains edge 417 of the solid; splitting along an existing edge has no unambiguous answer" (C6, W10). Union/Subtract/Intersect: form listing bodies in pick order; no preview; non-union results commit unvalidated (C3).

**Should be.** Mirror and Split default their plane to the selected body's centre and show the plane as a draggable ghost; booleans preview the result body on hover of Create and refuse _before_ commit with the same in-place sentence the tool card uses.

### J4 — Revising a finished design

**Today.** Parameters bind by typing a name into any field; changing the value rebuilds in seconds with clean diagnostics. Undo/redo carry labels ("Undo Set parameter w") but clear the selection. Deleting the fillet showed "Deleted Fillet edges · 1 feature depended on it · Undo" and the holes vanished; Diagnostics said `Feature "Extrude": Stored cut target body_cd3e23ce-… is unavailable.` (raw id). Retargeting the cut in its form repaired it. Rollback paused four features and reported **warnings 4** (C7). Editing a hole, shell, pattern or mirror is impossible (W1); a fillet's edge set cannot be changed (W8). Ctrl+Z while typing in a parameter field undid a sketch (C4).

**Should be.** Every feature row opens the same in-place editor it was created with, handles included; dependents are shown as a chain before deletion; suppression is state, not a warning; undo restores the selection that produced the change; Ctrl+Z in a text field edits text.

### J5 — Save, reopen, export

**Today.** Autosave to IndexedDB is invisible and reliable (a full reload restored the bracket, the camera and the tour state). Ctrl+S while signed out: "Saved on this device." Export STEP from the File menu: "Exported 1 body to Review-Bracket.step." Export mesh dialog: 3MF/STL/OBJ/glTF, three quality presets, watertightness check. Start screen shows the project tile with a thumbnail. Units cannot be changed after creation although the start screen says they can (agent map, `StartScreen.tsx:726-728`).

**Should be.** Mostly keep. Fix the units copy or add a units migration; put the export scope (which bodies) in the dialog instead of inferring it from the current selection.

### J6 — Imported STEP

**Today.** Import through the File menu or drop: pill "Imported parametric-bracket.step · saved on this device only · Archive now"; body and history row named `remus_solid`; the body lands at the file origin on top of existing bodies. Clicking a boss wall arms **Resize Cylinder** with a Ø chip; sketching on it is refused silently because the pick is non-planar (W9). Hole-diameter editing on through-holes exists in the inspector (agent map, `Inspector.tsx:636-766`) but was not exercised.

**Should be.** Name the body after the file, offer placement (or at least fit the view), and answer a non-planar pick during plane selection with one sentence.

---

## 3. Findings register

Severity: **S1** blocks real work or breaks engineering trust · **S2** major recurring friction · **S3** moderate friction or wrong feedback · **S4** polish. Confidence: **High** = reproduced and explained in code · **Medium** = reproduced once or code-only · **Low** = hypothesis. Categories: correctness (C), workflow (W), interaction (I), visual (V), accessibility (A), performance (P), missing capability (M). "Source" is the evidence class from the method note.

### 3.1 Priority order

| #   | ID  | Title                                                                                                                                            | Sev | Conf   | Source                         |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ------ | ------------------------------ |
| 1   | C1  | Negative extrude distance builds a mis-oriented solid; Union refuses it, Add ships a 14-face seam                                                | S1  | High   | hands-on + kernel probe + code |
| 2   | C3  | Non-union booleans, patterns, transforms and revolves commit unvalidated; failure is one Diagnostics line and the status "… added."              | S1  | High   | hands-on + code                |
| 3   | C4  | Ctrl+Z inside a text field undoes the document                                                                                                   | S1  | High   | hands-on + code                |
| 4   | W1  | Ten of twenty-two feature kinds have no editor (Hole, Shell, Draft, Thicken, Offset, Loft, Sweep, Helical, Mirror, Split)                        | S1  | High   | hands-on (Hole) + agent map    |
| 5   | W3  | Sketches cannot reference model geometry: no snapping to edges or vertices, no projection, no dimension to a body edge                           | S1  | High   | hands-on + code                |
| 6   | W2  | Patterns duplicate bodies, not features; repeated holes need five forms                                                                          | S1  | High   | hands-on + code                |
| 7   | C2  | A boolean tool that crosses an outer face (notch, slot) fails with a raw kernel sentence                                                         | S1  | High   | kernel probe + hands-on        |
| 8   | C6  | Raw kernel text and internal ids reach the user (Diagnostics, preflight refusals)                                                                | S2  | High   | hands-on                       |
| 9   | C7  | Suppressed and rolled-back features count as warnings                                                                                            | S2  | High   | hands-on + code                |
| 10  | I1  | Sketch entity editor shows raw double-precision values in fields that clip them                                                                  | S2  | High   | hands-on + code                |
| 11  | I2  | Grid snap off by default and no on-canvas dimensions: dragged geometry lands on arbitrary coordinates                                            | S2  | High   | hands-on + code                |
| 12  | W4  | Face-attached sketch frames are rotated relative to the view with no axis glyph; editor X/Y do not match the screen                              | S2  | High   | hands-on + code                |
| 13  | W5  | Two commit contracts (Create/Apply vs Check → Create) and no preview for most forms                                                              | S2  | High   | hands-on + agent map           |
| 14  | W6  | "Automatic" extrude operation yields a new body for a non-overlapping into-body extrude                                                          | S2  | High   | hands-on + code                |
| 15  | I3  | Edge hit radius ≈4.7 CSS px; edge clicks land on faces                                                                                           | S2  | High   | hands-on + code                |
| 16  | I10 | Every face or edge pick opens an inspector that says it cannot be edited                                                                         | S2  | High   | hands-on                       |
| 17  | W9  | A manual selection filter silently defeats plane picking; non-planar picks are ignored without feedback                                          | S2  | High   | hands-on + code                |
| 18  | I6  | One refusal sentence rendered three times at once                                                                                                | S3  | High   | hands-on                       |
| 19  | I7  | Outcome copy: "Set parameter w added.", "Roll back after Extrude added.", "Drill hole", "(new-body)"                                             | S3  | High   | hands-on + code                |
| 20  | W13 | History panel below the fold at laptop heights                                                                                                   | S2  | High   | hands-on                       |
| 21  | I14 | Part colour changes with the kind of the last feature                                                                                            | S3  | High   | hands-on + code                |
| 22  | W8  | Fillet edge set, feature rename, parameter rename and units are not editable through the UI                                                      | S2  | Medium | agent map + hands-on (units)   |
| 23  | A1  | Entity editor inputs have no accessible label (name = value)                                                                                     | S2  | High   | hands-on                       |
| 24  | A2  | Tab order enters 26 orientation-cube polygons with no visible focus ring                                                                         | S2  | High   | hands-on                       |
| 25  | I8  | Three snapping readouts disagree ("Snap off" beside "Geometry snaps on")                                                                         | S3  | High   | hands-on + code                |
| 26  | I9  | Status prompt invisible; long messages clipped; "draw one closed profile" before a plane exists                                                  | S3  | High   | hands-on + code                |
| 27  | C8  | Tool enablement counts previews and sketches, not committed bodies or closed profiles                                                            | S3  | High   | hands-on + code                |
| 28  | W11 | Extrude form opens on Distance 0 with a red error; three ways to enter one distance                                                              | S3  | High   | hands-on                       |
| 29  | W10 | Mirror/Split default their plane to the world origin                                                                                             | S3  | High   | hands-on                       |
| 30  | W15 | Sketch tooling gaps: no entity drag, trim, extend, offset, sketch fillet, sketch pattern; polygon not on the rail; Enter does not finish a chain | S2  | High   | agent map (code)               |
| 31  | I13 | Imported body named `remus_solid`, dropped at the origin over existing bodies                                                                    | S3  | High   | hands-on                       |
| 32  | I16 | Dead or phantom keys and copy: `E` in sketch, `P polygon`, "tap R", "Thin Extrude", undocumented Ctrl+J                                          | S3  | High   | agent map (code)               |
| 33  | C5  | Body size readout grew after an edge hole (100 × 63 × 6 for a 60-deep plate)                                                                     | S3  | Medium | hands-on                       |
| 34  | A3  | `--color-text-dim` on `--color-surface-2` is 3.58:1                                                                                              | S3  | High   | computed from tokens           |
| 35  | W16 | Tweak mode can edit parameters but has no undo, no revisions and no diagnostics                                                                  | S3  | Medium | agent map                      |
| 36  | W17 | Undo clears the selection; toolbar Undo has no label; no palette entry                                                                           | S3  | High   | hands-on + agent map           |
| 37  | I4  | Hover callout draws over the value chip                                                                                                          | S4  | High   | hands-on                       |
| 38  | I5  | Keypad anchors below the chip and covers the model                                                                                               | S4  | High   | hands-on                       |
| 39  | I12 | Escape after a commit closes the panel but keeps the selection; a second Escape is needed                                                        | S4  | High   | hands-on                       |

### 3.2 Detailed entries

#### C1 — Negative extrude distance builds a mis-oriented solid

- **Context / repro.** Plate: rectangle on XY, region extrude 8. Flange: sketch on the plate's side face, rectangle straddling the plate top, rail Extrude, type **−8**, Create → second body. Select both, `U`, Create.
- **Observed.** Union refused: "The resulting body wouldn't be valid." with no detail. Editing the flange Extrude to Operation = Add succeeds with 57,600 mm³ and **14 faces** (an L-bracket has 8); a seam line crosses the flange at the plate's top. Kernel probe on the dumped document: the fuse has `errorCount 1: "4 shared edges have inconsistent face orientations"`. `extrude(+n, −44)` reproduces it; `extrude(−n, −44)` is clean; the same solids built from primitives or with a positive distance union to 8 faces with no warning. Prior art: `test/fixtures/hammer-holder/README.md:44-70` recorded the same signature on 5 September; `test/region-hole-winding.test.ts` fixed the inner-loop variant.
- **Cause.** `packages/kernel-adapter/src/exact-profile-builders.ts:727` and `:1148` call `kernel.extrude(face, normal, totalDistance)` with the signed span from `resolveExtrudeSpan` (`:145-174`); Remus sweeps behind the face normal without re-orienting the shell. Strict validation runs only for union (`exact.ts:1307-1310`; `exact-feature-builders.ts:1287-1325`); add/cut (`exact-feature-builders.ts:424-431`) run none, and `selectSafelyUnifiedSolid` then discards the unified 8-face candidate because it inherits the error.
- **Impact.** The form's own hint ("Negative distance reverses the extrusion") and drag-into-body both produce this. Every downstream feature and the STEP export carry the latent error. Frequency: any flange, rib or boss drawn on a face and pulled inward.
- **Recommendation.** Build a negative span the way the symmetric span already is: profile face on the far plane, sweep forward by the absolute distance, lineage carriers still from the signed span (a raw-kernel probe showed that the wire winding relative to the sweep decides validity, and that flipping the direction, `reverseShape` or `fixFaceOrientations` do not). Implemented in PR #302 together with C4; the reconstructed Hammer Holder baseline advances with it. Still open: run the union's strict validation (or at least the unified-face acceptance) on add/cut results, and give the union refusal the `Details` disclosure the tool card already has.
- **Acceptance.** The J1 bracket built with −8 unions to one body with 8 faces and no warnings; a kernel parity test pins `extrude(±d)` volume, face count and `validateSolid === 0`; the union refusal for any other cause shows its kernel sentence under Details.

#### C3 — Unvalidated commits fail silently

- **Repro.** Plate + cylinder straddling the plate edge → select both → `X` → Create.
- **Observed.** Status "Boolean subtract added.", warnings 1, model unchanged, no toast, no alert. Diagnostics: `Feature "Subtract": exact-only policy: the exact boolean pipeline could not produce this result and the approximate fallback was declined`. The history row flag reads "Feature failed to build".
- **Cause.** `App.tsx:15874-15884` validates only `operation === 'union'`; revolve, transform, pattern and non-union booleans go straight through `executeCommand` (agent map). The rebuild loop is fail-soft per feature (`exact-build-loop.ts:129-140`).
- **Impact.** The user's model silently gains a broken feature; the outcome sentence says the opposite of what happened. Trust-critical.
- **Recommendation.** Route every feature create and edit through `useValidatedFeatureCommit` (the hook already exists) so a refusal never lands in history; if a feature must fail-soft (replay of old documents), announce it with the toast host and the refusal sentence, never "added.".
- **Acceptance.** A subtract that the kernel refuses leaves history unchanged and shows one refusal in the form with Details; `commandOutcome` never emits "added." for a command whose derived state carries a `build-failed` warning.

#### C4 — Ctrl+Z inside a text field undoes the document

- **Repro.** Click the Parameters _name_ field, type `abc`, press Cmd+Z.
- **Observed.** Status "Undo Add line sketch"; history 10 → 9; the field still reads `abc`.
- **Cause.** `App.tsx:13441-13449` handles the history key without consulting the `typing` guard computed earlier in the handler (agent map, confirmed live).
- **Recommendation.** When the event target is an editable control, let the browser's text undo run; only route to document undo when focus is on the workspace. Same for Cmd+S while typing.
- **Acceptance.** Cmd+Z in any input reverts the text and leaves history untouched; the e2e suite gets a regression spec.

#### W1 — Ten feature kinds have no editor

- **Observed.** The Hole row's inspector shows Appearance and Measurements only; `Inspector.tsx:996-1382` has no branch for hole, shell, draft, solid-offset, thicken, loft, sweep, helical-sweep, mirror or split, while `FEATURE_DATA_KEYS` (`document-core/src/index.ts:2526-2610`) and the AI's `set_feature_dimension` can patch all of them (agent map; Hole confirmed live).
- **Impact.** A hole diameter or pattern spacing typed once is permanent short of delete-and-recreate; the assistant has more editing power than the human.
- **Recommendation.** Reuse each creation form as the edit form (the `ModelingOperationsForm` state already round-trips the data), then move the primary parameters onto handles (see B2).
- **Acceptance.** Every history row opens an editor whose Apply re-runs the same validated commit path as creation; a hole's diameter, style and position are editable and previewed.

#### W3 — Sketches cannot reference model geometry

- **Observed.** `collectSketchSnapTargets(sketchMode.objects, …)` (`ModelViewer.tsx:8644`) gathers snap targets only from the sketch's own entities plus the origin; a rectangle started on the plate's corner pixel landed at Center X −0.440. Constraints (`lib/sketch/constraints.ts`) accept only sketch entities. When `w` changed 80 → 100 the flange stayed 80 wide.
- **Impact.** Face sketches cannot be positioned or dimensioned against the part they sit on; design intent that spans features cannot be expressed; every dependent sketch must be retyped after a change.
- **Recommendation.** Project the sketch plane's silhouette and coplanar edges/vertices into the sketch as snap targets (fast, lineage-named where available), then allow distance/coincident constraints to those projected references with lineage-backed resolution and the existing fail-closed rule. Show a "Project edge" action on the sketch rail.
- **Acceptance.** Drawing a rectangle from a face corner snaps exactly (0.000 offset); a distance dimension from a sketch line to a projected body edge survives a parameter change that moves that edge.

#### W2 — Patterns duplicate bodies, not features

- **Observed.** `PatternForm` takes a body (`FeatureForms.tsx:1342`); a Hole cannot be patterned. Six holes took Box → Hole → Cylinder → Move → Grid pattern → Subtract; the first attempt failed because the tool straddled an edge (C2).
- **Recommendation.** Add feature patterns (linear/circular/grid over hole, cut extrude, boss) as a first-class feature with the pattern body path as its implementation, and a sketch pattern for entities.
- **Acceptance.** Select a hole, choose Pattern, drag a count/spacing handle, commit; editing the source hole updates all instances.

#### C2 — Boolean tools crossing an outer face fail

- **Kernel probe.** Box 100×60×6, cylinder r3 h20: tool at y=15 subtracts (35,830 mm³, 7 faces); at y=3 (tangent inside) subtracts; at y=0 (straddling the side face) fails with the exact-only sentence; at y=−3 (touching outside) returns the plate unchanged with a warning that "every curved surface" was replaced. The Hole tool did produce a half-notch at an edge, so the kernel path exists.
- **Recommendation.** Kernel-side: robust face-crossing booleans. Product-side until then: detect the straddle in preflight (tool bbox crosses a target face while intersecting) and say "This cut crosses the edge of a face; the kernel cannot build notches yet. Move the tool fully inside or use Hole."
- **Acceptance.** A slot across a plate edge builds; until then the refusal names the condition and a way out.

#### C6 — Raw kernel text and ids reach the user

- **Observed.** `Feature "Extrude": Stored cut target body_cd3e23ce-8b05-4e17-af93-0054f6e7be09 is unavailable.`; `…the cutting plane contains edge 417 of the solid…`; `exact-only policy: the exact boolean pipeline could not produce this result and the approximate fallback was declined`. `Sidebar.tsx:717-733` renders `warnings` verbatim; `refusalLanguage.ts` is applied only on the direct-edit path.
- **Recommendation.** Run every warning through `splitRefusal` before display, keep the raw text under Details, replace ids with feature names, and make Diagnostics rows link to the feature.
- **Acceptance.** No Diagnostics row contains `body_`, `feat_`, `edge <n>` or `policy`.

#### C7 — Suppression counted as warnings

- **Observed.** Rollback after the first extrude → "warnings 4", four rows reading "Suppressed; skipped during exact rebuild." (`exact-build-loop.ts:120-126`; `featureValidation.ts:72-92` already filters correctly for the history panel).
- **Recommendation.** Treat suppression as state: badge the row, do not count it, do not list it.

#### I1 / I2 — Raw floats, clipped fields, no dimensions, grid snap off

- **Observed.** `String(raw)` at `SketchEntityEditor.tsx:114`; 128 px inputs with 146 px of text; `snapEnabled: false` default (`packages/shared/src/index.ts:2487`); no dimension labels after drawing.
- **Recommendation.** Format to the document precision (3 decimals mm, 4 inch) with full precision on focus; grid snap on by default with the adaptive 1-2-5 step already computed for the grid; draw live dimensions on the entity that stay as editable labels.
- **Acceptance.** A dragged rectangle reads 42 × 26 with the grid at 1 mm; clicking a dimension label edits it in place.

#### W4 — Face-frame axes vs the view

- **Observed.** On the plate's top face, editor Center X mapped to world −Y (screen down) and Center Y to +X (screen right); `frameFromFace` (`lib/sketch/session.ts:426-455`) picks the reference axis by the kernel's cylinder-frame convention.
- **Recommendation.** Orient the sketch frame to the camera at entry (u along screen-right, v along screen-up), store it, and draw a small u/v glyph at the sketch origin; name the editor fields "Across / Up" on faces.

#### W5 — Two commit contracts, no preview

- **Observed.** `FormShell` forms: Create/Apply on Enter with live preview for Extrude and Edge only; `ModelingOperationsForm`: "Check exact result" → "Create hole" (four button states). Hole, Shell, Mirror, Split, Pattern and Booleans show nothing in the viewport before commit.
- **Recommendation.** One contract: every form previews on change through `LivePreview` (the imperative rig already keeps one rebuild in flight), Enter commits, refusal appears in place. Drop the explicit Check step; run preflight as the preview.

#### W6 — Automatic operation for an into-body extrude

- **Observed.** `extrudeInference.ts:227-233` turns _add_ into _cut_ for the `into` direction but leaves _new-body/no-overlap_ alone, so a flange that only touches becomes a second body; the reference model's "direction decides" rule is not honoured.
- **Recommendation.** For a face-attached sketch: away = add (contact counts), into = cut when enclosed, else add when touching; new body only on explicit choice.

#### I3 — Edge hit radius

- **Observed.** `EDGE_PICK_PADDING_PX = 8` gives an effective radius of ≈4.7 CSS px (`packages/viewport/src/pick/edges.ts:37-51`); the first click on a visible edge selected the face behind it.
- **Recommendation.** 8–10 px effective radius with edge priority over faces inside that band, plus a visible hover thickening (already coded) — and make the Fillet tool pre-set the Edge filter so the first click after choosing Fillet always tests edges first (it does; the failure was with `Any`).

#### I10 — The dead inspector

- **Observed.** Every face or edge pick shows "This selection does not identify one editable history feature. Select a feature in History to edit it." above body measurements (`Inspector.tsx:1485-1522`), while the actual actions live in the floating tool card.
- **Recommendation.** For topology picks, either close the inspector or make it the object panel it was decided to be (coherence D1): face name, surface type, area, owning feature link, and the same actions as the card.

#### W9 — Selection filter defeats plane picking

- **Observed.** With the filter left on Edge after a fillet, `S` then a face click did nothing (`selectionFilter.ts:48-53`: manual outranks tool). A non-planar face click during plane pick is also silent.
- **Recommendation.** Plane picking temporarily forces the Face filter and restores the manual one on exit; any rejected pick during a modal prompt says why in the prompt card.

#### W13 — History below the fold

- **Observed.** At 1280×720 the History header sits at y = 739; at 1024×768 at y = 777, inside a 287 px `.sidebar` scroller with hidden scrollbars.
- **Recommendation.** Give History a guaranteed minimum height (or the scrub strip) and let the tools fold collapse to icons when the window is short.

#### I14 — Colour by feature kind

- **Observed.** `featureColor(kind)` (`packages/shared/src/index.ts:2865-2891`): primitive gold, extrude mint, boolean orange, mirror purple, fillet gold. The bracket changed colour twice during construction.
- **Recommendation.** One body colour (user-set per body, default grey), colour reserved for states.

#### A1 / A2 / A3 — Accessibility

- Entity editor inputs' accessible names are their values; associate labels. Tab from the canvas lands on the orientation cube's 26 polygons with `outline: none`; give the cube one focus stop with arrow-key navigation, and a visible ring. `--color-text-dim` (#6e7681) on `--color-surface-2` is 3.58:1; it is used for kbd badges and hints.

---

## 4. Minor polish log

Grouped by shared cause; each line lists where it was seen.

**Outcome copy built from command labels** (`lib/commandOutcome.ts:48`): "Set parameter w added." (add and edit), "Roll back after Extrude added.", "Resume full history added.", "Suppress Hole added.", "Grid pattern added.", "Boolean subtract added." (even on failure); imperative labels leak as outcomes: "Drill hole", "Mirror body"; developer parentheticals: "Extruded region by 8 mm (new-body)", "(cut)".

**Message duplication** (no owner per message): fillet refusal in card + keypad + status; union refusal in form alert + toast; Move hint in card + status; body name in callout + chip + bodies list + inspector heading.

**Sketch chrome**: "Sketch mode: draw one closed profile on the selected plane." before a plane is chosen and although multi-profile is supported; hidden a11y text "Editing Sketch: New Sketch" at the same moment; the next-step prompt (`workspace-status-summary`) is never painted; the fixed-plane caveat is clipped with "…" (`workspace-column.css:759-761`); column label "Sketch plane" vs "Attached face"; Line is the default tool on re-entry to edit; the "Selected geometry" dropdown duplicates canvas selection; "Sketch palette" opens beneath the rail and pushes Parameters down; 12 constraint glyphs have names only as aria-labels; "Snap off" (dock) vs "Geometry snaps on / Grid snaps off" (column) vs "Grid 5 mm · adaptive".

**Forms**: Extrude opens with Distance 0 and a red error; Distance field + "Distance…" keypad button + viewport chip; Back distance shown while one-sided; Pattern custom direction shows "required" under blank X/Y/Z while the caption says blank = axis; Box labels Width (X)/Depth (Y)/Height (Z) (keys swapped in code, fixed at the label layer); Hole form taller than a 900 px viewport (button below the fold); Mirror/Split origin fields default to 0,0,0.

**Feedback surfaces**: hover callout overlaps the value chip on top faces; the callout stays after Escape; keypad covers the model; toast lifetime (8 s) shorter than the time to read Diagnostics after a delete; import pill persists across mode switches and offers "Archive now" while signed out; the extrude re-arm on the far cap put the fillet handle at the edge end rather than the midpoint (single observation, rigs.ts:584 says midpoint).

**Naming**: two bodies both called "Extrude Body"; pattern result keeps "Cylinder Body"; imported body `remus_solid`; "Sketch 01" restarts per project (fine) but an open, unusable sketch looks like any other row.

**Keyboard**: `E` in sketch mode does nothing though the plan says it extrudes; the plane prompt promises `P polygon`; the fillet card says "tap R" with no handler; Ctrl/Cmd+J (assistant) missing from the shortcuts overlay; `?` overlay could not be opened when focus was in a text field (expected) and focus returns to the last input after closing the palette.

**Layout**: at 1440×900 the tools fold takes 371 px and History starts near the bottom; dock buttons 26 px; kbd badges 10 px at 3.9:1; section titles 11 px; history rows 23 px with 11.5 px text.

**Status of earlier review items** (2 Sept and 11 Sept): fixed — delete confirm/toast, box-select threshold, status lifetime, inspector demotion under a running command, tile truncation, viewport face pick for Hole, body naming by last feature, boolean pick hints, plane chips; still open — sketch orbit normal-to-sketch control, Sketch palette default (now collapsed), Finish placement (now the column header), "Total N mm" readout overlapping the hover label, primitives with no placement, Scale about the origin.

---

## 5. Coverage, evidence and uncertainties

### 5.1 Coverage matrix

| Area                                    | Item                                                                       | Status                                                     |
| --------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Start                                   | New project, units picker, tour, demo cards, tile reopen                   | tested                                                     |
| Sketch                                  | Ghost-plane pick, plane buttons                                            | tested · offset field not tested                           |
| Sketch                                  | Rectangle/circle by drag; entity editor; Enter commit; re-edit via history | tested                                                     |
| Sketch                                  | Line chain, arc, text; polygon                                             | code + e2e only · polygon unavailable on the rail          |
| Sketch                                  | Typed dimension while drawing                                              | not hand-verified (e2e `modeling.spec.ts:3329`)            |
| Sketch                                  | Constraints, driving dimensions, Solve, DOF pill                           | not hand-verified (e2e `workspace-polish.spec.ts:371,496`) |
| Sketch                                  | Snapping to sketch geometry / to body edges                                | code-verified / hands-on: none                             |
| Sketch                                  | Sketch on face: associative, fixed-plane fallback, non-planar pick         | tested                                                     |
| Sketch                                  | Open-profile feedback, Diagnostics button                                  | tested / partially                                         |
| Body                                    | Extrude new/add/cut typed and dragged; symmetric/back distance             | tested / not tested                                        |
| Body                                    | Revolve, Loft, Sweep, Helical                                              | not tested (forms mapped)                                  |
| Body                                    | Box, Cylinder / Sphere, Cone, Torus                                        | tested / not tested                                        |
| Edit                                    | Fillet by edge + keypad, refusal at R50 / Chamfer                          | tested / not tested                                        |
| Edit                                    | Hole create + preflight; Hole edit                                         | tested; editor confirmed absent                            |
| Edit                                    | Shell, Draft, Thicken, Solid offset                                        | not tested                                                 |
| Edit                                    | Offset-face and cylinder-radius handles (armed) ; drags                    | partially · drags not run                                  |
| Bodies                                  | Move panel, Mirror, Split, Union, Subtract, Intersect                      | tested (Split refused) · Intersect not tested              |
| Pattern                                 | Grid / Linear / Circular                                                   | tested / form only / not tested                            |
| Revision                                | Parameters, undo/redo, delete + toast + repair, suppress, rollback/resume  | tested                                                     |
| Persistence                             | Autosave, reload, Ctrl+S, STEP export, mesh dialog                         | tested (download not observable)                           |
| Import                                  | STEP import, imported face direct edit, hole diameter apply                | tested / armed only / not tested                           |
| Modes                                   | View, Tweak, Build                                                         | tested (read-only look)                                    |
| Layout                                  | 1440×900, 1280×720, 1024×768; light theme                                  | tested / not tested                                        |
| Accessibility                           | Focus order, labels, token contrast                                        | partially                                                  |
| AI assistant, collaboration, cloud sync |                                                                            | not tested (no key, signed out)                            |
| Desktop (WKWebView)                     |                                                                            | unavailable                                                |

### 5.2 Evidence kept

The chronological log (`findings-log.md`) and the probe outputs are in the session scratchpad; the two dumped documents (`bracket-two-bodies.json`, `hole-plate-subtract-fail.json`) reproduce C1 and C2/C3 through `normalizeDocument` + `createExactKernelAdapter().syncDocument`. Kernel probe numbers quoted above: touching primitive boxes union → 57,600 mm³ / 8 faces; dumped bracket union → 57,600 / 14 faces + orientation error; subtract y=15 → 35,830 / 7; y=0 → refusal.

### 5.3 Uncertainties

- Hover feedback, drag smoothness, preview latency and camera glides could not be judged in a hidden pane; earlier headed measurements (`docs/interaction-design.md`) stand.
- The fillet handle at the edge end (I11) was seen once and may be a stale readout.
- C5 (size readout 63) was not re-derived in the kernel probe.
- Light theme, trackpad gestures, touch and the desktop shell were not exercised.
- The agent-mapped claims (W1 beyond Hole, W8, W15, W16, I16) were spot-checked in code but not all driven by hand.

---

## 6. Recommended future interaction model

The current model has four stacked structures: a workspace mode (View/Tweak/Build), a sketch mode entered and left with camera choreography, a tool state (form in the inspector or card in the viewport), and a selection machine that arms handles. Users feel the seams: the sketch rail replaces the toolbar, Extrude exits the sketch, the inspector and the card both claim to be the command surface, and ten features can only be created.

The recommended model collapses those into **one object-centric loop**: _look → select → adjust → commit_, where every object (region, face, edge, body, feature, dimension) has the same three affordances — a handle you can drag, a value you can type, and a row you can revisit — and where "sketch" is a plane you are looking at, not a mode you have to leave.

1. **Sketching is an overlay, not a mode.** Picking a plane orients the camera and shows the sketch tools, but bodies stay pickable (ghosted), the Build tools stay visible (greyed only when meaningless), and pulling a region extrudes it in place without a "Finish". Leaving is implicit: orbit away or pick a body. A sketch is "done" when something consumes it or the user clicks elsewhere; an open profile is a visible red-endpoint state, not a hidden failure.
2. **Every feature is a handle first, a form second.** Hole: a cylinder ghost with a Ø chip and two position dimensions to projected edges. Pattern: count and spacing handles on the instance array. Fillet: the radius sphere (exists). Extrude: the arrow (exists). The form remains for expressions, names and rare options, opened from the chip or the row, and is the same form for create and edit.
3. **One commit contract.** Preview on every change (kernel rebuild at its own rate, proxy geometry meanwhile), commit on Enter or empty-click, refusal in place with Details and the last valid value kept. No "Check exact result" button; preflight _is_ the preview.
4. **Sketch geometry can reference the model.** Projected edges and vertices are snap targets and constraint references; dimensions to them are stored with lineage and fail closed with a named reason.
5. **One feedback rail.** A single status line at the bottom owns the current prompt (visible, not a11y-only), outcomes and refusals appear where the value is, Diagnostics rows are actionable and never count suppression, and nothing is said twice.
6. **The history is one tree with the bodies.** Rows carry inline rename, a state badge (paused, failed with a plain sentence, rolled back), the dependents chain on hover, and open the same editor as creation.
7. **Modes become filters.** View and Tweak remain as read-only projections of the same shell (they already are), but Tweak gains undo and diagnostics, and Measure is available in Build.

Engineering trust is preserved because nothing changes in the document model: every handle still produces the same commands the forms produce, every preview still goes through the exact kernel before commit, and lineage-backed references keep the fail-closed rule. What changes is which surface is authoritative (the object in the viewport) and how many steps stand between intent and a validated commit.

---

## 7. Before / after flows for the highest-impact improvements

### 7.1 Flange on a plate (C1, W3, W4, W6)

**Before.** S → click side face → zoom out → drag rectangle (does not snap) → select → retype four fields → rail Extrude (sketch closes, camera returns) → type −8 → second body → U → refused → hunt for Add in the Extrude row → 14-face body with a seam.
**After.** S → click side face (camera face-on, framed with margin) → drag rectangle: its bottom edge snaps to the projected plate corner (glyph "endpoint"), live dimensions read 80 × 40 → pull the region _into_ the plate: the preview is cyan, the chip reads "−8 mm · join"; release → one body, 8 faces. Later, `w` = 100 moves the flange because its width was dimensioned to the projected plate edge.

### 7.2 Six holes (W1, W2, W5)

**Before.** Box → Hole form (7 fields, Check, Create) → Cylinder → Move panel → Grid pattern form → select two bodies → Subtract → six holes, none editable.
**After.** Click the top face → Hole: a ghost cylinder follows the cursor with Ø 6 and two dimensions to the nearest edges; click to place, type 30 Tab 15 Enter. Click the hole → Pattern: drag the count handle to 3, spacing 30; drag the second axis to 2 × 30; Enter. Later, click any hole: the Ø chip edits all six; click the pattern: counts and spacing are handles again.

### 7.3 A refused operation (C3, C6, I6)

**Before.** "Boolean subtract added." + warnings 1 + a raw Diagnostics sentence; or one sentence in three places for a fillet.
**After.** The Create button's preview turns amber and the form shows one sentence: "This cut crosses the edge of the plate's front face; notches are not supported yet — move the tool inside the face or use Hole." with Details holding the kernel text. Nothing is written to history. For fillet: the card sentence only; the keypad keeps the value; the status line shows the prompt.

### 7.4 Revising a hole (W1, W17)

**Before.** Click the Hole row → measurements and Delete → delete, recreate, re-pick the face, retype.
**After.** Click the hole in the viewport (or its row) → the same handle set appears (Ø chip, position dimensions, depth arrow) → drag or type → Enter → history row updates; undo restores both the value and the selection.

### 7.5 Text editing vs document undo (C4)

**Before.** Cmd+Z in a field rewinds the model.
**After.** Cmd+Z in a field is text undo; the document shortcut applies only when the workspace has focus, and the toolbar Undo button reads "Undo Set parameter w".

---

## 8. Bold proposals

### B1 — Sketch as overlay (replace sketch mode)

- **Need / evidence.** The mode boundary produces the camera round-trip on Extrude, the rail-swap, the "one closed profile" copy, the Finish button, the dead `E`, and the filter trap (J1, I9, W9).
- **Incremental.** Keep the mode but make rail Extrude stay in the sketch view (the plan's §2.1 already intended this), default the tool to Select on re-entry, paint the prompt, and force the Face filter during plane picking.
- **Ambitious.** No mode: sketch tools appear when a plane is active, bodies stay pickable and ghosted, regions are always live, and a sketch is consumed or left by acting elsewhere. The column shows one tree.
- **Preferred.** Ambitious, staged behind the existing `experiments` flag pattern; the machine already models sketch as a session state, so the change is mostly in what the shell hides.
- **Trade-offs.** Discoverability: a beginner loses the explicit "you are sketching" frame — replace it with the plane tint and a persistent "Sketching on Top (XY) — press Esc to leave" line. Experts gain roughly a third fewer steps per feature. Migration: no document change. Risk: accidental body picks while sketching — mitigate with the ghosting and a region-first pick priority (already coded).
- **Prototype first.** A flag that keeps the Build tools visible in sketch mode and lets rail Extrude pull in place; measure steps and errors on J1 with two or three users.

### B2 — Everything is a handle (feature editors as gizmos)

- **Need.** W1, W2, W5: ten write-once features, no previews, two commit contracts.
- **Incremental.** Reuse creation forms as editors for the ten kinds; add preview to `ModelingOperationsForm`; drop the Check step.
- **Ambitious.** A handle kit per feature (hole, pattern, shell thickness, draft angle, mirror plane) built on the existing `DragRig`/keypad/LivePreview stack; forms become secondary.
- **Preferred.** Incremental first (weeks), ambitious for Hole and Pattern next (they carry most of J2), others as demand shows.
- **Trade-offs.** Gizmo clutter on small parts — show one feature's handles at a time; keyboard users keep the form path.
- **Prototype.** Hole handle with Ø chip and two edge dimensions; test placement precision and time-to-first-hole.

### B3 — One feedback rail

- **Need.** I6, I7, I9, C6, C7, V1.
- **Incremental.** Give every message an owner (prompt / outcome / refusal) and a single sink; paint the prompt line; translate warnings; stop counting suppression.
- **Ambitious.** Replace toast + status + card hint + form alert with one bottom rail (prompt on the left, outcome in the middle, warnings count on the right) plus in-place refusals, and an activity log behind it.
- **Preferred.** Ambitious; the code already funnels through `WorkspaceReadout` and `commandOutcome`.

### B4 — Precision by default

- **Need.** I1, I2, W4.
- **Incremental.** Format values, grid snap on, u/v glyph, dimension labels.
- **Ambitious.** Dimension-driven sketching: every drawn entity creates editable dimensions that become constraints when edited (the solver and dimension annotations exist).
- **Preferred.** Incremental now, ambitious with B5.

### B5 — Geometry references for sketches (projected edges) and feature patterns

- **Need.** W3, W2.
- **Design.** Project coplanar and silhouette edges into the sketch as snap/constraint references keyed by lineage name; feature patterns as a feature kind over hole/cut/boss with the pattern-body builder underneath.
- **Trade-offs.** Lineage is hash-only after booleans on many faces (ADR-011/013); references to hash-only edges must fail closed with the fixed-frame fallback and a named reason, as sketches on faces already do.
- **Prototype.** Projected-edge snapping only (no constraints) to measure precision gains on J1.

### B6 — Kernel trust pass

- **Need.** C1, C2, C3.
- **Plan.** Fix the extrude sign; validate every feature path the way union is validated; add straddle detection to boolean preflight; pin parity tests for ±distance extrudes and edge-crossing tools.

---

## 9. Roadmap

Value order first; effort is a separate column so cheap fixes do not push out the valuable ones. Effort is engineering days for one person including tests and a browser check, not calendar time.

| Phase                    | Scope (finding IDs)                                                                                                                                                                                                                         | Value                                        | Effort                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------- |
| 0 · Trust                | C1 far-plane sweep (PR #302) + validated add/cut · C3 validated commits everywhere · C4 text-field undo · C6 translate warnings, drop ids · C7 suppression not a warning · C8 enablement on committed state · I7 outcome copy               | Very high — stops silent corruption and lies | 6–9                           |
| 1 · Precision            | I1 formatting + field width · I2 grid snap default + dimension labels · W4 frame glyph and field names · I3 edge hit band · W9 filter during plane pick + non-planar feedback · I8/I9 snapping readouts, visible prompt, unclipped messages | High — daily friction on every sketch        | 6–8                           |
| 2 · Edit everything      | W1 editors for the ten kinds · W8 fillet retarget, rename in rows, parameter rename, units copy · W17 undo keeps selection and label · W13 History minimum height · W10 plane defaults at body centre                                       | High — makes the history a real model        | 10–14                         |
| 3 · One command surface  | W5 preview + single commit contract · B3 feedback rail · I10 object panel · I6 dedupe · W6 direction rule for face sketches · W11 extrude defaults                                                                                          | High — coherence across all tools            | 10–15                         |
| 4 · Handles and patterns | B2 Hole and Pattern handles · W2 feature patterns · sketch pattern                                                                                                                                                                          | Very high for J2-type parts                  | 15–25                         |
| 5 · Sketch as overlay    | B1 flagged rollout · W15 entity drag, Enter finishes, polygon on rail, trim/extend                                                                                                                                                          | High — expert speed, beginner clarity        | 20–30                         |
| 6 · References           | B5 projected edges → snap → constraints                                                                                                                                                                                                     | Very high for revision journeys              | 20–30 (+ kernel lineage work) |
| Parallel · Kernel        | C2 edge-crossing booleans · C5 bbox readout · union of face-coincident results after fixes                                                                                                                                                  | High                                         | kernel team                   |
| Parallel · Access        | A1 labels · A2 cube focus · A3 dim token · dock target sizes                                                                                                                                                                                | Medium                                       | 2–3                           |

Dependencies: Phase 0 before anything user-facing (every later phase relies on refusals being true); Phase 3's preview stack is what Phase 4's handles ride on; Phase 6 depends on lineage coverage and on Phase 5's live-sketch picking. Phases 1 and 2 can run in parallel with each other.

What to keep as-is: the ghost-plane picker and face-on glide, the region rig and cap re-arm, the keypad with unit chips and expressions, the validated-commit refusal card with Keep/Edit, the delete toast with dependents, rollback/resume, the selection chip with `U/X/I`, named faces in pick lists, the View-mode clean deck, the export dialog, and the start screen.
