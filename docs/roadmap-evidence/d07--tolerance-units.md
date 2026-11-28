---
row: D07
---

Tolerance units (schema v156, #2162, #2238): a dimension's length tolerance
and a feature control frame's amount state the units they are in, and the
sheet converts them to its printed units in the drawing and in SVG, DXF and
PDF. Changing a sheet's dimension units pins the old units on any tolerance
stated before v156, so its physical limits never change; mm → in → mm
exports identical files (`test/drawing-tolerance-units.test.ts`).
Every format change a v156 client builds works out its own pin, while a
pre-v156 log entry replays as recorded. A tiny converted amount still prints
nonzero (0.00001 mm is 0.00000039 in), and a pre-v156 document refuses edits
that state units.
