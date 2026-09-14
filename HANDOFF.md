# Handoff — one typed kernel-result seam (W04)

> **Stacked branch.** This is `claude/remus-typed-result-seam`, created from
> `claude/remus-typed-booleans` (PR #330). `git diff claude/remus-typed-booleans..HEAD`
> shows only this branch's work. The parent's own handoff is kept below under
> [Prior handoff](#prior-handoff--typed-detailed-booleans-and-the-retired-facet-census).

## What shipped

The parent branch gave **booleans** a typed refusal carrying the kernel's own
category. Every other kernel family still failed as a bare `Error` with the
kernel's prose in it, and the product told those failures apart by matching
that English in `apps/web/src/lib/refusalLanguage.ts`. An unsupported domain,
an exceeded budget and geometry refused on quality — three different stories
with three different answers — all rendered as one line: _"The exact kernel
could not build this result."_

This branch builds **one** seam across the adapter instead of a second way to
decode a kernel error:

- `packages/kernel-adapter/src/kernel-refusal.ts` — the shared `KernelRefusal`,
  its `family`, and `KernelRefusalCategory` **extracted from the pin's own
  `SolidOperationDetailedResult`** rather than restated. `ExactBooleanRefusal`
  now extends it and `BooleanRefusalCategory` is an alias, so there is exactly
  one copy of the taxonomy.
- **Validation** reads `validateSolidDetailed`, so a refusal carries the
  validator's own issue descriptions instead of a bare count.
- **Healing** reads `unifyFacesChecked`, which answers the `unifyFaces` +
  `validateSolid` pair in one call and reports `facesMerged`, `inputErrors`,
  `resultErrors` and `reverted`.
- **Import** reads `importStepWithReport`, so `solidCount`, `sheetCount` and
  the reader's bounded-healing diagnostics survive the boundary.
- The category reaches the UI. `FeatureWarning.exactBooleanRefusal` becomes
  `FeatureWarning.kernelRefusal` with a `family`, and `plainRefusal` answers
  for all nine categories, so those three stories now read as three sentences.
- `test/kernel-prose-matching.test.ts` fails the build if the adapter grows a
  new kernel-prose matcher outside a recorded, explained allowance.

## Kernel calls adopted

| Kernel call                                          | Replaced                                                             | Where                                                                                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validateSolidDetailed(solid)`                       | `validateSolid(solid) !== 0` at sites that turn a failure into words | `kernel-validation.ts` → `exact-shape-utils.validateGeneratedSolid`, `exact-face-distance`, `exact-direct-edit-ops` (blend resize), `exact-lineage-builders.diagnoseImportedSolid` |
| `unifyFacesChecked(solid)`                           | `unifyFaces(solid)` + `validateSolid(solid) !== 0`                   | `exact-cylinder-ops` ×2, `exact-direct-edit-ops` ×3                                                                                                                                |
| `importStepWithReport(data, maxBytes, maxEntities)`  | `importStep(data, …)`                                                | `kernel-step-import.importStepWithOwnBudget` → the build path, `inspectStep`, `reconstruction-measurement`                                                                         |
| `runHealPipeline` payload                            | an inline `as` cast plus a hand-rolled parse                         | `exact-shape-utils.unifySewnMesh` via the shared `readKernelPayload`                                                                                                               |
| `cutDetailed` / `fuseDetailed` / `intersectDetailed` | (parent branch) — now decoded through the shared base class          | `exact-boolean-refusal.ts`                                                                                                                                                         |

`healSolidDetailed` and `repairSolidDetailed` are **not** adopted: nothing in
ZCAD heals or repairs an arbitrary solid today, so adopting them would mean
adding a heal path, which is product work rather than a seam migration. Both
are verified present and correct on the pin (below) and are ready for whoever
builds that path.

## What I verified numerically against the pin

Probes run against the installed `remus_wasm_node.cjs` / `remus_wasm_io_node.cjs`
(pin `4bbcd5c7`, package `2.131.0`), then deleted.

1. **`validateSolidDetailed().errorCount === validateSolid()`** for every solid
   in the parity corpus — 21 files, 23 restored solids. The only member with
   errors is `f-hostile-open-shell`: both report **2**, and the detailed twin
   names them (`Euler characteristic V-E+F = 1 is invalid …`, `4 boundary
edge(s) found (shell is not closed)`). This is what makes the swap a
   rewording and not a moved gate.
2. **The corpus's voided solids now report ZERO strict errors** on this pin —
   `c-void-single-cavity` (2 shells), `c-void-two-cavities` (3) and the voided
   half of `d-multi-solid-and-void` all read `validateSolid = 0`. The module
   header of `imported-step-validation.ts` says every voided solid reports
   exactly one strict error, which was true when it was written and is now
   **stale**. The multi-shell relaxed-validation branch it justifies is
   harmless either way, and I left it alone — see Risks.
3. **`unifyFacesChecked` is exactly the pair it replaces.** On a
   box-minus-cylinder and on a two-box union: `facesMerged` equals what
   `unifyFaces` returned, `inputErrors` equals `validateSolid` before,
   `resultErrors` equals `validateSolid` after, and the face count and volume
   of the solid the caller holds are identical either way. On an open shell it
   returns `{"facesMerged":0,"inputErrors":2,"resultErrors":2,"reverted":false}`
   rather than throwing.
4. **`importStepWithReport` restores byte-identical solids** to `importStep`
   for `a-export-bored-plate`, `d-multi-two-boxes` and `f-hostile-open-shell`.
   Its `StepImportResult` owns WASM memory: reading `.solids` twice is fine,
   reading anything after `.free()` throws `null pointer passed to rust`, and
   so does a second `.free()`. The adapter frees exactly once, in a `finally`.
5. **The detailed readers return JSON TEXT, not objects**, despite
   `ValidationReportResult` / `UnifyFacesDetailedResult` existing as types —
   the `.d.ts` declares all four as `any`. That is why everything goes through
   one checked `readKernelPayload`.
6. **All four detailed readers throw for a bad handle**, exactly as
   `validateSolid` does (`invalid solid handle: index 9999 is out of bounds`).
   A programming error stays a throw and does not become a soft verdict.
7. **The STEP reader has no typed refusal.** `importStepWithReport` throws the
   same bare prose as `importStep`: `parse error: entity #999999 not found`,
   `parse error: STEP file declares no LENGTH_UNIT …`, `import limit exceeded
for input bytes: 8475 > 10`, `import limit exceeded for STEP entities: 3 > 2`.
   Pinned by a test so the limit below is a measured fact.
8. **`healSolidDetailed` / `repairSolidDetailed` / `unifyFacesChecked` on a
   clean box** return `{"solid":0,"repairs":[],"totalRepairs":0,"verified":true}`,
   `{"solid":0,"errorsBefore":0,"repairs":[],"totalRepairs":0,"errorsAfter":0,"verified":true}`
   and `{"facesMerged":0,"inputErrors":0,"resultErrors":0,"reverted":false}`.
9. **Every corpus file reports an empty `diagnostics` list**, so the reader's
   diagnostic ENTRY shape is unverified on this pin — see Deliberate limits.

## Check results

All five run from the worktree root, all green.

| Command                   | Result                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`               | `✖ 19 problems (0 errors, 19 warnings)` — the 19 pre-existing `react-hooks/exhaustive-deps` warnings, unchanged |
| `pnpm typecheck`          | clean, no output                                                                                                |
| `pnpm test` (root)        | `Test Files  246 passed \| 2 skipped (248)` / `Tests  2543 passed \| 4 skipped (2547)`                          |
| `pnpm test` (web)         | `Test Files  156 passed (156)` / `Tests  1190 passed (1190)`                                                    |
| `pnpm test:parity-corpus` | `Test Files  7 passed (7)` / `Tests  174 passed \| 1 skipped (175)`                                             |
| `pnpm build`              | `"warnings": []`, `"failures": []`, totals 18 802 577 bytes / 6 383 569 gzip                                    |

`node scripts/check-css-classes.mjs` also passes: _"Every classed element is
styled: 275 files checked against 811 classes from 28 stylesheets."_

No skip, tolerance or assertion was weakened. The 4 root skips and the 1
parity skip are inherited — none of the four test files this branch adds
contains a `.skip`.

## Regression coverage added

- `test/kernel-prose-matching.test.ts` — scans every non-test file in
  `packages/kernel-adapter/src` for a message being tested as text, in the two
  shapes every prose matcher in this repo has taken (a substring test against
  a string literal, and a regex literal run with `.test`/`.exec`). Both must
  contain a word gap, so `/^\d+$/.test(key)` and `startsWith('feat_')` are
  correctly not English. Three allowances remain, all in the blend family,
  each naming its family and its reason; an allowance that stops matching
  fails as **stale**. Two paired assertions guard the other direction, since
  deleting a typed reader would leave no matcher to find: every migrated
  family is pinned to its typed entry point, and the converted cleanup gates
  are pinned to `unifyAndRequireValidSolid`. **Verified by adding a matcher to
  an adapter file and watching the test fail.**
- `packages/kernel-adapter/src/kernel-refusal.test.ts` — the category
  enumeration (runtime half; the compile half is `UNENUMERATED_CATEGORIES`),
  the bounded cause walk, a boolean refusal hidden behind a validation refusal,
  and the payload reader raising on every unreadable shape rather than passing.
- `packages/kernel-adapter/src/kernel-validation.test.ts` — the
  `validateSolidDetailed` ≡ `validateSolid` equivalence and the
  `unifyFacesChecked` ≡ `unifyFaces` + `validateSolid` equivalence, both
  against the real kernel; the validator's issues reaching the refusal; an
  unreadable severity treated as an error and never as a warning.
- `packages/kernel-adapter/src/kernel-step-import.test.ts` — the report
  decoder, surface-only bodies naming themselves, restored solids matching by
  volume, and the untyped parse-error prose pinned as a measured limit.
- `apps/web/src/lib/refusalLanguage.test.ts` — three refusals that used to read
  identically now reading differently, an answer for all nine categories, and
  an unknown future category falling back exactly as an uncategorised one does.
- `apps/web/src/lib/diagnosticsRows.test.ts` — a row classified from the
  rebuild record rather than from its words.
- `test/boolean-refusal-reporting.test.ts` — updated for the renamed field; it
  now also asserts `family: 'boolean'`.

## Deliberate limits

1. **The STEP import family gets a typed REPORT, not a typed refusal.** There
   is none on the pin (verified item 7). Classifying `parse error:` and
   `import limit exceeded for …` from their prefixes would be the same English
   matching this work removes, at a new address and dressed as a category, so
   the existing handling for them stays in `refusalLanguage`. Both patterns
   are in the web app, which the prose scanner deliberately does not cover —
   presentation of last resort for families with no typed twin is exactly what
   that module is for.
2. **The blend family keeps its prose matching.** `fillet`, `chamfer` and
   `filletVariable` have no `*Detailed` twin. The kernel is the only thing
   that knows which edges its blend engines gave up on, and it says so only in
   its sentence, so relaying those counts beats dropping them. Three
   allowances in the scanner, each with its reason.
3. **`validateSolidRelaxed` has no detailed twin** and keeps its bare count.
   That covers `exact-direct-edit-ops`' face-offset and cylinder-resize gates
   and the multi-shell branch of the import taxonomy.
4. **Not every `validateSolid` call was converted.** The task is to change how
   failures are DESCRIBED, never whether they are CHECKED, and a guard that
   only returns `null` or picks a branch has no sentence to improve while
   `validateSolidDetailed` allocates a JSON payload per call. Bare
   `validateSolid` therefore stays in `exact-boolean-helpers`, `planar-emboss`,
   `opening-recognition`, `exact-feature-builders` and `remus-modeling-operations`.
   The scanner pins the converted sites rather than banning the bare call.
5. **`selectSafelyUnifiedSolid` is left on `unifyFaces`.** Its acceptance
   predicate is supplied by the caller and pairs strict validation with a
   closed-tessellation check, so the second verdict is not the one
   `unifyFacesChecked` reports; swapping it would not remove a duplicate call.
6. **The STEP reader's diagnostic entry shape is unverified** (item 9). Entries
   are rendered when they are a string or carry a string `message` and are
   otherwise counted, so a disclosure this adapter cannot render still shows up
   as one that happened (`diagnosticCount`).
7. **`healSolidDetailed` / `repairSolidDetailed` have no caller** — see above.
8. **No new lazy chunk and no entry-chunk growth.** Everything added sits in
   the kernel adapter, already behind the exact-geometry lazy boundary; the
   web change is two functions in modules `App.tsx` already reaches.

## Risks for the reviewer

1. **The schema field was renamed.** `FeatureWarning.exactBooleanRefusal` →
   `kernelRefusal`, with a new `family` and `operation` made optional. This is
   the parent's field, generalised rather than duplicated, because the task is
   explicitly one seam and not two. It is session-only, stripped by
   `attachDerivedState`, and additive — a document without it replays
   identically — but **if PR #330 merges first, this rename is the diff a
   reviewer sees**, and anything written against `exactBooleanRefusal` in the
   meantime needs the new name. `category` stays a `string`, not a union, so a
   new kernel category cannot break a build before someone decides what it
   means.
2. **One behaviour is now stricter on purpose.** `unifySewnMesh` used to treat
   an unreadable `runHealPipeline` payload as "no solid" and return the
   unmerged sewn shell. It now raises, which for a CLOSED mesh is a real
   repair failure surfacing rather than hiding. An open shell still falls back
   to the sewn faces exactly as before, and the caller's size guard is
   untouched. If a supplier mesh regresses here, this is the change to look at.
3. **`plainRefusal` ordering changed for one table entry.** The hand-written
   table still wins where it names a symptom, **except** where its sentence is
   literally the generic fallback — the `exact-only policy|approximate
fallback` entry — in which case a category that says more takes its place.
   That is the only entry affected and the existing tests for the others pass
   unchanged.
4. **A flagged STEP import's wording changed.** It now appends the validator's
   descriptions in parentheses. No corpus file reaches the flagged branch (the
   open shell is rejected structurally and everything else is clean), so no
   fixture-driven expectation moved; a real supplier file that _is_ flagged
   will read differently, and better.
5. **`imported-step-validation.ts`'s module header is stale** on the measured
   voided-solid behaviour (item 2). I left the prose and the rule alone rather
   than rewriting a load-bearing header on a branch about something else —
   flagging it rather than silently editing it. The rule is still safe: a
   multi-shell solid held to the relaxed bar is a superset of what strict now
   passes.
6. **The prose scanner is a regex over source text.** It is line-based, skips
   comment lines, and would miss a matcher split across lines or one built
   from a variable. It catches the shape every such matcher in this repo has
   actually taken, and it is a guard rather than a proof.

## Follow-ups

- **Booleans in the web app could act on the category, not just show it.**
  `CommandDiagnostic.category` and `DiagnosticRow.category` are populated and
  nothing branches on them yet. `resource_limit` could offer a retry at a
  coarser budget; `cancelled` should not read as a failure at all.
- **Adopt `booleanWithCancellation`** (KERNEL-FINDINGS §5) — it returns
  `{"status":"cancelled","code":"operation_cancelled"}`, which slots straight
  into the `cancelled` category this seam already answers for.
- **Give the blend family a typed refusal** and delete the three allowances.
  That needs kernel work: `blend_failure_code` exists in the Rust source and
  is only ever rendered into prose.
- **Ask for a typed STEP import refusal**, which would let limit 1 close.
- **A heal/repair product path** would have `healSolidDetailed` /
  `repairSolidDetailed` waiting for it, both verified on the pin.
- **Refresh `imported-step-validation.ts`'s header** against the measured
  voided-solid behaviour, and re-examine whether the multi-shell relaxed
  branch still earns its place.

---

<a id="prior-handoff--typed-detailed-booleans-and-the-retired-facet-census"></a>

# Prior handoff (parent branch `claude/remus-typed-booleans`, PR #330)

Kept verbatim below. Everything it describes is in this branch's history but
is reviewed separately.

## Handoff — typed detailed booleans, and the retired facet census

### What shipped

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

### Kernel calls adopted

| Was                                           | Now                                                                                              | Where                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kernel.cut(a, b)`                            | `exactCut` → `cutDetailed`                                                                       | `exact-feature-builders.ts` (extrude cut, boolean subtract), `exact-cylinder-ops.ts` (hole tool loop), `exact-direct-edit-ops.ts` (through-hole enlarge, both forms) |
| `kernel.fuse(a, b)`                           | `exactFuse` → `fuseDetailed`                                                                     | `exact-cylinder-ops.ts` (`fillThroughHole`), `exact-direct-edit-ops.ts` (through-hole shrink, imported-hole fill)                                                    |
| `kernel.intersect(a, b)`                      | `exactIntersect` → `intersectDetailed`                                                           | `exact-feature-builders.ts` (boolean intersect), `opening-recognition.ts` (section slab)                                                                             |
| `kernel.intersect(a, b)` inside a probe `try` | `exactBooleanOutcome(..., 'intersect', ...)` — refusal as data, no throw                         | `exact-boolean-helpers.ts` (`solidsShareMaterialOrTouch`), `exact-feature-builders.ts` (union contact probe, subtract overlap measurement)                           |
| `kernel.fuseAll(handles)`                     | `exactFuseAll` — `fuseAll` first, then a pairwise `fuseDetailed` fold on failure to attribute it | `exact-boolean-helpers.ts` (`fuseUniformSolid`), reached by union, add-extrude, pattern merge and `collapseShape`                                                    |
| `booleanFacetFallbackWarning(...)`            | deleted; `unionSwallowedCurvature(...)` keeps the one question that was not about faceting       | `boolean-result-validation.ts`, `exact-boolean-helpers.ts`, `exact-feature-builders.ts`                                                                              |

`SolidOperationDetailedResult` is re-exported from `remus-runtime.ts`, so the
adapter's `BooleanRefusalCategory` is derived from the pinned kernel's own
union rather than restated by hand.

### What I verified numerically against the pin

A throwaway node script against `remus_wasm_node.cjs` (deleted; it lived in the
session scratchpad, never in the repo). Kernel package `2.131.0`, commit
`4bbcd5c7`. Two `makeSphere(1.0, 24)`, the second translated 0.5 in x with a
row-major matrix:

| call                                              | result                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `fuse(a, b)`                                      | throws `exact-only policy: … the approximate fallback was declined`                                                             |
| `fuseDetailed(a, b)`                              | `{status:"error", code:"exact_only_unattainable", category:"quality_refused", details:{kernelCode, message, operation:"fuse"}}` |
| `fuseAll([a, b])`                                 | throws the same bare error — there is **no** `fuseAllDetailed` in the pin                                                       |
| `booleanWithQuality('fuse', a, b, false)`         | throws `non-manifold result`                                                                                                    |
| `cutDetailed(box60×18×24, cyl r6 h28 @ (30,9,0))` | `{status:"ok", value:<handle>}`, volume 23205.664, `validateSolid` 0                                                            |
| `cutDetailed` of the r=14 severing tool           | `exact_only_unattainable` / `quality_refused`                                                                                   |
| `cutDetailed(999999, 999998)`                     | `{code:"invalid_handle", category:"invalid_input"}` — the typed twins do **not** throw on a bad handle                          |
| `intersectDetailed` of two disjoint boxes         | `status:"ok"` with a handle, not a refusal                                                                                      |

The last two shaped the code: `exactBooleanOutcome` is safe for probes (a
refusal is data), and a programming error surfaces as `invalid_input` rather
than as an exception, so the probe sites keep their `try` for a kernel that
panics outright.

### Check results

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

### Regression coverage added

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

### Deliberate limits

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

### Risks for the reviewer

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

### Follow-ups

- Nothing consumes `FeatureWarning.exactBooleanRefusal` yet. The obvious first
  consumer is the commit gate / tool card: `quality_refused` is a "move it and
  try again" story, while `resource_limit` and `unsupported` are not, and today
  they all render the same way.
- `exactUnionOffsetSuggestion` still probes candidate moves by actually fusing
  them. Now that a refusal is typed, it could report _why_ each candidate was
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

### Verifier defects addressed

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
