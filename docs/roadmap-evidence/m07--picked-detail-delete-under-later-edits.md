---
row: M07
---

Picked chamfer, fillet and hole faces stay owned by their feature under later
edits: a later fillet or chamfer carries each support it re-trims, re-witnessed,
and edits with no construction history (blend removal, through-hole resize)
carry cone, torus and sphere faces by their exact kernel carrier. Deleting a
detail that later details or blend edits were built on offers to delete them
too; Delete on a face no step owns heals it in place, as on a STEP part; the
viewport menu offers Delete; single-face removal no longer refuses curved
bodies up front (`test/picked-chamfer-under-later-edits.test.ts`,
`remus-predicted-carrier-lineage.test.ts`,
`apps/web/src/components/DeleteDependentsDialog.test.tsx`).
