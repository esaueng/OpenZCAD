---
row: AS01
state: In review
---

Schema v54 `assembly` section: components reference bodies in the same
document (following the bodies' lineage), start at the modelled pose, and are
grounded or free; the Assemble workspace adds them in one undoable step from a
first-run card. Validation, storage, history and diagnostics redaction cover
the section ([plan](docs/plans/assemblies-plan.md)). Evidence:
`test/assembly-commands.test.ts`, `test/assembly-kinematics.test.ts`.
