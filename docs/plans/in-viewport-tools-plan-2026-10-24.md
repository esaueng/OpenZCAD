# In-viewport tools plan: every tool works where the geometry is (2026-10-24)

Status: **approved 2026-10-24 with every §7 recommendation.** Delivery status lives in [ROADMAP.md](../../ROADMAP.md) row U09, not here.
Source: a live drive of all 32 Build tools on `main` at `af5a1b17` (dev
server, signed out, 1280×800), plus the owner's 2026-10-24 reference
recording of a revolve (59 s). Earlier rules from
[reference-workflow-plan-2026-10-04.md](reference-workflow-plan-2026-10-04.md)
§1 still apply; this plan extends them from push/pull, extrude and fillet to
every tool.

## 1. What the recording shows

The revolve in the recording has no side card at any point:

1. Draw a rectangle in a sketch and finish it.
2. Click the region. The left command list now shows only the commands that
   apply to a profile (Move/Rotate, Scale Sketch, Pattern, Extrude, Rotate
   Around Axis; More → Revolve, Sweep, Loft, Mirror…).
3. Click **Revolve**. A one-line hint at the top centre reads "Select a
   sketch profile or face and an axis to create a revolved body". The
   profile is already filled from the selection.
4. Click a sketch edge to use it as the axis. On the next frame the full
   360° solid appears as a preview, with a dashed circle and an angle handle
   carrying a `360°` chip.
5. Drag the handle round: the chip reads `−270°` and the solid follows. A bad
   value typed into the chip shows "Invalid expression" in the hint slot.
6. The only controls are a **Cancel (Esc) / Done (↵)** pill at the bottom
   centre. Done commits; History gains "Revolve 01".

The rule this adds to the October list: **a command is a sequence of picks
in the model, then handles on the evaluated result. Its inputs are slots
filled by clicking, and its numbers live on chips. A form is never the
primary surface.**

## 2. Audit: what each tool does today

"Viewport" means something the user can see or drag in the model while the
tool is open. "Typed" lists the fields that only a form can set.

