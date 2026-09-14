# Handoff — typed detailed booleans, and the retired facet census

## What shipped

Remus change B21 made the plain `cut` / `fuse` / `intersect` / `fuseAll` entry
points exact-only: where the exact pipeline cannot produce a result they throw
instead of silently returning an approximated, tessellated solid. ZCAD called
those entry points everywhere and had no handling for the new refusal, so a
user who tried a boolean the engine declines saw raw kernel prose — "exact-only
policy: the exact boolean pipeline could not produce this result and the
approximate fallback was declined" — pasted into a feature warning.

Now:

- Every boolean in the adapter goes through the kernel's typed twins
  (`cutDetailed` / `fuseDetailed` / `intersectDetailed`), decoded by
  `packages/kernel-adapter/src/exact-boolean-refusal.ts`.
- A refusal reaches the user as a named product outcome: **"Union refused:
  "Ball" and "Ball 2" could not be combined exactly, and an approximate result
  was declined. Repositioning the overlap sometimes clears it; otherwise keep
  the bodies separate."** The kernel's own code and category sit behind the
  newline, where the feature cards already hide detail. The remedy claims
  nothing beyond that — see "Advice the kernel will honour" below.
- The kernel's category travels with it. `ExactBooleanRefusal.category` is the
  branchable field inside the adapter, and the build loop copies it onto the
  session-only `FeatureWarning.exactBooleanRefusal` (`{ operation, category,
  code }`) so nothing downstream has to match on English.
- A refused cluster fuse names the member that was declined — the body name for
  a union, `instance N` for a pattern.
- The boolean arm of the face-count census is retired, because the thing it
  detected can no longer happen.

**Advice the kernel will honour.** An earlier revision of this branch ended a
refused union with "or subtract instead — the same operands still cut exactly",
a sentence inherited verbatim from the retired facet census. The census could
say it because it only fired on a result the engine had already built; a
quality refusal is a far wider trigger and the promise does not survive it.
Measured on the pin: a 20×20×10 plate unioned with an r3 h10 boss whose base
sits ~1 µm inside its top face refuses with `exact_only_unattainable` /
`quality_refused`, and `cutDetailed` on that same pair refuses identically, so
a user who followed the advice got a second refusal. The remedy now offers only
repositioning (and, for a union, keeping the bodies separate), and
`exact-boolean-refusal.test.ts` pins the sliver pair refusing both ways.

**Approximation is not offered as a rescue.** A refused pair is not rerouted to
`booleanWithQuality` without `exactOnly`. Measured on the pin against the same
two offset unit spheres, that path throws `non-manifold result`: it trades one
failure for a worse one. `exact-boolean-refusal.test.ts` pins that decision so
nobody re-adds the "rescue" without first re-measuring it.

## Kernel calls adopted

| Was | Now | Where |
| --- | --- | --- |
| `kernel.cut(a, b)` | `exactCut` → `cutDetailed` | `exact-feature-builders.ts` (extrude cut, boolean subtract), `exact-cylinder-ops.ts` (hole tool loop), `exact-direct-edit-ops.ts` (through-hole enlarge, both forms) |
| `kernel.fuse(a, b)` | `exactFuse` → `fuseDetailed` | `exact-cylinder-ops.ts` (`fillThroughHole`), `exact-direct-edit-ops.ts` (through-hole shrink, imported-hole fill) |
| `kernel.intersect(a, b)` | `exactIntersect` → `intersectDetailed` | `exact-feature-builders.ts` (boolean intersect), `opening-recognition.ts` (section slab) |
| `kernel.intersect(a, b)` inside a probe `try` | `exactBooleanOutcome(..., 'intersect', ...)` — refusal as data, no throw | `exact-boolean-helpers.ts` (`solidsShareMaterialOrTouch`), `exact-feature-builders.ts` (union contact probe, subtract overlap measurement) |
| `kernel.fuseAll(handles)` | `exactFuseAll` — `fuseAll` first, then a pairwise `fuseDetailed` fold on failure to attribute it | `exact-boolean-helpers.ts` (`fuseUniformSolid`), reached by union, add-extrude, pattern merge and `collapseShape` |
| `booleanFacetFallbackWarning(...)` | deleted; `unionSwallowedCurvature(...)` keeps the one question that was not about faceting | `boolean-result-validation.ts`, `exact-boolean-helpers.ts`, `exact-feature-builders.ts` |

