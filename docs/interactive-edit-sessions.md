# Interactive edit sessions (H02 / W02)

Planar face dragging now requests a disposable mesh with `topology: 'pending'`.
The exact operation, recorded-face identity guards, analytic-carrier census,
B-rep validation, import diagnostics and strict union closure gates still run.
Display face ranges and analytic dimensions keep the dragged highlight current;
edge topology, output references, NURBS area measurements and recognition
remain deferred. Picking stays
suspended until complete topology arrives. Only output naming
for a terminal planar face offset is deferred; its separate history digest
forces normal replay before a commit, downstream operation or export can use
that result. Ordinary `previewGeometry` callers retain complete topology.
Radius and hole gestures also retain their owned cylinder semantics and complete picking
topology while streaming; the lighter publication is enabled for planar
push/pull, where edge recognition is not needed for the current gesture.
Bodies with validation warnings or an unqualified strict/display projection
use normal measurement, preserving warning/refusal attribution and the
caller's affected-feature scope. Hidden unions retain their normal closure gate.

The display path retains completed measurement's spline-refined bounds and
the existing held-deflection policy, consumes owned
WASM arrays once and avoids concatenating a single solid's buffers. It can
consume the strict union gate's same-sync mesh and closure proof only when
kernel, solid handle and both tessellation deflections match. Compound meshes
still require their combined closure check. Welding and winding checks use
the same tolerances; indexed vertices are quantized once and edge keys use
canonical numeric vertex pairs instead of repeated coordinate strings.

Parameter editing prepares the recognized construction, baseline parameter
scope and structural guard once. A tick compares immutable STEP strings
exactly instead of serializing or hashing their full contents, then updates
matrices over retained source meshes. Recognized parameter bounds are reused
for rendering and pure parameter drafts against that exact base; commit
validation still recognizes the candidate afresh. The recognized lettering body's verified
placement transforms participate too. Previously those post-import transforms
were mistaken for unsupported consumers, disabling the whole holder preview.
The viewport continues to label this display as a parameter preview; it is
never persisted or exported as an exact solid. Unsupported consumers, changed
structure/source/units, invalid expressions and minimum violations still
decline the approximation.

The retained exact arena also reuses successful immutable intersections and
transforms within an audited suffix. Each entry requires the full feature
digest and identical exact operand handles, lineage, consumption and mesh/revolve flags.
Only shape updates and monotonic consumption/origin additions are cached;
warnings, repairs or other build-state changes disqualify it. There is one
latest value per feature, at most 64 entries, with invalidation on restore,
project changes, disposal and ordinary arena recycling. Changed operands replay
normally. Unions retain their existing acceptance path. No post-interval
checkpoint is restored to resurrect a cached branch, so the separately
proposed H02 private Text-branch cache remains blocked as documented.

The existing 32-checkpoint, 128 MiB estimated admission and 512 executed-builder
budgets are unchanged. Admission estimates and allocated WASM pages are not a
process-memory ceiling. A cold rebuild after recycling remains visible in
tail latency.

## Release path

A face-offset or cylinder-radius release is validated by one complete exact
sync of the candidate (`useDirectEditCommit`), built with the live document's
lineage demand. When the commit stores exactly that content, the geometry
worker hook adopts the validation result as the live result
(`adoptValidatedResult`) instead of posting the broadcast that would only
rebuild and re-mesh it. Adoption is refused, and the ordinary broadcast runs,
for anything that broadcast would not reproduce: different geometry content
(a carried selection, a normalization written by the commit), another lineage
demand, an analysis request, a carry proposal, a transient font/source
result, or a live broadcast still running. The committed result is therefore
measured once and meshed at full display quality once (by its refinement, for
a draft display; see below), and the next gesture's preview no longer queues
behind a duplicate rebuild.

The validation stays authoritative: nothing reaches the document, its undo
history, local or cloud storage, or export until it passes. While it runs,
the released handle stays drawn where it was let go and may be taken again.
That press sets the release aside (`supersede`): it will neither commit nor
report a refusal, and its rebuild keeps running in the worker. Letting go at
the same value commits from that rebuild; letting go elsewhere validates the
new value against the same base document (one edit, one undo step); a drag
that starts no edit of its own (Escape, a press that stays put, a refused or
blocked value) commits the set-aside release as it was let go, with the
handle and preview kept at that value meanwhile; letting go back on the
original face or radius drops it. `useRetakenRelease` owns that hand-off: a
drag that ends without telling (the selection or tool changed under it)
still lands its release, a document that moved on drops it with the same
"document changed" report a validating release gives, and the edit lock
(`onBusy`) stays held until the release is committed or dropped. Exact entry
stays locked while a release validates.

