# M04 — Loft and sweep options: what shipped

Branch `claude/remus-sweep-loft-options`, worktree
`.claude/worktrees/rm-sweep-loft-options`. Kernel pin untouched
(`remus-wasm` 2.131.0, `4bbcd5c7`).

## What shipped

Two options, both proven numerically against the pinned kernel before being
wired up, both additive to the document schema:

1. **Loft apex point** (`loft.endPoint`). A loft can close its last section to
   a point instead of a flat cap. Ruled mode only. Absent means exactly
   today's geometry.
2. **Sweep guide rail** (`sweep.guide`). A sweep can track a second sketch
   path with the profile's up-vector instead of holding the kernel's
   rotation-minimizing frame. Absent means exactly today's geometry.

A second round on this branch fixed three defects an independent verifier
found by reading the diff and running the kernel: the apex guard was
fail-open on which side of the section plane the apex sat (below), the guide
rail was missing from every place that enumerates a sweep's sketch
dependencies (below), and a Smooth sweep with a rail was resurfaced silently
rather than refused (below). Each has regression coverage.

A **third round** closed what the second round's apex guard still left open.
That guard skipped itself whenever the section before the closing one was
coplanar with it, and it never looked at any other section, so two runs still
took an apex that quietly _removed_ material (measured below). It now measures
every section, and the failure message after a kernel validation error no
longer blames the apex for lofts that fail without one. Both are covered.

A **fourth round** replaced that guard outright. Measuring every section did
not help: the reasoning itself — read which side of the closing plane the
material is on from the sketch plane normal and the other sections' positions
along it — says nothing at all about a section that is not parallel to the
closing plane, and a section that _straddles_ it satisfied both rules on both
sides at once, so a wrong-side apex still removed material silently (measured
below). The guard is now the measured invariant **a closing apex may only add
material**: the run is lofted again without the apex and the two volumes are
compared. No positional side reasoning is left.

Both are exposed in the existing Loft and Sweep editors from PR #314 (a
checkbox plus the shared `VectorFields` for the apex; a "Guide rail" select
that defaults to "None — follow the path" for the rail), and both round trip
through the edit form.

The schema contract is held two ways. The builder keeps the _old call_ when
the new field is absent — a loft without `endPoint` still calls
`loft`/`loftSmooth`, a sweep without `guide` still calls
`sweepWithOptions`/`sweepAlongEdges` — so replay is bit-identical rather than
merely equivalent. And `loftSections`/`sweepProfile` only write the key when
it was asked for, asserted by
`featureDataKeys(...) === ['featureKind', 'sections', 'mode']` in
`test/advanced-modeling-features.test.ts`.

One supporting change: `updateFeature` gained `clearData`, a list of optional
data keys an edit may _remove_. A `data` patch skips `undefined` values, so
before this it could only ever set a key — an apex point or a rail the user
added could never be taken off again. `CLEARABLE_FEATURE_DATA_KEYS` in
`packages/document-core/src/index.ts` allows only `loft.endPoint` and
`sweep.guide`; clearing anything else throws.

## Kernel calls adopted

| Call                                                       | Used for                                                                                                      | Replaces                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `loftWithOptions(faces, json)`                             | a loft with `endPoint`                                                                                        | nothing — `loft`/`loftSmooth` still serve the unapexed case                                        |
| `guidedSweep(face, spine…, aux…)`                          | a sweep with `guide`                                                                                          | nothing — `sweepWithOptions`/`sweepAlongEdges` still serve the unguided case                       |
| `getNurbsCurveData(edge)`                                  | reading the spine and rail curves `guidedSweep` wants as raw NURBS                                            | new                                                                                                |
| `getFaceVertices(face)` + `getVertexPosition(v)`           | recognising a section run that lies _in_ the closing section's plane                                          | replaces a `planarFaceCentroid` point for that one measurement; the centroid stays as the fallback |
| `loft(faces)` a second time, whenever an apex is asked for | the baseline volume the apexed loft has to beat, and telling an apex failure apart from a section-run failure | new                                                                                                |

### The `loftWithOptions` options schema, as measured

The pinned kernel accepts exactly three keys, camelCase:

