---
row: M04
---

Curved loft guides on the exact route. The guide can be a line, an arc or an open spline, on a ruled or a smooth loft. Remus's guided loft (`loftWithOptions` `guide`, Remus #1932) follows it exactly. Every section corner rides a rail offset from the guide, every wall is a straight blend between two rails, and the guide lies on the solid. A straight guide on a ruled loft keeps the previous route: it is turned into section connections, so curved sections still take it.

These are refused by name as a typed `modeling` refusal (`loft_guide_refused`, or `loft-guide:not-one-curve` for a guide that is not one curve of its sketch), never faceted:

- a curved guide between curved sections, or between sections with different corner counts;
- a guide that misses a section corner;
- a guide that doubles back;
- a guide that crosses a section backwards.

The Loft card offers lines, arcs and open splines as guide picks once two sections are picked.

Evidence:

- `test/loft-connections.test.ts`:
  - an arc guide between 2 × 2 squares 10 apart, ruled and smooth: volume 40 (area × height), reaching out to the arc's bulge;
  - a straight guide on a smooth loft: the quarter-turn prismatoid;
  - a curved guide between discs: a typed refusal.
- `test/e2e/exact-sweeps.spec.ts`: a loft picked with a curved guide arc on the canvas, rebuilt at volume 40.
