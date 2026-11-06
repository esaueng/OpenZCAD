---
row: K08
---

A fillet or chamfer whose band the kernel can only fit as NURBS within
tolerance now carries an advisory saying the blend surface is approximate,
read from the typed blend's `quality` (or, for the evolution and variable
entry points that report none, from the NURBS faces the blend created). The
display-mesh-gaps advisory calls the solid exact only when it has no NURBS
face. Coverage: a real sphere/cylinder seam fillet, an exact box fillet
control, the typed-verdict route and copy checks
(`approximate-blend-disclosure.test.ts`, `exact-blend-refusal.test.ts`,
`exact-variable-blends.test.ts`). Records the 2026-11-06 owner decision in the
kernel robustness plan: a blend may be rebuilt at the approximate quality it
already had, disclosed; an exact blend is never silently rebuilt
approximately.
