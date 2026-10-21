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

### Prepared transform follow-up: `f6d8ae6e`

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

Verification uses clean committed
`f6d8ae6e4ea0b2394802d2b9dae29677d3ff8bb8`. The integrated Mac changes add only
test/evidence updates; application/package source and dependency files are
identical to runtime-fix commit `aeacb511`. Earlier failures and the frozen Mac
campaign are preserved separately.

All five local repository gates pass: lint (zero errors, 17 existing warnings),
typecheck, 5,820 root tests (eight existing skips), 3,474 web tests, 220 parity
tests (one existing skip), and the full build including paired-WASM, provenance
and bundle gates. The 25 focused transition cases, 118 selected existing tests and
unchanged strict public reproduction also pass. Independent static review found
no remaining actionable issue in the prepared-transform patch.

The unchanged private one-edit oracle matches all 3,204,155 serialized bytes
across 17 bodies / 720 faces, with zero normalized publication differences. One
Linux enabled `holder_height` arm passes the original budgets and fixed Text
assertion: Text executes zero times in the first settled edit, whose two cache
events restore 4 / 31 features and replay 27 / 0. This single diagnostic arm does
not establish matched timing or target-device acceptance.

The unchanged private 80-edit browser session passes with zero acceptance
failures. All seven raw/publication comparisons match, including refusal recovery
and actual worker termination/restart. Four real measurement-eviction passes also
match both oracles. The session exercises three replay-budget recycles, 252 retired
checkpoints, five correctly rejected retired-checkpoint restores and 220 prepared
feature reuses. The incoming continuation retains every original acceptance
condition; its two lifetime coverage assertions now pass. Source bytes, candidate
HEAD and the clean checkout remain unchanged throughout both private runs.

These are Linux results for the existing checkpoint cache. Raw artifacts and all
failed earlier attempts remain outside Git. They do not qualify quiet M5 timing,
whole-worker retention or a detached Text record. The documentation follow-up
changes no runtime, tests, dependency pins, defaults or thresholds.

Target-device acceptance still needs a new quiet M5 Pro campaign on this candidate.
Run the unchanged sustained private session first, then at least three alternating
matched pairs with fresh pair IDs. Use the existing
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

## M5 Pro follow-up: `64f07065`

The [fresh M5 Pro qualification](h02-64f07065-m5-qualification.md) uses clean
`64f0706512425b41bbf69f12dd4399b2cc93c274`, first running the unchanged sustained
session and then three alternating matched pairs. All six arms pass; enabled
first edits execute no Text. Recorded-load p95 exact completion is
3,442.9 → 2,487.1 ms (27.8% lower), meeting the unchanged ≥20% target.

The private 80-edit session passes all seven raw/publication and four eviction
comparisons, with three replay-budget recycles, 252 retired checkpoints, five
rejected retired-checkpoint restores and actual refusal/recovery and worker
restart. Acceptance failures are zero. The 93 private/mutation tests, strict
public reproduction and all five local repository gates pass at that same head.
No Linux or earlier-candidate sample enters the M5 aggregation.

Background load is recorded per instruction; quiet-host acceptance remains
unestablished. Separate post-GC metrics do not prove whole-worker retention.
The detached Text proposal and every remaining criterion stay open; H02 is
Partial. Source inputs, pins, runtime, budgets and assertions are unchanged.

## Historical M5 Pro qualification: `d30b589e`

[Target-hardware evidence for `d30b589e`](h02-pr805-m5-pro-qualification.md) records
all six arms: observed p95 improvement is 8.3%, below the unchanged 20% target,
and every enabled arm fails fixed Text restore. Raw/publication equality passes
through 80 edits, refusal recovery and worker restart; required private
retirement/replay-budget coverage still fails because fresh-arena fallback
prevents it. These results describe the first candidate, not the later import and
prepared-transform follow-ups. Whole-worker memory and quiet-host acceptance
remain open. H02 stays Partial.
