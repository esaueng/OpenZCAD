# D07 geometric tolerancing and model-based definition

D07 adds geometric tolerancing to drawings, then to the 3D model, then to
STEP: datum features and feature control frames on drawing views (ASME
Y14.5-2018 and ISO 1101 symbols), general-tolerance blocks and hole and
thread tolerance classes, the same annotations stored on the model, and
STEP AP242 semantic PMI. Like every D02 annotation, they store intent only
and stay attached through model edits or show as broken.

## Slices

| Slice | Scope                                                                                                                     | Schema   |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | -------- |
| A     | Datum feature symbols and feature control frames on drawing views                                                         | v98      |
| B     | General-tolerance block (ISO 2768-1 classes, or a stated block) and hole and thread tolerance classes on M01 callouts     | additive |
| C     | Model-based definition: datum features and frames stored on the model's faces, shown in the viewport, and listed per body | v106     |
| D     | STEP AP242 semantic PMI written from slice C, through the I0x lane's STEP writer                                          | none     |

Slice D depends on the I0x lane: it owns the STEP writer and the AP242
protocol choice (I04), so the PMI entities land through its PRs or after them,
never by editing its open branches.

## Slice A: datum symbols and feature control frames (schema v98)

- **Shape.** Two drawing annotation kinds on a view. `datum-feature` holds a
  letter: one or two capitals from A–Z without I, O and Q, which both
  standards skip. `feature-control-frame` holds a characteristic, a
  tolerance `amount` (positive, at most six decimals, in the units the
  sheet prints in, like a dimension tolerance), an optional cylindrical
  zone (Ø), an optional material condition (Ⓜ or Ⓛ), and up to three datum
  references, each with an optional Ⓜ or Ⓛ. Each points at what it controls
  in one of two ways, and stores exactly one:
  - `leader`: an edge, held like a note's leader (lineage, then hash). It is
    a surface seen edge-on, or a feature's outline.
  - `attachedTo`: the dimension of a feature of size. A frame sits under the
    dimension's value. A datum symbol may also hang from a frame.

  A datum symbol is never a host, so attachments nest at most two deep and
  never cycle.

- **Characteristics.** All fourteen: straightness, flatness, circularity,
  cylindricity, profile of a line or surface, parallelism,
  perpendicularity, angularity, position, concentricity, symmetry, circular
  and total runout. Concentricity and symmetry are ISO 1101's (Y14.5-2018
  dropped them); the picker labels them so.
- **Rules the validator enforces by name.**
  - A form tolerance takes no datum.
  - Orientation, runout, concentricity and symmetry need at least one datum.
  - Only axis-capable characteristics take a Ø zone.
  - Only straightness, orientation and position take a material modifier.
  - Only position, orientation and profile datums take one.
  - A frame names each datum once.
  - A host must be a dimension (or, for a datum symbol, a frame) on the
    same view.
- **Resolution.** Read each time the sheet is drawn, like every annotation.
  These break by name; nothing is ever re-lettered or reattached:
  - `datum-duplicate`: two symbols anywhere in the drawing declare the same
    letter, which makes both ambiguous.
  - `datum-undefined`: a frame names a letter no symbol declares on any
    sheet. A frame may name a datum declared on another sheet.
  - `host-missing`: the host was deleted.
  - `host-broken`: the host is broken. This cascades from a dimension to
    its frame to a datum symbol hanging from it.
  - A lost leader edge breaks the way a note's does.
- **Page.** Sheet text is base-14 Helvetica (WinAnsi), which has no GD&T
  glyphs, so the characteristic symbols and circled modifiers are drawn as
  strokes in their cells (`toleranceFrames.ts`). Ø is WinAnsi text.
  - A frame is twice the 3 mm text height, with a square symbol cell, then
    the tolerance cell, then one cell per datum.
  - A frame on a leader has the middle of its left side at its placement,
    and an arrow from its nearer side to the nearest drawn point of its
    edge.
  - An attached frame sits 1 mm under its dimension's text, left-aligned,
    and moves with it.
  - A datum symbol is its letter in a square frame on a line ending in a
    filled 60° triangle, whose base stands on the nearest drawn point of its
    edge or its host's outline.

  Attachments are laid out after their hosts, so a sheet without them lays
  out exactly as before. Everything goes through the one page model to the
  preview, PDF, SVG and DXF; filled triangles are DXF SOLIDs.

- **Tools.** Datum feature (Q) and Feature control frame (F), in their own
  rail group.
  - **Placing.** Pick an edge, or click a healthy size dimension (for a datum
    symbol, also a frame) to attach to, then place. A new datum symbol takes
    the drawing's next free letter. A new frame states flatness, which needs
    no datum, at 0.1 mm (0.004 in) in the sheet's units, and Properties
    opens on it.
  - **Properties.** Disable what the characteristic cannot take. Changing
    the characteristic drops what it no longer takes, and names the first
    declared datum when the new one needs a datum.
  - **Re-pick.** Moves a symbol or frame to another edge or host and keeps
    the rest.
