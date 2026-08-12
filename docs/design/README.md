# OpenZCAD Workspace Design Specification

The accepted workspace concept is [`openzcad-workspace-concept.png`](./openzcad-workspace-concept.png). The concept was generated with OpenAI's image tooling and intentionally retains its C2PA Content Credentials; it is a design reference, not an application asset.

## Product hierarchy

1. The exact B-rep viewport is the primary surface.
2. The model tree and contextual inspector are compact rails, not dashboards.
3. AI work is always presented as a reviewable patch with Preview, Apply patch, and Reject controls.
4. Applying a patch is explicit and atomic. A proposal never appears already applied.

## Layout

- Compact top application bar.
- Narrow model rail on wide screens.
- Flexible viewport with a contextual inspector.
- Bottom AI rail with proposal summary and approval controls.
- Compact status bar.
- Small-laptop layouts may collapse either side rail into a drawer, but the viewport and AI approval boundary remain visible.

## Visual system

- Near-black engineering canvas and graphite rails.
- Cool neutral text with deliberate high contrast.
- Electric blue for selection, focus, and primary actions.
- Warm amber-gold body color for the active solid.
- One-pixel borders, minimal shadows, and 4-8px radii.
- Modern sans-serif UI typography; monospace is limited to values and status.

## Allowed primary-screen copy

- OpenZCAD
- Mounting Bracket
- Saved
- Undo
- Redo
- Import
- STEP
- STL
- MODEL
- Parameters
- Feature history
- Hole
- Measurements
- Apply
- Cancel
- AI command
- Proposed patch
- Preview
- Apply patch
- Reject
- Exact B-rep
- 0 warnings
- Synced

## Component families

- Application bar actions and icon buttons.
- Model-tree section, parameter row, and feature row.
- Viewport overlays: view cube, axis triad, Fit, and Grid.
- Contextual inspector fields, toggles, actions, and measurements.
- AI command editor, ordered patch operations, assumption line, and approval actions.
- Status items for kernel, units, diagnostics, and synchronization.

All visible controls and text are code-native. The concept image is a visual specification, not an application asset.

## Fidelity ledger

- Preserved: graphite shell, blue selection/actions, warm gold active bodies, top project/actions bar, model tree, grid viewport, inspector, AI proposal rail, and exact/sync status.
- Density adaptation: the implemented rails use 46px/252px/330px/28px dimensions so more viewport remains available on common laptop displays.
- Functional adaptation: the live viewport displays the user's actual model rather than a hard-coded mounting bracket.
- Functional adaptation: the compact rail shows the proposal summary; Preview makes the proposed geometry inspectable before Apply. Without an AI API key, the rail reports the configuration state.
- Functional adaptation: authenticated identity and live-room presence sit in the top bar without displacing the core modeling actions.
- Functional adaptation: finishing and pattern tools extend the contextual inspector while preserving the concept's compact tool density; exact face/edge IDs appear only when selected.
- Direct modeling adaptation: literal box dimensions can be changed by dragging an exact selected face, with a live numeric HUD and a single document-history command on release. Expression-driven dimensions are deliberately preserved for inspector editing.
- Selection-order adaptation: fillet and chamfer accept either edge-first or tool-first workflows while still storing stable exact edge hashes in the canonical feature.
- QA result: the implemented layout, rail hierarchy, control density, typography, graphite/blue visual system, and core viewport-first workflow remain faithful to the concept. The live QA capture uses actual exact fillet and pattern geometry rather than concept-only sample content.
- Compact breakpoints preserve the model and viewport first; the inspector hides only below 820 px, where full CAD editing is not the primary target.

## Viewport chrome studies

- [`viewer-rail-options.html`](./viewer-rail-options.html) — five redesigns of the right-hand viewer rail (`ViewerToolbar`), each rendered live at 1:1 against a mock viewport, with measured footprints and the trade-offs behind each. Open it in a browser; no build step or network access is required. Option C shipped; the page records the alternatives and the reasoning.
