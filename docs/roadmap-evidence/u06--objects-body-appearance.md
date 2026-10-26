---
row: U06
---
Objects appearance slice (this PR): every live body row shows its color and
opens a named color/opacity popover directly, without changing selection or
opening the feature Inspector. The popover stays outside the panel's scroll
clip, follows docked and floating panels, and fits the phone viewport. Presets,
hex entry, pointer/keyboard previews, opacity and reset use the existing
undoable node-metadata command and saved document; source bodies have no
appearance editor and unavailable model edits disable the swatches. Escape
closes the picker and returns focus to its swatch; closing or filtering the
panel clears transient previews. Regression evidence:
`modelPanels/ObjectsPanel.test.tsx`, `objects-appearance.spec.ts` (desktop/phone,
dark/light, undo/redo, reload and floating panels), and the retained-appearance
case in `staged-geometry.spec.ts`. Production acceptance remains separate.
