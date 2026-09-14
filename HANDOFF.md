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

| Call                                                | Used for                                                                      | Replaces                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `loftWithOptions(faces, json)`                      | a loft with `endPoint`                                                        | nothing — `loft`/`loftSmooth` still serve the unapexed case                                        |
| `guidedSweep(face, spine…, aux…)`                   | a sweep with `guide`                                                          | nothing — `sweepWithOptions`/`sweepAlongEdges` still serve the unguided case                       |
| `getNurbsCurveData(edge)`                           | reading the spine and rail curves `guidedSweep` wants as raw NURBS            | new                                                                                                |
| `getFaceVertices(face)` + `getVertexPosition(v)`    | measuring how far each built section reaches past the closing section's plane | replaces a `planarFaceCentroid` point for that one measurement; the centroid stays as the fallback |
| `loft(faces)` a second time, on the error path only | telling an apex failure apart from a section-run failure                      | new                                                                                                |

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
resolves the apex through `resolveParametricPoint`, checks the coordinates are
finite, and then proves the apex actually _closes_ the section run. Every
section but the closing one is measured against the closing section's plane —
from that section face's own vertices, so a section on a plane that is not
parallel to the closing one is taken at its true extent — and three failures
fall out:

1. **An apex _on_ the closing plane** (standoff below 1e-6 mm). The kernel
   takes it and quietly returns the unapexed loft.
2. **An apex on the same side as the rest of the loft.** The run has to reach
   the closing section from the far side, or the apex is inside the body.
3. **An apex an earlier section already reaches past.** The apex has to stand
   beyond _every_ section, or the closing band re-enters an earlier one.

Every one of those three is a silent, _subtractive_ wrong answer on the pinned
kernel — `warnings: []`, a body whose volume is **lower** than the same loft
with no apex at all, the apex buried out of sight so the viewport is
unchanged, and `validateSolid` reporting nothing:

| sections (z) | no apex  | apex z=5     | apex on the far side |
| ------------ | -------- | ------------ | -------------------- |
| 0, 10        | 373.3333 | **266.6667** | 480.0000 (z=15)      |
| 0, 10, 10    | 373.3333 | **313.3333** | 433.3333 (z=15)      |
| 0, 20, 10    | 253.3333 | **193.3333** | 433.3333 (z=25)      |

Rows 2 and 3 are what the second round still let through, and they are why the
guard is not a single side test against the section before the closing one:
in row 2 that section is coplanar with the closing one (no side to read), and
in row 3 it is on the far side already (the right side, but not the whole
story). The earlier claim in this file that those two runs are "degenerate for
reasons of their own" and that "the kernel and the solid validator own the
refusal" was wrong, and the measurements above are what disproves it: strike
the apex from either run and both build valid solids.

**The one run that genuinely has no side to be on is decided, not skipped.**
If _every_ other section is coplanar with the closing section the loft has no
interior for the apex to fold into, and measured it closes correctly either
way: 4×4 and 8×8 both on z = 0 with an apex at z = 10 and at z = −10 both give
213.3333, the analytic 8 × 8 × 10 / 3 pyramid. That run is accepted, with a
regression test pinning both signs. Refusing it would take away a loft the
kernel builds correctly.

The guard is a side test, not a "higher z" test and not an "above the axis"
test: reverse the section order and an apex _below_ both sections is the
correct one (volume 400, `bbox.min.z` −5), and an apex 200 mm off to one side
and 1 mm beyond the closing section builds at the analytic 394.6667. All three
are covered.

### When the kernel refuses an apexed loft anyway

`validateGeneratedSolid` can still fail on the apex path, and the advice
appended to that failure used to blame the apex unconditionally. A loft
between a rectangle on XY and a rectangle on XZ refuses with "Loft did not
produce a valid closed solid" _whether or not_ an apex is asked for; telling
that user to move or clear an apex that is already correctly placed sends them
after the wrong input. The builder now lofts the same section run again
without the apex and reports which of the two is at fault. The re-loft only
runs on the error path, and face handles survive repeated loft calls on this
pin (verified: `loft`, `loftWithOptions`, `loft` again over the same
`Uint32Array` each return their own solid).

