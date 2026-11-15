---
row: AS03
---

Prerequisite recorded before the exploded-view slice: the AS01/AS02 offline
save/reopen and conflict cases AS03 inherits now have evidence (stored
transforms reopen exactly; pose-only divergence is a conflict, never a silent
choice; concurrent room edits merge only when they touch different content).
Evidence: `apps/web/src/lib/assembly/assemblyPersistence.test.ts` and the
offline drag/reopen case in `test/e2e/assembly.spec.ts`.
