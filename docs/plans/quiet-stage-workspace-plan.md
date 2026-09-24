# Quiet-stage workspace redesign (U04)

Status: slice 1 in review (#411); slice 2 in review (#412); slice 3 in review (#413); slice 4 in review (#414); slice 5 in review (#415); slice 6 in review (#416); slice 7 in review. Roadmap row: [U04](../../ROADMAP.md#u04).

## Intent

A full visual and layout redesign of the workspace, decided 2026-09-23 on a
design canvas that walked the reference CAD's interaction model and then
diverged from it. The model owns the screen. Four islands float over the
viewport and only one of them changes with context:

| Zone                     | Contents                                                                                                                                                                                                          | Changes with context? |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Document (top)           | project name and save state · View / Tweak / Build · undo, export, share, account                                                                                                                                 | no                    |
| Verbs (left)             | one **verb rail**, the instrument rail's mirror: icon buttons for the commands that apply to the selection, one primary verb lit, "More tools" at its foot (the selection chip in the bottom lane names the pick) | **yes**               |
| Instruments (right)      | icon-only view controls (fit, display, section, measure, grid), then Items / History / Parameters, which open one drawer; view cube bottom-right                                                                  | no                    |
| Hint and search (bottom) | one line of guidance, then a ⌘K bar that searches commands, features and parameters and hands a question to the assistant                                                                                         | the hint text only    |

While a command runs, the left card collapses to its header and an operation
card (title, add/cut badge, sub-mode controls, Cancel, Apply) sits top-centre.
Values ride the model at the point of action.

## Decisions

- **Palette A, "steel and cobalt".** Neutrals carry a faint steel tint
  (hue 214). One signal colour, `#6798ff`, marks selection, handles and the
  primary verb; it is deliberately the strongest hue on screen. Adds are
  `#48cd8f`, cuts `#ff644d`, construction `#ef91ef` (moved off the signal hue
  so a construction line never reads as a selection).
- **Type:** Geist Sans 400/500/600 and Geist Mono 400/500, self-hosted like the
  fonts they replace. Every number is monospaced.
- **Corners:** near-square. Keys and chips 2px, controls 3px, panels 4px. Dots
  and the marking-menu hub stay round.
- **Sketch rail (compaction pass):** in a sketch the left column is the same
  40px icon rail as Build's verb rail — draw, modify, utilities and solve,
  then a Sketch palette button and Finish at its foot. The overview, the
  settings and the constraint list open beside it as the palette flyout; the
  selected entity's editor is a second flyout above it. Nothing on the rail
  carries a word: names and keys are tooltips, and every button keeps the
  accessible name the specs use (`Line`, `Circle: Center Circle`, `Solve`,
  `Sketch palette`, `Finish Sketch`).
- **Tweak rail (compaction pass):** Tweak's left side is the same rail: a
  Parameters button whose flyout is the parameter table (open to begin with,
  remembered per device), then Export STEP, Export Mesh and, on a share link,
  Make a copy. The rail and the table share the stage's centre line; View's
  parts island keeps the top-left corner.
- **Sketch relations:** a fixed icon rail on the right in the order of
  `CONSTRAINT_TOOL_SPECS`; icons never move, relations that do not fit the
  selection grey out, and a name label appears only beside the ones that fit.
- **History, Items, Parameters:** one drawer on the right, closed by default.
- **Assistant:** merged into the ⌘K bar; the conversation grows up out of it.
- **Face offset preview ("B refined"):** only the change is coloured. The moved
  face is neutral with a signal outline; added material is a shaded green band
  on the side walls with a crisp seam at the old level; a cut shows the removed
  slab as a dashed coral outline and tints the newly exposed wall. The pin
  stands on the outer end of the change, the white change arrow runs straight
  beneath it on the same axis from a dashed ring at the old level, and the
  `Offset ⌄` label sits beside the pin. Offset, not Total, is the default
  reading here; Total stays in the tag menu.

## Constraints every slice keeps

- **Accessible names are the e2e contract.** The suite finds the shell by role
  and name (`Workspace mode`, `Viewer bar`, `Box (B)`, `/^Fillet/`,
  `Feature inspector`, `contentinfo`, `Workspace status`). A slice may move a
  control; it keeps its name unless the slice updates every spec that uses it.
- **The launcher chunk has a few hundred bytes of headroom.** New shell pieces
  are `lazy()` unless they must paint on first frame; measure with
  `pnpm build` (its bundle report is the gate), never a filtered build.
- **Class coverage.** Every new class needs a rule or a reasoned allowance in
  `scripts/check-css-classes.mjs`.
- **No behaviour hides behind the redesign.** A slice that moves a command keeps
  it reachable; the verb rail always ends in a "More tools" button that opens a
  flyout of every tool it did not name (closed by default since the compaction
  pass, so the rail shows only what fits the pick; ⌘K reaches everything by
  name).

## Slices

Each slice is one PR against `main`, recorded on the U04 row when it merges.

1. **Visual foundation.** Palette A tokens, Geist, the radius scale, the raw
   colours in component CSS mapped onto palette A families, and the viewport's
   blue family (selection, hover, handle, sketch, region, measurement) shifted
   to cobalt with the stage moved to steel. No layout change.
   Acceptance: theme contrast test passes in both themes; class coverage and
   token-definition tests pass; e2e passes unchanged.
2. **Shell islands.** Top bar becomes three islands; the viewer bar leaves the
   bottom dock for a right-hand icon rail with the view cube bottom-right; the
   bottom lane becomes the hint line and the ⌘K bar. Acceptance: names kept
   (`Viewer bar`, `Undo`, `Redo`, `Selection filter`, `Search commands (…)`);
   the layout specs (`viewport-overlay-lanes`, `settings` top-bar order and
   phone fit, `viewport` scale stability, `sidebar-divider`) are rewritten to
   the new regions, not deleted. As built: undo and redo stay in the viewer
   bar (now the rail) rather than moving to the top-right island, which keeps
   the `viewport.spec.ts` contract; the scale bar sits beside the cube so the
   readout fits under the column.
3. **Command card.** Replaces the tool palette. Extends
   `lib/interaction/capabilities.ts` to idle and body selections so one
   function answers "what applies"; the header reuses `selectionSummary`.
   Acceptance: each context (idle, body, face, edges) lists its commands with
   the primary one marked; "All commands" reaches every tool by its current
   name. As built: the rows are tools only. The face and edge verbs that act
   on the pick itself (Offset Face, Adjust Radius, Edit Fillet…) stay in the
   floating tool card, which already marks the preferred one, so no command
   has two buttons; the face context therefore marks no primary of its own.
   The context rules live in `lib/commandContext.ts` inside the lazy card, off
   the entry chunk. The folds and `panelState.toolGroups` are no longer read;
   removing the stored field is a follow-up.
4. **Right drawer.** Items (bodies), History and Parameters move from the left
   column into one drawer. Acceptance: rollback, suppress, delete and
   parameter editing unchanged; drawer state persists in panel state. As
   built: the drawer carries the whole browser (Revisions and Diagnostics
   too), and each rail button opens it on its section with the other two
   primary sections folded. It stops above the bottom-right row so the cube
   and scale stay reachable. The inspector and the drawer share one right
   lane beside the rail — the inspector on top, hugging its content, the
   drawer filling the rest — because pushing the inspector left of the
   drawer put it over the values riding the model. Direct-edit controls
   (Move, the extrude value) and the rail's own panels float over the lane.
   The e2e fixtures (`stubApi`, `stubAnonymousApi`, the cloud-sync stub and
   `workspace-polish.spec.ts`'s own stub) seed it open for the specs that
   exercise its contents; a dedicated spec covers the closed default.
5. **Search and ask.** ⌘K gains features and parameters as results and an
   "Ask" row that submits to the assistant; the conversation surface anchors
   to the bar. Acceptance: proposals still preview and apply through the same
   validated path; ⌘J still opens the conversation. As built: the closed
   assistant is an Ask button at the end of the search bar (the readout hands
   it a slot; the panel portals its launcher there). The Ask row is last, so
   Enter still runs a matching command, and is the only row when nothing
   matches. A question is sent as a turn when the assistant can take it, and
   otherwise waits in the composer. The open conversation floats centred over
   the bottom lane, standing on the bar, instead of docking a column; its
   collapse control moves into its header, and the column resizer goes. A
   feature result opens the drawer on History and selects it; a parameter
   result opens it on Parameters and focuses the expression. The stored
   assistant width is no longer read; removing it is a follow-up.
6. **Sketch card and relations rail.** Draw and modify tools in the left card,
   Finish at its foot; the relations rail on the right. Acceptance: every
   constraint kind reachable in rail order; greyed kinds carry the refusal
   reason as their accessible description. As built: "fits the selection"
   uses the app's single sketch selection and `constraintToolsForObject`, and
   a fitting relation starts from the selection through the path the entity
   editor already had (`planConstraintFromSelection`: one-pick relations apply
   at once, two-pick ones arm with one pick left), so the editor's own row of
   relation buttons went. With nothing selected every relation arms for canvas
   picks as before, and none is named unless armed. The entity editor moved
   from its top-right float into the card under the tools, since the rail's
   names now use that corner. No relation shortcuts: their letters collide
   with the draw tools' keys.
7. **Face offset preview.** The B-refined preview in `packages/viewport`
   (band, seam, cut ghost, in-line change arrow, beside-pin label).
   Acceptance: add and cut previews match the design at 20 mm and 0.05 mm
   scale bars in default, head-on and side views; the committed geometry is
   unchanged. As built: the band comes from the picked face's display
   triangles (`faceSweepProfile`), projected back onto the plane the gesture
   started from, so a rig re-armed over a landed preview still starts at the
   old level; its hatching is a screen-space shader, so it keeps one pitch
   however the wall is foreshortened. The default reading follows the
   operation: Offset for moving a face, Total for resizing a primitive, whose
   number is its own dimension. Where the axis points at the camera the label
   keeps to the pin's right rather than covering it. Not yet as designed: the
   moved face keeps its selection fill. Fading it during the drag made hosted
   CI's software-GL drag specs miss their budgets on every attempt (bisected
   on CI: the same build without the fade passed), so a neutral moved face
   needs another route and is a follow-up.

## Open questions

- **Neutral solids.** The design shows committed bodies in neutral grey so the
  signal colour carries selection. Body colours today are written into the
  document at creation (`featureColor`), so changing the default is a
  document-level decision, not a restyle. Not in any slice yet.
- **Sketch Discard.** The design has Discard beside Finish. Each sketch entity
  is committed as its own command, so there is no session to discard; slice 6
  ships Finish only unless a rollback is designed.
- **Band style.** Shaded (default in the design) or hatched for added and cut
  material in slice 7.
