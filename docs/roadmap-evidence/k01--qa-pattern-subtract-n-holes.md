---
row: K01
---

2026-11-15 QA 2026-11-14 finding 2 (circular pattern ×4 then Subtract cutting one hole) still does not reproduce on the Remus 2026.1.138 pin. Its requested regression now covers N = 2–8 copies about the bore's datum axis on the face-touching hub the QA pass built, with the overlapping hub and a world-axis pattern as controls: the removed volume is exactly N holes and the flange top annulus loses exactly N hole discs, with no warnings (`test/touching-cylinder-union.test.ts`).
