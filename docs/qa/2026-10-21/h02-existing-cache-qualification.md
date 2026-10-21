# H02 existing-cache qualification (2026-10-21)

This follow-up separates qualification of the shipped prefix, measurement and
STEP-import caches from the proposed detached Text-branch cache. H02 remains
Partial. No runtime behavior, cache budget, geometry tolerance or acceptance
threshold changes in this work.

The runtime under test is OpenZCAD `6cd0838b45ad9af18367b3d819de3b113cfcb246`
with the frozen paired Remus packages at
`0d942168550b6dd5101d049f7a10de0230bb5848`. Qualification helpers and regression
tests are the test-only additions in this PR. The private source, generated
documents, raw samples and browser artifacts remain outside the repository.

## Matched browser results

All six production-preview arms completed and passed their unchanged within-run
reload/edit budgets. Three pairs ran serially in alternating order on Linux
x86-64, AMD Ryzen 9 5900XT (32 logical CPUs), 31 GiB RAM, Node 24.14.0,
Playwright 1.63.0 and headless Chromium 153.0.8010.12. No local validation suite
ran alongside the retained samples. Unrelated host work continued: the one-minute
load at arm starts ranged from **18.67 to 38.37**. This is a shared-host
characterization, not quiet target-device or physical-display acceptance.

The report verified matching source bytes, source commit, lockfile, feature
count, parameter sequence, pair IDs and observed cache modes. Every arm's final
exact counts are 17 bodies / 720 faces; each document has 31 features. Disabled
sets the existing history, measurement and STEP-import cache budgets to zero;
enabled retains defaults. The worker's document-keyed result memo stays enabled
in both arms. The three-sample p95 is the maximum; all samples are retained.

Times below are milliseconds, rounded to one decimal. The stage rows describe
the first edit's preflight stages. Union, Text and placement are contained within
replay; measurement is an envelope rather than a sum of overlapping timers.
They must not be added to the primary Enter-to-fresh-live exact completion.

| Observation                     |  Disabled median / p95 |  Enabled median / p95 |
| ------------------------------- | ---------------------: | --------------------: |
| Suffix replay                   |      2,510.5 / 3,832.8 |     3,665.0 / 3,799.6 |
| Growing-holder union            |      1,244.8 / 1,798.0 |     1,857.4 / 1,881.3 |
| Fixed Text branch               |          103.5 / 203.2 |             0.0 / 0.0 |
| Parameter-driven text placement |            10.0 / 20.4 |           15.9 / 18.6 |
| Body measurement envelope       |      1,914.4 / 2,832.4 |     2,691.0 / 2,969.3 |
| Total exact completion          | **8,571.1 / 12,386.6** | **7,704.5 / 9,348.2** |

Observed p95 total completion improves **24.5%**; median improves **10.1%**.
The report's `existingCacheTimingTargetMet` is true for these three matched
pairs, and `proposedBranchCacheAccepted` remains false. Several contained stage
medians are slower in the enabled arm; these noisy measurements do not establish
individual cache contributions or a general stage speedup. A quiet M5 Pro
campaign remains necessary, and no sample is removed to improve the result.

Across each arm's six first-edit preflight/live cache events, disabled replayed
all 31 features and remeasured all 17 bodies per sync (102 `no-entry` misses,
zero restores/reuse). Enabled replayed a median 13.5 features and restored 17.5,
measured 7.5 bodies and reused 9.5; the totals are 45 `solid-handles` misses and
57 hits. Neither arm reported an integrity reset. Enabled's zero Text time means
the existing prefix restored that import; it is not a detached branch hit.

Median stored local-copy JSON lengths are 59,415,052 bytes disabled and
59,527,434 enabled. These observed snapshot sizes include derived data; they are
not canonical input equivalence, raw B-rep equivalence or reference-only cloud
document size. The independent exact-output checks below remain necessary.

### Memory observations

Each arm forces GC on the one geometry worker after all five edits and two
durable page reloads. All six CDP probes succeeded. These endpoint observations
are separate from peak memory and the primary first-edit timings.

| Observation, bytes              |   Disabled median / p95 |    Enabled median / p95 |
| ------------------------------- | ----------------------: | ----------------------: |
| Geometry-worker JS isolate heap | 15,828,836 / 15,829,388 | 21,953,712 / 21,968,404 |
| CDP embedder heap               |         43,280 / 43,280 |         43,288 / 43,288 |
| CDP backing storage             | 37,912,289 / 37,912,289 | 50,903,107 / 50,903,107 |

Maximum accounted measurement retention is 0 disabled / 16,364,678 enabled;
maximum estimated checkpoint/topology bytes are 7,403,328 / 141,467,197; maximum
WASM linear-memory capacity is 130,023,424 / 273,743,872. Accounting, estimates,
capacity, JS heap and backing storage describe different things and may overlap.
They are not summed into a whole-worker retained-memory claim. They do not prove
a sustained private-session memory bound or the proposed branch allowance.

## Exact output

The opt-in `test/h02-private-holder-cache.test.ts` passes on the local holder:

- The unchanged-source measurement hit matches the entire published payload,
  including mesh buffer bytes and structure.
- The changed holder matches the cache-disabled fresh-build publication across
  17 bodies and 720 faces, including validation, warnings, topology/lineage and
  measurement provenance, under the oracle's existing documented normalization.
- Each body's reachable exact B-rep is additionally serialized from the actual
  cached and fresh builds, before measurement. All **3,204,155 serialized bytes**
  match exactly across the 17 bodies, including consumed construction bodies.
  No numeric tolerance, timestamp normalization or geometry substitution is
  applied to these serialized bytes.

