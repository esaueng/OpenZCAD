---
row: AS02
---

Offline save, reopen and conflict behavior of saved transforms (recorded for
AS03): the assembly section is saved content, never bookkeeping. On the
device store, components, grounding, joints, limits, the pose, named
positions and studies reopen exactly and solve to the same transforms, and a
pose edited offline reopens and undoes as one step. A copy that differs only
in its pose is a different project when opening: the copy that alone moved
since the last sync wins, and two copies posed differently are offered as a
conflict, never chosen silently. The room's three-way merge keeps a pose made
on one device with a body rename made on the other, and refuses (a conflict
for the submitter to resolve) two different poses of one joint, a joint added
to a part the other device removed, and one body added as a part on both
devices. Evidence: `apps/web/src/lib/assembly/assemblyPersistence.test.ts`
and the `test/e2e/assembly.spec.ts` CI smoke case "a part dragged offline
reopens at the dragged pose and undoes as one step" (the drag is saved on the
device while offline; after reload the part is at 35° and one undo returns
25°). No product code changed.
