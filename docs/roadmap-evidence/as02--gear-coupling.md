---
row: AS02
---

Gear coupling (schema v56, `assembly.couplings`): meshed gears turn
together. A coupling is one linear relation between two joint values,
`driven = ratio × driver + offset`: −z₁/z₂ for an external pair, +z₁/z₂ for a
pinion in a ring, pitch radius × π/180 per degree for a rack and its pinion,
the offset holding the tooth phase the pair was placed at. Joint values are
settled first as plain numbers and the tree is then placed as before, so
drag previews, Animate, motion studies, View playback and saved poses all
follow it without their own code. Couplings never form a loop, so each group
has one free value and the solve is exact: whichever member was moved leads,
the rest follow, and the lead is clamped to the range every member's limit
allows (a driven joint's limit stops its driver; a drag and an Animate sweep
read that narrowed range). Refused by code (`coupling:*`): an unknown joint,
a joint coupled to itself, a rigid joint or a motion the joint lacks, a joint
that never moves, a zero or non-finite ratio, a second link between motions
already coupled (`redundant` at the same ratio, `conflict` at another) and
limits that leave no shared position. A coupling is removed with either of
its joints, and a joint's details name it and offer Remove. Place gears
gains a Motion step: Fixed together (the default, the rigid joint as before)
or Turn together, which gives each gear a revolute joint about its own axis
(a rack a slider along its teeth, limited to its length) on the part the
pair is mounted on, plus the coupling, as one undo step; a floating mount is
fixed, a fixed first gear is released, and a first gear that already turns
on a joint about its axis keeps it, so a train is built gear by gear.
Refused by code (`gear-coupling:*`): no part to mount the pair on, a first
gear held by a rigid joint or moving on a joint off its axis, and joints
that would close a loop. The ratio and its sign come from the M14 helper
(`meshGearPair`) and the placed axes ([plan](docs/plans/assemblies-plan.md)).
Not in this slice: a general ratio editor for non-gear joints, screw
couplings and bevel or worm pairs (AS08, M14); a coupling's ratio is fixed
when the pair is placed and does not follow a later tooth-count edit.
Evidence: `test/assembly-coupling.test.ts` (CI smoke selection: external,
internal and rack ratios with poses, phase-preserving offset, either side
driving, an idler train, limit clamping and the narrowed drag range, motion
study keys, every refusal code, stored loops rejected, add/update/delete with
undo and redo, a pose or typed value on either joint, limit conflicts,
pruning with a joint, component or kind change, replay, save and reopen, and
v54 documents opening unchanged while couplings require v56),
`test/gear-coupling.test.ts` (CI smoke selection: the saved joints and
coupling land the second gear exactly where the fixed placement does; at the
pitch point both parts move at the same velocity for external, flipped-axis,
ring and rack pairs whichever stays put, for a reused joint at a non-zero
angle, against its axis or from its parent end, and through a three-gear
train; rack travel limits stop the pinion; every `gear-coupling:*` refusal;
one undo), `test/gear-coupling-kernel.test.ts` (full suite: on the exact
kernel, an external spur pair, a pinion in its ring and a rack pair are
driven through several angles and built where the coupled solve poses them;
grids across the pitch point never overlap and stay interleaved, while the
same drive with the ratio's sign reversed collides),
`apps/web/src/components/assembly/GearMeshCard.test.tsx` (Turn together saves
one transaction, selects the driving joint, the joint's details name the
coupling and Remove deletes it; without a mount the card says why),
`apps/web/src/lib/assembly/assemblyView.test.ts` (both bodies move when
either joint is overridden; a sweep covers only the coupled range) and
`test/e2e/gear-mesh.spec.ts` (CI smoke: two gears on a plate, Turn together,
40° on the pinion reads −20° on the wheel and back, and the coupling holds
after a reload).
