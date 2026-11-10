# Topological naming: design-review briefing pack

This pack prepares a design review of topological naming: how OpenZCAD keeps
references to faces, edges and vertices stable across feature-history replay,
and what its kernel, Remus, contributes. It summarizes code and history; it
proposes nothing.

**Revisions.** OpenZCAD `main` at `c73dccff3` (schema version 54). Remus at
`087d6360e6299f357f9b662fe6ebe42ffc1a9aab`, the revision pinned in
[kernel-adapter/package.json](../../../packages/kernel-adapter/package.json).
Line numbers refer to those revisions. Statements marked *(inferred)* were read
from code but not executed. No test suite was run to prepare this pack.

## Contents

| Section | Headline |
| --- | --- |
| [1. OpenZCAD reference model](01-openzcad-references.md): resolver, face attachment, persisted shapes, ADR divergence | A stored reference is name + ADR-011 hash + quantized witness, resolving only to one verified candidate |
| [2. Remus lineage and evolution APIs](02-remus-lineage-apis.md) | Four payload shapes plus a journal; OpenZCAD uses a subset as evidence and never stores a Remus reference |
| [3. Roadmap rows that depend on stable references](03-roadmap-dependencies.md) | 45 rows; K05 edge lineage is the most common blocker |
| [4. Recent reference-loss bugs and workarounds](04-reference-bug-history.md) | 20 incidents (2026-09-25 to 2026-11-09): 12 fixes, 5 workarounds, 2 guards, 1 test-only |
| [5. Existing lineage tests](05-lineage-tests.md) | 23 files; resolver rules tested only on synthetic inputs; 3 in CI smoke |

## Cross-cutting findings

1. **Two resolution policies.** The kernel adapter treats a v5 lineage miss as
   terminal. The web resolver (`topologyResolution.ts`) falls back to the hash
   and the projection `topologyId`. Tests pin both behaviours (§1.5, §5).
2. **Edge identity is the weak layer.** Remus fillet and chamfer lineage covers
   faces only. The typed `*Detailed` geometry calls that OpenZCAD ships emit no
   lineage. Booleans are probed on operand copies. Five of the 20 incidents
   trace to boolean-generated edges, and K05 still lists several open edge
   classes (§2.10, §3, §4).
3. **Kernel claims are evidence, not identity.** OpenZCAD re-verifies every
   Remus claim against its own witnesses. It never adopts the journal or
   `PersistentRef`, yet it depends on the undocumented index order of
   `resolveOperationOutput` for pattern and move-face names (§2.7, §2.9).
4. **Some name components are positional** *(inferred)*: sweep side-face
   indices, the vertex `end: 0 | 1` chosen by coordinate order, and union
   operand slots. Edits upstream could re-target a reference to a different
   valid entity without any error (§1.6, §5).
5. **Split, merge and delete look alike to users.** No tombstones are written,
   splits with a withheld name read as `deleted`, and only datums have a
   re-pick repair flow (§1.2, §1.5, §4).
6. **Stability across versions is unproven.** Determinism within one kernel
   version is well tested. Across Remus updates, the parity corpus pins only
   name sets and hash digests, and no golden document with stored v5
   references is replayed (§5).
7. **Documentation has drifted.** The ADR-013 capability table and coverage
   text disagree with the publishers in both directions (§1.5).

## Suggested agenda

1. **Identity spine.** Should OpenZCAD keep witness-verified names, adopt Remus
   journal references, or combine them? This also decides how saved documents
   survive kernel upgrades.
2. **One resolution policy** for the modelling path and the UI, or an explicit
   list of the consumers allowed to use the permissive one.
3. **Kernel contract.** Complete edge evolution for supported operations,
   geometry and lineage from the same call, and a documented
   `OperationOutput` order or output roles.
4. **Positional name components:** keep them, or replace each with a role or a
   construction-derived key.
5. **Lost-reference UX.** Tombstones, distinguishing split from deleted, and
   extending the datum re-pick flow to fillets, holes and face sketches.
6. **Gates.** Golden v5 documents in the parity corpus, the warm-versus-cold
   publication oracle in CI, and real-kernel lineage pins in the smoke set.

Each section ends with its own detailed open questions.
