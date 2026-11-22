---
row: M04
---

Corners next to arcs now have their own canvas pick. A new case in `test/e2e/exact-sweeps.spec.ts`, "a picked line and arc take a round corner beside the arc, exactly", works through the Sweep card:

1. Choose Round, then pick a line and a square-leaving radius-10 arc on the canvas.
2. Switch to Mitre. The card refuses it by name ("A mitre is cut only between straight lines").
3. Switch back to Round and type a corner radius of 3, which is not the default.

It rebuilds with no warning at the closed-form volume π · (30 − √160 + 13 · (π/2 − asin(3/13))).