```json
{ "ruled": true, "startPoint": [x, y, z], "endPoint": [x, y, z] }
```

`ruled` defaults to `true`. **Every other key is silently ignored, and so is
malformed JSON** — `loftWithOptions(faces, "not json")` returns the default
ruled loft rather than erroring. There is no tangency, twist, continuity,
closed or per-section option; `{"startTangent":…}`, `{"twist":…}` and
`{"closed":true}` all parse to the default. `{"ruled":true}` was measured
byte-for-byte equal in volume to `loft()`, and `{"ruled":false}` to
`loftSmooth()`.

Because the kernel is permissive, all validation is on our side. The builder
resolves the apex through `resolveParametricPoint` and checks the coordinates
are finite. Two things are then decided about it, and only the first is
geometric:

1. **An apex _on_ the closing plane** (standoff below 1e-6 mm) is refused by
   name. The kernel takes it and quietly returns the unapexed loft, so there is
   no apex to check at all.
2. **An apex that does not add material is refused by name.** This is
   _measured_, not inferred: the same section run is lofted a second time
   without the apex, and the apexed body has to hold more material than the
   plain one. The refusal quotes both measured volumes.

The invariant that matters is the second one — **a closing apex may only add
material** — because the failure being guarded is exactly a body that holds
_less_. Every folded apex measured on this pin comes back with `warnings: []`,
the apex buried out of sight so the viewport is unchanged, `validateSolid`
reporting nothing, and a volume _lower_ than the same loft with no apex:

| sections                          | no apex   | folded apex              | apex on the far side |
| --------------------------------- | --------- | ------------------------ | -------------------- |
| z = 0, 10                         | 373.3333  | **266.6667** (z=5)       | 480.0000 (z=15)      |
| z = 0, 10, 10                     | 373.3333  | **313.3334** (z=5)       | 433.3333 (z=15)      |
| z = 0, 20, 10                     | 253.3333  | **193.3334** (z=5)       | 433.3333 (z=25)      |
| XZ at y = −20, closing XY at z=10 | 2000.0000 | **1666.6667** (0,25,0)   | 2333.3333 (0,25,20)  |
| XZ at y = −20, closing XY at z=10 | 2000.0000 | **1333.3335** (0,25,−10) | 2333.3333 (0,25,20)  |
| XZ at y = −20, closing XY at z=10 | 2000.0000 | **1800.0000** (0,25,4)   | 2333.3333 (0,25,20)  |

### Why the positional guard was replaced rather than patched again

The last three rows are the ones that killed the positional approach. That
first section is drawn on XZ at y = −20 and spans z = 5..15, so it **crosses
the closing section's own plane** at z = 10. A rule of the form "some section
must reach the far side of the closing plane from the apex" is satisfied by
that section on _both_ sides, so it decides nothing; a rule of the form "the
apex must stand beyond every section's reach" is then satisfied on either side
too. Round 2 fell into its coplanar escape hatch on the same input and round 3,
which removed that hatch and measured every section, still accepted the
wrong-side apex. A third variation of the same reasoning would be a third
fail-open: which side of a cap the material lies on is simply not recoverable
from plane normals once a section is not parallel to the cap.

The volume comparison needs no such inference, and on this pin it refuses every
folded case above — including all three straddling ones — while accepting every
valid one.

### The tolerance, and why a tiny apex survives it

The comparison is `apexedVolume - baseline > geometryTolerance(max(baseline,
apexedVolume))`, i.e. the model's own tolerance function read as a volume: an
absolute floor of `GEOMETRY_LINEAR_TOLERANCE` (1e-6 mm³, a cube 10 µm on a
side) with the geometry layer's usual 1e-10 relative term so it stays
meaningful on a large model. It was chosen to sit between two measured bounds
rather than picked for roundness:

- **Above the noise.** Both numbers are `kernel.volume(..., 0.08)` on bodies
  built from the same section faces, so the only slack needed is measurement
  rounding — order 1e-11 relative on a millimetre body, five orders below the
  floor.
