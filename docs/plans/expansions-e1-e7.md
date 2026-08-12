# OpenZCAD E1-E7 expansion plan

Status: amended plan of record. The full E1-E7 program was authorized for
execution on 2026-08-03; expansions still land as separately scoped branches.

This document records the E1-E7 feature-development program supplied on
2026-08-03. It governs these expansions when they are implemented. If an
implementation detail below has drifted, verify the current code, record the
correction, and preserve the product and architecture intent.

## Execution gate

- Work on one expansion per feature branch.
- Execute only the expansion or sub-phase explicitly selected for the branch.
- Do not start the next expansion automatically.
- The required order inside an expansion is binding. E4 starts only after E1
  and remains the last topology-dependent expansion.
- Press-pull and hash/ordinal-based face re-anchoring are not in scope.

The source brief did not select an expansion. The subsequent full-program
authorization selects E1-E7 while retaining the one-expansion-per-branch gate.

## Verified baseline corrections

The following facts were checked in the current checkout before this document
was added:

- The active workspace is `/Users/dev/codex/OpenZCAD`, not the path named
  in the source brief.
- `docs/ui-overhaul-plan-2.md` is not present.
- `apps/web/src/components/FeatureTimeline.tsx` is not present. E2 must locate
  the current feature-history UI before changing it.
- The design QA document is `design-qa.md` at the repository root, not
  `docs/design-qa.md`.
- On clean `origin/main` at `9de27d7`, typecheck and lint pass. The suite
  discovers 1,238 tests in 97 files: 1,227 pass and 11 are explicitly marked as
  expected failures. The source brief's 184-test/21-file baseline is stale.
- The current exact adapter is BrepKit-first and routes STEP documents through
  OCCT. Kernel API availability must be rechecked against the pinned
  dependencies before E1.
- Durable Object document persistence already uses `ctx.storage`, while the
  dead `JOB_QUEUE` and `OpenZCADExportWorkflow` symbols named in the source
  brief are absent. E6 and E7 must inventory current code before deleting or
  adding infrastructure.

These corrections do not relax any behavior, safety, or acceptance requirement
below.

## Architecture invariants

1. The browser `ProjectDocument` and command history are the source of truth.
   Meshes, topology projections, previews, and viewport state are derived.
2. All geometry and export byte generation run in the browser geometry worker.
   Cloudflare code may orchestrate, authorize, store metadata, and store bytes;
   it may not execute the geometry kernel.
3. AI output is a reviewed proposal. It never mutates the document, viewport,
   or kernel directly.
4. Package boundaries remain strict. In particular, viewport state must not
   enter document or kernel packages.
5. Units, coordinate systems, tolerances, defaults, file formats, and public
   API shapes may not change silently. Approximate results stay labeled.
6. Existing exact B-rep, STEP, STL, and OBJ behavior must be preserved unless
   an expansion explicitly changes it.

## Cross-cutting implementation rules

### Replay compatibility

`replayCommands` skips unknown command kinds, after which collaboration can
detect divergence. Prefer representing new document-visible state through the
existing `node.metadata.set` command when that produces a clear, typed, and
durable contract. If a new command kind is necessary, its ADR must document
old-client replay and collaboration behavior.

### Both build paths

Any per-feature build behavior must be implemented in both the exact build path
and the compatibility/legacy build path. A feature is incomplete if only one
path honors it.

### AI visibility

Every document-visible state added by an expansion must appear in
`createCadDocumentDigest` in the same increment so the assistant does not edit
blindly.

### Schema changes

Additive schema fields do not automatically require a schema-version bump, but
every schema-shape change requires an ADR. Verify normalization and migration
behavior against the current implementation before deciding that no migration
is needed.

### Transactions

A user gesture that emits several commands must use `runTransaction`, producing
one document version and one collaboration broadcast.

## E2 - Feature suppression and timeline rollback

### Scope

- Choose and document the suppression representation: a typed optional field on
  `FeatureNode`, or typed metadata carried through `node.metadata.set` for
  replay compatibility.
- Skip suppressed features in both build paths.
- Report each skip through the existing per-feature warning/diagnostic channel;
  suppression must never crash or silently corrupt a build.
