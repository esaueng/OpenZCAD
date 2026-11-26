---
row: K10
---

2026-11-26 CAD-workflow coupon (Slice 0) on the Remus 2026.1.171 pin
(`f210583`). `test/cad-workflow-coupon.test.ts` carries one invented slotted
coupon through a mixed history on the production adapter and the installed
WASM. The coupon is a 90 × 36 × 14 blank with a separate 20 × 36 × 14 witness
block. Two 10 × 20 channels and an r 6 bore are cut through it as sketch
extrudes (no primitive subtraction). Two direct wall offsets go through the
app's face-offset planner: +1.5 along a channel wall's −X normal narrows the
channel, and −1 along a −Y normal widens it. One R2 fillet rounds a channel's
four corners, and a Split at x = 52 closes the chain. Each step matches its
closed form to the K10 tolerance, max(0.05 mm³, 1e-6·V): 40285 − 560π after
the fillet, and 23709 − 504π and 16576 − 56π for the halves. The witness
keeps its id, bounds and volume, and each offset moves only its named wall.
Split cells on the blank: x = 30 builds 15120 and 30240. The feature's body
id is the +normal half. Both halves are hash-only. A strict miss (x = 98) and
a vertex touch (x + y + z = 0) refuse as `modeling/invalid_input/split_refused`.
A face-coincident plane (x = 90) and an edge touch (x + y = 0) refuse as
`modeling/unsupported/split_refused`. A typed zero normal makes no Split
request. After the fillet, x = 42 through the bore builds 18669 − 252π, and
x = 63 through two fillets builds 29029 − 504π − 56π/3 + 14√3. Redrawing
channel 1 as x 12–24 carries the offset to x = 22.5, with a low half of
23121 − 504π and no retarget. Undo, Redo and a reopen on a fresh adapter
keep the body ids and volumes. A split on an R01 offset datum follows the
datum from 30 to 40. `test/e2e/split-recovery.spec.ts` (`@ci-smoke`) runs
Split on the blank's picked end face. Inward is a negative offset, since the
face normal is +X. The first preview at offset 0 shows the touch refusal.
−38 previews two halves with Done enabled. +8 refuses with Done disabled,
both picks kept, and the preview frame taken down. Done, Undo, Redo and a
reload keep three bodies, their ids and the stored plane at x = 52. Escape on
a refusal adds no History row. Wording findings (refusalLanguage.ts) are
pinned as `it.fails`. A strict miss shows the generic "The exact kernel could
not build this result.", since there is no table entry for "cutting plane
does not split the solid". The face-coincident plane, where every face pick
starts, reads as "lies exactly along an existing edge".
