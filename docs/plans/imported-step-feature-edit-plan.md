# Imported STEP Feature Editing Plan

Status: in progress; Phase A and the initial read-only imported-blend UX are complete
Repos involved: `esaueng/brepkit` (kernel operation) and `esaueng/OpenZCAD` (schema,
adapter, UI). This is the first plan in this series that REQUIRES kernel PRs.
Spec: importing a history-less STEP body must give the same select → see current value →
edit interaction that in-app features get. Headline case: click a fillet band on an
imported part, read `R 3 mm`, drag or type a new radius, commit. The same pattern must
extend to other recognized features (holes first), with unsupported cases shown
read-only with a reason — never silently ignored and never guessed at.

## Summary of findings — what already exists vs. what is missing

Verified against the current tree (post PR #300 / vsel Phase 6). Most of the interface
already exists; the gaps are one commit path and one kernel operation.

**Already working (verify, don't rebuild):**

- STEP import is production-grade: `apps/web/src/lib/stepImportRun.ts` (size caps, blob
  store + R2 archival + ≤12 MB embedded fallback), replayable `imported-step` feature
  (`packages/shared/src/index.ts:565-595`), checksum-keyed rebuild cache with unit
  rescale (`packages/kernel-adapter/src/exact.ts:5033-5133`), per-solid K0.6 validation
  (`packages/kernel-adapter/src/imported-step-validation.ts`).
- Blend recognition for display is purely geometric and already works on imported
  bodies: `isBlendFace` (`exact.ts:852-914`, torus / tangent-cylinder / bspline) and
  `measureOwnedFaceGeometry` (`exact.ts:3599-3620`) publish
  `featureType:'blend'` + `blendRadius` on `FaceGeometry`
  (`packages/shared/src/index.ts:750-757`). The Inspector already shows
  "fillet radius R n" read-only for any blend face (`Inspector.tsx:522-533`).
- The entire select-to-edit interaction stack from vsel Phase 6: capability policy
  (`apps/web/src/lib/interaction/capabilities.ts:96-106`), interaction machine
  `edit-fillet` op, radius handle with exact radial direction
  (`apps/web/src/lib/interaction/filletFaceEdit.ts:96-141`), chip + keypad, LivePreview
  through the worker, validate-then-commit
  (`apps/web/src/hooks/useDirectEditCommit.ts:57-140`), R→0 removal, and post-commit
  reselection (`App.tsx:8177-8250`).
- The direct-edit pattern for history-less bodies (ADR-010): `direct-edit` features with
  fail-closed geometric fingerprints — through-hole diameter resize and
  `remove-face-feature` (`exact.ts:6186-6268`) are the working templates.
- Kernel: STEP reader with exact analytic surfaces including torus major/minor radius;
  `fillet_v2` runs on imported bodies (proven by
  `brepkit crates/io/tests/bracket_cylindrical_resize_step.rs`);
  `resizeCylindricalFace` is the template for an exact analytic resize op;
  `filletWithEvolution`/`chamferWithEvolution` return versioned source→result face maps
  (`brepkit crates/wasm/src/bindings/operations.rs:455`,
  `brepkit docs/wasm-face-evolution.md`).
- A complete, tested, **unwired** exact feature-recognition module:
  `packages/kernel-adapter/src/imported-feature-recognition.ts` (1465 lines — blind
  holes, counterbores, countersinks, bosses, pockets, tapers, with typed refusal
  reasons). Exported from `packages/kernel-adapter/src/index.ts:28` with zero production
  callers.

**Missing (the actual work):**

1. **No commit path for a blend without a producing feature.** vsel D5 routes Edit
   Fillet through `updateFeature{radius}` on the producing `fillet` feature; imported
   bodies have none, so `editableFilletFeature` (`filletFaceEdit.ts:58-74`) returns null
   and the face is read-only.
2. **BrepKit has no blend resize / unfillet.** `defeature`'s "extend" heal recomputes
   corners as three-PLANE intersections and refuses curved wounds
   (`brepkit crates/operations/src/defeature.rs:55-80`), so today an imported fillet can
   be removed only when every other face on the body is planar. Re-filleting an existing
   blend is not a kernel concept at all (the band's G1 contact edges are filtered out of
   fillet selections by design).
3. **In-app fillet attribution is complete.** Phase A landed through #305 and #307:
   fillet replay now consumes evolution payloads while retaining the cylinder-rooted
   lineage path as a fallback. Imported blends still intentionally have no native
   producing feature and remain read-only except for the existing all-planar removal
   path.
   The e2e suite happens to build the one working shape.
4. **Recognition is dead code.** Neither `recognizeImportedFeature` (app) nor the
   kernel's `recognizeFeatures` reaches any UI. Imported holes/pockets/counterbores show
   nothing beyond raw surface data.
5. Kernel blend classification (`detect_fillet_like_fag`) is an area heuristic —
   irrelevant for this plan; the app-side classification is the one used for
   affordances, and the new kernel op must do its own exact verification anyway.

**Known limitations to carry, not fix here:** spline (freeform) blend bands stay
read-only — general unfillet via curved-surface extension is future kernel work. STEP
assemblies still collapse to positionless solids. Sphere face picks remain unavailable.

---

## Architecture decisions

### D1. The kernel gains an operation, not recognition

The edit affordance keeps keying off the app-side blend classification already in
`FaceGeometry` (`featureType:'blend'`, `blendRadius`). The new kernel op
`resize_blend(topo, solid, face, new_radius)` independently re-derives everything it
needs from exact topology — band membership, supports, current radius — and refuses with
typed errors when its own analysis disagrees with the caller's expectation (an
`expected_radius` argument, compared through tolerance). JS-side classification is a
hint for the UI, never authority for geometry. This mirrors how
`resizeCylindricalFace` re-verifies bore/boss concavity instead of trusting the caller.

### D2. v1 operation coverage is analytic-only, fail-closed

`resize_blend` v1 supports: a blend band that is a **torus** or **cylinder** face (or a
G1 chain of them sharing one radius, including full loops), whose two support faces are
**plane / cylinder / cone** each. That covers the standard convex/concave edge fillets a
Fusion/Shapr3D/SolidWorks export produces, including the walking-stick-foot class of
parts. Spline corner patches at band junctions are v1's hard boundary: a chain whose
closure touches a freeform patch is refused (`OperationsError::Unsupported`, stable
reason code), and the UI shows the radius read-only with that reason. `new_radius == 0`
removes the band and restores the sharp edge for the same analytic cases. Everything
else fails closed with a typed reason — never an approximate result.

### D3. An imported blend edit is a replayable `direct-edit` feature

Per ADR-010, exactly like through-hole resize. New `DirectEditOperation` variant:

```ts
{ kind: 'resize-blend';
  faceOrdinal: number;                // deterministic ordinal, ADR-010 pattern
  surfaceClass: 'torus' | 'cylinder';
  recordedRadius: number;             // fingerprint + kernel expected_radius
  recordedCenter: [number, number, number];  // torus center or cylinder axis point
  recordedAxis: [number, number, number];
  newRadius: number }
```

Rebuild resolves the ordinal, re-measures the face, and fails closed when surface class,
radius (tolerance), or center/axis (tolerance) disagree — same policy as
`removeFaceFeature`'s recorded surface/area/centroid checks (`exact.ts:6186-6268`).
Schema bump follows the ADR-010 v3 precedent: old documents normalize forward unchanged.

### D4. In-app fillet attribution moves to face-evolution payloads

Replace the cylinder-rooted `rederiveCylinderModifierLineage` special case as the source
of fillet-face `producingFeatureId`: the adapter's fillet/chamfer replay arm
(`exact.ts:5741-5822`) calls `filletWithEvolution`/`chamferWithEvolution` and publishes
semantic lineage for the produced blend faces from the returned
`FaceEvolutionPayloadV1`. Evolution data is candidate evidence under ADR-013 — it still
passes the carrier-witness + uniqueness checks before a reference is published; on any
mismatch the face falls back to hash-only lineage exactly as today. This closes gap 3
(fillet-on-box gets Edit Fillet) with no kernel change and no schema change, and it is
independently shippable before any of the imported-body work.

### D5. Imported-blend reselection resolves by analytic identity, never hash

Blend faces re-hash on every radius change (closed-edge hashes embed 2πr — the #155
lesson), and imported blends have no `producingFeatureId`. Reselection after
preview/commit therefore resolves by: blend classification + surface class + frozen
`center`/`torusCenter` distance (tolerance), returning null on ties — the same
fail-closed shape as `resolveFilletBlendFace` (`filletFaceEdit.ts:148-190`), extended
with a `directEditFeatureId` rung so the *editing feature* (not a producing feature)
anchors the selection across replays.

### D6. Recognition wiring is display-first

`recognizeImportedFeature` gets called (worker-side, on demand for a selected face of an
imported body) and its result rides a new optional, additive `FaceGeometry`/Inspector
payload: recognized kind, dimensions, and — critically — the refusal reason when
recognition declines. The only *edit* this plan commits through recognition is the
already-shipping through-hole diameter resize; counterbore/countersink/pocket/taper
edits are explicitly future work, but their dimensions become visible now. Showing "why
not" is a spec requirement: unsupported combinations are labeled, not hidden.

### D7. Two-repo delivery via the pinned kernel, no hand-edited SHAs

Kernel phases land in `esaueng/brepkit` `main` first, gated by its own test suite plus
new STEP-fixture regression tests. OpenZCAD consumes them through the scheduled
`update-brepkit.yml` pin bump (lockfile-only diff — never hand-edit the resolved SHA),
and any phase containing a pin bump runs the full CI matrix including
`pnpm test:parity-corpus` and Playwright. OpenZCAD UI phases that merely *tolerate* the
new kernel (feature-detect the binding) may land before the bump.

### D8. Package boundaries unchanged

`@openzcad/viewport` stays React-free and emits intent; capability/commit logic stays in
the app shell; new payload fields go in `@openzcad/shared` + producer code in
`@openzcad/kernel-adapter`. All `FaceGeometry` additions are strictly additive —
existing fields are ADR-011 witness inputs and never change semantics, units, or
tolerances.

---

## Phases

### Phase A — In-app fillet attribution via evolution payloads (OpenZCAD only, complete)

Implements D4. Independent of everything else; ship first.

- Adopt `filletWithEvolution`/`chamferWithEvolution` in the fillet/chamfer replay arm;
  map evolution results into ADR-013 candidate evidence; publish semantic lineage for
  blend faces when witness + uniqueness checks pass.
- Delete nothing: `rederiveCylinderModifierLineage` stays as fallback until the
  evolution path proves itself on the corpus; removal is a later cleanup.
- Tests: fillet-on-box blend face carries `producingFeatureId` and gets the Edit Fillet
  affordance; existing cylinder-chain e2e still passes; lineage uniqueness rejection
  (two identical fillets) falls back to hash-only without error.
- Gate: `npx vitest run`, `pnpm test:parity-corpus`, `pnpm build`, plus the existing
  `test/e2e/visual-selection-fillet-edit.spec.ts`.

### Phase K1 — Kernel `resize_blend` (brepkit)

Implements D1 + D2 core.

- `crates/operations`: band walk (G1-adjacent torus/cylinder blend faces sharing one
  radius, closed loops included), support-face identification, analytic reconstruction
  of the band at the new radius with re-trimmed supports; transactional rollback on any
  failure (reuse the snapshot/restore pattern from `try_fillet`); result must pass
  `validate_solid` or the op refuses.
- `new_radius == 0` → remove band, extend supports to the recovered sharp edge
  (analytic intersections only).
- Typed errors with stable reason codes (`blend-band-not-analytic`,
  `support-not-analytic`, `radius-too-large`, `band-touches-freeform`, …) following the
  `blend_failure_code` convention.
- WASM binding `resizeBlend(solid, face, expectedRadius, newRadius) -> u32` plus a
  face-evolution payload for the produced band (extends the
  `FaceEvolutionPayloadV1` scheme).
- Tests: parametric fixtures (box fillet, cylinder rim fillet — grow and shrink,
  radius→0) plus imported-STEP fixtures added under `crates/io/tests` from real
  exporter output (see instructions doc for fixture sourcing). Property: volume changes
  monotonically with radius on convex bands.
- Gate: brepkit `cargo fmt --check`, `cargo clippy` (pedantic, `-D warnings`),
  `cargo test` including new fixtures; stability-matrix row added.

### Phase K2 — Kernel hardening + refusal surface (brepkit)

- Broaden validated support pairs (cone supports, cylinder×cylinder bands), variable
  radius explicitly out of scope.
- Exhaustive refusal-path tests: every reason code reachable and asserted; fuzz the band
  walk on the parity-corpus-style generated solids.
- A read-only query `describeBlendBand(solid, face) -> JSON` (band faces, radius,
  supports, or refusal reason) so the app can show "why not editable" without attempting
  the op.
- Gate: same as K1.

### Phase B — Pin bump + document schema + adapter arm (OpenZCAD)

Implements D3. Requires K1 merged.

- Kernel pin bump via the updater workflow (lockfile-only diff), full CI matrix.
- `packages/shared`: `resize-blend` `DirectEditOperation` variant + schema
  normalization; `packages/document-core` accepts it through the existing `direct-edit`
  feature; `packages/command-system` command plumbing (mirror `resize-through-hole`).
- `packages/kernel-adapter`: rebuild arm — resolve ordinal, re-measure, fail-closed
  fingerprint checks per D3, call `resizeBlend`, surface kernel refusals as build
  warnings with the stable reason code.
- Tests: replay determinism (apply → serialize → rebuild twice, identical topology
  counts + volume), fail-closed on a moved/changed face, radius→0 removal, unit-scaled
  documents (imported cache is mm; document units vary).
- Gate: `npx vitest run`, `pnpm test:parity-corpus`, `pnpm build`.

### Phase C — UI: select-to-edit on imported blends (OpenZCAD)

Implements D5 + the capability seam. Requires B.

- `capabilities.ts`: blend face + no producing feature + `body.source ===
  'imported-step'` (+ K2 `describeBlendBand` says editable, feature-detected) →
  `edit-fillet` action with a new commit route: `direct-edit resize-blend` instead of
  `updateFeature`. Same chip, handle, keypad, live preview, R→0 removal flow.
- When the band is not editable, keep the read-only radius display and surface the
  reason code's human text in the tool card (extends the existing
  "R… is read-only" hint in `machine.ts:503-512`).