- Add a per-feature suppression toggle to the current feature-history UI.
- Add a rollback marker that suppresses every feature after the marker in one
  `runTransaction` call.
- Include suppression state in the AI document digest.

### Acceptance

- Unit tests cover individual suppression, unsuppression, replay, undo/redo,
  and rollback transaction semantics.
- Kernel tests cover both build paths and visible skip diagnostics.
- One Playwright scenario covers the user-facing toggle and rollback flow.
- Add an ADR for the document representation.

## E3 - AI-created sketches

### Scope

- Add an `add_sketch` operation to the CAD patch vocabulary without weakening
  `MAX_PATCH_OPERATIONS`.
- Add a sketch-alias namespace to proposal validation. It must reject dangling
  aliases, duplicates, cross-namespace confusion, and references that are not
  valid at the point of use.
- Use pre-assigned sketch and feature IDs so a later operation in the same
  proposal can reference the newly created sketch deterministically.
- Allow a same-proposal extrude to consume the new sketch through the command
  conversion path.
- Validate profile closure before the kernel. Open profiles must be rejected as
  patch-validation errors rather than surfacing later as kernel warnings.
- Extend the AI digest with sketch plane, offset, and object geometry.

### Acceptance

- Unit tests cover valid creation, alias resolution, duplicate and dangling
  aliases, open-profile rejection, operation limits, and replay.
- Conformance tests cover create-sketch-then-extrude proposals.
- One Playwright scenario covers proposal preview and apply.

## E1 - Shell, mirror, and optional uniform offset

### Scope

- Recheck the pinned BrepKit and OCCT APIs before choosing the implementation
  seam. The historical brief cited `occt-wasm@3.6.1`; that is not sufficient
  evidence for the current BrepKit-first exact path.
- Add shell and mirror feature data, document operations, command/replay
  support, exact and compatibility build behavior, and UI forms.
- Add whole-solid uniform offset only if the pinned kernel supports it with
  deterministic success and failure behavior.
- Prefer kernel operations that return topology evolution/history when
  available so later persistent naming can use it.
- Route modeling failures into the per-feature warning path. A kernel failure
  must not terminate the worker.

### Explicit exclusions

- Do not implement per-face offset or press-pull. It requires an upstream
  kernel capability or a separately designed extrude-face-and-boolean
  construction.
- Do not add shell or mirror AI operations until deterministic kernel tests are
  green in a later increment.

### Acceptance

- Exact and compatibility tests cover happy paths and failure paths.
- Conformance tests include known-difficult thick-solid cases and assert a
  visible warning instead of a worker crash.
- User-facing forms have one Playwright scenario.
- Add an ADR for new document feature shapes.

## E5 - Partial revolve and add/cut inference

Treat E5 as two separately sized and separately reviewable sub-phases.

### E5a - Partial revolve

- Add an optional angle to revolve feature data while preserving the existing
  full-revolution default.
- Apply the angle in every relevant kernel/build path.
- Add an angle input to the current revolve UI.
- Add conformance and Playwright coverage for partial and full revolutions.

### E5b - Extrude add/cut inference

- Infer add versus cut from overlap/enclosure against live bodies and show the
  result in live preview.
- Store the resolved operation on the extrude feature. Rebuilds must never
  re-infer it.
- Define tolerance, tangency, enclosure, no-overlap, and multiple-body behavior
  before implementation. Do not use exact float equality.
- Add an ADR for the new persistent operation field and inference contract.

## E4 - Face-attached sketches

E4 starts only after E1 and after the current topology-evolution capabilities
have been evaluated.

### Scope

- Extend sketches beyond enumerated planes and offsets with a durable attachment
  representation.
- Re-anchor geometrically using centroid, normal, area, and explicitly defined
  tolerances.
- Surface a visible stale-plane warning when no unambiguous match exists.
- Evaluate kernel evolution/history data as the durable persistent-naming seam.

### Explicit exclusion

- Never re-anchor from the historical topology hash or an ordinal disguised as
  a hash. Ambiguous or stale references fail visibly.

### Acceptance

- Tests cover unchanged geometry, benign upstream edits, ambiguous matches,
  deleted faces, tolerance boundaries, replay, and cross-kernel behavior.
