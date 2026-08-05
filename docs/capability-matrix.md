# Capability and gap matrix

Snapshot: 2026-08-04, schema v6. “Exact” means the browser geometry worker
evaluates the operation through a B-rep kernel. “Implemented behind flags” is
not a production-availability claim. Approximate previews and isolated proof
modules are called out explicitly.

| Area                    | Current capability                                                                                                                                                                                                                                     | Status                           | Explicit limit / release gate                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical model         | Schema-v6 `ProjectDocument`, serialized command history, replay, transactions, undo/redo, and v1–v5 normalization                                                                                                                                      | Working                          | Public schema changes remain additive; exact topology references use the schema-v5 contract carried by schema v6                                                                                                            |
| Exact geometry          | BrepKit implements mirror-copy, shell, and sharp positive-outward solid offset for every document, imported STEP included                                                                                                                              | Working safe subset              | BrepKit mirror refuses dense blended/boolean bodies when the pinned kernel does not preserve measured solid volume. The OpenCascade convex-planar offset limit and its capability fields are deleted (Z5); the reference adapter is corpus-only           |
| STEP                    | Exact BrepKit import/export honouring the file's declared units, plus the existing validated direct-edit subset                                                                                                                                        | Partial                          | Six-family imported-feature recognition is read-only and isolated until a live exact adjacency adapter and coordinated commands ship. Blends on imported bodies fit B-spline bands where a quarter cylinder is exact (K0.4) |
| Topology identity       | Exact witnesses and semantic lineage for supported primitives, sweeps, and rigid transforms on both kernels                                                                                                                                            | Working safe subset              | Boolean post-processing, blends, patterns, direct edits, and STEP provenance stay explicitly hash-only where complete evolution is unavailable                                                                              |
| Face-attached sketches  | Schema-v5 face references resolve an exact planar face at the sketch’s history position on both exact adapters; new UI attachments require a current matching reference; a deterministic frame is rebuilt from that face                               | Working for current references   | Deleted, ambiguous, non-planar, and unsupported faces stop rebuild. Hash-only faces refuse new sketches. Legacy attachments use the stored migration frame with a warning and can be converted explicitly to a fixed plane                      |
| Multi-profile extrusion | Multiple exact closed profiles on BrepKit; deterministic AI contract available                                                                                                                                                                | Working                          | Keep the seam and history-position fixtures green as topology contracts evolve; the parity corpus still checks the same profiles against the OpenCascade reference                                                                                                                                     |
| Modeling UI             | Mirror, shell opening-face selection, and solid-offset forms share command preflight and expression validation                                                                                                                                         | Working safe subset              | Output lineage remains hash-only. Solid offset is no longer withheld on imported documents — that gate described OpenCascade, which Z5 deleted                                                                   |
| Direct edits            | Planar offsets, cylindrical hole/boss radius edits, through-hole resize, and feature removal run on both kernels with analytic and volume validation                                                                                                   | Partial                          | Coordinated counterbore/countersink, pocket-depth, and taper-angle edits remain disabled; on BrepKit, hole closing refuses where the boolean falls back to a mesh and defeature refuses any body that is not all-planar     |
| Imported-feature proof  | Bounded analytic adjacency proofs for blind holes, counterbores, countersinks, bosses, prismatic pockets, and conical tapers                                                                                                                           | Tested read-only module          | No tessellation/nearest guessing; blends, ribs, intersections, partial revolutions, ambiguous twins, and incomplete proofs are refused. No live product wiring yet                                                          |
| Viewport edges          | One idle exact-edge batch per visible body with ownership, picking, hover, selection, seams, and wireframe                                                                                                                                             | Working                          | Continue measuring draw calls and consolidate further only against the committed probe                                                                                                                                      |
| Local persistence       | IndexedDB autosave, offline reopen, and recovery-project writes before every destructive collaboration resolution                                                                                                                                      | Working                          | Reload-survival remains a required real-session beta check during the collaboration rollout                                                                                                                                 |
| Cloud settings          | Serialized/coalesced saves, revision chaining, bounded conflict retry, offline resume, session epochs, and logout flush                                                                                                                                | Working                          | Separate from project-conflict resolution by design                                                                                                                                                                         |
| Collaboration           | Invitation acceptance UI, owner/editor/viewer APIs and dialog, one-time token copy, per-message authorization, one persisted project-wide edit lease, and explicit conflict actions                                                                     | Working for authenticated beta accounts | The beta flags admit any authenticated email; project ownership/membership and edit leases still authorize access and writes. The secret account canary remains a scoped fallback if the global flags are closed again        |
| Conflict recovery       | Use room version, Keep my version, and Save local as a copy all preserve the divergent local document first; unresolved divergence survives dialog close/reload                                                                                        | Working client flow              | Keep mine requires this client’s unexpired lease and the exact expected room version; release gate is the reload E2E                                                                                                        |
| AI proposals            | Strict schema, deterministic digest-bound validation, exact preflight, review, and one undoable transaction; face sketch, multi-profile extrude, mirror, shell, solid offset, and validated direct edits are implemented behind independent dark flags | Working, rollout-gated allowlist | Recognized imported features, imports, and collaboration actions remain disabled; stale topology witnesses are rejected                                                                                                     |
| Kernel delivery         | The exact adapter and BrepKit load lazily in the worker; jobs have tagged lifecycle state and stale-result gating                                                                                                                                     | Working                          | First-load latency remains hardware-dependent and must be measured separately from UI bundle startup                                                                                                                        |
| Exact rebuild cache     | Canonical-content key excluding derived state; structured-cloned LRU results; in-flight deduplication; 8-entry, 32 MiB, 4-load bounds                                                                                                                  | Working bounded cache            | Exports are uncached and caller-owned; cache performance and retained memory need target-hardware baselines                                                                                                                 |
| Production rollout      | Beta/development resources only                                                                                                                                                                                                                        | Deliberately absent              | No production target or production-domain configuration is authorized                                                                                                                                                       |

