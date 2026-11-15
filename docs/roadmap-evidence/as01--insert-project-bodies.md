---
row: AS01
---

Cross-project insert, first bounded slice: File › Insert project… copies
another project's shown bodies into the open one as one undoable step. The
backup is rebuilt in a disposable worker with its own kernel (its imported
sources served from the backup, nothing written to the device) and written as
one millimetre STEP through the new `exportStepBodies`, which reports each
body's run of solids. That STEP imports like any other (one stored source, the
same exact check and archive), one body per source body under its name, its
chosen colour and opacity, filed in an Objects folder named after the project.
A copy with no link back; history, parameters, assembly and drawings stay
behind; mesh references and failed bodies are named as left out. Import
project… still opens a separate copy. Evidence:
`packages/kernel-adapter/src/exact-step-bodies.test.ts`,
`test/project-insert.test.ts` (inch target, source references, name
collisions), `apps/web/src/lib/stepImportRun.test.ts` (layout, one undo) and
`test/e2e/insert-project.spec.ts`.