- One Playwright scenario covers attachment and a fail-visible stale state.
- Add an ADR for attachment and re-anchoring semantics.

### Verified implementation correction

The repository acquired schema-v5 exact topology witnesses and persistent
lineage before this expansion was closed. ADR-014 therefore uses the stronger
history-position lineage resolver instead of a centroid/normal/area proximity
matcher. The measured snapshot remains diagnostic evidence, and even a
zero-distance geometric candidate is refused when it cannot prove the selected
lineage. This removes tolerance-boundary rebinding as an acceptance category:
there is no proximity threshold that can silently choose another face.

OpenCascade is no longer a production adapter. The shared resolver remains
kernel-neutral, BrepKit exercises the production path, and the retained OCCT
reference adapter consumes the same resolver for corpus comparisons. Browser
acceptance must still demonstrate a named stale warning and recovery.

## E6 - Export and artifact pipeline

### Scope

- Keep export byte generation in the browser geometry worker.
- Reuse the current presigned upload/finalization flow to store bytes in the R2
  `ARTIFACTS` binding and metadata in `ArtifactRecord`.
- Inventory the current repository before deleting legacy jobs, queues,
  workflows, dependencies, or configuration; several historical symbols are
  already absent.
- Remove only dead orchestration after proving no live route, package, test, or
  deployment configuration depends on it.
- Document orphan handling for uploads that never finalize and objects whose
  artifact records are deleted. A provider lifecycle rule is acceptable when
  it is explicit and testable operationally.

### Acceptance

- Tests prove browser-generated bytes, upload/finalize authorization, metadata,
  download behavior, and disabled-binding errors.
- Typecheck proves removal of any legacy job surface.
- One Playwright scenario covers the user-visible export/archive flow.
- Update API documentation and write an ADR if response or storage schemas
  change.

## E7 - Durable collaboration and roles

Implement these phases in order. Do not describe a viewer role as enforced
until both REST and WebSocket authorization are complete.

### E7a - Membership and REST authorization

- Add the D1 membership model and owner/editor/viewer roles.
- Replace owner-only authorization on every REST write route with explicit role
  checks while preserving non-disclosure behavior for unauthorized resources.

### E7b - Durable Object authorization

- Enforce the same role contract inside WebSocket message handling.
- Viewers may observe allowed state but may not publish document changes.
- Reconcile with the existing `ctx.storage` persistence rather than adding a
  second state mechanism. Confirm whether any Durable Object migration is
  actually required from the current Wrangler configuration.

### E7c - Invitations

- Add high-entropy, single-use, expiring invite tokens.
- Define revocation, replay, role assignment, and project-deletion behavior.

### E7d - Locks

- Replace any process-local lock scaffolding with durable TTL-based locks and a
  heartbeat/expiry contract.
- Define disconnect, stale client, reconnect, takeover, and clock-skew behavior.

### Authentication decision

Write an ADR for the Cloudflare Access JWT trust boundary. Either verify the JWT
in the application or explicitly accept boundary verification with a concrete
deployment rationale and threat model.

### Acceptance

- Route tests cover each role on every write surface.
- WebSocket tests prove viewers cannot publish and editors cannot perform
  owner-only actions.
- Invite tests cover entropy, single use, expiry, revocation, and races.
- Lock tests cover TTL, heartbeat, disconnect, and takeover.
- One Playwright collaboration scenario covers the user-visible role behavior.

## Per-expansion delivery checklist

Before each commit and before declaring an expansion complete:

1. Re-run typecheck and the unit/integration suite; report the actual current
   counts and distinguish baseline failures from regressions.
2. Run targeted tests for the changed packages.
3. Run the complete Playwright suite for a user-facing expansion.
4. Add or update the user-facing scenario in `test/e2e/openzcad.spec.ts`.
5. Update `docs/walkthrough.md` and the repository's root `design-qa.md`.
6. Add an ADR for schema, public API, storage, or architectural changes.
7. Rebuild any committed generated artifacts affected by source changes.
8. Record working behavior, stubs, risks, brief corrections, test counts, and
   the next expansion's watch items in the final report.
