---
row: O01
---
PR #952 adopts the paired Remus 2026.1.80 packages at
`f167bb2bde923b9d8a252d3ef9f6ebb475487332` and advances the reconstructed
native Hammer Holder arm-fillet regression from refusal to valid construction
at radii 1 mm and 3 mm. `test/hammer-holder-native.test.ts` requires strict
solid validation, one closed consistently wound shell, expected topology and
bounds, measured volume witnesses, and independent removed/retained-material
probes. An oversized 100 mm arm fillet must still refuse and preserve the
input topology and volume. Existing plate-fillet volume and simple/countersunk
drilling assertions remain. This qualifies the reconstructed fixture only;
broader blend families and live product acceptance remain separate work.
