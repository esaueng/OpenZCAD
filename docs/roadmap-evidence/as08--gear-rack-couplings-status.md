---
row: AS08
state: Partial
---

Status correction (2026-11-15 ledger review): gear and rack-and-pinion
couplings merged under AS02 (schema v56 `assembly.couplings`, one linear
`driven = ratio × driver + offset` relation per pair;
`packages/shared/src/assembly-coupling.ts`, `test/assembly-coupling.test.ts`,
`test/gear-coupling.test.ts`, `test/gear-coupling-kernel.test.ts`), so the row
is Partial. Screw couplings, a user-set ratio coupling between arbitrary
joints, and video/GIF export of a study remain.
