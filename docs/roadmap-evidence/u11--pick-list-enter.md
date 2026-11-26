---
row: U11
---

Enter on a focused Select other row confirms that row, as Space and a click
do: the list owns Enter on its rows (`packages/viewport/src/scene/TopologyPickList.ts`),
and the workspace's Enter-opens-value-entry shortcut leaves Enter inside any
menu alone (`enterSkipsExactEntry`), so it no longer opens exact entry for the
pick the list would replace. Focus returns to the viewport, where Enter still
opens the confirmed pick's value entry. A held Enter confirms the row and
nothing else: the list keeps that press's auto-repeat until release, and
neither the value-entry shortcut nor the keypad's commit acts on a repeat (`ModelViewer.pickList.test.ts`,
`exactEntryShortcut.test.ts`, unpinned case in
`test/e2e/selection-preview-feedback.spec.ts`).
