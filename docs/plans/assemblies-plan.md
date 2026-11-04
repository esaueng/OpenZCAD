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

Commands, each one undo step: `assembly.components.add`,
`assembly.component.update`, `assembly.component.delete`,
`assembly.joint.add`, `assembly.joint.update`, `assembly.joint.delete`,
`assembly.pose.set`, `assembly.position.save`, `assembly.position.delete`,
`assembly.study.set`, `assembly.study.delete`. A structural edit first writes
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
- **Drag:** the nearest movable joint between the dragged part and the ground
  takes the drag; turns use the angle rig about the joint axis, slides project
  onto it; the value soft-stops at its limits.
- **Animate (AS06):** Play on a joint sweeps its limits (or a full turn) once,
  on a loop or back and forth; time-pure, so dropped frames never change the
  motion.
- **Motion studies (AS07):** a timeline of keys per joint value with scrub,
  key-at-playhead, easing, speed and loop modes; playable in View mode.

## Limits and follow-ups

- Frames are stored as numbers with their picked source; re-resolving them
  after a body is reshaped is a follow-up (today the stored frame is kept).
- Loops (AS09), couplings and video export (AS08), interference during motion
  (AS04, after kernel clash support), exploded views and BOM (AS03).