- **Below the smallest apex the standoff rule admits.** An apex 2 µm above an
  8 × 8 section adds 64 × 2e-6 / 3 = 4.3e-5 mm³, forty times the floor. It is
  accepted, and a regression test pins it (measured 373.3333760 against the
  plain 373.3333333).

An exact float comparison would have been wrong in the other direction, and a
relative-only slack would have thrown that tiny apex away.

### The one run with no baseline, decided rather than waved through

If _every_ section lies in the closing section's plane, the run encloses
nothing: lofted without an apex it is refused outright ("Loft did not produce a
finite positive volume"), so there is no measurement to compare against. That
run also has no interior for an apex to fold into, so its baseline is nought
material rather than an unknown, and measured it closes correctly either way:
4×4 and 8×8 both on z = 0 with an apex at z = 10 and at z = −10 both give
213.3333, the analytic 8 × 8 × 10 / 3 pyramid. Both signs are accepted, with a
regression test pinning them. Refusing that run would take away a loft the
kernel builds correctly.

That branch is a **degeneracy** test (`runLiesInClosingPlane`), not a side
test, and a straddling section can never satisfy it. Any _other_ run whose
unapexed loft fails while the apexed one validates is undecidable and is
refused by name — the apex cannot be proved sound, so it is not accepted. I
could not construct such a run on this pin (see Risks).

### What it costs

One extra `loft` call per rebuild of a loft that **asks for an apex**; a loft
with no apex point takes exactly the call it always did and pays nothing. Round
3 already paid this cost, but only on the error path — it is now paid on the
success path as well, which is the price of measuring the invariant instead of
guessing it. Face handles survive repeated loft calls on this pin (verified:
`loft`, `loftWithOptions`, `loft` again over the same `Uint32Array` each return
their own solid), so the second build is safe as well as cheap.

### What still builds, unchanged

Every case the earlier rounds established as valid was re-measured end to end
through `syncDocument` after the rewrite: the 373.3333 plain frustum, the
480.0000 two-section apex, the 400.0000 descending run closed below itself, the
394.6667 apex 200 mm off axis, both 433.3333 clear-apex runs (the coplanar
closing pair and the overshooting run), the 213.3333 all-coplanar run from
either side, and the 2333.3333 correct-side straddling apex. The guard is not a
"higher z" test and not an "above the axis" test: reversing the section order
makes an apex _below_ both sections the correct one.

### When the kernel refuses an apexed loft anyway

`validateGeneratedSolid` can still fail on the apex path, and the advice
appended to that failure used to blame the apex unconditionally. A loft
between a rectangle on XY and a rectangle on XZ refuses with "Loft did not
produce a valid closed solid" _whether or not_ an apex is asked for; telling
that user to move or clear an apex that is already correctly placed sends them
after the wrong input. The builder now lofts the same section run again
without the apex and reports which of the two is at fault. That is the same
second build the volume comparison needs, so it is made once and read by both.

## Deliberate limits

- **No twist option.** Nothing in the pin binds a twist angle for a loft or a
  sweep. `multiSectionSweep(faces, params, spine…, ruled)` can express a twist
  only if the _user_ rotates the section profiles themselves; that is a
  multi-section feature, not a twist control, and it is not this PR.
- **An apex smaller than the kernel's own apexed-surfacing loss on a curved
  run is refused, not accepted on faith.** See the first entry under Risks for
  the measurement and the reasoning; planar sections are unaffected.
- **No end-tangency option.** `loftWithOptions` does not accept one (see the
  schema above), and no other bound entry point takes a tangency vector. The
  task listed end tangency as highest-value; the pin does not offer it. Report
  rather than invent.
- **No `startPoint`, deliberately — the kernel builds it wrong.** See the
  defect below. The apex at the other end is reached by reversing the section
  order, which the loft form already supports; the UI says so.
- **Guide rails need a single-curve path and a single-curve rail.**
  `guidedSweep` takes one spine curve and one rail curve. `sweepPathEdges`
  splits an arc into quarter-turn pieces, so a path or rail wider than a
  quarter turn, or made of several entities, is refused by name rather than
  swept unguided. Covered by a test.
- **Surface mode and a guide rail are refused together, not silently
  reconciled.** `sweepWithOptions` takes a segment count (24 standard / 64
  smooth); `guidedSweep` takes no segment count and no surfacing argument at
  all. Rather than rebuild a saved Smooth sweep at the kernel's default
  surfacing while the feature still reads "Smooth", the adapter refuses the
  combination by name — the same shape as the loft apex + Smooth refusal —
  and `modelingFormValidationReason` says so before the edit can be saved. The
  stored mode is untouched, so clearing the rail restores it.
- **`pipe` and `multiSectionSweep` are not adopted.** `pipe` was probed and
  works (a circle profile along a straight NURBS path measured the exact
  analytic volume), but it is a strictly weaker `sweepWithOptions` for what
  ZCAD already routes; there is no user-facing gap it closes.
- Lineage is unchanged: both features stay ADR-011 hash-only with their
  existing reason strings. A guided sweep publishes no new semantic names.

## Kernel defect found: `loftWithOptions` `startPoint` leaves a hole

Measured on the pin, not inferred. A loft between two **rectangular** sections
with `startPoint` produces a solid whose faces are all geometrically correct
(the four apex triangles measure the exact analytic area, 10.7703 for a 4×4
section and an apex 5 below it) but whose tessellation is **missing one apex
facet**:

| case                                           | triangles | open mesh edges | mesh volume  | analytic     |
| ---------------------------------------------- | --------- | --------------- | ------------ | ------------ |
| rect 4×4 → 8×8, no apex                        | 12        | 0               | 373.3333     | 373.3333     |
| rect, `endPoint` z=15                          | 20        | 0               | 480.0000     | 480.0000     |
| rect, `startPoint` z=−5                        | **13**    | **5**           | **380.0000** | **400.0000** |
| circle r2→r3 (4, 6, 32 segments), `startPoint` | —         | 0               | exact        | exact        |

`validateSolid` returns 0 on the broken one and `validateSolidDetailed`
reports zero issues, so the adapter's existing guards do not catch it.
`volume()` and `massProperties()` disagree with each other on it (380.00 vs
349.76), which is the cheapest signature to test for. The same shape built
from `makeCircleFace` with any segment count — including 4, a square — is
exact, so it is not a vertex-count effect; it reproduces through the app's own
region faces from a sketch rectangle (measured 380.0000033 end to end).
`endPoint` is watertight and analytically exact on every profile tried
(rectangles of several aspect ratios, polygons of 4/6/32 segments, apex on and
off axis).

That is why only `endPoint` shipped. Repro (throwaway probes were deleted):
build two `makeRectangle` faces, translate one, call
`loftWithOptions(handles, '{"ruled":true,"startPoint":[0,0,-5]}')`, then
compare `tessellateSolid` triangle count and summed signed volume against
`volume()` and `massProperties()`.

## Other probe findings worth keeping

Measured in the third round, all on the pinned kernel through
`remus_wasm_node.cjs` and through `syncDocument`:

- **Face handles are reusable across loft calls.** `loftWithOptions(h, …)`,
  then `loft(h)`, then `loftWithOptions(h, …)` again over the same
  `Uint32Array` each return their own solid with the right volume. A loft does
  not consume its section faces, which is what makes the un-apexed re-loft
  diagnostic cheap and safe.
- **`volume()` on a self-intersecting loft shell is an algebraic integral, not
  an occupied volume.** It adds the closing cone's contribution whether or not
  the cone lies inside earlier bands, which is exactly why the folded cases
  come back _lower_ than the unapexed loft and why no validator sees them.
- **An apex's lateral position does not change the volume**, as Cavalieri
  requires: apexes 20, 200 and 1 000 000 mm off axis at the same standoff all
  measure 394.6667 over an 8×8 closing section 1 mm below.
- **`validateSolid` accepts a cone over a non-convex section whose apex is
  outside the section's visibility core** (an L-shaped section with the apex
  over the notch validates and measures the Cavalieri volume). The kernel's
  validator is not a self-intersection test, which is the whole reason the
  apex guard exists in the adapter.
