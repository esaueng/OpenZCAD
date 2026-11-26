---
row: M11
---

2026-11-26 Mirror takes several bodies about one plane (slice 5c, owner
decision D4), on the Remus 2026.1.171 pin (`f210583`). There is no grouped
feature and no schema change. Each body is its own Mirror feature, named on
from the one before ("Mirror", "Mirror 2", …), so each History row is edited
and deleted on its own, as a single Mirror always was. Done commits them as
one transaction: one Undo takes every copy back, and one Redo restores them
under the same feature and body ids. One body is the request Mirror always
made. Bodies join from a preselection, from Objects rows (a click adds or
removes one) or by Shift-click in the view. With a body picked, a plain click
on a flat face is still the plane. An edit of one Mirror still takes one
body. The plane is stored by its numbers, so a face of one of the picked
bodies is a plane like any other: every picked body is mirrored about it,
and that body's copy meets it on the face. When one body's mirror refuses,
the bar names that body ("Back block cannot be mirrored: …"), Done stays
disabled, and every pick is kept. Clicking the body out lets the rest
mirror. Done's commit gate judges each body's Mirror as its own target, so a
partial set never lands. Three invented blocks (1000, 192 and 192 mm³)
mirrored about x = 40, and two of them about the first block's +X face, keep
each closed-form volume, with bounds reflected as x' = 2p − x; the result
survives a reopen through `assertStorableDocument`
(`test/mirror-several-bodies.test.ts`; requests and body modes in
`apps/web/src/lib/inPlace/tools.test.ts`; the named refusal, held Done and
kept picks in `apps/web/src/hooks/useInPlaceCommand.test.tsx`; the
multi-pick flow with one Undo and Redo in
`test/e2e/mirror-several-bodies.spec.ts`). Finding (Untyped refusal, K10
adapter): a Mirror whose target has no shape fails as the prose "Mirror
target is unavailable." with no typed record.
