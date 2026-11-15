---
row: AS01
---

Offline save and reopen of the assembly: components, their grounding and
display order reopen from the device store unchanged, and the BOM derived
from the reopened copy matches the saved one; concurrent part additions of
one body on two devices are refused by the room merge rather than doubled
(`apps/web/src/lib/assembly/assemblyPersistence.test.ts`; offline drag and
reopen in `test/e2e/assembly.spec.ts`; AS02 records the conflict cases).
