---
row: D07
---

Tolerance units (schema v156, #2162, #2238): a dimension's length tolerance
and a feature control frame's amount state the units they are in, and the
sheet converts them to its printed units in the drawing and in SVG, DXF and
PDF. Changing a sheet's dimension units pins the old units on any tolerance
stated before v156, so its physical limits never change; mm → in → mm
exports identical files (`test/drawing-tolerance-units.test.ts`).
