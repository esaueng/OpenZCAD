---
row: AS02
state: In review
---

Typed rigid, revolute, slider, cylindrical, ball and planar joints between
picked frames, as-built when the frames coincide; exact tree kinematics with
loop-closing joints reported as not solved; a drag moves the nearest movable
joint and soft-stops at its limits, one undo step per drag. Evidence:
`test/assembly-kinematics.test.ts`, `apps/web/src/lib/assembly/*.test.ts`.