- Reselection per D5; regression test dragging an imported fillet twice without
  reselecting.
- Live preview through the existing `LivePreview` worker path building a candidate
  document with the new direct-edit feature; `previewDoc` only, never the document.
- Gate: `npx vitest run`, `pnpm build` (entry-chunk check), lint, screenshots of the
  edit on an imported fixture from two oblique angles.

### Phase D — Recognition display wiring (OpenZCAD, floats)

Implements D6. Depends only on Phase A being merged (shared Inspector seams), not on
the kernel work.

- Worker RPC to run `recognizeImportedFeature` for a selected face on an imported body;
  cache per (checksum, faceOrdinal).
- Inspector: recognized feature kind + dimensions (hole Ø/depth, counterbore Ø/depth
  pairs, pocket depth, taper angle) or the typed refusal reason. Through-hole faces keep
  their existing edit path; everything else is display-only with reasons.
- Gate: `npx vitest run`, `pnpm build`, unit tests against the module's existing
  fixture library.

### Phase E — Acceptance suite (OpenZCAD)

- Playwright spec: import a committed STEP fixture (analytic part with plane×cylinder
  torus fillets), select a fillet band → chip shows the exporter's radius; drag and
  type-commit a new radius → re-measured `blendRadius` matches; radius→0 removes the
  band; export STEP → re-import → radius round-trips; a spline-blend fixture face shows
  read-only + reason. Seed through the import path, not modeling UI; topology-payload
  asserts are the oracle, screenshots secondary.
