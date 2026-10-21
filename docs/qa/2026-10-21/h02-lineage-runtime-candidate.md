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
no second kernel or geometry branch and retains no scratch probe handles. Audited
primitive, boolean and rigid-transform paths propagate an alternate view. The
follow-up also qualifies self-contained STEP imports (including fixed planar
emboss separation), canonical-plane sketches and blind new-body extrusions from
canonical sketches. Their own output lineage is independent of earlier bodies;
earlier divergent lineage stays intact. Unknown provenance, reference-bound axis
transforms and unsupported suffixes miss and rebuild in a fresh arena when the
mode changes. A selective demand must match the full effective signature rather
than only the terminal boolean's demand.

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

### First candidate: `d30b589e`

The first candidate passed all 14 public transition regressions, 118 selected
existing tests, the unchanged manual reproduction, the private one-edit oracle,
and the full local repository gates. Its private one-edit comparison matches
3,204,155 serialized bytes across 17 bodies / 720 faces, with no normalized
publication differences and unchanged source bytes.

The unchanged Linux sustained probe completed all 80 edits: five raw/publication
checkpoints and four forced-eviction passes match. It then failed the existing
replay-budget assertion: 166 syncs created 161 arenas, with zero replay-budget
recycles or retired checkpoints. Refusal/recovery and worker restart were not
reached. The M5 matched campaign also reports enabled-arm failures of the fixed
Text-restore assertion. Samples are written before assertions and are retained.
This revision is not accepted.

### Independent import follow-up: `6cea4606`

The first follow-up addresses the excessive fallback without changing those assertions.
Public generated STEP/planar-emboss, canonical sketch and independent extrusion
fixtures first pass cold eager/idle raw and publication controls. On `d30b589e`,
the intended restore and real-edit recycling checks fail. Their same-checkpoint
metadata propagation does not create a detached Text cache. Private lifecycle and
target-device qualification must be rerun for the follow-up revision.

Its 23 public cases retain the earlier strict transitions and add the
Text-prefix/recycling regressions, draft/symmetric/two-sided blind extrusion
controls, and conservative fallback checks for reference-bound profiles and
unsupported extrusion operations/extents. The full private and target-device
requirements remain unchanged.

All five local repository gates, the strict public reproduction and the private
one-edit oracle pass on this revision. One Linux enabled arm also passes the
unchanged Text and latency assertions: its first settled edit restores the fixed
prefix instead of executing Text. This is a single diagnostic arm, not matched
target-device performance acceptance.

The unchanged private sustained probe still fails replay-budget coverage after
80 edits. All five raw/publication checkpoints and four forced-eviction comparisons
match, but 166 syncs create 41 arenas with no replay-budget cycles. Every one of
the 40 prepared-reuse events is followed by a full rebuild. The existing prepared
transform path restores valid geometry without completing its alternate lineage;
the following mode switch therefore loses reuse. This revision is not accepted.

### Prepared transform follow-up

The next follow-up completes alternate lineage after the existing prepared
transform reuse. Ordinary modeling and metadata completion share the same authored
matrix resolver, including units, pivot and allowed scaling. Metadata completion
projects the captured pre-feature lineage onto the already verified cached output;
it adds no modeling or probe calls. Reference-bound axis transforms still abandon
the alternate view. Failed metadata completion also abandons that view without
changing whether prepared geometry is accepted. Prepared-cache eligibility,
storage, counters and budgets are unchanged.

Two additional public regressions cover prepared reuse across an eager-to-idle
transition and 180 real parameter edits through an actual replay-budget cycle.
They retain strict fresh raw/publication equality. The sustained fixture puts its
fixed Text before the boolean, matching the private recipe, and requires no Text
execution outside recycling. The first eager request after an idle recycle must
still replay the boolean suffix: the idle rebuild cannot create a probed eager
view. The separate transition regression retains Text after the boolean and
requires prepared reuse followed by complete idle restoration.

Private lifetime and target-device results for the earlier revisions do not
qualify this follow-up. It requires fresh verification at its committed head.

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
