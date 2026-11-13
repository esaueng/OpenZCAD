---
row: U03
---

13 November design review I67, I68 and the export part of I70: the Units,
Export mesh, Export image and Shapr dialogs are forms whose primary button
submits, so Enter in any field (the focused radio included) acts and each
dialog's own guard still refuses a blocked submit; the workspace refuses files
dropped while any modal is open, also on the dialog's backdrop, and says so
in the status line; Cancel and Export stay pinned to a scrolling export
dialog's foot at phone width; format hints and image Width/Height line up;
the drop overlay names DXF and the .shapr + STEP pair (`submitOnEnter`,
`FileDropTarget.test.tsx`, dialog tests, `exchange-units.spec.ts`).
