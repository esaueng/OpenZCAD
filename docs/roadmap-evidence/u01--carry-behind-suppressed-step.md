---
row: U01
---

Resize Body behind a manually suppressed step: a Box width edit on Box → Cylinder → Chamfer (suppressed) → Union → Fillet → Chamfer 2 refused on release because Chamfer 2's edges, picked on the filleted union, are stored by hash alone (that body names none of them) and the build withheld the hash-only carry after any suppression. The carry is now proposed and stored behind a manual suppression; lineage repairs stay withheld there and nothing after a failure is carried (ADR-017 amendment; `test/upstream-resize-carried-edges.test.ts`, `test/edge-modifier-creation-paths.test.ts`).