`SolidOperationDetailedResult` is re-exported from `remus-runtime.ts`, so the
adapter's `BooleanRefusalCategory` is derived from the pinned kernel's own
union rather than restated by hand.

## What I verified numerically against the pin

A throwaway node script against `remus_wasm_node.cjs` (deleted; it lived in the
session scratchpad, never in the repo). Kernel package `2.131.0`, commit
`4bbcd5c7`. Two `makeSphere(1.0, 24)`, the second translated 0.5 in x with a
row-major matrix:

| call | result |
| --- | --- |
| `fuse(a, b)` | throws `exact-only policy: … the approximate fallback was declined` |
| `fuseDetailed(a, b)` | `{status:"error", code:"exact_only_unattainable", category:"quality_refused", details:{kernelCode, message, operation:"fuse"}}` |
| `fuseAll([a, b])` | throws the same bare error — there is **no** `fuseAllDetailed` in the pin |
| `booleanWithQuality('fuse', a, b, false)` | throws `non-manifold result` |
| `cutDetailed(box60×18×24, cyl r6 h28 @ (30,9,0))` | `{status:"ok", value:<handle>}`, volume 23205.664, `validateSolid` 0 |
| `cutDetailed` of the r=14 severing tool | `exact_only_unattainable` / `quality_refused` |
| `cutDetailed(999999, 999998)` | `{code:"invalid_handle", category:"invalid_input"}` — the typed twins do **not** throw on a bad handle |
| `intersectDetailed` of two disjoint boxes | `status:"ok"` with a handle, not a refusal |

The last two shaped the code: `exactBooleanOutcome` is safe for probes (a
refusal is data), and a programming error surfaces as `invalid_input` rather
than as an exception, so the probe sites keep their `try` for a kernel that
panics outright.

## Check results

Run from the worktree root, in order, on the final tree:

```
pnpm lint               ✖ 19 problems (0 errors, 19 warnings)     [baseline: 0 errors / 19 warnings]
pnpm typecheck          clean (tsc --noEmit, no output)
pnpm test               root:  Test Files 242 passed | 2 skipped (244)
                               Tests 2501 passed | 4 skipped (2505)
                        web:   Test Files 156 passed (156)
                               Tests 1182 passed (1182)
pnpm test:parity-corpus Test Files 7 passed (7)
                        Tests 174 passed | 1 skipped (175)
pnpm build              ✓ built; "warnings": [], "failures": []
```

The recorded `origin/main` baseline is root 241 files / 2489 passed + 2
skipped, web 156 files / 1182 passed, parity 174 passed / 1 skipped — every
count here is at or above it. The web and parity counts are untouched by this
branch; the root count grew by its two new test files, five of whose tests are
the regressions for the verifier defects (the previous run of this branch read
2496, this one reads 2501). No test was skipped, loosened or deleted; the two
root skips and the one parity skip are the pre-existing ones.

`pnpm build` carries the bundle-size gate and reports no warnings and no
failures. The new module is type-only against `remus-runtime`, so it adds no
WASM to any chunk; the tightest entry budget still reports 57 459 bytes
remaining.

## Regression coverage added

- `packages/kernel-adapter/src/exact-boolean-refusal.test.ts` — the two offset
  spheres refuse as a typed `ExactBooleanRefusal` naming the operation, the
  bodies and the category; the plain `fuse` still throws an untyped error (the
  reason this module exists); dropping `exactOnly` is not a rescue; the cause
  chain survives a caller's own heading; an invalid handle is `invalid_input`;
  the ordinary box-minus-cylinder cut still returns `ok` with the same volume
  and curved faces; a refused cluster fuse names `instance 2`.
