---
row: AS04
---

Assembly exports match what Assemble shows. IGES and every mesh format
(3MF, STL, OBJ, PLY, glTF) now bake each part's solved pose into its
geometry, the same placements the STEP occurrences carry (never the
exploded offset), so a posed assembly no longer exports with every part at
its modelling origin (#2391). While Assemble draws a written part from a
configuration other than the active one, every exact and mesh export
refuses with a message naming the part, its configuration and the active
one, instead of silently writing the active row's part or omitting one that
row suppresses or hides (#2389). An imported mesh reference is posed in STL
like any part. What Assemble draws for a part that names another row (that
row's suppression and its Visible cell included) is decided by one
function, `assemblyRowDrawnParts`, which the viewport, the app's export
scope and the adapter's refusal all read, the adapter over an exact build
of each row a written part names. So the scope holds a part its own row
shows although the active row hides or does not build it (its export
reaches the refusal), and leaves out a part whose own row shows nothing for
it, which exports the rest without a refusal; a hidden or unselected part
is never refused. An export of another configuration row writes that row
with every part in it, as View draws a row: a part's own Configuration pins
it only in Assemble's view of the active model, and the active row's own
empty scope never stops it. Regression:
`test/assembly-export-placement.test.ts` reads the exported IGES solids,
3MF build items and ASCII and binary STL facets (exact and mesh-reference
parts) back and checks each part's posed extent, and checks the refusal,
its scope and the left-out parts for STEP, IGES, 3MF, glTF and STL through
the app's own scope functions; `apps/web/src/lib/modelExportScope.test.ts`
checks the app's export scope and row export target.
