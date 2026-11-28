---
row: F04
---

OBJ and PLY are read in the chosen unit before the translator runs: the unit prompt is sized from a kernel-free scan of the file, and the import rewrites vertex positions into millimetres so translation, tessellation and the rebuild check see the numbers a millimetre copy would hold; an inch spindle imports to the same triangles as its millimetre copy, and a sub-micron feature the translator welded at the inch numbers survives (`test/unitless-mesh-units.test.ts`, `apps/web/src/lib/meshImportWorkerClient.test.ts`, `test/e2e/exchange-units.spec.ts`; #2096).