The new test helper captures the owning kernel and live build result; it does
not invoke export and build a second model. It compares bytes, solid counts and
consumed flags. Diagnostics contain body indices, counts and equality booleans,
never source names, model identifiers or geometry. Per-body serialization does
not establish cross-body shared-topology identity or equality of unrelated
kernel session state. The existing publication normalization still replaces
mesh arrays with triangle counts and two arena-local diagnostic indices with
zero; the raw B-rep check is separate and does not relax that comparison.

`test/h02-exact-arena-equivalence.test.ts` checks the helper against an actual
unchanged cache hit, a one-byte corruption and a real geometry edit.

## Existing-cache lifetime

The new measurement-cache regression calibrates real entry sizes, then gives
the cache enough bytes for any two of three entries. Four passes verify two
retained hits, one evicted-body remeasurement, exact payload equality and the
sum of accounted bytes remaining within the cap. A refused build, recovery,
disposal and a fresh rebuild are checked after eviction.

The installed-kernel checkpoint regression also confirms that an old suffix
checkpoint stays unusable after new geometry is replayed, and that rejecting
its restoration leaves the new geometry valid. Existing tests continue to
cover 270 repeated edits, kernel recycling, source/sketch/parameter/unit and
analysis changes, checkpoint eviction, witness failures and caller mutation.

These checks qualify existing arena-bound owners. They do not qualify a
detached Text record, and adapter disposal is not a physical-device browser
termination or whole-worker retained-memory measurement.

## Remaining branch boundary

The [pinned Remus checkpoint API](https://github.com/esaueng/remus/blob/0d942168550b6dd5101d049f7a10de0230bb5848/crates/wasm/src/bindings/checkpoint.rs#L53-L100)
restores ancestors and permanently retires later checkpoints and handles. It
has no operation that restores an old Text
branch while preserving a newly rebuilt holder branch. The proposal therefore
still needs a branch-preserving kernel contract and complete interval
dependency/effect analysis before it can be implemented or tested for false
hits. Unknown dependencies must remain misses. Current recipes also move Text
before the edited suffix; the later text placement reads the edited parameters
and cannot be treated as immutable.

No detached branch record or additional 8 MiB allocation exists. That proposed
cap is an additional accounted branch-record ceiling alongside existing cache
limits; it is not a total-worker limit or an enabled-minus-disabled JS-heap
allowance. Existing-cache timing cannot accept an unimplemented branch cache.

## Reproduction

Use the matched-arm commands in the
[benchmark reproduction](../2026-10-15/h02-matched-cache-benchmark.md#reproduction).
Run arms serially, alternating order, with a clean unchanged source checkout,
fresh preview servers and output paths outside the repository. Do not run
validation suites concurrently with retained timing samples.

```bash
OZ_PERF_HOLDER_STEP=/absolute/local/source.step \
OZ_PERF_PRIVATE_DIFF_OUT=/absolute/local/h02/oracle.json \
pnpm exec vitest run test/h02-private-holder-cache.test.ts --maxWorkers=1

pnpm exec vitest run test/h02-measurement-cache.test.ts \
  test/h02-exact-arena-equivalence.test.ts --maxWorkers=1
```

The public focused run passes 27 tests; the opt-in private oracle passes its
one case. Browser timing, target-device acceptance and whole-worker retained
memory remain separate evidence from those exactness and lifetime checks.

## Local M5 Pro handoff

The maintainer confirms that the M5 Pro is the target laptop and will use a
local Codex chat for that campaign. The Linux executor can see the Mac online
but its read-only SSH connection timed out; no target-Mac execution is claimed.
This is a browser production-preview campaign, not the paid Apple Silicon CI
workflow or a desktop package qualification.

For the local chat:

1. Preserve existing work and use isolated checkouts. Pin the browser checkout
   to the runtime commit above; use this PR's test-only additions in a separate
   qualification checkout for the private oracle. Frozen installs must retain
   the recorded paired kernel pin. Audit hooks and use the approved identity.
2. Locate the existing private holder locally. Keep its bytes, names, documents,
   raw reports, browser artifacts and source fingerprints outside the repository.
   Do not substitute the small public fixture for the private acceptance trace.
3. Record macOS, M5 Pro model, memory, Node, Playwright and Chromium versions,
   display/headless settings and background load. Run on a quiet plugged-in
   machine, without concurrent builds or tests. Do not change runtime cache
   behavior, limits, tolerances, geometry validation or benchmark assertions.
4. Run all six arms in order: disabled/enabled for pair 1, enabled/disabled for
   pair 2, disabled/enabled for pair 3. Use `holder_height`, the same source and
   edit sequence, a new outside-repository output directory, a clean unchanged
   checkout and a fresh preview server per arm. Retain failures and slow samples.
5. Aggregate with `scripts/h02-cache-benchmark.mjs`. Report every stage's median
   and nearest-rank p95, exact completion, cache hit/miss/reset diagnostics,
   restored/replayed features, measured/reused bodies, document bytes and exact
   counts. With three samples, p95 is the maximum. Keep preview timing separate.
6. Report post-GC JS isolate heap, embedder and backing-storage observations
   separately, including unavailable values. Do not call their sum total worker
   memory, substitute accounted bytes for heap, or use the proposed 8 MiB branch
   allowance as a total-cache delta limit.
7. Run the private raw B-rep/publication oracle and existing mutation/lifetime
   suites serially after the timing campaign. A sustained private browser session
   still needs checkpoint eviction/recycling, repeated edits, worker termination,
   refusal/recovery, fresh-oracle comparisons and repeated post-GC observations;
   the small public lifetime fixtures do not replace that private memory proof.
   Record immutable source identities and update the H02 evidence row through a
   ready-for-review PR with the required checks. A timing improvement does not
   accept the detached Text proposal; preserve the explicit kernel/dependency
   and memory limitations above.
