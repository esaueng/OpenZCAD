---
row: I04
state: Complete
---

Export package slice: the mesh export dialog writes one file per body
(named after the project and the body), a batch of further formats of the
same export scope (the visible or isolated selection), and OBJ colours as
an MTL; more than one file downloads as one ZIP, and the dialog remembers
its format and package choices per browser (favourite formats). glTF now
writes each body as its own named node and mesh in a material of its
display colour (sRGB converted to glTF's linear factors), and OBJ writes
each body as a named `o` object, with `usemtl` and a companion MTL when
colours are asked for. Evidence: `test/mesh-labels.test.ts` (glTF nodes,
materials and buffer layout; OBJ index renumbering; OBJ + MTL package),
the OBJ and glTF rows of `test/exchange-round-trip.test.ts` and
`docs/exchange-loss-contract.md` (both now keep names, glTF colours),
`ExportDialog.test.tsx` (package options and remembered choices) and
`test/e2e/export-package.spec.ts`. DWG stays the separately qualified
optional slice the file-format plan names; drawing DXF/PDF stay with
D01/D04.
