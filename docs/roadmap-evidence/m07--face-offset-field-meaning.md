---
row: M07
---

QA 2026-11-14 findings #9 and #12: the face-offset entry says what its number
means (Total, the size the face sets, with the signed move it makes; or
Offset, the signed move) in the field and on the Total/Offset tag, and the
armed hint names both readings instead of "an exact distance"
(`NumericKeypad.test.tsx`, `prompt.test.ts`). Solid offset, which only grows
a body, no longer applies the inward wall cap of half the thinnest extent;
the kernel keeps its own refusals (`remus-modeling-operations.test.ts`). A
decimal comma (`2,5`) names the decimal point (`expression-audit.test.ts`).
