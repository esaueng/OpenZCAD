---
row: U01
---
Delete key on a viewport pick: a picked face or edge now deletes the feature
that defines it (the feature its readout names and Edit opens), so selecting
a fillet band and pressing Delete or Backspace removes that fillet, through
the same dependents confirm and Undo toast as a History row. A body pick and
a face no single feature owns still do nothing, and a drag or commit in flight
holds the key; this lifts the earlier rule that only History or Edit offers
deletion (`selectionFeature.test.ts`, `visual-selection-fillet-edit.spec.ts`,
`inspector-object-panel.spec.ts`, `visual-selection-acceptance.spec.ts`).
