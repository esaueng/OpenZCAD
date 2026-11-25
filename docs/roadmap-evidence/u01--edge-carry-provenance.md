---
row: U01
---

An upstream edit no longer carries a hash-only fillet or chamfer pick onto another feature's edge. Two bosses whose positions a parameter swaps leave the united solid with the same structure, fixed anchors and plane offsets, so the role matcher carried a chamfer on boss A's flush edge to boss B's and the app stored it. Each recorded pick now also keeps its provenance: the lineage identities of its adjacent faces, read through the named faces bordering any face that has none. A carry needs that provenance unchanged, and every named face in a unique role must keep its producer. Otherwise the pick refuses as `reference_missing` with a typed `carry_*` reason (`carry_provenance_changed`, `carry_provenance_unavailable`, `carry_ambiguous`, …) and nothing is persisted (`test/edge-carry-provenance.test.ts`; the reported Box 30 → 22.5 carries in `test/upstream-resize-carried-edges.test.ts` are unchanged).
