---
row: M02
---

Patterns of wraps (no schema change: an older client refuses such a pattern
by name rather than building it wrongly). A feature pattern's
`sourceFeatureIds` may now name a wrap, embossed or engraved, beside holes,
bosses, cuts, fillets and chamfers. Each wrap now names its faces: the
body's names are carried through where the wrap only trims a face
(`carryAnalyticFaces`), and each face the wrap adds, on a surface the body
had no face on, is named after its own exact witness by a
128-bit name (`wrap.face.w<name>`, `nameAddedFaces`; the 32-bit
fingerprint could name two faces alike across an edit). A cone is read by
its exact surface. A face whose witness another
shares, or whose surface cannot be read, stays unnamed, and an edit that
reshapes a face renames it, so a reference never moves to another face.
The wrap's build records the cylinder or cone it resolved; a pattern makes
the wrap's material again from it and repeats it through the same arm as a
boss (emboss) or cut (engrave), each copy proven as slice 1's are. An
emboss's copies are fused one at a time, as the wrap fuses its own pieces:
the kernel declines several wrapped copies in one pass though each fuses
exactly alone. Each copy's faces are named after the wrap's, by copy.
Refused by name: a wrap that did not build ("Badge did not build, so a
pattern cannot repeat it; fix Badge first"). In the workspace, Repeat
Features takes a wrap by a click on one of its faces. Evidence:
`test/pattern-wraps.test.ts` (on the pinned kernel, a radius-10 post: the
wrap's own faces named after it and the post's caps keeping theirs; a 6 × 4
badge embossed 1 deep repeated four times round the post at
4 × 24 × (11² − 10²)/20 added, reaching ±11 on both axes, with each copy's
faces named by copy; a Ø4 disc engraved 1 deep repeated three times; a wrap
that did not build refused by its pattern; across an edit that moves the
badge, no name shared by two different faces; a badge on a frustum naming
its raised cone); `test/e2e/pattern-wraps.spec.ts`
(`@ci-smoke`), which picks the badge under Repeat Features, clicks the Z
axis line above the post, sets Fixed step, drags the step rig, sets four
copies 90° apart, and checks the stored pattern.
