---
row: M14
state: Partial
---
First slice (schema v40): an additive `gear` feature kind with Gear (create)
and Gear teeth (on a cylindrical face) in-place tools, edit from History, and
the exact build through Remus `makeGearDetailed` / `cutGearTeethDetailed`.
Helical external and internal gears, new or cut into a cylinder, take a helix
angle (0–45°, normal-section sizing per ISO 21771) and a hand; a spur gear
sends no helix fields, so it still builds on a kernel without helical gears,
which refuses a helical spec rather than building a spur. Herringbone gears
(`herringbone`, a Helix option) reverse the hand at mid-width; each half's
faces are named `….start-half` / `….end-half`. Bevel and worm gears, the
meshing-pair helper and partial-span teeth remain.
Diametral pitch is read per inch in every unit system; tooth faces carry
`gear.face.*` lineage from the kernel's roles; refusals surface as `gear:*`
kernel refusals and undercut as an advisory. Evidence:
`test/gear-feature.test.ts` (sizing conversions, frame, command validation and
refusals, 20-tooth m 2 volume between root and tip discs with every face named,
2.2 in tip diameter for 20 teeth at P 10, undercut advisory, pointed-tip
refusal, teeth on a Ø22 cylinder equal to the standalone m 1 gear's volume,
cylinder-too-small refusal, helix-angle and hand validation, a 20° helical
gear's transverse tip diameter, 40 named flanks and equal volumes for both
hands, a herringbone gear's 80 half-named flanks and its volume equal to the
single helix's) and `apps/web/src/lib/inPlace/edit.test.ts` (untouched edits of a new
gear, of teeth on a body, of a helical and of a herringbone gear write back
as stored; returning to spur clears the helix and hand, and to a single helix
clears `herringbone`).
