# Checked axial extent reuse

M07 remains partial. This qualifies a narrow incremental width edit through
an existing native history, including its authoritative checking and final
build. Display previews retain their existing contract.

## Eligibility and geometry

`exact-axial-extent.ts` records bounded evidence while building checked history.
It accepts an initial literal box in millimetres, fixed cylinder operands,
union, constant-radius fillets, and perpendicular planar face offsets. A
retained prefix needs at least 16 features for reuse. Expressions, other
operations, suppressed/refused features, compound shapes and native vertex
construction metadata keep ordinary replay. Axial widths above 1,000,000 mm
also keep reconstruction; this eligibility ceiling bounds floating-point
transport error and does not restrict model dimensions.

For every prefix, all non-invariant carriers and transverse edges must avoid
one common open x slab beyond every fixed primitive operand. Plane and
cylinder carriers invariant along x may cross it. Other analytic carriers use
conservative support bounds; positive-weight spline control hulls bound free
forms and edge curves. Only an exact two-pole linear curve proves an axial
edge. Sampled mesh normals, near-collinearity and analytic recognition labels
do not supply that evidence.

Inside the slab, the boundaries describe a product cross-section. Extending
that product leaves its fixed side unchanged and translates its far side.
Set union commutes with this homeomorphism. Constant-radius blends act on
rigid neighbourhoods or on invariant axial sections, and perpendicular planar
face moves change those sections independently of their length. Recording
both input and output prefixes keeps their curved transitions outside the
common slab. A contraction must leave the slab open, with a clearance margin;
a move into its occupied region replays history.

Hash-only fillet picks additionally constrain their complete curves to the
fixed region. Their legacy resolver must still find one identical curve and
ordered endpoints after transport; a changed pick or new collision refuses
reuse. A later in-place edit of their retained source also ends eligibility.

## Acceptance, naming and ownership

Only the literal root width may differ in the reused prefix. Its other fields,
every subsequent feature digest, project, units, scope, lineage demand and
checkpoint ownership are checked through the existing cache contracts.

A resting display preview may reuse the same fully checked prefix when its
deferred face edit lies strictly after that prefix. The transported prefix
retains checked feature and idle-lineage digests; display-only blend salts
never replace its checked provenance. Its deferred tail still requires the
normal authoritative release build. Resting exact refusal checks remain
enabled, and cancellation preserves only the existing owned checked source.

Each affected root is moved through the exact native journal entry point.
Unavailable or conflicting construction maps, facet fallback, relaxed
validation errors, or an end plane that differs from the requested width
abort reuse. The normal measurement, strict union and commit gates still run.
There is no additional approximation permission or deferred validation.

Face identities require a complete one-to-one native construction map.
Named edges require a unique boundary between the mapped incident faces.
The existing semantic publisher verifies newly measured witnesses; incomplete
identity is a replay fallback. Both eager and idle lineage views are refreshed
on the same output handles.

The source checkpoint owns the proof. Its serialized metadata is charged to
the existing checkpoint ceiling, with bounded interval/body/pole counts. The
kernel owner, native handle discipline and replay-work ceiling remain in
force. Local move attempts are charged before execution, including failed and
cancelled attempts. Failure restores the checked source before normal replay;
cancellation publishes no result.

Checkpoint admission also prefers the checked tail when earlier snapshots
exhaust the byte ceiling. Restore now accepts a retained subset of scheduled
positions after validating its complete digest spans and ownership. It no
longer discards a scheduled tail solely because preceding slots were evicted.

## Verification

The public `longFilletedUnion` fixture extends the existing authored native
fixture with perpendicular height adjustments. Unit regressions compare all
body quantities, bounds, face/edge hashes and construction references with a
fresh adapter whose history cache is disabled. They cover successive sizes,
a return to the original width, eager/idle views, occupied-region contraction,
simultaneous radius changes, expression widths, width-sensitive legacy picks,
missing native history, cancellation and recovery. Sparse-tail coverage checks
that repeated restores retain their owned checkpoint.

The public browser test covers both short and long histories: immediate
whole-body display, Total entry, Apply, unchanged feature count, undo, redo,
device persistence and reload, with console/page-error checks and screenshots.
The opt-in `perf-face-drag-trace.spec.ts` case `long native history` measures
pointer release through an accepted revision's final checked frame.

Three alternating local browser comparisons used the public 25-feature
fixture, 120 pointer moves at 16 ms intervals, full production rendering and
headed Chromium on Apple M5 Pro/Metal. The baseline is the deployed preview
change (`5dda745871c1195d41f78fdf97d62a87a7291ee5`, Remus 2026.1.104);
the candidate includes this axial reuse and the paired Remus 2026.1.107
packages at `261ac4c0567018dbe5432b941f2f4ef842afbfc5`. The packages use
the source-identical hosted build artifact documented in Remus #1505.

| Release through accepted final checked frame | Baseline | Candidate |
| --- | ---: | ---: |
| Run 1 | 757.4 ms | 117.2 ms |
| Run 2 | 686.3 ms | 101.7 ms |
| Run 3 | 892.7 ms | 121.2 ms |
| Median | 757.4 ms | 117.2 ms |

The median improves 6.5 times on this public case; every run presents all 120
display frames. This is a local sample, not a universal latency guarantee.
Cold loading, an unsupported history, an occupied-region contraction or a
kernel cache recycle still takes the normal rebuild path. No CPU profiler was
active during these comparisons; the desktop host was not isolated.

The final pinned package passes 51 focused regression tests and the parity
corpus (92 passed, one existing skip), type checking and the production
build/bundle gate. Browser reload coverage also waits for current exact STEP
export readiness, so a restored cached display alone cannot pass.

The broad local integration run passed 8,934 root tests with eight failing
tests, and 5,119 web tests with one failing CSS-token assertion. All eight
test failures and the CSS assertion independently reproduce on pristine
current main (`3a1dae9f`, paired Remus `35b197aa`). A separate gear fixture
setup deadline under the broad load passes all five tests on isolated retry.
These failures were not suppressed or relabelled as passes. This broad run
used the source-identical Mac package before the final hosted-artifact pin;
the final pin has the focused and parity validation above. Hosted checks on
the exact PR head are reported separately. Local test results do not
establish production deployment.
