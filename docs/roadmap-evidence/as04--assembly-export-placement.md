---
row: AS04
---

Assembly exports match what Assemble shows. IGES and every mesh format
(3MF, STL, OBJ, PLY, glTF) now bake each part's solved pose into its
geometry, the same placements the STEP occurrences carry (never the
exploded offset), so a posed assembly no longer exports with every part at
its modelling origin (#2391). While an assembly part shows a configuration
other than the active one, every exact and mesh export refuses with a
message naming the part, its configuration and the active one, instead of
silently writing the active row's part or omitting one that row suppresses
(#2389). Regression: `test/assembly-export-placement.test.ts` reads the
exported IGES solids, 3MF build items and binary STL facets back and checks
each part's posed extent, and checks the refusal for STEP, IGES, 3MF, glTF
and STL.
