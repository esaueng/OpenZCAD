# Guided Parametric Reconstruction Plan

Status: approved plan of record (2026-08-25); Phase R0 implemented 2026-08-27;
R1 and later phases not started.
Scope decision: build the reusable guided-reconstruction **framework** now, with
the hammer holder (46 mm) as its first profile. Generality is NOT claimed until
at least two further, structurally different parts pass the same validation
contract.

This plan turns an imported, history-less body (STEP, optionally paired with a
`.shapr` evidence file) into a native, parametric feature tree — user-guided,
evidence-graded, fail-closed — while keeping the imported body as a locked
exact witness. It is the product answer to "I imported my part and typing a
parameter changes nothing."

## Why the current import cannot be parameterized

Binding is per-field expression strings (`ParamValue`,
`packages/shared/src/index.ts`), resolved at rebuild. The `imported-step`
feature has **no `ParamValue` fields**; its geometry is rebuilt by re-importing
archived STEP bytes (`buildImportedStepFeature`,
`packages/kernel-adapter/src/exact-feature-builders.ts`). Writing a parameter
into the Parameters table therefore changes nothing, by construction. The
existing auto-parameterizer (`packages/ai-contracts/src/auto-parameterize.ts`)
binds literals in native features and kernel-proven imported holes only; it
cannot express "move two walls apart symmetrically" or create sketches.

Direct-edit bindings on the imported body (coordinated push/pull) were
**measured and rejected** on the reference part: the text-bearing inner face
throws a kernel mesh-boolean work-limit error, full-body booleans trip the
candidate-pair budget, and one-sided moves break symmetric intent.

## Architecture

Hybrid exact-witness delivery:

1. The imported STEP body stays in the document as a **locked, hidden witness**
   — never deleted, never edited, never called "editable".
2. A native parametric **twin** is constructed as real document features
   (sketch / extrude / mirror / boolean / hole / fillet / text), parameters
   bound by expression.
3. Equivalence between twin and witness is proven by a coverage- and
   tolerance-based contract with **declared approximate regions** — never
   claimed byte-exact. Cross-engine NURBS (blend patches, text walls) cannot be
   surface-identical; the UI must say "proven equivalent within tolerance,
   regions X/Y approximate", never "exact".
4. A **real changed-value rebuild** is part of acceptance: the parameter must
   demonstrably move exactly the intended region before anything is applied.
5. Apply is one atomic transaction (twin features + reconstruction record +
   witness lock); undo restores the exact prior document.

Fully automatic STEP→history conversion is a NO-GO. Recognition without user
confirmation guesses exactly where this product refuses to guess. The framework
is guided: hypotheses are generated from measured evidence, graded, and
confirmed by the user before construction.

## Framework components

### Reconstruction IR (versioned, additive-only)

Separate from raw STEP entities, `.shapr` rows, the canonical document, and
viewport state. Exact `version` gate like `io-shapr`; unknown fields rejected;
SHA-256 checksums pin the IR to the exact source files (stale evidence =
refuse). Contents: analytic region inventory (surface type + params + ADR-011
fingerprint + adjacency), detected symmetries, feature hypotheses (each with
kind, regions, evidence list, confidence grade
`proven-step | supported-shapr | inferred | user-required`), semantic parameter
candidates (name, meaning, default, driven expressions, fixed dependents,
proven range), user confirmations, declared unsupported regions, and the
validation report. Stored in the document (bounded); bulk geometry stays in the
content-addressed blob store.

### Evidence sources, graded

- **STEP (required):** proves geometry — planes, axes, radii, symmetry,
  through-holes, emboss depth. Cannot prove intent (which dimension drives,
  what stays fixed).
- **`.shapr` (optional):** proves intent hints. The existing `io-shapr`
  adapter (schema 269/307000/100/249000 only) is extended to read the
  `PersistedCalls` table — executed 4×4 rigid transforms, extrusion drag
  vectors, operation parameters — as typed optional evidence. Same bounded
  ZIP/SQLite/MessagePack decoders, same privacy sanitization; unknown call
  shapes are dropped with a diagnostic, never guessed. Parasolid blobs are
  **never decoded** (licensing; also unnecessary — the STEP is the witness).
- **User confirmation (required):** the semantic gate. No confirmation → no
  reconstruction; the import behaves exactly as today.

