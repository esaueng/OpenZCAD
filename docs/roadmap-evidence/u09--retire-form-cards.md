---
row: U09
---

Phase 7: the form cards the in-place commands replaced are gone. Every
modeling tool except Move, Extrude, the primitives, sketches, datums and
reference images starts and edits in place, so the Revolve, Boolean, Pattern,
Fillet/Chamfer and modeling-operation (Mirror, Split, Hole, Shell, Thicken,
Solid offset, Draft) cards, the Inspector branches and App state that fed
them, and the Hole card's bore ghost were unreachable and are deleted
(about 7,500 lines). The commits they made still go through the same
`updateFeature` and feature commands the in-place Done uses; the Move
card's Transform form stays for the Move edits it serves.
