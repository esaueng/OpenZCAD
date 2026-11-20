---
row: M02
---

Slice 3, patterns along a sketch path (schema v112, up from v111; no kernel
change). A `pattern` with `patternKind: 'path'` stores `path`: an earlier
sketch, the line and arc entities it runs along (construction ones
included), and optionally `reversed: true` and `orientation: 'tangent'`.
The curves are chained end to end, open or closed, in any listed order
(`packages/geometry/src/path-stations.ts`): an open path starts at the free
end of the earliest-listed of its two end curves, a closed one where its
first-listed curve begins, and `reversed` starts at the other end. The
original stands at the start; copy `i` stands `i × spacing` along the path
by arc length (an arc's length is r·θ, so every station is closed form),
moved there, and with `'tangent'` also turned in the sketch plane by how far
the path has turned. Copies are labelled by their index as a linear
pattern's are, so `skippedInstances` and copy names work unchanged, and it
works for whole bodies and, with `sourceFeatureIds`, for holes, bosses and
cuts with slice 1's per-copy proofs. Every copy is a rigid copy through the
K05 copy-and-fuse path. Refused: a path on another kind, a missing sketch,
a curve named twice, an entity that is not a line or arc, a later sketch,
an unknown orientation, and below v112 by the content gate; at build, by
name, curves that branch or do not join, a deleted curve, and copies that
do not fit ("6 copies 20 apart need 100 of path, and the path is 80 long…
Lower the count or the spacing", a closed path short of coming back onto
the original). UI (U11 pick-and-drag): a Path pattern tool in the Pattern
group with Repeat (Body, Features); after the body or the feature, clicks
on sketch lines and arcs pick the path. The start is the end nearer the
original (an edit keeps the stored one while the curves stay the same);
Options hold Orientation (Moved, Follow path) and Start (Near end, Other
end). One arrow along the path's first direction drags the spacing, each
copy wears the skip chip, and a count that does not fit is named in the
hint with the path's length. A History edit reopens with the curves as
picks and writes the pattern back unchanged; History makes the sketch a
parent of the pattern and an edit to the sketch revalidates it. Evidence:
`test/path-pattern.test.ts` (16 cases: stations, turns and fit on a line
and arc in closed form; a hole repeated four times along a line with bore
axes, closed-form volume and per-copy names; copies carried round an arc
from a reversed start; whole-body copies moved or turned with the path,
by bounding box; copies past the end and a deleted curve refused by name;
an edited count and spacing; the document and v112-gate refusals);
`apps/web/src/lib/inPlace/tools.test.ts`, `edit.test.ts`,
`featureHistory.test.ts`, `affectedFeatureTargets.test.ts`;
`test/e2e/path-pattern.spec.ts`, which drills a hole in place, picks its
bore under Repeat Features, clicks the two lines of an L, drags the spacing
arrow, skips copy 1 by its chip and checks the stored path and its "1
skipped" History row. The grid preview path the M02 budget measures is
unchanged. Open: mirror patterns; naming boss and cut copies' faces;
repeating fillets, chamfers and other feature kinds; a total-or-spacing
choice for linear patterns.