A released face drag or cylinder resize whose last frame was a drag mesh is
accepted with a draft display (`BodyRepresentation.displayQuality: 'draft'`,
see `exact-display-refinement.ts`). That commit's sync draws the moved body
with the drag tessellation it was just shown at, whose per-face meshes the
kernel still holds. It keeps every other part of a complete sync: replay and
the edit's kernel guards, relaxed and strict validation, exact face and edge
measurements, full-quality edge polylines, volume, warnings and refusals. A
body a union produced is never drafted, because its strict closure check
reads the display mesh. Nor is a refused release or an analysis request.
The draft box is tightened to the draft mesh with the draft deflection as
slack, so it is still a valid bound. Once the worker has been idle for
100 ms, it re-runs the same sync. The adapter then keeps the draft's exact
measurement and swaps in the full-quality mesh, face triangle ranges and
certified box, so the result equals what a full-quality commit publishes.
The worker sends it as `display-refined`. The hook replaces the live result
only while that result is still the draft of the same content; a refinement
that overtook its adoption is adopted instead. Any new request cancels the
refinement at the next build boundary, and drag frames hold it back, so the
next gesture never waits behind it. The worker's result cache never stores a
draft. Exports, mass properties, drawings, sections and mesh-quality reports
build their own tessellations and never read a display mesh. The local store
may hold a draft projection until the derived-only save that follows the
refinement; a reopen rebuilds anyway. Idle thumbnail capture waits for the
refined display. The at-rest warm-up (`refineEditPreview`) is skipped for a
drafted release, because it only existed to make a full-quality commit
cheap, and when a release arrived during it the commit queued behind it.

