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
| C     | Model-based definition: datum features and frames stored on the model's faces, shown in the viewport, and listed per body | additive |
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