## Deliberate limits

- **No twist option.** Nothing in the pin binds a twist angle for a loft or a
  sweep. `multiSectionSweep(faces, params, spine…, ruled)` can express a twist
  only if the _user_ rotates the section profiles themselves; that is a
  multi-section feature, not a twist control, and it is not this PR.
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
                        Tests  2505 passed | 4 skipped (2509)
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
measured on the first round, plus the 5 added in the second and the 5 added in
the third, give the 2505 above.

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
  - **apex on the same side as the rest of the loft** (z=5, between the
    sections, and z=−5, beyond the far end) refused by name — the fail-open
    that produced a silent 266.667 body;
  - **apex hidden from the side test by a coplanar closing pair** (sections at
    z=0, 10, 10 with the apex at z=5) refused by name — the silent 313.3333
    body — and the same run with the apex at z=15 asserted to still build at
    433.3333;
  - **apex an earlier section already reaches past** (sections at z=0, 20, 10
    with the apex at z=5) refused by name — the silent 193.3333 body — and the
    same run with the apex at z=25 asserted to still build at 433.3333, so the
    guard refuses the fold and not the overshooting run;
  - **a run whose sections are all coplanar** closes from either side, both at
    the analytic 213.3333, with the bbox reaching the apex;
  - **an apex 200 mm off the section axis** builds at the analytic 394.6667,
    so the guard measures along the closing normal only;
  - **a loft the sections cannot make** keeps the kernel's own message and says
    the section run is at fault, and is asserted _not_ to carry the old advice
    to move or clear the apex;
  - **a descending section run closed to an apex below it** builds: volume
    400, `bbox.min.z` −5, proving the guard tests a side and not a direction;
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
- **The apex guard reads section faces through `getFaceVertices`.** A section
  face that reports no vertices falls back to `planarFaceCentroid`, and that
  to the sketch plane's origin — the weaker proxies earlier rounds used. Every
  section face built from an app sketch reports vertices, so the fallbacks are
  a safety net rather than the normal path, but they are the part of the guard
  I have not exercised on a real face.
- **A straddling section is measured at its extremes, which is deliberately
  conservative.** A section on a plane at an angle to the closing one can
  reach past the closing plane on both sides. Its far extent is what the apex
  has to clear, so such a run refuses an apex that a centroid test would have
  accepted. I could not build a case where that refuses a loft the kernel
  makes correctly, but it is the direction the guard errs in.
- **I could not reach the "the apex is what this loft cannot take" half of the
  new failure message on this pin.** Every apexed loft that passes the guard
  and whose sections loft without an apex also validated — I tried apexes at
  1e-6 and 1e7 mm standoff, 1e6 mm off axis, over the notch of an L-shaped
  section (where the cone self-intersects), rectangle/circle/mixed sections
  and an annulus (which the kernel refuses outright: "loft profiles with holes
  are unsupported"). So that branch is a safety net with no fixture; the other
  branch is covered.

## Follow-ups

- File the `startPoint` tessellation defect upstream in Remus with the repro
  above; once fixed, `loft.startPoint` is a one-field addition here.
- Ask upstream for a tangency and a twist control on `loftWithOptions` —
  neither exists on this pin, and both were named as wanted in the roadmap row.
- A curve-coincidence check would let the builder refuse a rail that lies on
  the path however it was authored.
- The apex guard is a separating-plane test, so it answers "can this apex fold
  the run" and not "does this loft self-intersect". A real self-intersection
  test over the ruled bands would subsume it and would also catch the runs that
  fold without any apex at all (sections at z = 0, 20, 10 loft to 253.3333 with
  no warning today). That is a larger piece of work and belongs with the kernel
  people, since `validateSolid` is where it would naturally live.
- `multiSectionSweep` remains unadopted and would be the natural home for a
  multi-section sweep feature if one is ever wanted.
