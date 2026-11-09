---
row: U11
---

Helical sweep, smooth coils: a new helix is wound about its axis where the profile sits, as exact curved surfaces (Remus `helicalSweepInPlace`, stored as the optional `construction: 'in-place'`, no schema bump), so the coil starts at the profile and the coil-end ball rides the built coil from there; the height arrow stands on the axis, clear of the ball, and the turns chip steps off the ball instead of covering it; one without the field replays the faceted `helicalSweep` unchanged, and an edit keeps how a helix was built; the faceting advisory no longer fires for an in-place coil (`tools.test.ts`, `edit.test.ts`, `modelingOperationsEdit.test.ts`, `advanced-modeling-features.test.ts`, `sweep-faceting-disclosure.test.ts`, `in-place-sketch-tools.spec.ts`).