### Profiles

A profile is a hypothesis generator + parameter schema + confirmation questions
for one part family. Profile 1 is the hammer holder (parallel-plane opening +
mirror + countersunk holes + text emboss). The IR, dialog, and validation
contract are profile-independent; only hypothesis generation and the question
set are per-profile.

### Validation contract (applies to every profile)

Context that shapes it: imported bodies may be strict-invalid (the reference
part has 24 mis-oriented shared edges), which corrupts `massProperties` and
makes kernel booleans against the source infeasible (work limits). Therefore:

- Never trust `massProperties` on a strict-invalid witness; never run
  `fixFaceOrientations` (measured: it destroys the reference model); never use
  boolean symmetric difference against the witness.
- The **reconstruction** is held to a higher bar than the source: strict
  kernel validity (0 errors), `massProperties.volume` == mesh volume within
  1e-6 relative.
- Default-value proof vs. witness: bbox exact to 1e-6 mm; analytic surface
  inventory (types + parameters) exact to 1e-6 outside declared regions;
  adjacency isomorphism outside declared regions; volume |Δ| ≤ 0.5%; center of
  mass within 0.2 mm/axis; bidirectional point-classification coverage
  (≥20 000 uniform-in-bbox + ≥20 000 near-surface probes on both solids):
  100% agreement outside declared regions, ≥99.9% overall, every disagreement
  localized and reported; holes proven by the existing imported-feature
  recognizer; STEP export→reimport strict-valid with stable counts.
- Changed-value proof: rebuild at a perturbed parameter value; assert the body
  actually changes, only the intended region moves (fingerprint-stable faces
  elsewhere), strict validity holds, dependent behavior matches the declared
  dependency graph, persistent references resolve or fail closed, STEP
  round-trip stays valid, undo/redo restores/reproduces exactly.
- Parameter range: proven by bisection-on-failure rebuilds, never assumed.
- Any stage fails → reconstruction refused, witness retained, dialog states
  exactly why. Coverage sampling is statistical, and the UI says so.

### Topology discipline

Mirror/hole/direct-edit outputs (and boolean faces on shared or split carriers) are hash-only lineage in the current
capability table (`packages/document-core` topology-lineage). A parameter
change rebuilds them fresh. Anything the user later attaches must bind to the
reconstruction's own semantic names where available, otherwise post-rebuild
hashes with fail-closed resolution. Do not promise reference survival the
lineage system cannot deliver.

## Profile 1: hammer holder (46 mm)

All geometry below was measured read-only against the authoritative files with
the pinned kernel (2026-08-25 investigation; source checksums recorded in the
IR at import time). The part: two 14 mm arms with r15 hook curls, an 8 mm
bridge, two Ø5 countersunk through-holes, embossed `esau.co` text 0.4 mm proud
of the left inner face, mirror-symmetric about X=11 except the text. The inner
upright faces sit at exactly X=−12 and X=+34.

### Confirmed semantics (decisions of 2026-08-25)

1. **`opening_width` = 46 mm is the inside dimension between the two contact
   faces that hold the hammer** — the bare inner-face spacing, as modeled. The
   embossed text locally intrudes 0.4 mm (45.6 mm over the glyphs); that
   matches the original and is intended.
2. **Holes ride with the arms**: each hole center stays 3.0 mm inboard of its
   inner face (0.5 mm wall to the Ø5 hole — matches the original at 46 mm).
   Hole spacing therefore changes with the opening; this is intended.
3. **Text is natively re-embossed** (+0.4 mm, on the left inner face, riding
   with the left arm). Glyph shaping is approximate and declared as such.
4. **Equivalence bar**: the tolerance contract above, with the 8 neck blend
   patches and 34 text wall faces declared approximate. Byte-exactness is
   explicitly not the contract.

### Feature graph and dependencies

Master side-profile sketch → extrude arm (14 mm) → mirror about center →
bridge plan sketch on Z=4.5 → extrude 8 mm → union → 2× countersunk hole
(Ø5 through, 45° csink to Ø9) → fillets (r3/r5/r14/R6/R8/R11, 45° tip
chamfer) → text emboss.