## Wave convergence

### Wave 0: baselines and immediate hardening

- Cloud settings serialization/retry, orientation-widget lifecycle, performance
  probes, and the pinned-kernel topology-history spike are present.
- The spike is characterization evidence, not permission to trust raw kernel
  evolution. ADR-013 records the safe subset and bridge gaps.

### Wave 1: independent foundations

- Exact-edge batching and its matched interaction baseline are working.
- Sharing authorization and additive topology witness/reference contracts are
  implemented. Unknown/closed free-form carriers fail closed.

### Wave 2: lineage, roles, leases, and worker lifecycle

- Kernel history is candidate evidence only. Exact witnesses independently
  verify the shipped semantic lineage subset, and unsupported transitions
  retain unique-hash fallback.
- Geometry worker state is project/version/request tagged. Broadcast rebuilds
  coalesce; explicit export/preview work remains lossless.
- Sharing storage, routes, role authorization, and the persisted project lease
  are enabled for authenticated beta accounts and remain closed in local Worker
  development by default.

### Wave 3: modeling contracts

- Schema v6 owns mirror, shell, and solid-offset features. Mirror creates an
  independent body; shell and offset consume their source and own the result.
- Positive shell thickness is inward while retaining the outer envelope;
  positive solid offset is outward. These unit/sign conventions are public and
  must not change silently.
- Imported-feature recognition is a narrow proof service, not a claim that the
  six feature families are editable in the workspace.

### Wave 4: product UI and conflict safety

- New face-attached sketches resolve lineage at their history position on both
  exact kernels. The stored frame is diagnostic, never a fallback for a current
  lineage reference. The UI refuses new attachments to hash-only faces rather
  than creating a warned legacy snapshot.
- Modeling forms expose exact readiness and kernel-specific unsupported reasons.
- The app centrally blocks mutations for viewers, while waiting for a lease, or
  during unresolved conflict. Recovery choices preserve a local project first.

### Wave 5: deterministic AI and worker convergence

- New AI operations use the same commands and exact preflight as manual UI.
  Topology-dependent proposals are bound to the exact digest that prompted them.
- The exact adapter/BrepKit boundary is now dynamic, OpenCascade is deleted
  from the adapter and ships nowhere, and canonical derived results use the
  bounded worker-local cache described in
  [ADR-015](adrs/ADR-015-bounded-exact-rebuild-cache.md).

## Feature flags and rollout order

The root beta `wrangler.jsonc` currently sets:

```text
PROJECT_SHARING_ENABLED=true
PROJECT_EDIT_LEASES_ENFORCED=true
PROJECT_PERSONAL_SYNC_ENABLED=true
```

`apps/web/wrangler.jsonc` remains closed for local Worker development. The beta
rollout is now:

1. Apply and verify the sharing migration and Durable Object binding.
2. Admit every authenticated account; continue enforcing project ownership,
   membership, and same-origin checks server-side.
3. Run authorization, revocation, lease-expiry, conflict recovery-copy, and
   reload-survival tests against the target beta environment.
4. Roll back all three global flags together if live authorization or lease
   behavior regresses; the secret allowlist may be used for a scoped retest.
5. Keep production configuration absent until separately authorized.
