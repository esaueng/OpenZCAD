---
row: M02
---

Patterns of ribs (no schema change: an older client refuses such a pattern
by name rather than building it wrongly). A feature pattern's
`sourceFeatureIds` may now name a rib. Each rib now names its faces as a
wrap does: the body's names carried where the rib only trims a face, and
each face it adds named after its own exact witness by a 128-bit name (`rib.face.w<name>`).
A pattern makes the rib's material again against the body the rib was made
on, as its build does (`buildRibSolid`), and adds each copy where it lands,
one copy at a time, each proven as slice 1's are and to join the body (a
copy whose fuse adds a separate piece is refused by its label); each copy's faces are
named after the rib's, by copy. Refused by name: a rib that did not build
("Gusset did not build, so a pattern cannot repeat it; fix Gusset first").
In the workspace, Repeat Features takes a rib by a click on one of its
faces. Evidence: `test/pattern-ribs.test.ts` (on the pinned kernel, an L
bracket 20 deep: the rib's own faces named after it; its 2-thick gusset
across the inside corner repeated three times 4 apart along Z, adding
3 × 625 to 7 500, each copy's faces named by copy; a rib whose profile
closes off nothing refused by its pattern; a copy 20 along (1, 1, 0), clear
of both legs, refused as not joining the bracket); `test/e2e/pattern-ribs.spec.ts`
(`@ci-smoke`), which sets Repeat Features along Z, picks the gusset's side,
drags the spacing arrow from 20 to between 2 and 4.5, and checks the stored
pattern.