- **Loft profiles with holes are refused by the kernel by name**: "invalid
  input: loft profiles with holes are unsupported; refusing to discard an
  inner wire", with and without an apex.

From the earlier rounds:

- `loftSmooth` with **three or more** sections already returns an invalid
  solid on this pin (`validateSolid` = 2, negative `massProperties.volume`),
  with or without an apex. Pre-existing, not introduced here; the adapter's
  `validateGeneratedSolid` refuses it today.
- Smooth mode plus an apex is invalid even at two sections (`validateSolid` =
  2), which is why the builder refuses that combination by name instead of
  letting the generic "did not produce a valid closed solid" fire.
- `guidedSweep` places the profile exactly as `sweepWithOptions` does (both
  translate it to the spine start; measured identical bounding boxes for an
  offset spine), so adding a rail does not move an existing sweep.
- A rail lying on the spine, or a degenerate point rail, is _not_ an error to
  the kernel: it returns the unguided result. The builder refuses a guide
  whose sketch and entity set match the path.
- `faceArea(face)` needs a deflection argument (`faceArea(face, 0.001)`); the
  one-argument form throws "deflection must be finite, got NaN".

## A guide rail is a sketch dependency everywhere, not only in the builder

The first round added `sweep.guide` to the schema and the builder but did not
register it in the places that enumerate which sketches a sweep depends on.
The consequence was a real fail-open: `affectedFeatureTargets` tested only
`data.profile.sketchId` and `data.path.sketchId`, so editing a rail sketch
produced no targets, `checkSketchEdit` returned at `if (!targets.length)`
without deriving, and the edit was saved unguarded — the sweep's body then
vanished on the next rebuild with "A sweep guide rail must be a single curve,
but this rail resolves to 2 curves". The identical edit to the _path_ sketch
was refused up front. Five sites now read the rail:

