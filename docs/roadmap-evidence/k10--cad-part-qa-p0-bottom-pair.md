---
row: K10
---

CAD part QA P0 O2 pair on the authored Part A bottom face: −14 mm and −18 mm
both refuse with the typed chamfer-carry reason on the recorded-census twin,
and both build correctly on a 30 mm plate (face position, footprint and volume
against plate section × distance). The pair is monotonic, and seeded chain
cells hold the refusals (`test/direct-edit-corpus/recorded-bottom-offsets.test.ts`).
A stepped chamfered cap that consumes its wall now raises the typed
`offset_face_collapses_chamfered_cylinder_wall` refusal with its limit
(`test/stepped-chamfered-cap-offset.test.ts`). Results are in
`docs/plans/cad-part-qa-plan-2026-11-22.md`.