| Tool                                   | How it opens          | In the viewport today                                                                  | Typed-only inputs today                                                                                           |
| -------------------------------------- | --------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Sketch                                 | Rail, `S`             | Ghost planes or face pick, in-place drawing, dimensions at the cursor, constraint rail | None. **Already the target model.**                                                                               |
| Extrude                                | Region click, `E`     | Arrow handle at the pick point, swept preview, chip/keypad, cut by direction           | Extent options (to face etc.) in the card. **Already mostly the target.**                                         |
| Face push/pull (Resize/Offset)         | Face click            | Arrow with Total/Offset chip, selection card with Resize/Offset/Sketch/Hole            | None                                                                                                              |
| Cylinder diameter                      | Wall click            | Radial handle, ⌀ chip                                                                  | None                                                                                                              |
| Fillet                                 | Edge click or tool    | Edge pick (Shift adds), `R` handle and chip on the edge                                | Card stays open beside the handle: radius field and slider (duplicating the chip), end radius, radius-change mode |
| Chamfer                                | Edge click or tool    | Same as fillet                                                                         | Angle, second distance                                                                                            |
| Hole                                   | Face card, tool       | Bore ghost; **a click on the face sets U/V**                                           | Style, diameter, depth mode, U/V fields; the ghost cannot be dragged                                              |
| Move / Rotate                          | `M`, body card        | Translate/rotate gizmo with snapping                                                   | Gizmo also mirrored as six number fields (fine as a fallback)                                                     |
| Box / Cylinder / Sphere / Cone / Torus | Rail                  | Translucent preview of the default size at the origin (display only)                   | Every dimension and the position (3–5 numbers + XYZ)                                                              |
| Plane                                  | More tools            | **No plane preview before Done**                                                       | Mode (offset/midplane/3 points/parallel), source plane dropdown, offset, flip                                     |
| Axis                                   | More tools            | None while open                                                                        | Mode, from/to points as dropdowns or typed positions                                                              |
| Image                                  | More tools            | Placed image quad after creation                                                       | Not driven: it needs a file                                                                                       |
| Revolve                                | More tools            | **No preview, no axis shown**                                                          | Sketch dropdown, axis limited to "sketch vertical/horizontal axis" (no edge or datum axis), angle                 |
| Loft                                   | More tools            | Not driven: disabled until two closed profiles exist                                   | Profile order in the card (from code)                                                                             |
| Sweep                                  | More tools            | None while open                                                                        | Profile, path sketch, guide rail, surface mode, all as dropdowns                                                  |
| Helical sweep                          | More tools            | None while open                                                                        | Profile, axis origin XYZ, axis direction XYZ, radius, pitch, turns                                                |
| Shell                                  | More tools            | "Pick faces in viewport" button fills a face list; **no preview**                      | Target body, wall thickness                                                                                       |
| Draft                                  | More tools            | Face pick button; no preview                                                           | Pull direction as an XYZ vector, neutral point XYZ, angle                                                         |
| Thicken                                | More tools            | Face pick button; no preview                                                           | Signed thickness                                                                                                  |
| Solid offset                           | More tools            | None                                                                                   | Target body, distance                                                                                             |
| Scale                                  | More tools            | None                                                                                   | **The full transform form**: dX/dY/dZ, rX/rY/rZ, scale ×, pivot XYZ (13 fields)                                   |
| Rotate about axis                      | More tools            | None                                                                                   | Body, copy, axis dropdown ("Create an axis first" with no datum axis)                                             |
| Mirror                                 | Body card, More tools | **No mirror-plane or ghost preview**                                                   | Plane chips plus origin XYZ and normal XYZ fields                                                                 |
| Split                                  | More tools            | No plane preview                                                                       | Same plane fields, keep original                                                                                  |
| Union / Subtract / Intersect           | `U`/`X`/`I`           | Click bodies in the viewport or list; pick order sets the base                         | Operation dropdown, "keep originals". A result preview was not checked visually                                   |
| Linear pattern                         | More tools            | **No preview of the copies**                                                           | Body, count, axis X/Y/Z, spacing, custom direction XYZ                                                            |
| Circular pattern                       | More tools            | No preview                                                                             | Body, count, axis X/Y/Z, total angle                                                                              |
| Grid pattern                           | More tools            | No preview                                                                             | Two each of count, axis and spacing                                                                               |

What the selection card offers per selection, measured live:

| Selection     | Verbs offered today                                                  |
| ------------- | -------------------------------------------------------------------- |
| Planar face   | Resize, Offset, Sketch, Hole                                         |
| Edge          | Fillet, Chamfer, All N edges                                         |
| Sketch region | Extrude arrow only (hint: "Drag the arrow off the plane to extrude") |
| Body          | Move, Mirror                                                         |

So seven tools are already direct (Sketch, Extrude, push/pull, diameter,
fillet/chamfer drag, Move), three are hybrids (Fillet/Chamfer card, Hole,
primitives), and the remaining 20 are forms with nothing to see until after
Create.

## 3. The one interaction contract

Every tool becomes the same five-part command. Nothing here is specific to
one tool; the per-tool work in §5 is filling in a table row.

1. **Entry.** Either select first and pick a verb from the selection card, or
   pick a tool first. Tool-first opens the same command with empty slots.
2. **Slots, filled by clicking.** A command declares its inputs (profile,
   axis, faces, bodies, plane, path, point), each with a pick filter. The
   current selection fills what it can, and the hint names the next empty
   slot: "Pick an axis: a sketch line, an edge, a cylinder or a datum axis".
   Clicking a filled slot's chip in the hint re-opens it for re-picking.
3. **Evaluated preview as soon as the required slots are filled**, built by
   the existing single-in-flight `livePreview` path from the real command
   factory, so the preview is the commit. The October rules apply: hard-cut
   state changes, refusal keeps the last valid preview, `Keep <value>`.