| Site                                                                     | What it was missing                                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/affectedFeatureTargets.ts`                             | the pre-save downstream guard for a rail-sketch edit                                         |
| `apps/web/src/lib/featureHistory.ts`                                     | the rail as a parent — delete toast under-counted dependents, history panel showed no link   |
| `packages/ai-contracts/src/auto-parameterize.ts`                         | the rail sketch in a guided sweep's feature scope                                            |
| `packages/command-system/src/index.ts` (`validateModelingFeatureUpdate`) | an _edit_ could set a rail pointing at a missing sketch or entity; only creation was checked |
| `apps/web/src/App.tsx` (`consumedSketchIds`)                             | a rail sketch stayed visible as if nothing consumed it                                       |

## Check results

Run from the worktree root, in order. These are the actual final lines:

```
pnpm lint               ✖ 19 problems (0 errors, 19 warnings)      [exit 0]
pnpm typecheck          clean, no output                           [exit 0]
pnpm test               (root vitest)
                        Test Files  241 passed | 2 skipped (243)
                        Tests  2507 passed | 4 skipped (2511)
                        (web vitest)
                        Test Files  156 passed (156)
                        Tests  1188 passed (1188)
pnpm test:parity-corpus Test Files  7 passed (7)
                        Tests  174 passed | 1 skipped (175)
pnpm build              ✓ built; report-bundle-sizes --check:
                        "warnings": [], "failures": []
