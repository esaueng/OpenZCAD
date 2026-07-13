# Direct sketch and extrusion design QA

## Comparison setup

- Source visuals:
  - `/var/folders/t_/tvn84c292rzdfcbj06vltnsw0000gn/T/codex-clipboard-8e2e9dd8-1c0b-4b1d-89f5-a28ff936fe9e.png` — focused sketch interaction reference.
  - `/var/folders/t_/tvn84c292rzdfcbj06vltnsw0000gn/T/codex-clipboard-c7bd1bf9-c27c-49b3-b017-f12d71165714.png` — arrow extrusion reference.
  - `/var/folders/t_/tvn84c292rzdfcbj06vltnsw0000gn/T/codex-clipboard-c953e1c3-672a-4bd1-8ae8-c485115aafe9.png` — existing OpenZCAD visual-language baseline.
- Implementation evidence:
  - `/private/tmp/openzcad-qa/openzcad-sketch.png`
  - `/private/tmp/openzcad-qa/openzcad-extrude.png`
  - `/private/tmp/openzcad-qa/openzcad-solid.png`
- Side-by-side comparison input: `/private/tmp/openzcad-qa/comparison.png`
- Primary viewport: 1440 × 900 at device pixel ratio 2.
- Responsive checks: 1024 × 768 and 768 × 650.

The implementation intentionally preserves the OpenZCAD application chrome and visual tokens while adopting the reference interaction hierarchy: full-canvas sketching, a compact left tool palette, centered task guidance, plane controls on the right, selected closed profiles, and signed direct-manipulation extrusion.

## Fidelity and behavior review

- Layout and spacing: the sketch canvas owns the central workspace, with the tool palette and setup panel clear of the drawing origin at desktop and tablet widths. The compact-width check keeps all primary sketch controls usable; secondary top-bar text truncates before modeling controls are lost.
- Typography and color: existing OpenZCAD monospace/status typography and dark surfaces remain consistent. Amber marks active sketch geometry, red and blue identify axes, green communicates profile readiness, and blue identifies extrusion actions.
- Icons and surfaces: controls use the existing Lucide icon family, matching stroke weight and avoiding custom SVG/CSS artwork. Borders, radii, and elevation follow the current OpenZCAD panels rather than copying the reference application's unrelated chrome.
- Copy and hierarchy: the active tool, current gesture, plane, profile readiness, signed distance, side, and confirmation action are visible without opening the feature inspector.
- Interaction states: rectangle, circle, and polygon modes have one active state; plane buttons and profile selection expose pressed/selected state; finish/create actions disable until valid; Escape and Enter are supported; profile deselection and cancel paths are present.
- Accessibility: primary controls are semantic buttons/forms/toolbars with accessible names, pressed states, labels, and visible focus styles. Keyboard shortcuts remain available for profile tools and completion/cancellation.
- Image fidelity: no product imagery was required or substituted. The functional Canvas and Three.js renderers draw the CAD grid, geometry, preview, and handles.

## Comparison history and fixes

1. P2 interaction-state mismatch: the first sketch pass visually marked both Select and Circle as active. The static Select styling was removed; the post-fix DOM and screenshot show exactly one active tool (`Circle`).
2. P2 handle visibility: the extrusion arrow head initially ended flush with the translucent preview cap. The handle now renders without depth testing and extends 7 mm beyond the preview, keeping the drag target and signed value visible at non-zero distances.
3. Post-fix evidence: the final desktop comparison shows the closed circle at Ø32 mm, an opposite-side preview at -34.5 mm, a visible outboard arrow head/value, and the exact confirmed solid. No P0, P1, or remaining P2 findings were observed.

## Functional verification

- Drew a snapped closed circle on the Front (XY) plane and finished it into canonical document history.
- Selected the filled profile directly and launched Extrude from the contextual action.
- Dragged to -34.5 mm on the opposite side, crossed through the sketch plane, and reached +3 mm on the positive side.
- Confirmed `Extrude 1`; the exact kernel returned one live body, 2412.743 mm³ volume, three faces, and zero workspace warnings.
- Console warning/error log after confirmation: empty.

## Remaining P3 scope differences

- Advanced sketch entities and constraints from the reference product (line, arc, spline, trim, tangent, concentric, and dimensional constraints) are not part of this delivery.
- The current document model stores one closed profile object per sketch. Multi-loop and multi-region sketches need a document-schema milestone rather than a UI-only change.
- Extrusion creates a standalone body; automatic add/cut/intersect semantics against an existing body remain a future modeling-mode milestone.

## Final result

Passed. The requested sketch-to-bidirectional-extrusion journey is implemented, visually verified against the supplied references, and functional in the real application flow.
