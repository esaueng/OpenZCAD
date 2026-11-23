---
row: M01
state: Partial
---

Hole handles audited against U01/U11 (no schema change).
Audited: the viewport handles (diameter rim, depth and thread arrows, the
counterbore/countersink and position chips, drag preview and release), the
chip keypad, the in-place card and its Options, the History re-arm edit,
display-unit read-outs and typed entry, and cancel, Escape, undo/redo and
refusals. Fixed: (1) a clicked hole's handles stood on the raw click while
the preview and commit drilled it at the click rounded to the sketch snap,
so the rim and arrows sat up to half a snap step off the bore; they now stand
where the request drills it, from the same function. (2) Switching a clicked
hole's Position to Typed dropped it to (0, 0); U and V now carry the position
it was drilled at (Typed chosen again keeps what was typed). (3) A standard hole's hint read its table diameter in the
stored unit, unlabelled, beside Options and chips in the display unit; it
now reads in the display unit, with its symbol, when they differ. (4) A
tapped hole stored with a clearance of its own reopened with no Thread fit
chosen; it reopens on an "As saved" choice and writes the clearance back
unchanged. (5) A refused Hole request took its preview down and left the
handles on the refused value; like Fillet and Chamfer it now keeps the last
frame that built, its handles and chips standing on the values that frame
built from, and names the input that changed ("Counterbore ⌀: …"),
not the steps that only followed a new bore. (6) Picking a bore, or its
rim, of a hole on sketch points (`hole.face.at.<point>.bore`) named no
feature, so Edit, Delete and the read-out missed it; it names its Hole.
(7) A standard hole's chips were spaced from the stale typed diameter, not
the table's bore. Verified unchanged: one value owner across chip, keypad
and Options (each writes the same session value the request reads); an
untouched edit writes the hole back as stored; Escape and Cancel commit
nothing; a thread arrow dragged past its bore is refused by the kernel by
name. Evidence: `apps/web/src/lib/inPlace/tools.test.ts` (snapped handles,
Typed carry, display-unit hint, standard spacing, refused inputs),
`apps/web/src/lib/inPlace/edit.test.ts` ("As saved" fit), `test/hole-points.test.ts`
(on the pinned kernel each point's bore and rim resolve to the hole), and
`test/e2e/hole-handles-contract.spec.ts`: a click at (23.4, 16.6) puts the
diameter ball on the rim of the bore at the snapped (23, 17) within 1.5 px;
the dragged size is the chip's text and the stored diameter; Typed reads
U −2, V 3 and stores them; a keypad 8 and an Options blind depth 7 are what
the History edit stores; Escape after a typed size and a drag leaves the
stored hole deep-equal and History unchanged; Undo and Redo restore each
committed hole exactly; a too-narrow Ø4 counterbore is named "Counterbore ⌀",
its chip stays on the kept Ø10.8 rim within 2 px, and Escape leaves no hole; in a millimetre document
shown in inches the Ø6 chip reads 0.236 in, a keypad 0.25 reads 0.25 in and
stores 6.35 mm, and an M8 clearance hint reads 0.354 in. The first two
browser cases fail without the fix. Remaining for M01: an untouched tapped
through-hole's thread arrow reads the inactive blind depth (10 mm) while Done
threads the whole bore (an M8 tapped through a 20 mm plate shows 10, cuts 20);
the client has no exact through-bore length, so the arrow needs the built
bore's length or no default reading before displayed value = committed
geometry holds for it.
