---
row: F01
---

Per-side draft slice: schema v126 lets a symmetric or two-sided blind
extrude take `draftAngleDeg` for the side its distance runs to, and adds
`backDraftAngleDeg` for its other side. Each side is swept one-sided from the
start plane, tapered by its own angle about it (positive narrows as it
leaves; planar walls through the kernel draft, a round wall as the exact cone
loft), and the two halves are fused exactly into one solid per profile cell.
A side at zero keeps straight walls. A back draft without a back side, and
any draft on a through-all cut, refuse at entry, edit and rebuild. A taper
that closes either side refuses by name for that side. Every one-sided extrude
builds as before, and older documents load byte for byte. The Extrude bar
offers "Back draft angle" on its keypad when the extrude is symmetric or has a
back distance, and the draft rig now drafts a two-sided extrude's front side.
The History row reads "10 mm symmetric · 2° draft · 3° back draft".
Regression evidence: `test/extrude-per-side-draft.test.ts` (prismatoid and
frustum closed forms for symmetric front-only, both-sides and back-only
drafts, a two-sided taper and flare, a reversed two-sided extrusion, sides
about a start plane, a round profile, a parameter back draft, a closing back
taper refused by side, a drafted pocket cut, entry refusals, rename, edit
round trip and undo, editor rules and the History row),
`test/extrude-to-face-draft.test.ts` (a symmetric draft parameter leaving 0
now tapers the front half) and the `@ci-smoke` case in
`test/e2e/extrude-to-face-draft.spec.ts` (160 → 153.2 → 146.4 → undo).
Remaining: multi-target and add through-all, to-next, and to-face on a slanted
or curved face.
