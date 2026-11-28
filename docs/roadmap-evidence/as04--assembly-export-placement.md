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
(#2389). An imported mesh reference is posed in STL like any part. Only
parts inside the export scope are refused (a hidden part is not), and the
scope includes a part that only its own row builds, so its export reaches
the refusal. An export of another configuration row writes that row with
every part in it, as View draws a row: a part's own Configuration pins it
only in Assemble's view of the active model. Regression:
`test/assembly-export-placement.test.ts` reads the exported IGES solids,
3MF build items and ASCII and binary STL facets (exact and mesh-reference
parts) back and checks each part's posed extent, and checks the refusal and
its scope for STEP, IGES, 3MF, glTF and STL;
`apps/web/src/lib/modelExportScope.test.ts` checks the app's export scope
and row export target.
