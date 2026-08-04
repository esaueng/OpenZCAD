# Viewport scale indicator design QA

## Comparison setup

- Source visual truth:
  `/Users/userzero/.codex/generated_images/019fb177-2439-7962-ad2d-76b01ebab6ac/call_EKZEzibQHOiTVPGbf6XreBU5.png`
- Browser-rendered implementation:
  `/private/tmp/openzcad-scale-qa/viewport-scale-demo-final.png`
- Focused implementation crop:
  `/private/tmp/openzcad-scale-qa/viewport-scale-demo-focused-final.png`
- Full side-by-side comparison:
  `/private/tmp/openzcad-scale-qa/viewport-scale-comparison-full-final.png`
- Focused side-by-side comparison:
  `/private/tmp/openzcad-scale-qa/viewport-scale-comparison-detail-final.png`
- Browser viewport: 1440 × 1024 CSS px at device pixel ratio 2.
- Source pixels: 1536 × 1024.
- Implementation pixels: 1440 × 1024; the focused viewport crop is
  768 × 512.
- Density normalization: the 1536 × 1024 concept was downsampled to
  768 × 512 before the full comparison. The concept intentionally enlarges
  the instrument for inspection; the implementation follows the concept
  brief's production size of roughly 80–200 CSS px as camera scale changes.
- State: Mounting Bracket demo, perspective projection, grid visible, model
  fitted, millimetre document units.

## Findings

- No actionable P0, P1, or P2 differences remain.
- Fonts and typography: the value uses the bundled IBM Plex Mono at 16px,
  regular weight, matching the concept's technical readout and the product's
  established viewport typography.
- Spacing and layout rhythm: the indicator sits 18px from the viewport's left
  edge and 38px above its bottom edge. It remains separated from the existing
  units/body HUD by 9px at 1024 × 768 and does not collide with the drafting
  frame or model.
- Colors and visual tokens: the baseline and end caps use
  `--color-text`, minor divisions use `--color-text-muted`, and the single
  center division uses `--color-accent`. The transparent background preserves
  the selected concept's unboxed HUD treatment.
- Image and asset fidelity: no raster asset substitution is used. The scale
  rule is a functional high-density canvas tied to camera math, so it stays
  sharp and physically meaningful instead of stretching a screenshot. The
  final focused comparison confirms the selected end-cap, minor-tick, center
  accent, and centered-label hierarchy.
- Copy and content: the label displays the live 1/2/5 measurement step and the
  document unit. The tested millimetre state rendered `50 mm`, then changed to
  `20 mm` during wheel zoom. Inch documents use the conventional `in` label.
- Accessibility: the visual canvas is hidden from assistive technology; the
  component exposes a concise label such as
  `Viewport scale at the camera focus plane: 50 mm`, avoiding the false claim
  that perspective scale is constant at every scene depth.

## Interaction and responsive verification

- Wheel zoom changed the live indicator from `50 mm` at 192.26px to
  `20 mm` at 122.02px.
- The indicator remained visible and correctly labeled after switching to
  orthographic projection and back to perspective.
- At 1024 × 768, the scale occupied 82.62px within an 804px-wide viewport and
  remained clear of the bottom HUD.
- Browser console warning/error log: empty.
- The local Worker reported expected missing development D1 tables in the
  terminal, but the offline CAD workspace and viewport remained functional;
  this did not surface as a browser-console error or affect the indicator.

## Comparison history

1. Initial browser comparison found a P2 sizing defect: the existing
   `.viewer-shell canvas` rule forced every canvas to `width: 100%` and
   `height: 100%`, doubling the indicator at device pixel ratio 2.
2. The scale canvas now uses a component-specific, higher-specificity width
   override while retaining a 2× backing store for sharp lines.
3. Post-fix browser measurements showed a 140.87px CSS rule with a 282px
   backing store, then the final live zoom check stayed inside the designed
   80–200px range. The final full and focused comparison inputs show no
   remaining P0/P1/P2 mismatch.

## Follow-up polish

- P3: at extreme camera scales, the label intentionally switches to compact
  scientific notation rather than allowing a long decimal to dominate the
  HUD.

## Final result

final result: passed
