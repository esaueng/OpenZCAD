---
row: AS02
---

Gear coupling (schema v56, `assembly.couplings`): meshed gears turn
together. A coupling is one linear relation between two joint values,
`driven = ratio × driver + offset`: −z₁/z₂ for an external pair, +z₁/z₂ for a
pinion in a ring, pitch radius × π/180 per degree for a rack and its pinion,
the offset holding the tooth phase the pair was placed at. Joint values are
settled first as plain numbers and the tree is then placed as before.
Couplings never form a loop, so each group has one free value and the solve
is exact. One member leads and the rest follow, and the leader is named
rather than guessed from values: each caller passes the motions being driven
(most recent first) beside the values, so a dragged or typed motion leads
even over a value an earlier scrub left on screen, a study's tracks lead in
track order wherever their values stand, and `assembly.pose.set` stores the
drivers so the saved pose is the one shown. The paths that move joints each
carry them: viewport drag and its cancel, the joint's slider and number,
Animate, study playback and scrubbing, View playback, and keying a pose in an
open study (which keys the motion the study already tracks in that group,
so coupled joints share one track, and only a group the pose really moved:
moving an unrelated joint never rewrites a key that a limit holds short of,
and a part put back where the study shows it is no edit, since movement is
judged on the driving motion in its own units rather than on values the
ratio chain has scaled; a real move is keyed however small it is on a
geared-down tracked shaft). The moved motion is required: the runtime keeps what the user moved apart
from what a scrub or playback drives, and a pose that writes into a coupled
group without naming a motion of it is refused rather than judged from the
track. The lead is clamped to the range every
member's limit allows (a driven joint's limit stops its driver); a drag, an
Animate sweep and View's joint playback all read that narrowed range.
Refused by code (`coupling:*`): an unknown joint, a joint coupled to itself,
a rigid joint or a motion the joint lacks, a joint that never moves, a zero
or non-finite ratio, a second link between motions already coupled
(`redundant` at the same ratio, `conflict` at another) and limits that leave
no shared position. A coupled joint must stay movable: an edit that would
stop one (fixing a coupled gear in place) is refused until the coupling is
removed, and storage validation rejects a coupling on a joint the solve
cannot move. A coupling is removed with either of its joints, and a joint's
details name it and offer Remove. Place gears gains a Motion step: Turn
together (where the card starts whenever it can be made) gives each gear a
revolute joint about its own axis (a rack a slider along its teeth, limited
to its length) on the part the pair is mounted on, plus the coupling, as one
undo step; Fixed together saves the rigid joint as before and is all a bare
pair can have. A floating mount is fixed, a fixed first gear is released,
and a first gear that already turns on a joint about its axis keeps it, so a
train is built gear by gear. Refused by code (`gear-coupling:*`): no part to
mount the pair on, a first gear held by a rigid joint or moving on a joint
off its axis, joints that would close a loop, and a mount nothing holds
still. The ratio and its sign come from the M14 helper (`meshGearPair`) and
the placed axes ([plan](docs/plans/assemblies-plan.md)). A coupling's ratio
is fixed when the pair is placed; when a gear's teeth no longer give it, the
joint's details and the reopened card warn and ask for the pair to be placed
again. The coupling records its gear pair (`gears`, component ids), so the
check reads the real gears also when one is keyed to a shaft or two share a
shaft, and the coupling goes when either gear leaves the assembly; removing
a part or a joint in the sidebar names the couplings that went with it.
v56 sits on top of v55 (M14 partial-span teeth, which merged first): a v55
document opens with its span, and only couplings need v56. The three coupling
commands are in the analytics operation vocabulary. Not in this slice: a
coupling editor outside the card, couplings for non-gear joints, screw
couplings and bevel or worm pairs (AS08, M14). Evidence:
`test/assembly-coupling.test.ts` (CI smoke selection: external, internal and
rack ratios with poses, phase-preserving offset, either side driving, an
idler train, limit clamping and the narrowed drag range; the edited motion
leading over a value a scrub left, the lead holding where a keyed value
crosses its saved one and in either track order; every refusal code, stored
loops rejected; add/update/delete with undo and redo, a pose or typed value
on either joint, a pose saved with its drivers, limit conflicts, fixing a
coupled gear refused and rejected in storage, pruning with a joint,
component or kind change, the recorded gear pair validated and the coupling
dropped with a keyed gear, replay, save and reopen; v54 documents opening
unchanged, a v55 partial-span document opening with its span, and couplings
refused below v56),
`test/gear-coupling.test.ts` (CI smoke selection: the saved joints and
coupling land the second gear exactly where the fixed placement does; at the
pitch point both parts move at the same velocity for external, flipped-axis,
ring and rack pairs whichever stays put, for a reused joint at a non-zero
angle, against its axis or from its parent end, and through a three-gear
train; rack travel limits stop the pinion; the stale-ratio warning for a
re-toothed wheel and rack pinion, and for a pinion keyed to a shaft that a
second gear pair shares; every `gear-coupling:*` refusal; one undo),
`test/gear-coupling-kernel.test.ts` (full suite: on the exact kernel, an
external spur pair, a pinion in its ring and a rack pair are driven through
several angles and built where the coupled solve poses them; grids across
the pitch point never overlap and stay interleaved, while the same drive
with the ratio's sign reversed collides),
`apps/web/src/lib/assembly/coupledDrive.test.tsx` (the driven gear dragged
after a scrub leads and is saved with its driver; drivers follow the values
on screen; a drag in an open study re-keys the tracked gear; moving an
unrelated joint at the end of a study whose track a limit holds at 40° of
its 80° key leaves that key exactly; a 0.1° move of the first of five
shafts geared 1 : 20 four times is keyed on the tracked last shaft at
6.25e-7° and plays back; on a ten-shaft train with offsets and an eased
track, a shaft returned to its shown value adds no key and leaves the
curve as it was, though rounding moves the first shaft's settled value by
more than the tolerance; the five-shaft move as a complete pose is keyed
when its motion is named and throws when it is not; the runtime's moved list
excludes scrub and playback drivers; one track per coupled group; Animate and the View player sweep the same ±40° of a pair
whose mate is limited to ±20°),
`apps/web/src/components/assembly/GearMeshCard.test.tsx` (Turn together is
the default with a mount and saves one transaction, Fixed together one
choice away and the default for a bare pair; the joint's details name the
coupling and Remove deletes it; the stale-ratio warning on the joint and in
the reopened card, also for a pinion keyed to its shaft; removing that
pinion from the row menu or its details says Gear ratio went with it),
`apps/web/src/components/assembly/MotionStudyTimeline.test.tsx` (a coupled
move that names no motion is not keyed and says so; named, it keys the
study's own gear), `apps/web/src/lib/assembly/assembleWorkspace.test.ts` (the removal message
for a keyed gear, a joint and several couplings, and none when refused), `apps/web/src/lib/assembly/assemblyView.test.ts` (both
bodies move when either joint is overridden; a sweep covers only the coupled
range) and `test/e2e/gear-mesh.spec.ts` (CI smoke: two gears on a plate
start on Turn together, 40° on the pinion reads −20° on the wheel and back,
and the coupling holds after a reload).
