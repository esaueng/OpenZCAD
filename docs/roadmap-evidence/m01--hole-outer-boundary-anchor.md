---
row: M01
---

QA15-2D-01 fix (schema v150, up from v148): a new hole's typed position is measured from the centroid of its entry face's outer boundary loop (`positionAnchor: 'outer-centroid'`, `FaceGeometry.outerCentroid`), so drilling or resizing another hole in the face no longer moves it; holes saved with `centroid` or no marker keep their anchor (`test/hole-outer-anchor.test.ts`: four 10 mm-inset holes on a 100 × 60 plate land where typed, resizing the first leaves the rest, and a document saved before v147 rebuilds its drifted holes unchanged).