`opening_width` drives: arm inner faces at center ∓ width/2, bridge slot
width, hole centers at (inner face ± 3.0 mm inboard), text plane. Fixed:
arm thickness 14, bridge thickness 8, all radii, hole Ø/csink, overall
Y/Z envelope, text content and depth.

### Proven kernel feasibility (read-only experiments, 2026-08-25)

A native skeleton (extrude/mirror/union/holes) builds strictly valid at 46 and
50 mm, with mesh volume == exact volume, an exactly predicted +640 mm³ delta,
and a clean STEP round-trip. Point classification costs ~4.5 ms/probe. The
witness imports with 160 faces / 386 edges / 50 240.47 mm³ and one strict
error (edge orientations) that survives round-trips unchanged.

## Phases

Each phase is a separate branch and normal ready-for-review PR; one phase per
PR; do not start the next phase automatically. Never commit the proprietary
hammer files; CI fixtures are synthetic solids built with the kernel (e.g. a
generated U-bracket exercising the same hypothesis kinds).

- **Phase R0 — measurement tooling.** Productize the investigation probes as a
  test-only helper: analytic inventory, symmetry detection, parallel-plane
  spacing on an imported STEP. Acceptance: reproduces the recorded hammer
  measurements locally; synthetic fixture in CI. Also run the neck-blend
  deviation experiment (rebuild one neck via edge sweep, measure deviation vs.
  witness) — its result decides whether exact-NURBS sketch entities (R5) are
  ever worth it. **Result:** the better witness-edge ruled sweep still reached
  1.913926 mm maximum bidirectional deviation, so the neck does not justify R5.
  The test-only probes fail closed on malformed geometry or exhausted face,
  candidate, spacing, tessellation, and comparison budgets. See
  [the R0 measurement record](../qa/2026-08-27/guided-reconstruction-r0.md).
- **Phase R1 — evidence pack (`packages/io-shapr`).** Read `PersistedCalls`
  into an additive optional `executed` field on operation IR. Acceptance:
  synthetic fixtures for the observed call shapes; absent field → byte-
  identical current behavior. Version-gate call shapes like the schema tuple.
- **Phase R2 — reconstruction IR + analysis (`packages/kernel-adapter` +
  geometry worker).** Whole-body adjacency + inventory publication, symmetry
  detection, bounded hypothesis generation, the IR types. Kernel-adapter gaps
  to close: batched `classifyPoint` and a mesh-pair deviation metric (small,
  additive wrappers). No worker timeouts exist and WASM cannot be interrupted:
  hypothesis caps and sampling budgets are the only defense — enforce them.
- **Phase R3 — confirmation UX (`apps/web`).** `ReconstructionDialog`
  following `ShaprImportDialog` patterns: witness ghost + candidate overlay,
  face-pair highlight, profile questions pre-filled with the confirmed
  answers, throwaway perturbed preview via scratch sync. Playwright covers the
  refusal path. Copy review: no overstatement, ever.
- **Phase R4 — construction + validation + atomic apply.** New
  `reconstruction.apply` command (`packages/command-system`), a
  `reconstructions` document record beside `shaprImports`
  (`packages/document-core`, schema migration), cloud externalization like the
  guided import. Runs the full validation contract including the changed-value
  and range proofs. Tests: unit, parity-corpus (reconstruct → export →
  reimport), worker, persistence/offline replay, security limits, Playwright
  apply/perturb/undo/redo/export. Rollback: command unexecuted → today's
  witness-only import; undo → exact prior state.
- **Phase R5 — deferred, needs explicit authorization.** Exact-NURBS sketch
  entities for byte-exact necks/text (the R0 neck experiment did not justify
  them; a different measured use case is required); `.shapr` schema-270+
  adapters when the format moves; profiles 2+ (revolve-heavy, drafted, multi-body parts)
  to earn the generality claim.

R0–R2 are independent of each other except R2 using R0's helpers; R3 depends on
R2; R4 on R2+R3.

## Standing constraints

- Never call the reconstruction "exact"; declared-approximate regions are part
  of every report and every UI surface.
- Never decode Parasolid data.
- Legal review before public release of the `.shapr`-guided path (the existing
  note in `docs/shapr-import.md` stands).
- No new third-party dependencies anticipated for R0–R4; any exception is
  flagged prominently in its PR.
- Units and tolerances in this document are millimeters and are load-bearing;
  do not adjust them without re-deriving from measurements.
