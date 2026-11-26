---
row: M11
---

2026-11-26 Edit Subtract takes back an operand it removed (U11, owner
decision D1, no separate swap action), on the Remus 2026.1.171 pin
(`f210583`). This closes the Pick-class gap that
`test/e2e/boolean-role-correction.spec.ts` had pinned as `test.fixme`. Root
cause: in the edit, the operands sit inside the committed result, so with one
removed the request built nothing, the viewport kept drawing the committed
result, and Objects listed only that result. A click on the removed body
therefore landed on the edit's own result, which the pick gate refuses. Now,
while a Boolean edit's operands build nothing, the edit shows the model as it
stood before the feature (that feature and every later one paused, as a
rollback pauses them). Objects lists the inputs the feature consumed as live
rows and drops the result being rebuilt, as for a new Boolean. That frame
never enables Done. A late one is not drawn over a newer request. The edit
refuses, with a status line, any body that another feature (before or after
it) consumes. On Fixture B (Block − Post, 1750), removing the Base and
clicking Block's top, or its Objects row, takes Block back as the Tool. Done
enables only on the Post − Block frame (2750). It commits one undoable update
of the same feature under the same result id, and the History row count is
unchanged. Reopened, the feature shows Base · Post and Tool · Block. One Undo
restores Block − Post (1750) with Base · Block. Escape leaves the feature as
stored (`test/e2e/boolean-role-correction.spec.ts`; rest frame and
stale-frame ordering in `apps/web/src/hooks/useInPlaceCommand.test.tsx`; pick
eligibility, rest document and Objects rows in
`apps/web/src/lib/inPlace/edit.test.ts`).
