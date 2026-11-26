---
row: M11
---

2026-11-26 Boolean role correction and generated-wall edits (CAD-workflow
slice 3, coverage only, with U06/K05) on the Remus 2026.1.171 pin
(`f210583`). Fixture B, synthetic, in mm: Block 20 × 10 × 10 at the origin
(2000) and Post 10 × 10 × 30 moved (15, 5, 0) (3000) share a 5 × 5 × 10
column (250), so Block − Post = 1750, Post − Block = 2750, union 4750 and
intersect 250. Facts for owner decision D1 (a one-step swap or make-base
action), which this slice does not build: in a new Subtract, reversing the
roles takes two clicks, either on the Base's Objects row or on the Base in
the model. The first click takes it out, so the Tool becomes the Base, and
the second adds it back as the Tool. With every preview reply held, the late reply for
Block − Post neither enables Done nor is drawn. Only the Post − Block frame
enables Done, nothing reaches History until Done, and the committed feature
stores `[Post, Block]`, reopens Base · Post and Tool · Block, and measures
2750 (`test/e2e/boolean-role-correction.spec.ts`). After commit, the edit
cannot reverse the roles. Edit Subtract can remove either operand, but the
removed body cannot be picked back from the model or Objects (a Pick-class
gap, pinned `test.fixme` with its smallest prefix), so only Undo or
delete-and-redo reverses them. The document already allows the swap: one
undoable `updateFeature` of `targetBodyIds` rebuilds 2750 under the same
result id. Every Keep originals choice under both role orders of Subtract,
Union and Intersect keeps exactly the operands it names, each whole, beside
the closed-form result (`test/boolean-role-correction.test.ts`). The +X wall
that Post cut, named `boolean.face.operand.1…x-min`, is offset 2 mm (1850)
through the app's planner as a local offset, not as an edit of Post. When
Post moves to x = 13 in History, the offset follows the wall to x = 15
(1750) with no warning, no repair prompt and no retarget onto Block's end at
x = 20, both in the browser and on a cold reopen. A three-operand Subtract
still names every face, so the offset follows there too. It names no edges
(two operands name all 18), so a chamfer on a generated rim holds only a
hash. After the same move it stops with a typed `invalid_input` refusal and
leaves the cut unchamfered (1400), never moving to another edge; the
two-operand chamfer follows to x = 13. This is the K05 limit. An `it.fails`
pins an incidental Untyped-refusal gap: that rim chamfer refuses with category
`internal` once a through bore sits in the same top face. In a Subtract
picked from Objects, the canvas and Objects name the same operands. History
Find and an Isolate request write nothing, and Isolate on an operand the
preview has consumed is refused with a status line.
