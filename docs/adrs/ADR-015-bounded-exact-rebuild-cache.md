# ADR-015: Lazy exact kernels and a bounded rebuild-result cache

## Status

Accepted and implemented in the browser geometry worker (2026-07-31).

## Context

The canonical document is the source of truth and exact geometry is a derived
projection. Replaying a large unchanged history repeatedly wastes kernel work,
but an unbounded geometry cache can retain tens or hundreds of megabytes of
meshes and topology. Sharing mutable cached objects between requests can also
let one consumer corrupt another. A cache key based on derived timestamps or
JavaScript object insertion order would miss equivalent requests; a key that
omits canonical history could return stale geometry.

Kernel delivery has a separate startup concern. Empty projects and users who
never model should not pay to instantiate BrepKit, and non-STEP documents
should not load OCCT.

## Decision

The geometry worker shall dynamically import the exact adapter on the first
non-empty sync or export. BrepKit initializes behind that boundary. OCCT remains
lazy inside the adapter and is loaded only for STEP histories or the compound
STEP-export path.

Sync results use a worker-local cache with these invariants:

- The key is a stable JSON encoding of the entire canonical project document
  except `derived`. Object keys are sorted and undefined object fields omitted.
  Version, units, nodes, feature order, parameters, and history therefore remain
  part of the key.
- Equal in-flight keys share one promise; distinct in-flight loads are bounded.
- The cache stores a private structured clone and returns a fresh structured
  clone to every caller, including cache hits.
- Completed results are least-recently-used and bounded by both entry count and
  estimated bytes. Oversized or non-finitely-sized results are not cached.
- A failed load is not stored. A terminated cache rejects pending and future
  callers and drops completed entries.
- Export requests bypass the result cache. They are explicit caller-owned work
  and must rebuild/export the requested canonical document without a cached
  text artifact.
- Broadcast freshness is independent from caching: only the newest broadcast
  token may publish; explicit request IDs are never suppressed as stale.

The current worker limits are 8 completed entries, 32 MiB across keys and
values, and 4 distinct loads in flight. These are safety bounds, not a public
performance guarantee. Changing them requires memory and latency evidence.

The size estimator is deliberately conservative and inexpensive (stable JSON
UTF-16 length). It is not an exact browser heap measurement. The cache lifetime
is the Web Worker lifetime; it is not persisted to IndexedDB, D1, or a service
worker.

## Consequences

- Empty projects avoid exact-kernel startup, and ordinary native histories do
  not load OCCT.
- Repeated canonical syncs may reuse exact derived output without allowing
  callers to mutate the cached copy.
- Canonical edits, including version/history changes, create a different key;
  derived-only updates do not.
- Memory is bounded and eviction deterministic, but structured cloning and the
  full canonical key still have costs for large embedded STEP documents.
- The cache does not weaken exactness: a hit returns the result of the same
  canonical content, and stale broadcast gating still controls publication.

## Verification and release measurement

Unit tests cover key stability, derived-state exclusion, in-flight
deduplication, clone isolation, LRU/byte eviction, in-flight refusal,
termination, and newest-broadcast gating. Worker tests cover lazy loading and
cache reuse. Before tuning limits, capture cold first rebuild, warm hit latency,
eviction behavior, and retained worker memory on target hardware as described
in `docs/performance-baseline.md`.
