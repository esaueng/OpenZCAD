---
row: K07
---

Overlapping axial cylinder Union STEP export (#1243): re-reproduced on Remus 2026.1.129, where the writer kept cylinder A's seam inside the window B cuts and OCCT misclassified interior witnesses and meshed with boundary and non-manifold edges. It is fixed from Remus 2026.1.130 by [Remus #1624](https://github.com/esaueng/remus/pull/1624), which moves the seam into a free angular gap. Both union orders, committed and reloaded, now read in OCCT 8.0 as closed manifold solids with both witnesses inside. `test/cylinder-union-step-seam.test.ts` screens the exchange text for a seam inside a window, with a positive control, and checks the production reader's validity, volume, witnesses and welded mesh census. The suite fails on the 2026.1.129 packages.
