# H02 lineage runtime candidate

H02 remains **Partial**. This is a separate runtime candidate for the
[publication failure recorded in #799](https://github.com/esaueng/OpenZCAD/pull/799).
The frozen qualification baseline remains
`6cd0838b45ad9af18367b3d819de3b113cfcb246`; the paired Remus packages remain
`0d942168550b6dd5101d049f7a10de0230bb5848`. The previous M5 Pro timings and private
session results describe that baseline, not this candidate.

## Changed behavior

An eager export or preview can populate boolean lineage that a fresh idle build
would omit. Previously, a later idle request could restore that geometry checkpoint
and publish its eager lineage. The public two-box reproduction has identical raw
B-rep bytes but different edge references and lineage diagnostics.

The candidate records the full prefix's effective probe decisions and can retain
one finalized empty-demand lineage view on the same geometry checkpoint. It adds
no second kernel or geometry branch and retains no scratch probe handles. Only
audited primitive, boolean and rigid-transform paths propagate an alternate view;
unknown provenance, reference-bound axis transforms and unsupported suffixes miss
and rebuild in a fresh arena when the mode changes. A selective demand must match
the full effective signature rather than only the terminal boolean's demand.

The alternate maps are cloned with checkpoint snapshots and dropped with their
owner on retirement, eviction, reset or disposal. Their serialized metadata and
probe-key estimates count against the existing checkpoint estimated-byte ceiling.
Tracking is disabled when checkpoint retention is disabled. This accounting is an
estimate, not a whole-worker memory bound. Cache defaults and byte ceilings are
unchanged.

Publication uses the requested lineage before the unchanged measurement provenance
key is evaluated. A mode transition can therefore require remeasurement. Eager
checkpoint creation also does additional topology reads and lineage derivation to
prepare the idle view. Unsupported paths deliberately lose reuse. These costs
require fresh performance qualification.

## Qualification boundary

The public regression suite compares the first returned publication and actual
owning-kernel serialized bytes with a fresh build; it does not resync the result to
hide a transition. Existing normalization, geometry tolerances, cache budgets and
acceptance assertions remain unchanged. The manual public reproduction remains a
strict equality test.

Target-device acceptance still needs a new quiet M5 Pro campaign on this candidate,
including the sustained private session and at least three alternating matched
pairs with fresh pair IDs. Run the existing
[matched-arm commands](../2026-10-15/h02-matched-cache-benchmark.md#reproduction)
and sustained command from the
[baseline report](h02-m5-pro-qualification.md#reproduction-and-verification) in a clean committed
candidate checkout. Keep source inputs and all samples, diagnostics, backups,
builds and browser artifacts outside Git; use a new output directory. Do not mix
candidate samples with the frozen campaign or run validation suites alongside
timing arms.

The proposed detached Text branch, branch-preserving kernel support and
whole-worker retained-memory acceptance remain separate open requirements. This
candidate does not accept or implement that branch.

## M5 Pro qualification result

[Candidate target-hardware evidence](h02-pr805-m5-pro-qualification.md) records all six new arms: observed p95 improvement is 8.3%, below the unchanged 20% target, and every enabled arm fails fixed Text restore. Raw/publication equality passes through 80 edits, refusal recovery and worker restart; required private retirement/replay-budget coverage still fails because fresh-arena fallback prevents it. Whole-worker memory and quiet-host acceptance remain open. H02 stays Partial; the candidate has not met acceptance.