4. **Handles for the numbers.** Each numeric input is a rig (linear, angular,
   count, plane or point) with a chip; the chip opens the existing
   `NumericKeypad`, and expressions stay parametric. Starting values are the
   model's current dimension.
5. **Done / Cancel pill** at the bottom centre: Enter commits, Esc cancels.
   Rarely used options (end radius, surface mode, keep originals, extent
   modes) sit behind a `⋯ Options` popover on the pill, not in a standing
   card.

The side card does not have to vanish at once. During the migration it
collapses to the Options popover for converted tools and stays as it is for
unconverted ones, so nothing loses a way in.

## 4. Shared infrastructure (phase 1)

Each piece below reuses something that already exists:

| Piece                                                                            | Builds on                                                                                                 | New work                                                                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| In-place command shell: hint slot, slot chips, Done/Cancel pill, Options popover | `workspace-hint`, `UnappliedCardDialog`, U01 Enter/Escape contract                                        | One `InPlaceCommand` component and a declarative command spec (slots, rigs, options, factory)           |
| Pick slots with filters                                                          | `machine.ts` select-face/edge/region actions, `PickDetail`, the Hole/Shell `viewportFacePick` path (#285) | A slot-aware pick router: which selection kinds a slot accepts, auto-advance, Shift to add              |
| Generic exact preview                                                            | `livePreview.ts`, `previewDoc`, `executeValidatedDirectEdit`                                              | Run any command factory as a preview with the same coalescing and refusal handling                      |
| Angular rig                                                                      | `DragRig` (linear today; its header already names "an angle handle for a revolve")                        | A rotational variant: centre, axis, angle, arc/ring visuals, angle snapping from `chooseRotateSnapStep` |
| Count/spacing rig                                                                | `DragRig`, linear rig                                                                                     | Spacing arrow plus `+`/`−` count steppers on the chip                                                   |
| Plane rig                                                                        | `planePickerRig`, `datumPlaneRig`, `datumOffsetHandle`                                                    | A draggable plane: normal arrow for offset, rings for tilt, snaps to faces and principal planes         |
| Point rig                                                                        | Hole's click-to-place U/V                                                                                 | Drag a marker over a face, with snaps to the face centre, edges and other holes                         |
| Selection-driven verbs                                                           | `capabilities.ts` (`SelectionActionId`), `SelectionCard`                                                  | Extend the action table to every tool per selection kind (§5)                                           |

The proof for phase 1 is Revolve, done exactly as in the recording.

## 5. Proposed gesture per tool

| Tool                                       | Slots (picked)                                                                                                          | Handles                                                                                                                    | Left in Options                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Revolve**                                | Profile (region or face) → axis (sketch line, edge, cylinder axis, datum axis, principal axis)                          | Angle rig with chip; 360° by default                                                                                       | Two-sided/symmetric                                                                                           |
| **Sweep**                                  | Profile → path (sketch curves or edges, Shift adds) → optional guide rail                                               | None; the preview updates on each pick                                                                                     | Surface mode                                                                                                  |
| **Loft**                                   | Profiles in click order, with numbered badges at each pick; optional apex: a picked point closes the last section to it | Apex handle along the last section's normal while an apex is set                                                           | Ruled/smooth; apex on/off                                                                                     |
| **Helical sweep**                          | Profile → axis (same filter as Revolve)                                                                                 | Radius (radial rig), pitch (linear rig along the axis), turns (count chip)                                                 | Handedness                                                                                                    |
| **Extrude**                                | Unchanged                                                                                                               | Unchanged arrow; a second arrow on the back face for an independent back distance; a draft angle rig on a side wall        | Extent modes, symmetric, back distance and draft angle move from the card to Options as well as their handles |
| **Fillet / Chamfer**                       | Edges (Shift adds)                                                                                                      | Existing `R`/distance rig                                                                                                  | End radius and radius change (fillet); angle and second distance (chamfer). The card goes                     |
| **Hole**                                   | Face, where the click point is the position                                                                             | Point rig to drag the position; diameter radial rig; depth linear rig, with through-all as a snap at the far face          | Style (counterbore/countersink), standard sizes                                                               |
| **Shell**                                  | Faces to open (Shift adds), body inferred                                                                               | Wall-thickness linear rig on the first opened face, pointing inward                                                        | Inward/outward                                                                                                |
| **Draft**                                  | Faces → neutral plane or edge (pull direction defaults to its normal)                                                   | Angle rig hinged on the neutral edge                                                                                       | Flip pull direction                                                                                           |
| **Thicken**                                | Face                                                                                                                    | Signed thickness linear rig along the normal                                                                               | None                                                                                                          |
| **Solid offset**                           | Body                                                                                                                    | Linear rig on the face nearest the click                                                                                   | None                                                                                                          |
| **Scale**                                  | Body → optional pivot (point; default the bounding-box centre, not the origin)                                          | Corner scale handle with a `×` chip                                                                                        | Non-uniform (later)                                                                                           |
| **Rotate about axis**                      | Body → axis (edge, cylinder, datum, principal; no datum needed)                                                         | Angle rig                                                                                                                  | Copy                                                                                                          |
| **Move**                                   | Unchanged (gizmo)                                                                                                       | Unchanged                                                                                                                  | The six number fields move to Options                                                                         |
| **Mirror**                                 | Body → plane (face, datum or principal plane)                                                                           | Plane rig; the mirrored ghost is the preview                                                                               | Keep original                                                                                                 |
| **Split**                                  | Body → plane (face, datum, principal)                                                                                   | Plane rig to slide or tilt the cut; both halves tinted                                                                     | Keep original                                                                                                 |
| **Union / Subtract / Intersect**           | Base body → tool bodies (Shift adds)                                                                                    | None; the evaluated result shows as the preview                                                                            | Keep originals. The operation becomes a segmented chip in the hint, not a dropdown                            |
| **Linear pattern**                         | Body or feature → direction (edge, axis, face normal)                                                                   | Spacing rig with count steppers; copies shown as ghosts                                                                    | Custom vector                                                                                                 |
| **Circular pattern**                       | Body → axis                                                                                                             | Angle rig for the total angle, count steppers                                                                              | Equal spacing / fixed step                                                                                    |
| **Grid pattern**                           | Body → two directions                                                                                                   | Two spacing rigs, each with count steppers                                                                                 | None                                                                                                          |
| **Plane**                                  | Source face, plane, or three points                                                                                     | Plane rig with an offset chip; midplane = pick two faces                                                                   | Flip normal                                                                                                   |
| **Axis**                                   | Edge, cylinder, two points, or two planes, inferred from what is picked                                                 | None                                                                                                                       | Reverse                                                                                                       |
| **Box / Cylinder / Cone / Sphere / Torus** | Placement plane or face, then click to place                                                                            | Drag the footprint like the sketch rectangle and circle, then a height arrow, as one gesture; the chips are the dimensions | Exact position                                                                                                |
| **Image**                                  | Plane or face, then click to place; calibrate by clicking two points on the image                                       | Corner scale handle, rotation ring; after a calibration pick, a length chip for the real distance between the two points   | Opacity                                                                                                       |

Selection card verbs after the change:

| Selection          | Verbs                                                                        |
| ------------------ | ---------------------------------------------------------------------------- |
| Sketch region      | Extrude, Revolve, Sweep, Loft (when two or more are selected), Pattern, Move |
| Planar face        | Resize, Offset, Sketch, Hole, Shell, Draft, Thicken, Plane                   |
| Cylindrical face   | Diameter, Hole (coaxial), Axis, Shell                                        |
| Edge               | Fillet, Chamfer, Axis, Revolve axis (while revolving)                        |
| Body               | Move, Rotate, Scale, Mirror, Split, Pattern, Shell, Solid offset             |
| Two or more bodies | Union, Subtract, Intersect, Move                                             |

## 6. Phases and PRs

Each PR is a branch off `origin/main`, never stacked. "Done" for every tool
PR means: the tool works with zero form fields, has an e2e spec that drives
it entirely by picks, drags and the keypad, and matches the AI patch path
(the same command factory).

| Phase | PRs                                                                                                                                                                                                                       | Outcome                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 0     | A: this plan plus a ROADMAP row (proposed **U09**, in-viewport commands)                                                                                                                                                  | Ledger entry                            |
| 1     | B: `InPlaceCommand` shell, slot router and generic exact preview. C: angular rig. D: **Revolve** on B+C, exactly as in the recording                                                                                      | The contract is proven end to end       |
| 2     | E: Sweep + Loft (slot-only, no new rigs). F: Helical sweep                                                                                                                                                                | Every From-sketch tool is in place      |
| 3     | G: Fillet/Chamfer drop their card. H: Hole point rig, diameter and depth. I: Shell, Thicken, Solid offset (linear rigs). J: Draft (angular rig)                                                                           | Every Edges & faces tool is in place    |
| 4     | K: plane rig, then Mirror and Split. L: Rotate about axis (angular rig, any axis). M: Scale (scale handle, centroid pivot, its own spec, not the transform form). N: booleans with a result preview and an operation chip | Every Bodies tool is in place           |
| 5     | O: count/spacing rig, then Linear, Circular and Grid patterns with ghost copies                                                                                                                                           | Every Pattern tool is in place          |
| 6     | P: Plane and Axis in place. Q: primitives by click-drag placement. R: Image placement handles                                                                                                                             | Every Create tool is in place           |
| 7     | S: selection card verb table (§5), Options popovers replace the remaining cards, delete the dead form paths                                                                                                               | The forms are gone as a primary surface |

C can run alongside B. After phase 1, phases 2–6 are independent of each
other, so they can run in parallel sessions.

## 7. Decisions for the owner

1. **The tool card.** **Decided 2026-10-24: remove it.** For converted
   tools the feature form goes away; rare options move to a `⋯ Options`
   popover on the Done pill, Tab steps between handle chips, and a History
   row re-arms the same handles for editing. This is the tool card only:
   the docked model panels (Objects, History, Parameters, Revisions,
   Diagnostics) are unchanged.
2. **Selection-driven command list.** **Decided 2026-10-24: grow the
   selection card's verbs (§5) and keep the rail fixed**, dimming rail tools
   that do not apply to the selection. The rail is not filtered as in the
   recording, so tools never move.
3. **Primitives.** **Decided 2026-10-24: keep them, placed by click-drag**
   (footprint on a plane or face, then height, as one gesture). They stay
   editable primitive features.
4. **Default pivots.** **Decided 2026-10-24:** Scale defaults to the body's
   bounding-box centre, shown as a pivot dot that can be re-picked; patterns
   use the picked direction or axis. Stored features keep their explicit
   pivot, so existing documents rebuild unchanged.
5. **First slice.** **Decided 2026-10-24: phase 1 with Revolve**, exactly as
   in the recording, before anything else.

## 8. Defects seen during the audit (fix inside the phase that owns them)

- Scale opens the full 13-field transform form (phase 4, M).
- Plane shows no plane before Done (phase 6, P).
- Revolve can only use the sketch's own horizontal or vertical axis (phase 1, D).
- Rotate about axis is unusable without first creating a datum axis (phase 4, L).
- A region selection offers only Extrude; a body selection offers only Move and Mirror (phase 7, S).
- The Fillet card's radius field and slider duplicate the on-model chip (phase 3, G).
- Helical sweep and Draft take axes and directions as raw XYZ vectors (phases 2 and 3).
