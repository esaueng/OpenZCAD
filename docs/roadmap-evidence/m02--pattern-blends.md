---
row: M02
---

Patterns of fillets and chamfers (no schema change: an older client refuses
such a pattern by name rather than building it wrongly). A feature
pattern's `sourceFeatureIds` may now name fillets and chamfers beside holes,
bosses and cuts. Each copy takes the blend where it holds the edges the
original rounded. The original's stored edge references are moved with
the copy's placement, and each must find exactly one edge of the body
there: the same kind of curve and length, with the moved ends and middle
(or, for a closed edge, the moved centre and axis). The blend is then
applied with the original's own size and options through the same entry
point and acceptance rules as its build (`edgeModifierSettings`, shared with
it). An approximate blend is disclosed as the original's is. Sources run in
History order, so a pattern of a boss and its fillet rounds each boss copy.
Refused by name: a blend stored before its edges were named ("pick its
edges again"); a copy that finds no edge where the original's would be
("Copy 1 of Round finds no edge where Round's edge 1 would be; skip it, or
repeat the feature it rounds first"); and the kernel's refusal of a copy,
prefixed with the copy's label. In the workspace, Repeat Features takes a
fillet or chamfer by a click on one of its faces, as it takes a hole, boss
or cut. Evidence: `test/pattern-blends.test.ts` (on the pinned kernel, a
10 × 10 × 5 boss and the fillet on its four uprights repeated three times,
each giving up (1 − π/4) × 5 per upright; the boss and a chamfer on its top
edges repeated, each top millimetre a frustum from 10 × 10 to 8 × 8; the
fillet repeated alone refused by its first copy).
