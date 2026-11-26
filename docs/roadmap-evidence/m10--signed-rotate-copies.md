---
row: M10
---

Signed Rotate about axis copies about one picked edge: on an L prism with unequal arms, a +35° copy and a −35° copy about the same straight body edge, each its own Done, land at the corners the Rodrigues rotation about the edge line puts them (each corner keeping its distance to the axis, volume unchanged), on opposite sides of the source, which does not move. Each copy is one History step; one Undo removes that copy alone (and the datum axis its step added). Editing the first copy's angle in History moves only that copy. Reopened from saved JSON in a fresh kernel and replayed from the command log, the bodies, angles and positions are unchanged. In the workspace the second click on the edge lands on the drawn Axis 1, so the second copy turns about that datum and adds none; both paths are covered (`test/m10-signed-rotate-copies.test.ts`, `test/e2e/signed-rotate-copies.spec.ts`).
