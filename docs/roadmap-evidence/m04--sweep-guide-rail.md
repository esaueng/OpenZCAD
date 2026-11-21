---
row: M04
---

Guide rails on the exact route. An in-place sweep now follows a `guide` rail when the rail is one straight line beside a straight path, in one plane with it, running from the profile's plane to the path's far end. The rail's distance from the path then changes linearly, so the profile scales about the path to follow it exactly. The end scale is the rail's far distance over its near one, built by the kernel's exact `sweepExactWithOptions`. Every point at the rail's distance stays on the rail.

Each of these is refused by name and builds nothing, never sampled:

- a curved rail;
- a rail on a path that bends;
- a rail that does not run the length of the path;
- a rail that crosses the path or turns about it;
- a rail together with a twist or end scale.

On Exact, the Sweep card offers Rail picking; the twist and scale rows are not written with a rail. The rail adds no stored field, so the schema is unchanged.

Evidence:

- `test/exact-sweep-guide-rail.test.ts`: a square scaled to half by a rail from 3 to 1.5 off the path, six planes at the Cavalieri volume; a disc and a rail drawn the other way round, one cone; the four refusals; entry validation.
- `apps/web/src/lib/inPlace/edit.test.ts`: the rail request.
- `test/e2e/exact-sweeps.spec.ts`: a square picked, then a path and a rail clicked on the canvas, builds the scaled sweep.
- `test/exact-sweep-twist-scale.test.ts`: a stored twist in a document older than v132 is refused (the guard previously covered replayed commands only).

Remaining: a rail that turns about the path (a helix) has no exact construction yet.
