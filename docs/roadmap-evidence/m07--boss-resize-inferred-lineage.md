---
row: M07
---

Stable replay after a boss-wall resize: the kernel's journaled cylinder resize
binds a rebuilt boss's faces positionally (`provenance: "inferred"`), and the
move-face reader consumed those bindings as construction history, so a side
plane's name landed on the top face and one name on two faces; later pushes of
that face refused as "Direct-edit face is stale … multiple compatible
candidates". Move-face journals now count only construction-provenance
bindings; the affected faces are hash-only, and references a document saved
before the fix stored under those names resolve by the exact stored witness
onto an unnamed face (ADR-013 step 2, `partial` lineage). A push into a
cylinder's rounded rim remains the kernel's plainly worded collision refusal,
not a stale name (`test/cylinder-resize-face-lineage.test.ts`,
`topology-lineage.test.ts`).
