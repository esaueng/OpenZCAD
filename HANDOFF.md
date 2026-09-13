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

Both are exposed in the existing Loft and Sweep editors from PR #314 (a
checkbox plus the shared `VectorFields` for the apex; a "Guide rail" select
that defaults to "None — follow the path" for the rail), and both round trip
through the edit form.

The schema contract is held two ways. The builder keeps the *old call* when
the new field is absent — a loft without `endPoint` still calls
`loft`/`loftSmooth`, a sweep without `guide` still calls
`sweepWithOptions`/`sweepAlongEdges` — so replay is bit-identical rather than
merely equivalent. And `loftSections`/`sweepProfile` only write the key when
it was asked for, asserted by
`featureDataKeys(...) === ['featureKind', 'sections', 'mode']` in
`test/advanced-modeling-features.test.ts`.

One supporting change: `updateFeature` gained `clearData`, a list of optional
data keys an edit may *remove*. A `data` patch skips `undefined` values, so
before this it could only ever set a key — an apex point or a rail the user
added could never be taken off again. `CLEARABLE_FEATURE_DATA_KEYS` in
`packages/document-core/src/index.ts` allows only `loft.endPoint` and
`sweep.guide`; clearing anything else throws.

## Kernel calls adopted

| Call | Used for | Replaces |
| --- | --- | --- |
| `loftWithOptions(faces, json)` | a loft with `endPoint` | nothing — `loft`/`loftSmooth` still serve the unapexed case |
| `guidedSweep(face, spine…, aux…)` | a sweep with `guide` | nothing — `sweepWithOptions`/`sweepAlongEdges` still serve the unguided case |
| `getNurbsCurveData(edge)` | reading the spine and rail curves `guidedSweep` wants as raw NURBS | new |

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

Because the kernel is permissive, all validation is on our side: the builder
resolves the apex through `resolveParametricPoint`, checks the coordinates are
finite, and refuses an apex within 1e-6 mm of its section's plane (the kernel
takes that apex and quietly returns the unapexed loft).

## Deliberate limits

- **No twist option.** Nothing in the pin binds a twist angle for a loft or a
  sweep. `multiSectionSweep(faces, params, spine…, ruled)` can express a twist
  only if the *user* rotates the section profiles themselves; that is a
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
- **Surface mode is inert under a guide rail.** `sweepWithOptions` takes a
  segment count (24 standard / 64 smooth); `guidedSweep` takes no such
  argument. The form says so in a note when a rail is selected.
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

| case | triangles | open mesh edges | mesh volume | analytic |
| --- | --- | --- | --- | --- |
| rect 4×4 → 8×8, no apex | 12 | 0 | 373.3333 | 373.3333 |
| rect, `endPoint` z=15 | 20 | 0 | 480.0000 | 480.0000 |
| rect, `startPoint` z=−5 | **13** | **5** | **380.0000** | **400.0000** |
| circle r2→r3 (4, 6, 32 segments), `startPoint` | — | 0 | exact | exact |

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
- A rail lying on the spine, or a degenerate point rail, is *not* an error to
  the kernel: it returns the unguided result. The builder refuses a guide
  whose sketch and entity set match the path.
- `faceArea(face)` needs a deflection argument (`faceArea(face, 0.001)`); the
  one-argument form throws "deflection must be finite, got NaN".

## Check results

Run from the worktree root, in order:

```
pnpm lint              ✖ 19 problems (0 errors, 19 warnings)   [exit 0]
pnpm typecheck         clean, no output                        [exit 0]
pnpm test              Test Files 156 passed (156)
                       Tests 1185 passed (1185)
pnpm test:parity-corpus Test Files 7 passed (7)
                       Tests 174 passed | 1 skipped (175)
```

Baseline on `origin/main` was 156 files / 1182 tests and parity 174 / 1
skipped, so this adds tests and loses none. `node scripts/check-css-classes.mjs`
also passes (275 files against 811 classes); no new CSS class names were
introduced — the apex checkbox and the rail select reuse `.field` and
`.muted`. `pnpm test:e2e` and the desktop workflow were not run, per the
briefing.

## Regression coverage added

- `test/advanced-modeling-features.test.ts`
  - loft with no apex: feature data keys are exactly
    `featureKind, sections, mode` and the volume is the historical
    373.3333333333333;
  - loft with `endPoint` at z=15 over an 8×8 section: volume 480 (the analytic
    frustum plus one 64×5/3 pyramid) and `bbox.max.z` = 15;
  - apex on the section plane refused by name;
  - apex in smooth mode refused by name;
  - sweep with no guide: data keys exactly `featureKind, profile, path, mode`,
    volume 160, bbox 4 mm on x and 2 mm on y;
  - same sweep with a rail offset along y: volume still 160, bbox now 2 mm on
    x and 4 mm on y — the quarter turn the rail is for;
  - a half-turn arc rail refused by name ("resolves to 2 curves").
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

## Follow-ups

- File the `startPoint` tessellation defect upstream in Remus with the repro
  above; once fixed, `loft.startPoint` is a one-field addition here.
- Ask upstream for a tangency and a twist control on `loftWithOptions` —
  neither exists on this pin, and both were named as wanted in the roadmap row.
- A curve-coincidence check would let the builder refuse a rail that lies on
  the path however it was authored.
- `multiSectionSweep` remains unadopted and would be the natural home for a
  multi-section sweep feature if one is ever wanted.
