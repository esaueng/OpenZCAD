---
row: AS02
---

The Scissors sample opens in Assemble with its pivot controls expanded, on
first seed, catalogue reopen and reset. Reload restores the open pivot while
retaining the edited angle. The default is applied at project opening, so
later edits, selections and workspace switches remain under user control;
other projects keep their existing launch behavior. No geometry, saved model
format or dependency changes. Acceptance covers desktop/mobile signed-out
opening, immediate angle/Play access, edited-copy reopening and reload, and
the ordinary assembly path. Regression coverage lives in
`assembleWorkspace.test.ts` and the CI smoke cases in `assembly.spec.ts`.
