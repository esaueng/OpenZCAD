# Assemblies: components, joints, actuation and animation

Owner rows: [AS01](../../ROADMAP.md#as01), [AS02](../../ROADMAP.md#as02),
[AS06](../../ROADMAP.md#as06), [AS07](../../ROADMAP.md#as07), with
[AS08](../../ROADMAP.md#as08) and [AS09](../../ROADMAP.md#as09) following.
ROADMAP.md owns status; this document owns the contract.

## Goal

Make a mechanism — a pair of scissors, a hinge, a slide — from bodies already
in the document, move it by hand within its joints, and play it back on a
loop. Keep it simple: four concepts, no constraint stacks, no solver for the
common case.

## What other tools share

Onshape, Fusion, SolidWorks and FreeCAD 1.x share a small core: instances of
parts, one grounded part, a joint defined by **two frames picked on
geometry** (a circular edge snaps to its centre and axis), a short list of
joint types, optional limits, a drag that respects the joints, and "Animate"
on one joint. Patterns we copy: one joint per pair (not stacks of primitive
mates, which over-constrain), limits double as the animation range, loop and
back-and-forth modes, a rest/named position. Pitfalls we avoid: drag poses
turning into history (Fusion's Capture Position), modal one-joint-only
animation (Onshape), the body/component split (Fusion), invisible grounding
(early FreeCAD).

## Decisions

1. **A component references a body in the same document.** Most people model
   both blades in one part. The reference follows the body through features
   that remake it (`assemblyComponentBodies`, the same lineage Objects folders
   use). Inserting from another project copies its bodies; no live link.
2. **The modelled position is the starting pose.** A component's placement
   starts at the identity, so it shows where it was drawn. A joint created
   between frames that already coincide is **as-built**: nothing moves and the
   current pose is value 0.
3. **Moving a part never rebuilds.** Poses are rigid transforms applied as
   object matrices; geometry is built once per body.
4. **Tree kinematics first.** `pose(child) = pose(parent) · F_parent ·
M(values) · F_child⁻¹` over a spanning forest built in joint order from the
   grounded components. Exact and deterministic. A joint that would close a
   loop is saved and reported as "not solved" (AS09 adds loop solving).
5. **Poses are saved but are not modelling history.** Joint values persist in
   the document; one drag is one undo step. Playback and the joint tool's
   preview are transient and never write the document.
6. **Assemble is a workspace mode** beside View, Tweak, Build and Drawing.
   Shapes are still edited in Build.

## Saved content (schema v54)

`ProjectDocument.assembly?: AssemblySet` — absent means no assembly; a
rebuild never reads it.

| Field        | Contents                                                                               |
| ------------ | -------------------------------------------------------------------------------------- |
| `components` | id, name, `bodyId`, `grounded`, `placement` (translation mm + unit quaternion)         |
| `joints`     | id, name, kind, parent/child end (component, frame, picked source), `values`, `limits` |
| `positions`  | named sets of joint values                                                             |
| `studies`    | name, `durationS`, playback mode, tracks of keys (`t` s, value, linear/ease)           |

Joint kinds and their values, all in the parent frame:

| Kind        | Values              | Motion                       |
| ----------- | ------------------- | ---------------------------- |
| rigid       | —                   | none                         |
| revolute    | angle °             | turn about Z                 |
| slider      | length mm           | slide along Z                |
| cylindrical | angle °, length mm  | turn about and slide along Z |
| ball        | three angles °      | turn about Z, then Y, then X |
| planar      | x mm, y mm, angle ° | slide in XY, turn about Z    |

Frames are right-handed, stored as origin + Z + X in the component's modelled
coordinates; validation requires unit axes and perpendicularity within
`1e-6`. Values are clamped into their limits on every write.

### Couplings (schema v55)

`assembly.couplings?: AssemblyCoupling[]` — absent means none, so a v54
assembly reads unchanged. A coupling ties two joint values with one linear
relation:

```
driven = ratio × driver + offset
```

| Field              | Contents                                                       |
| ------------------ | -------------------------------------------------------------- |
| `driver`, `driven` | a joint id and the index of one of its free values             |
| `ratio`            | driven units per driver unit; never zero, so it runs both ways |
| `offset`           | the phase the pair was coupled at, in the driven value's unit  |

An external gear pair is `−z₁/z₂` (degrees per degree), a pinion in a ring
`+z₁/z₂`, a rack its pinion's pitch radius × π/180 (length per degree). Each
joint measures its value about its own axis, so the stored sign also carries
the two axis senses; Place gears works it out from the placed pair.

Why this shape: joint values already are the assembly's only free numbers
(decision 4), so a relation between two of them needs no change to frames,
poses or the tree solve. The values are settled first, as plain numbers, and
the tree is then placed exactly as before. It is the smallest addition that
moves two joints together, and it is not a loop solver (AS09): a coupling
relates values, it never closes a kinematic loop.

- **One free value per group.** Couplings never form a loop (validation
  refuses one), so every group of coupled motions is a tree and each member
  is a linear function of one value. The solve is exact, with no iteration.
- **Either side drives.** In a group the member whose value was written (a
  drag, a typed value, a key, a playback frame) leads and the rest follow;
  when nothing was written the group's first member leads with its stored
  value. When several members were written at once (a motion study that keys
  both gears) the first in the group's order leads and the others' written
  values are ignored. Every command that writes values, limits or couplings
  settles the group before it returns, so stored values always satisfy every
  coupling.
- **Limits bound the pair.** The lead value is clamped into the range every
  member's limit allows: a driven joint's limit stops its driver, and a drag
  or an Animate sweep reads that narrowed range.
- **Refused by code** (`coupling:*`): an unknown joint, a joint coupled to
  itself, a rigid joint or a motion the joint does not have, a joint that
  never moves (it closes a loop or joins two fixed parts), a zero or
  non-finite ratio, a second link between motions that already move together
  (`redundant` at the same ratio, `conflict` at another, which would lock
  them), and limits that leave the group no shared position.
- A coupling goes with either of its joints: deleting the joint or its
  component, or changing the joint's kind, removes it.

Commands: `assembly.coupling.add` (without an offset it holds the current
pose), `assembly.coupling.update`, `assembly.coupling.delete`.

Commands, each one undo step: `assembly.components.add`,
`assembly.component.update`, `assembly.component.delete`,
`assembly.joint.add`, `assembly.joint.update`, `assembly.joint.delete`,
`assembly.pose.set`, `assembly.position.save`, `assembly.position.delete`,
`assembly.study.set`, `assembly.study.delete`, and for couplings (v55)
`assembly.coupling.add`, `assembly.coupling.update`,
`assembly.coupling.delete`. A structural edit first writes
every component's solved pose into its placement, so nothing jumps when the
joint graph changes.

## Interaction

- **First run:** a card lists the document's bodies; "Use N bodies as
  components" adds them in one step, the first grounded.
- **Joint tool (J):** pick the moving part's frame, then the target's. Types
  are suggested from the picks (circle ↔ circle → revolute). Coincident picks
  make an as-built joint; otherwise the moving part snaps, with Flip and
  Rotate 90°. Optional limits use the joint's own units. A second joint on the
  same pair is refused.
- **Set up motion:** the quick path when no geometry needs picking. One
  card asks what stays put (the fixed part), what moves (the first part
  not joined yet), Slide or Turn along world X, Y or Z (Reverse flips it),
  the range and the cycle (once, loop, back and forth; slow, normal or fast),
  and previews that exact sweep while it is open. Create makes an ordinary
  as-built slider or revolute joint on that axis through the moving part's
  box centre, so nothing jumps and the current pose is 0. It fixes a
  floating base first (its own undo step) and then plays the joint. The
  default slide is the base's size along the axis, rounded up to 5 mm, so a
  part resting in a holder lifts clear of it. It refuses a fixed moving part,
  an empty range, and a part that already moves on another joint (that
  would close a loop). "Pick on the model" hands over to the Joint tool.
- **Place gears:** two gear parts are placed at their working centre
  distance and tooth phase (M14). Saved fixed together (one rigid joint, the
  default) or moving together: each gear gets a revolute joint about its own
  axis (a rack a slider along its teeth) on the part the pair is mounted on,
  plus the coupling. Gears turn about fixed axes, so they need that third
  part; a pair with nothing to mount it on can only be fixed together. A
  first gear that already turns on a joint about its axis keeps that joint
  and the second gear joins the same part, which is how a train is built
  gear by gear. A joint's details name its coupling and can remove it.
- **Drag:** the nearest movable joint between the dragged part and the ground
  takes the drag; turns use the angle rig about the joint axis, slides project
  onto it; the value soft-stops at its limits.
- **Animate (AS06):** Play on a joint sweeps its limits (or a full turn) once,
  on a loop or back and forth; time-pure, so dropped frames never change the
  motion.
- **Motion studies (AS07):** a timeline of keys per joint value with scrub,
  easing, speed and loop modes. While a study is open, moving a part keys it
  at the playhead (a new study opens at its end). Playable in View mode,
  which plays each joint's Animate sweep when a project has no studies.

## Limits and follow-ups

- Frames are stored as numbers with their picked source; re-resolving them
  after a body is reshaped is a follow-up (today the stored frame is kept).
- Loops (AS09), couplings beyond gear pairs (a general ratio between any two
  joints with its own editor, screw couplings on one cylindrical joint) and
  video export (AS08), interference during motion (AS04, after kernel clash
  support), exploded views and BOM (AS03).
- A coupling's ratio is fixed when the pair is placed: editing a gear's
  tooth count or moving a joint's frame afterwards does not update it. Place
  the pair again after such an edit.