```

`pnpm test` runs **both** vitest projects; the earlier revision of this file
quoted only the web block, which understated the work since every new kernel
test lives in the root project. Baseline on `origin/main` is lint 0 errors /
19 warnings, root 241 files / 2489 tests, web 156 files / 1182 tests, parity
174 / 1 skipped. The 4 root skips are all environment-gated and unrelated to
this branch: `test/hammer-holder-growing`, `-imported`, `-measurement` and
`test/reconstruction-measurement` are `it.skipIf(!process.env.OPENZCAD_HAMMER_STEP)`,
and that STEP fixture is not present here. The 2495 root tests the verifier
measured on the first round, plus the 5 added in the second, the 5 added in the
third and the 2 added in the fourth, give the 2507 above.

`node scripts/check-css-classes.mjs` also passes (275 files against 811
classes); no new CSS class names were introduced — the apex checkbox and the
rail select reuse `.field` and `.muted`. `pnpm test:e2e` and the desktop
workflow were not run, per the briefing.

## Regression coverage added

- `test/advanced-modeling-features.test.ts`
  - loft with no apex: feature data keys are exactly
    `featureKind, sections, mode` and the volume is the historical
    373.3333333333333;
  - loft with `endPoint` at z=15 over an 8×8 section: volume 480 (the analytic
    frustum plus one 64×5/3 pyramid) and `bbox.max.z` = 15;
  - apex on the section plane refused by name;
  - **apex inside the section run** (z=5, between the sections) refused with
    both measured volumes named — the fail-open that produced a silent 266.6667
    body — and an apex beyond the far end (z=−5) refused by the kernel's own
    validation with the advice pointing at the apex;
  - **apex hidden from the side test by a coplanar closing pair** (sections at
    z=0, 10, 10 with the apex at z=5) refused — the silent 313.3334 body — and
    the same run with the apex at z=15 asserted to still build at 433.3333;
  - **apex an earlier section already reaches past** (sections at z=0, 20, 10
    with the apex at z=5) refused — the silent 193.3334 body — and the same run
    with the apex at z=25 asserted to still build at 433.3333, so the guard
    refuses the fold and not the overshooting run;
  - **a section that straddles the closing plane** (a 10×10 rectangle on XZ at
    y=−20 spanning z=5..15, closing on a 10×10 rectangle on XY at z=10): the
    run lofts to 2000.0000 with no apex and to 2333.3333 with the correct apex
    at (0, 25, 20), while apexes at (0, 25, 0), (0, 25, −10) and (0, 25, 4) are
    each refused with their measured 1666.667 / 1333.333 / 1800 named in the
    message. **This is the case two positional guards could not see**, and it
    is pinned so the defect class cannot return a fourth time;
  - **an apex the model can barely measure** (2 µm above an 8×8 closing
    section, adding 4.3e-5 mm³) still builds, so the comparison's tolerance is
    proved not to eat a legitimately tiny apex;
  - **a run whose sections are all coplanar** closes from either side, both at
    the analytic 213.3333, with the bbox reaching the apex;
  - **an apex 200 mm off the section axis** builds at the analytic 394.6667, so
    lateral position is the user's business;
  - **a loft the sections cannot make** keeps the kernel's own message and says
    the section run is at fault, and is asserted _not_ to carry the old advice
    to move or clear the apex;
  - **a descending section run closed to an apex below it** builds: volume
    400, `bbox.min.z` −5, proving the guard tests material and not a direction;
  - apex in smooth mode refused by name;
  - sweep with no guide: data keys exactly `featureKind, profile, path, mode`,
    volume 160, bbox 4 mm on x and 2 mm on y;
  - same sweep with a rail offset along y: volume still 160, bbox now 2 mm on
    x and 4 mm on y — the quarter turn the rail is for;
  - a half-turn arc rail refused by name ("resolves to 2 curves");
  - **a rail on a Smooth sweep refused by name** instead of being resurfaced;
  - **an edit that sets a rail** with an empty entity list, or with entity ids
    belonging to another sketch, refused by `validateModelingFeatureUpdate`;
    the well-formed rail edit is asserted not to throw.
- `apps/web/src/lib/affectedFeatureTargets.test.ts` — a guided sweep is a
  target of an edit to its rail sketch. Verified to fail against the
  unregistered version of the walk before the fix was kept.
- `apps/web/src/lib/featureHistory.test.ts` — the rail sketch feature is one
  of the guided sweep's parents, and the sweep is downstream of it.
- `test/auto-parameterize.test.ts` — scoping a proposal to a guided sweep's
  body reaches the rail sketch, so its dimension is offered as a parameter.
- `apps/web/src/lib/modelingOperations.test.ts` — every combination the form
  has to name: rail + Smooth, rail == path, apex + Smooth, and the two legal
  combinations that must stay `null`.
- `test/document-core.test.ts` — `clearData` removes `endPoint` and refuses
  `sections`.
- `apps/web/src/lib/modelingOperationsEdit.test.ts` — an apexed loft and a
  guided sweep round trip through the edit form unchanged; a feature without
  them round trips with the matching `clearData`.

## Risks for the reviewer

- **`clearData` is a new edit primitive.** It is narrow (an allowlist of two
  keys) and throws on anything else, but it is a change to a shared mutation
  path. Worth a look at `CLEARABLE_FEATURE_DATA_KEYS`.
- **The guide rail's refusal bounds are ours, not the kernel's.** The kernel
  accepts a degenerate rail silently; we refuse the two cases we can detect
  (same path, more than one curve). A rail that is geometrically coincident
  with the path but authored as a different sketch will still sweep unguided
  with no warning. Detecting that needs a curve-coincidence test I did not
  want to invent.
- **`nurbsCurveOfEdge` parses kernel JSON.** It validates degree, knot,
  control-point and weight shapes and throws a named error otherwise, but it
  is the first place in the adapter that reads `getNurbsCurveData`.
- The guided sweep keeps ADR-011 hash-only lineage, so a rail change
  re-fingerprints downstream references exactly as a path change already does.
- **A small apex on a _curved_ section is now refused, and that is the one
  behaviour change a reviewer should weigh.** Asking for an apex moves the run
  onto the kernel's chordal apexed surfacing: two circles r = 2 and r = 3 ten
  apart measure the exact 198.9675 with no apex and 0.642% less — exactly the
  32-segment chord ratio — as soon as an apex is given. So on curved sections
  the apex has to add more than that surfacing costs (here, a standoff over
  about 0.14 mm) before the body holds more material than the plain loft, and a
  smaller one is refused with both volumes quoted. I kept that rather than
  loosening the slack, on three grounds: the refusal states a true measurement
  (the body really does hold less material than the plain loft, whichever half
  of the build gave it away); loosening the slack to absorb a 0.6% surfacing
  loss would re-open a fail-open window of the same size for real folds; and
  the direction of the error is closed, not open. If the maintainer would
  rather accept those, the honest fix is upstream — ask Remus why `endPoint`
  drops the exact surfaces — not a wider tolerance here. A planar-section apex
  is unaffected: both builds surface it identically, and a 2 µm apex passes.
- **The undecidable branch has no fixture.** If the unapexed loft fails, the
  apexed one validates, and the run does not lie in the closing plane, the
  builder refuses because it cannot prove the apex only adds. I could not
  construct such a run on this pin: crossed-plane runs fail with an apex too
  (nine apex positions tried), and the only run whose unapexed loft fails while
  the apexed one builds is the all-coplanar one, which is decided by
  `runLiesInClosingPlane`. So that branch is a fail-closed safety net with no
  test behind it.
- **The apex guard reads section faces through `getFaceVertices`.** A section
  face that reports no vertices falls back to `planarFaceCentroid`, and that to
  the sketch plane's origin. That fallback now only affects whether a run is
  recognised as lying in the closing plane (which decides only whether a zero
  baseline may be used), not which side anything is on, so its blast radius is
  much smaller than in earlier rounds — but it is still the part I have not
  exercised on a real face.
- **The refusal message names measured volumes, so it changes with the
  fixture.** The tests match on those numbers deliberately (they are the
  evidence), which means a kernel bump that moves a volume will fail them
  loudly rather than quietly. That is intended; it is also why they are worth
  reading before any pin move.

## Follow-ups

- File the `startPoint` tessellation defect upstream in Remus with the repro
  above; once fixed, `loft.startPoint` is a one-field addition here.
- Ask upstream for a tangency and a twist control on `loftWithOptions` —
  neither exists on this pin, and both were named as wanted in the roadmap row.
- A curve-coincidence check would let the builder refuse a rail that lies on
  the path however it was authored.
- The apex guard answers "does this apex add material" and not "does this loft
  self-intersect". A real self-intersection test over the ruled bands would
  subsume it and would also catch the runs that fold without any apex at all
  (sections at z = 0, 20, 10 loft to 253.3333 with no warning today). That is a
  larger piece of work and belongs with the kernel people, since `validateSolid`
  is where it would naturally live.
- Ask upstream why `loftWithOptions` with an `endPoint` surfaces a curved run
  chordally when the same run without one keeps exact surfaces. If that is a
  defect, fixing it removes the only capability this round narrows.
- `multiSectionSweep` remains unadopted and would be the natural home for a
  multi-section sweep feature if one is ever wanted.
