---
row: D07
---

Slice C, model-based definition (schema v106, built on v105;
[design](docs/plans/drawing-gdt-design.md#slice-c-model-based-definition-schema-v106)):
datum features and feature control frames are stored on the model itself
(`pmi`), each on one face held by lineage then hash, with its label's anchor
on that face and the drawing's datum and frame fields (one shared
validator; a frame's tolerance in document units; one declaration per
datum letter). `pmi.add`/`update`/`delete` are undoable, replay, and never
rebuild. A face that no longer resolves leaves the entry broken by name
(`body-missing`, `not-found`, `ambiguous`), as does a frame naming an
undeclared datum (`datum-undefined`); nothing rebinds, and "Move to selected
face" re-points it. With a face selected, Objects adds either, lists them
with their state and edits the open one; the viewport labels each at its
face with the drawing's own frame and symbol geometry, amber when broken.
Evidence: `test/model-pmi.test.ts` (validation by name; commands with undo,
replay, storage, no model change and the v105 gate; a parameter-widened box
followed by lineage; `datum-undefined` and `body-missing`; drafts with the
next letter and unit amounts; the SVG frame) and `test/e2e/model-pmi.spec.ts`
(datum A on a box's bottom and a frame on its top made parallel to A in
Objects, both labelled in the viewport, reopened).
