# OpenZCAD UI overhaul design QA

## Evidence

- Source visual truth: `/var/folders/t_/tvn84c292rzdfcbj06vltnsw0000gn/T/codex-clipboard-5a57955c-f509-4b7f-ad85-28f3501608d8.png`
- Browser-rendered implementation: `/Users/userzero/codex/OpenZCAD/test-results/ui-overhaul-direct-edit.png`
- Additional implementation states:
  - `/Users/userzero/codex/OpenZCAD/test-results/ui-overhaul-workspace.png`
  - `/Users/userzero/codex/OpenZCAD/test-results/ui-overhaul-fillet.png`
  - `/Users/userzero/codex/OpenZCAD/test-results/ui-overhaul-fillet-target.png`
- Full-view comparison: `/private/tmp/openzcad-ui-comparison.png`
- Focused direct-edit comparison: `/private/tmp/openzcad-focused-comparison.png`
- Local URL: `http://127.0.0.1:4173/`
- Viewport: 1600 x 900 CSS pixels, Chromium, desktop dark theme, ISO view.
- State: one box body; front face selected and set to 42.00 mm; separate captures cover the applied 2.50 mm fillet and tool-first edge prompt.

The reference is a professional-CAD interaction and visual-density target, not an exact screen clone. It shows a different model, feature set, and product shell. The comparison therefore evaluates hierarchy, solid rendering, selection clarity, direct manipulation, and tool discoverability rather than identical content.

## Findings

No actionable P0, P1, or P2 design differences remain for the requested desktop workflow.

- Typography: the compact system sans-serif stack, small uppercase section labels, restrained weights, and tabular numeric input match the reference's dense professional-tool hierarchy. Labels remain readable at 1600 x 900 without clipping.
- Spacing and layout: the slim modeling ribbon, browser/model tree, large central canvas, and narrow inspector preserve the reference's canvas-first proportions. Tool groups, dividers, and selected states scan consistently.
- Colors and visual tokens: neutral solids, dark graphite surfaces, cyan selection/tool states, fine gray dividers, and high-contrast black silhouettes reproduce the source's CAD semantics without copying its brand.
- Image quality and assets: the model is rendered as live antialiased WebGL geometry, not a raster substitute. Lucide icons provide one consistent vector icon family. The source contains no required brand imagery or logo assets that needed reproduction.
- Copy and content: direct guidance uses concise task language: "Drag face or enter a value," "Fillet this edge," and "Select an edge." Status copy reports the committed dimension or radius.
- Interaction states: selected faces receive a cyan surface highlight and anchored exact-value control; edges use a forgiving model-space hit area and cyan segment highlight; fillet supports selection-first and tool-first ordering.
- Accessibility: modeling controls are semantic buttons with accessible names, numeric inputs have labels, selected tools expose pressed state, and status/coach surfaces use readable contrast. The desktop CAD layout is the target; mobile is outside this pass.

## Full-view comparison evidence

The combined full-view board shows the same overall interaction hierarchy as the reference: dense tools around a dominant dark modeling canvas, a neutral solid with defined edges, one cyan-selected geometric element, and supporting panels that do not compete with the model. OpenZCAD intentionally uses a horizontal ribbon and right inspector instead of copying the reference's vertical tool rail.

## Focused region comparison evidence

The focused board compares the reference's cyan selected face and inline numeric manipulator with OpenZCAD's cyan face highlight and anchored 42.00 mm control. Both keep the model visible, preserve selection context, and allow direct manipulation without opening a modal dialog. The implementation uses a larger input target and explicit apply affordance for clarity.

## Comparison history

1. Earlier finding [P1] - Direct manipulation lost pointer capture when equivalent worker-derived geometry remounted the canvas.
   - Fix: stabilized the Three.js lifecycle with a semantic body signature and stopped reposting the same document version to the browser worker.
   - Post-fix evidence: the Chromium workflow completes face drag and commits one history command before the exact-value edit.
2. Earlier finding [P2] - Edge selection was too brittle and could fall through to face selection when the line intersection omitted a usable distance.
   - Fix: added deterministic nearest-segment fallback, a larger fillet-tool tolerance, and conceptual sharp-box pick edges for rounded previews.
   - Post-fix evidence: the same Chromium workflow passes both edge-first and tool-first fillet paths.
3. Earlier finding [P2] - The origin grid intersected the solid and weakened its visual solidity.
   - Fix: moved the presentation grid beneath the body bounds, removed unnecessary box subdivisions, and strengthened the silhouette treatment.
   - Post-fix evidence: the final direct-edit and fillet screenshots show uninterrupted solid faces and defined outer edges.

## Primary interactions tested

- Create a new project and box.
- Select a face.
- Drag the face and commit a direct resize.
- Enter and apply an exact 42.00 mm value.
- Deselect geometry and select a visible edge.
- Start fillet from the selected edge, enter 2.50 mm, and apply.
- Start Fillet first, then select an edge on the rounded preview.
- Confirmed no browser page errors during the workflow.

## Open Questions

- True single-edge B-Rep filleting remains a geometry-kernel milestone. The beta interaction records selected-edge intent, while the current mock renderer rounds the box edge set for its preview. This does not block the UI/interaction QA result, but it must remain explicit in product handoff.

## Implementation Checklist

- [x] Canvas-first professional CAD shell.
- [x] Direct face selection, drag preview, and exact numeric commit.
- [x] Strong solid shading, silhouette, and selectable edges.
- [x] Edge-first and tool-first fillet interaction ordering.
- [x] Browser console/page-error check and end-to-end interaction test.
- [x] Full-view and focused visual comparisons.

## Follow-up Polish

- [P3] Capture additional desktop evidence at 1366 x 768 and 1920 x 1080 when responsive density tuning becomes a milestone.
- [P3] Replace the mock whole-box fillet preview with the future worker-hosted topology kernel's selected-edge result.

final result: passed
