---
row: M04
---

Loft guide curves and connections, on the exact route (schema v136).

**Connections.** A loft stores `connections`: one vertex per section, a line's or arc's end or a rectangle's or polygon's corner, named by identity. Each section's correspondence then starts there, through the kernel's `loftWithOptions` `connections` (Remus #1918). The kernel re-enters each section's outer loop at that vertex. Nothing moves. Straight-edged sections take the exact polygon loft, and curved ones the curve-preserving loft, or the loft is refused: a connection never sends a loft to the chording fallback.

**Guide.** A loft stores `guides`: one straight sketch line through a vertex of every section, on a ruled loft. The line fixes the connections where it meets each section's plane, and the ruled edge between those vertices is exactly the guide.

**Refused by name:**

- a point that is not a section vertex;
- a curved guide, more than one guide, or a guide on a smooth loft;
- connections or a guide with an apex point;
- a section that is one closed curve.

**Card.** The Loft card picks a guide line after its sections.

**Evidence:**

- `test/loft-connections.test.ts`: matching corners give the plain loft at 40. A start shifted by one corner gives the quarter-turn loft at the exact prismatoid 10/6·(4 + 8 + 4), and so does a guide from a bottom corner to the next top corner. Also the refusals.
- `test/e2e/exact-sweeps.spec.ts`: a loft picked with a guide line.

**Remaining:** a curved guide, which would need a guided surface, has no exact construction yet. Periodic lofts and end tangency are outside this slice.