With `window.__ozFaceDragTrace` enabled, each release records `release`,
`validated`, `committed`, `superseded` and `settled` (`detail.adopted`) in
that array and as `performance.mark('oz.drag.<stage>')` User Timing marks. On a private 32-feature filleted box ∪ cylinder
reproduction part in local Chromium (Linux, Vulkan ANGLE; three releases each,
release → live result accepted): top-face offset 488/337/356 → 293/119/137 ms,
side-face −32 mm 602/445/386 → 381/277/156 ms, cylinder diameter 1413/906 →
1366/1088 ms, where the cylinder's exact resize dominates and only its
post-validation tail (about 130 ms → 5 ms) changed. Main-thread work after a
side release fell from about 970 to 420 ms in a profiled build, mostly the
re-armed handle's step profile (136 → 28 ms). A retaken handle answers within
one input event regardless of the validation's length. With the draft display
(same part and setup, three top-face releases per run, two runs, against main
`f7a1a1ca`), release → accepted fell from 291/282/292 and 317/286/530 ms to
117/85/92 and 119/92/98 ms. The full-quality mesh replaced the draft about
320–350 ms after acceptance, with no empty frame. In the Node harness the
commit sync fell from 273 to 96–101 ms (full-quality tessellation 157 ms → the
draft's 17 ms); the background refinement sync took 196–212 ms. These are
local measurements, not target-device results.

## Qualification

The baseline and candidate use the same paired Remus `2026.1.65` packages at
`9add24f1b10cd5f5ae7f502b06e80e5eb5ba15c5`, without kernel or tolerance changes.
The public `crates/io/tests/data/shapr3d_hammer_holder.step` in that revision
has SHA-256 `2403b4c9868cbb56292a09ec2f2d37baca16cc4b789d11e97ff8df3f1e46bef8`:
160 faces, 386 edges, including 42 NURBS, 42 cylinders, 14 tori and 8 spheres.
The direct workflow offsets the outer +X arm face in both directions. The
parameter workflow changes the opening of its recognized, lettered holder
construction around 46 mm.

Measurements distinguish matrix preview preparation, candidate-document
creation, exact mesh publication, and completed analysis. Worker timings
exclude main-thread packing, transfer, GPU upload and display presentation.
Real-app checks separately exercise repeated parameter input, exact face
dragging/cancel, release, selection and deferred-analysis behavior in Chromium
with SwiftShader. These are workstation results on one model, not a universal
60 fps or target-device guarantee.

Regression coverage includes fresh-build numerical/topology equivalence,
changed operands and restored handles, lettered previews, source/structure
invalidation, pending topology, normal release metadata, owned mesh buffers,
display-quality matching, duplicated face seams, closed/open/nonmanifold meshes
and winding. The complex part also retains its exact carrier/radius census
and closed mesh for inward/outward edits; reversed parameter edits restore
volume and match independent fresh rebuilds.

For a local adapter profile, use the existing opt-in harness with the public
fixture from a Remus checkout:

```sh
OFFSET_PERF_STEP=/path/to/remus/crates/io/tests/data/shapr3d_hammer_holder.step \
OFFSET_PERF_PREVIEW=1 OFFSET_PERF_DEFER_TOPOLOGY=1 OFFSET_PERF_SAMPLES=20 \
pnpm exec vitest run test/perf/offset-face-perf.test.ts
```

Leave `OFFSET_PERF_DEFER_TOPOLOGY` unset to measure the compatibility preview.
These method-instrumented Node profiles are separate from the uninstrumented
production-browser comparisons. `OZ_PERF=1 pnpm exec playwright test
test/e2e/visual-selection-live-preview.spec.ts` enables the existing request,
reply and renderer-frame probes; CI's normal runs skip those timing cases.

## Initial matched qualification, 18 October 2026

Three fresh-browser pairs alternated baseline/candidate, candidate/baseline,
then baseline/candidate. Each workflow/mode used three warmups and 20 timed
samples per arm (60 samples per table cell). The fixture, parameter/offset
sequence and WASM bytes matched the original milestone. Chromium 153 ran on a
Ryzen 9 5900XT Linux workstation. The frozen baseline is OpenZCAD `f69025c7`;
this initial adapter implementation is `192014ff`, based on main `394854b4`. That main
advance adds through-all extrusion; this fixture uses finite distances.

Numbers below are worker median / p95 milliseconds, excluding UI transport
and rendering. Cold recycling samples remain included.

| Workflow | Baseline median / p95 | Candidate median / p95 | Median reduction |
| --- | ---: | ---: | ---: |
| Face drag: exact display | 142 / 197 | 88 / 148 | 38% |
| Face edit: completed analysis | 765 / 805 | 758 / 766 | 1% |
| Parameter edit: exact display | 1963 / 2269 | 1264 / 1404 | 36% |
| Parameter edit: completed analysis | 2971 / 3280 | 2556 / 2865 | 14% |

All 240 paired geometry comparisons match live face counts, triangle counts
and bounds. Completed volumes also match (numerical tolerance 1e-6), with no
warnings or browser errors. The
largest parameter completions remain 5,212 ms baseline / 4,946 ms candidate:
one replay-budget recycle per pair. The matrix preview keeps responding while
that exact work runs; exact face dragging on this part still does not reach
60 fps.

Peak reported checkpoint accounting fell from 193.3 to 177.5 MiB, while peak
allocated WASM pages rose from 347.1 to 361.6 MiB. Neither figure measures
process RSS. The three existing retention budgets were not increased.

A separate 100-update browser probe measured parameter-preview preparation at
2.3 ms median / 2.9 ms p95 after a 10.7 ms session setup. Candidate-document
creation was 6.2 ms median / 10.8 ms p95. The old visual path declined every
sample for this lettered model, so its 16.1 ms preparation time is not a
successful preview baseline. Matrix displays remain approximate and exact
release checks remain mandatory.

Subsequent work (`ac7cb130`) reuses the recognized bounds for panel rendering
and pure draft checks. A ten-update real-app probe on the same holder measured
14.4 ms median from parameter input through `renderer.render` (13.6 ms after
the first update); the first update was 84.7 ms. Nine subsequent installations
had an 11.4 ms median. This is Chromium/SwiftShader evidence, not a physical
presentation or target-device guarantee. A synchronous test observer records
installation before the next renderer frame, avoiding asynchronous-observer
races.

The final display path additionally defers NURBS face-area metadata while its
picks are held. Face hashes and triangle ranges remain available, analytical
faces retain geometry for their highlight/dimensions, and normal completion
recomputes all face measurements. Current-head matched results are reported
with the implementation PR; the table above preserves the earlier qualification.

Local verification covers the complete root suite (4,776 passed), complete web
suite (3,133 passed), parity corpus (185 passed, one existing skip), lint,
typecheck, bundle-size/provenance checks, and 23 focused viewport cases. The two
opt-in drag timing cases also pass separately. Host fork processes intermittently
crashed with SIGSEGV; the full root/web passes use Vitest threads, with two web
workers for the final pass. No assertions or repository pool configuration were
changed. The PR's ordinary CI remains independent validation of its exact head.
