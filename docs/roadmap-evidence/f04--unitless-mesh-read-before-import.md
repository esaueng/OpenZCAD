---
row: F04
---

OBJ and PLY are read in the chosen unit before the translator runs: the unit prompt is sized from a kernel-free scan of the file, and the import rewrites vertex positions into millimetres so translation, tessellation and the rebuild check see the numbers a millimetre copy would hold; an inch spindle imports to the same triangles as its millimetre copy, and a sub-micron feature the translator welded at the inch numbers survives; the rewrite follows the pinned reader's own syntax, writes every PLY position as a double (an ASCII float read as the translator rounds it), enforces the vertex and byte budgets while it scans, reads the finished file back a second way and refuses a file whose positions cannot all be converted (`test/unitless-mesh-units.test.ts`, `apps/web/src/lib/meshImportWorkerClient.test.ts`, `test/e2e/exchange-units.spec.ts`; #2096).
