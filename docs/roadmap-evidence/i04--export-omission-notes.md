---
row: I04
---

Exports name what they leave out or write from retained geometry (#2254,
#2255, #2205). A new-body feature that fails to rebuild leaves no body on
screen, so the failed-history guard had nothing to withhold and STEP wrote the
rest of the model as "Exported 1 body": the export scope now counts it ("1 of
2 bodies") and the File note, status line and a warning-toned activity card
name the body and the failed feature. A solid built from a sketch whose linked
projection is broken still exports, as the model shows it, and every one of
those surfaces names it and the sketch whose last valid geometry it uses. The
command palette, desktop menu and compact controls give the failed-feature
reason when it holds back every body, keeping "Create a body" for an empty
document. `apps/web/src/lib/exportOmissions.ts`;
`test/export-omission-notes.test.ts` covers both cases against the exact
kernel, and `test/e2e/step-in-isolation.spec.ts` checks the palette reason.
