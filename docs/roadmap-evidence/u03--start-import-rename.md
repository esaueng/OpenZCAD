---
row: U03
---

13 November design review I13 and I14 (and I17's copy thumbnails and
Properties Close): a file dropped on the start screen makes a project named
for it and runs Import CAD files there (a backup restores; anything else is
refused before a project is made), and the start screen's Import takes CAD
files too; a project is renamed from its tile menu or its Properties without
opening it (an account project is written there first, fenced on its
version), with a hint when another project already has the name; a copy of a
sample drops "Demo ·" and wears its source's picture; Properties keeps Close
in view (`libraryProjectRename.test.ts`, `startScreenImport.test.ts`,
`StartScreen.test.tsx`, `start-screen-import-rename.spec.ts`).