- `packages/kernel-adapter/src/exact-boolean-refusal.test.ts`, second round —
  the three regressions for the verifier's defects. The ~1 µm sliver contact
  refuses for `cut` exactly as it does for `fuse`, so the refused union's
  sentence may not name subtract and a refused cut may not tell the user to
  keep the bodies apart. And the diagnosis fold is traced through a kernel with
  `fuseDetailed` and `deleteSolid` shadowed (`Object.create` keeps the one live
  wasm instance on the prototype): every solid the fold allocates is released,
  no caller input is, the inputs still measure afterwards, and the success path
  allocates and releases nothing.
- `test/boolean-refusal-reporting.test.ts` — the same union driven through a
  real document and `syncDocument`: the feature warning reads "Union refused:
  … could not be combined exactly", carries `{operation:'fuse',
  category:'quality_refused', code:'exact_only_unattainable'}`, and leaves both
  operand bodies unconsumed. Plus the ordinary subtract, pinned by volume and
  by the surviving cylindrical face.
- `packages/kernel-adapter/src/boolean-face-census.test.ts` — rewritten, not
  deleted. It now asserts the new contract: the boolean arm is gone, the
  direct-edit arm is unchanged, and `unionSwallowedCurvature` deliberately does
  **not** judge face-count growth.
- `test/exact-kernel-adapter.test.ts` — the face-contact union helper used to
  accept either "faceted" or "exact" and check they agreed. Under exact-only
  there is no faceted answer, so it now asserts the union was built exactly
  (no warnings, curved faces survive). This is a strengthening.

## Deliberate limits

- **The dropped-operand AABB check and every other distrust guard stay.**
  `droppedUnionOperandWarning`, the subtract removal-ratio guard, the union
  strict-solid / mesh-closure gate, the hole face-count proof and
  `directEditFacetFallbackWarning` are all untouched. Only the boolean facet
  census was retired, and only because the kernel can no longer produce what it
  looked for.
- **`directEditFacetFallbackWarning` kept in full.** It guards `pushPullFace`,
  which is not a boolean and has no exact-only policy behind it.
- **`booleanWithQuality(..., exactOnly = true)` in `exactSharedSolidVolume` was
  left alone.** It is already an explicit exact-only call with its own
  inclusion–exclusion fallback, not one of the plain entry points B21 changed.
- **`fuseAll` has no typed twin in the pin**, so `exactFuseAll` still calls it
  and only falls back to a pairwise `fuseDetailed` fold to attribute a failure
  that already happened. The fold is diagnosis, **not** a rescue: if it finds
  no culprit the original error is rethrown unchanged. Accepting a left fold
  that succeeded where the balanced reduction refused would make a cluster's
  fate depend on the order the diagnosis happened to take. Every partial union
  the fold builds is scratch and is retired with `deleteSolid` as soon as the
  next step supersedes it (the last one on the way out), so it holds at most
  one extra solid at a time. `deleteSolid` retires only the unshared topology
  subtree, so the caller's operands survive — checked on the pin, where the
  inputs still measure and the running union still validates after a mid-fold
  release.
- **No web UI work.** The refusal is surfaced through the existing feature
  warning channel, which the panel already renders with a first-line/detail
  split. No component was changed.
- Test and parity-reference code under `test/` still calls the plain entry
  points directly; that is deliberate — those files exercise the kernel, not
  the product path.

## Risks for the reviewer

- **Message copy changed.** Anything matching on the old census sentences
  ("could only be built as an approximation", "replaced every curved surface
  with flat faces", "produced far more faces than its operands") will no longer
  match — nothing in `apps/web` did, which I checked by grep, but a future
  string match should use `exactBooleanRefusal.category` instead.
- **`FeatureWarning` gained an optional field** (`exactBooleanRefusal`). It is
  session-only, stripped by `attachDerivedState` like the rest of the record,
  and additive — a document without it replays identically. It has no consumer
  yet; it exists so the next one does not have to parse English. `category` is
  typed as `string`, not a union, so a new kernel category cannot break the
  build before anyone has decided what it means.
- **The pairwise diagnosis fold costs a second pass on the failure path** —
  up to n−1 `fuseDetailed` calls, plus one `deleteSolid` each, for an
  n-member cluster that has already failed. It never runs on success. The cost
  is bounded by the product: a feature may contribute at most 100 solids
  (`exact-feature-builders.ts` enforces it for patterns), and 99 fuses plus
  their releases measured **54 ms** on the pin for a 100-box row. I judged that
  proportionate to naming the instance and did not add a cutoff; a cutoff would
  drop the attribution exactly for the largest clusters, where it matters most.
- **The union move probe's candidate filter narrowed.** It used to reject a
  candidate on faceting OR on losing all curvature; only the curvature half
  survives, because the other half is now the kernel's own refusal (and a
  refused candidate is skipped by the surrounding `try`). The validity and
  mesh-closure checks after it are unchanged.
- **`exact-feature-warnings.test.ts` fixture text was updated** to the new
  refusal copy. That test exercises the warning-amend plumbing, not the copy;
  the strings are fixtures, and keeping retired sentences as fixtures would
  have been misleading.

## Follow-ups

- Nothing consumes `FeatureWarning.exactBooleanRefusal` yet. The obvious first
  consumer is the commit gate / tool card: `quality_refused` is a "move it and
  try again" story, while `resource_limit` and `unsupported` are not, and today
  they all render the same way.
- `exactUnionOffsetSuggestion` still probes candidate moves by actually fusing
  them. Now that a refusal is typed, it could report *why* each candidate was
  declined instead of silently skipping it.
- B23 (fillet is one walking-then-rolling-ball cascade, no flat planar bevel
  fallback) is the same class of change on a different operation and is not
  touched here.
- `docs/adrs/ADR-020-remus-browser-kernel.md` records, as a live consequence,
  that "a shallow circular union now returns a watertight faceted result
  instead of refusing" and "remains visibly labeled as approximate". B21
  reversed that: the plain booleans refuse instead. I left the ADR alone
  because it is a decision record pinned to the kernel state of its day and
  amending it is a separate, deliberate call; flagging it here so the next
  reader does not take it as current.

## Verifier defects addressed

An independent verifier read this branch and reported three minor defects.
All three are fixed, none disputed:

1. **The remedy promised a subtract the kernel also refuses.** Reproduced on
   the pin with the ~1 µm sliver contact, where `fuseDetailed` and
   `cutDetailed` both return `exact_only_unattainable` / `quality_refused`.
   The false clause is gone; the sliver pair is now a regression test.
   (`fix(kernel-adapter): stop promising a subtract the kernel also refuses`)
2. **The diagnosis fold leaked its intermediates.** Each partial union is now
   released, traced by a regression test that shadows `fuseDetailed` and
   `deleteSolid`.
   (`fix(kernel-adapter): give back the scratch solids the diagnosis fold builds`)
3. **`docs/kernel-roadmap-remus.md` still cited `booleanFacetFallbackWarning`
   as a live guard.** Corrected in both places that named it — the S1 item and
   the distrust-harness paragraph (the verifier found the first; the second is
   the same staleness).
   (`docs(kernel-roadmap): booleanFacetFallbackWarning is gone, say so`)

The verifier also flagged the one-line `ROADMAP.md` pin correction
(`f1968568`/2.130.14 → `4bbcd5c7`/2.131.0) as outside this task's scope. It was
explicitly requested and is factually right against `pnpm-lock.yaml`, so it
stays; it is a one-line change and a trivial conflict to resolve if another
branch touches the same header.
