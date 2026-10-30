---
row: M14
state: Partial
---
First slice (schema v40): an additive `gear` feature kind with Gear (create)
and Gear teeth (on a cylindrical face) in-place tools, edit from History, and
the exact build through Remus `makeGearDetailed` / `cutGearTeethDetailed`.
Diametral pitch is read per inch in every unit system; tooth faces carry
`gear.face.*` lineage from the kernel's roles; refusals surface as `gear:*`
kernel refusals and undercut as an advisory. Evidence:
`test/gear-feature.test.ts` (sizing conversions, frame, command validation and
refusals, 20-tooth m 2 volume between root and tip discs with every face named,
2.2 in tip diameter for 20 teeth at P 10, undercut advisory, pointed-tip
refusal, teeth on a Ø22 cylinder equal to the standalone m 1 gear's volume,
cylinder-too-small refusal) and `apps/web/src/lib/inPlace/edit.test.ts`
(untouched edits of a new gear and of teeth on a body write back as stored).