- Gate: suite green headless; no timing-based waits.

---

## Risks / open questions

- **Analytic re-trim correctness** (K1) is the technical crux: shrinking a band extends
  supports, growing consumes them; support wires with inner loops (holes crossing near
  the band) can make the re-trim non-analytic — those must be detected and refused, not
  approximated. Budget the majority of kernel effort here.
- **Exporter variance**: some exporters emit fillet bands as NURBS even when analytic.
  BrepKit's `convert_to_elementary` can refit them, but it is documented non-atomic —
  do not run it implicitly on import; treat NURBS bands as read-only in v1.
- **False-positive blends**: a real cylindrical boss tangent to a wall passes
  `isBlendFace`. The kernel op's independent verification (D1) is the backstop: the UI
  may offer the handle, the commit will refuse, and the refusal must render cleanly
  (Phase C invalid-state path).
- **Fingerprint strictness vs. usability** (D3): too-tight tolerances make replay fail
  on benign kernel-version drift; reuse the `remove-face-feature` tolerance choices and
  the parity corpus to calibrate before inventing new numbers.
- **Entry chunk ceiling**: Phase C/D UI must stay in lazy chunks (~400 bytes eager
  slack).
- **Pin-bump coupling**: K1 regressions surface in OpenZCAD only at Phase B. Run the
  parity corpus A/B against the new wasm build during K1 review, not after the bump.

## Suggested increment order & sizing

A (M) → K1 (XL) → K2 (M) → B (M) → C (M) → E (M); D (M) floats after A.
Phase A alone ships user-visible value (box fillets become editable). A + K1 + B + C is
the minimum path to "edit the fillet on the imported walking-stick foot".
