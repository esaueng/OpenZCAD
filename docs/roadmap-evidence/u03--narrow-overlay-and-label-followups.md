---
row: U03
---
Six reproduced design-review gaps are addressed: the Section toolbox paints
above the Model panels rail; the sketch More modify menu follows its scrolled
trigger outside the transformed column and clamps to the viewport; 320 px
Controls rows stack bindings above descriptions; phone Advanced build readouts
stack labels and values; narrow History rows retain a visible More menu while
giving names room and the inspector drops its redundant eyebrow; short-window
rail buttons use 24 px targets so Activity remains on screen.

`test/e2e/design-review-followups.spec.ts` passes all 18 cases in Light and Dark,
including Section hit tests across the DXF button, menu scroll/resize checks,
shortcut overflow, build-label intersections, full default feature names and
inspector headings, and retained suppression/rollback menu actions. The six
states are rendered at 320 x 568, 390 x 844 and 1440 x 900; the rail and sketch
flyout also cover 844 x 390 landscape. Screenshot inspection and a separate
comfortable-density browser check confirm the phone layout. The focused
SketchToolRail, ViewerToolbar, ShortcutsOverlay and sidebar contract suites
pass (66 tests), as does the full web suite. All seven existing
`sketch-modify-tools.spec.ts` workflows still pass through the portalled menu,
including their document and undo checks. Two additional Light/Dark browser
cases verify focus entry, Tab and Shift+Tab traversal, Escape return and
continuation to Construction at phone and desktop widths; all 27 browser
cases pass together. Lint, typecheck, the parity corpus
and the root production build with bundle budgets pass. U03 remains Partial.

The flyout uses the popover layer below dialogs and closes on an outside
press, matching the existing View options menu. The rendered phone/desktop
cases open Export mesh from File while the flyout is up, verify dismissal,
cancel the dialog and reopen the tools without exporting a file.
