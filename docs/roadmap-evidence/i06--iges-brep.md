---
row: I06
state: Complete
---

Precise-scope decision and qualification landed in Remus O5.7
(esaueng/remus#1820): an additive exact IGES 5.3 B-rep path for type 186
solids over 190–198 analytic and 128 B-spline faces, 110/100/104/126 edges,
rigid 124 frames and declared units, read through the strict STEP body
reader; surface models (143/144 with no 186 solid), other entity types and
non-rigid frames are refused by name, and the legacy preview reader stays a
declared lossy preview that OpenZCAD does not use. Eleven independent B-rep
files (box, cylinder, cone, sphere, torus, holed plate, cavity and tilted
cylinder in mm and inch, B-spline box) read with the independent reader's
volumes and centroids and validate; every file written back reads to the
same solid, and the independent reader opens every Remus-written file as one
valid solid with exact volume and area. OpenZCAD: Import CAD files reads
`.igs`/`.iges` as the exact STEP the translator restates it to (stored,
archived and replayed under the IGES file's name), and File › Export IGES
writes the shown bodies in the export unit. Evidence: `test/iges-exchange.test.ts`,
the IGES (B-rep) row of `test/exchange-round-trip.test.ts` and
`docs/exchange-loss-contract.md`, `test/e2e/iges-exchange.spec.ts`.
