---
row: M04
---

Corners next to arcs now have their own canvas pick. A new case in `test/e2e/exact-sweeps.spec.ts`, "a picked line and arc take a round corner beside the arc, exactly", works through the Sweep card:

1. Pick a line and a square-leaving radius-10 arc on the canvas. The card refuses Mitre by name ("A mitre is cut only between straight lines").
2. Choose Round and type a corner radius of 2.

It rebuilds with no warning at the closed-form volume π · (20 − (√140 − 10) + 12 · (π/2 − asin(1/6))).