- **Schema.** v98, built on v97 (R01 datum points, #1719), gated below it:
  an older client would refuse the unknown kinds.

Evidence: `test/drawing-gdt.test.ts`, `DrawingWorkspace.test.tsx` (frame
properties) and `test/e2e/drawing-gdt.spec.ts`.

## Slice B: fits, thread classes and general tolerances (schema v105)

- **Fits.** A diameter of a circular edge may state an ISO 286 fit class
  (`fit`). Printing it ("Ø8 H7 +0.015/0") reads the limit deviations from
  ISO 286-1 tables 1–3, for the size the model has now, so a resized pin
  re-reads its range's limits at the next Update.
  - **Classes.** Only the classes those tables state alone: holes F, G, H
    and JS, and shafts f, g, h, js, k, m, n and p, in grades 5 to 11. Holes
    K to ZC need the Δ correction, and shafts r to zc need subdivided size
    ranges, so the schema refuses them rather than print a guessed limit.
  - **js.** ±IT/2 exactly, as ISO 286-1:2010 states it.
  - **Out of range.** A size outside over 0 up to 500 mm breaks as
    `fit-out-of-range`.
  - **What it replaces.** A fit is the diameter's tolerance and replaces a
    hole's callout. It excludes a tolerance, a reference flag and a thread
    class.
- **Thread classes.** A tapped M01 hole's diameter may state an internal
  thread class (`threadClass`), printed after the designation ("M6×1-6H"):
  ISO 965-1 (4H–8H, 4G–8G) for metric threads, or UN (1B–3B) for inch ones.
  - A class from the other system breaks as `thread-class-mismatch`.
  - A bore without a thread breaks as `not-threaded`.
- **General tolerances.** A `general-tolerance` block sits on the paper,
  its top-left corner at its placement, as a ruled table like the parts
  list.
  - **ISO 2768.** `iso-2768` prints the ISO 2768-1 linear (table 1) and
    angular (table 3) deviations for class f, m, c or v. These are in
    millimetres, as the standard states them. The header names the class
    with any ISO 2768-2 geometric class ("ISO 2768-mK").
  - **By decimal places.** `decimal` states ± for values written to 0–4
    decimals, and on angles, in the sheet's units. This is the common
    block for inch drawings.
  - **Tool and Properties.** Sheet Properties' Add general tolerances (or
    the W key) places an ISO 2768-m block, and Properties switches its
    scheme and classes. It is not on the tool rail, which has no row to
    spare at phone width.
- **Schema.** v105, built on v106 (#1739), gated below it. An older client would print
  a fitted diameter without its fit.

## Slice C: model-based definition (schema v106)

- **Shape.** A top-level `pmi` section (`ModelPmiSet`) holds datum features
  and feature control frames on the model.
  - **Face.** Each names one face of a body (a `DrawingFaceRef`: lineage
    first, then hash).
  - **Anchor.** A point on that face, where its label's leader lands: the
    point the face was clicked at, or the face's centre.
  - **Fields.** The datum and frame fields mean what they do on a drawing
    (one validator, `toleranceFieldsError`). The exception is a frame's
    amount, which is in the document's units.
  - **One datum reference frame per model.** A letter is declared at most
    once, and a second declaration is refused.
- **Commands.** `pmi.add`, `pmi.update` (the whole entry) and `pmi.delete`
  are undoable and replay. They never rebuild: the section is left out of
  the geometry content key, rebuild inputs and diagnostics. Undo and redo
  of a PMI-only step keep the ready geometry, as reference images do.
- **Resolution.** Each entry's face is resolved against the current bodies
  each time it is shown, so an entry follows its face through a model edit
  by lineage. When nothing resolves, the entry is broken by name and
  nothing rebinds:
  - `body-missing`, `not-found` or `ambiguous`: its face no longer
    resolves to exactly one face.
  - `datum-undefined`: a frame names a letter no datum declares.

  A broken entry shows amber in the viewport and in Objects. "Move to
  selected face" re-points it and keeps its fields.

- **Workspace.**
  - **Objects.** With a face selected, Objects offers Datum feature and
    Feature control frame. Each entry lists with its state, and the open
    one edits its letter, characteristic, tolerance, zone, modifier and
    datums, with the same constraints as the drawing panel.
  - **Viewport.** The viewport draws each entry as a CSS2D label: a dot on
    the face, and the frame or datum symbol in SVG made from the drawing's
    own frame geometry. The dot is the stored anchor snapped to the nearest
    point of the face as it is now, so a label follows a moved or resized
    face and never sits on another one.
  - **Loading.** The PMI module loads on demand, off the entry chunk.
- **Schema.** v106, built on v105, gated below it. An older client would drop
  the section on save.
