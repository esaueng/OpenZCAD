# Direct-edit reliability plan

**Status: Phase A in progress (2026-09-01).** Phase A ships the measurement
instruments — a local interaction diagnostics log and a replayable refusal
corpus — before any behaviour changes. Later phases are gated on what those
instruments record.

Goal: make direct manipulation — drag a face to offset it, drag an edge to
fillet or chamfer, resize a cylinder — succeed on the geometry people actually
build, and make the cases that still cannot succeed refuse *before* the drag,
in plain language, with a way out. "Feels janky" and "often errors" are the
two complaints; this plan treats the errors as the first problem because the
2026-08-12 interaction-feel work already covered most of the motion side and
its open rows are listed at the end.

## What the offset path does today

Verified against source on `main` at `7bfd3b00`.

1. **Arming.** `selectionCapabilities`
   (`apps/web/src/lib/interaction/capabilities.ts:134`) offers *Offset Face*
   for every planar face with a hash — it does not consider whether the face
   has a schema-v5 lineage reference, nor what borders it.
2. **Drag.** The viewport rig tracks the pointer and hands every applied
   value to `LivePreview`, which keeps one rebuild in flight and drops the
   values the hand has moved past. (Until B4 landed it published at most every
   150 ms and stopped for the rest of the gesture after one rebuild slower than
   400 ms, leaving the handle moving and the geometry frozen with the chip
   reading `paused`.)
3. **Plan.** `buildOffsetEditPlan` (`App.tsx:10751`) turns a cap drag on a
   primitive cylinder into a parametric height edit; every other planar face
   becomes a generic `offset-face` direct edit carrying `sourceArea`,
   `sourceCenter`, `sourceNormal`, and the face hash.
4. **Kernel.** `applyDirectEdit`
   (`packages/kernel-adapter/src/exact-direct-edit-ops.ts:1013`) re-resolves
   the face, pins its area to 1e-5 relative when the face is hash-resolved
   (`:1080`), then calls `pushPullFace` with one analytic special case for
   cylinder caps (`:1108`). There is no other construction. The result must
   pass `validateSolidRelaxed` and the faceted-fallback census
   (`boolean-result-validation.ts:323`).
5. **Verdict.** `useDirectEditCommit` (`apps/web/src/hooks/useDirectEditCommit.ts`)
   rebuilds the candidate document, and `directEditRejection` /
   `validatedFeatureRejection` (`lib/directEdit.ts`, `lib/featureValidation.ts`)
   turn a build-failed or refusal warning, a missing body, or a moved
   document into a refusal. The interaction machine enters `phase: 'failed'`
   and the message lands on the handle chip and the status bar.

Every refusal a user sees is therefore one of four classes:

| Class | Where it originates | What the user sees |
| --- | --- | --- |
| **K — kernel refusal.** `pushPullFace` cannot do it: faces bordered by fillets/chamfers, cylindrical neighbours, negative offsets on caps ([kernel roadmap S1.3](../kernel-roadmap-remus.md)), faces on boolean results. Every existing `offset-face` test builds on a bare box or cylinder; none offsets a face bordered by a blend or on a boolean result. | `exact-direct-edit-ops.ts:1110-1125` | "does not produce a valid solid", "faceted approximation instead of exact surfaces" |
| **L — lineage brittleness.** A hash-only `offset-face` must re-measure the same area on every replay. 11 of 18 lineage classes are hash-only (`topology-lineage.ts:82`), so any face downstream of a boolean, pattern, shell, chamfer, or direct edit breaks on the next upstream edit. Nothing warns before the drag. | `exact-direct-edit-ops.ts:1080` | "no longer matches its recorded measurements", or the edit silently drops out of replay (`test/direct-edit-face-repair.test.ts`) |
| **P — preview/commit mismatch.** Preview degraded or failed mid-gesture; commit rebuilds again and can be refused with `documentMoved` although the preview looked fine. | `lib/livePreview.ts:129`, `useDirectEditCommit.ts` | frozen ghost, `paused` chip, then a refusal on release |
| **U — presentation.** 273 `setStatus` sites; refusal text is kernel vocabulary; no action offered. | `App.tsx` | a red sentence with nothing to do about it |

The plan does not yet know the proportions. That is what Phase A measures.

### First corpus run (2026-09-01, Remus a36bdda)

The authored scenarios were expected to refuse. None did — and the volumes
say why that is not good news:

| Scenario | Offset | Volume before → after | Δ observed | Δ oracle (part rebuilt with the dimension changed) |
| --- | ---: | --- | ---: | ---: |
| box top, control | +5 | 9600 → 11600 | 2000 | 2000 |
| box, all edges filleted r 1.5, top | +5 | 9461.12 → 10756.12 | 1295.0 | 1990.31 |
| box, all edges chamfered 1.5, top | +5 | 9285 → 10580 | 1295 | 1977.5 |
| box filleted, top | −3 | 9461.12 → 8684.12 | −777 | −1194.13 |
| cylinder r 10 h 30, +z cap | −5 | 9424.78 → 7853.98 | −1570.80 | −1570.80 |
| union of two boxes, top of B | +5 | 16800 → 18800 | 2000 | 2000 |

On the blended plates the change is exactly the trimmed face area
(37 × 7 = 259 mm²) times the offset: `pushPullFace` extrudes the face's own
outline as a prism and leaves the blend rim standing, so "raise the top" comes
back as a boss with a 1.5 mm ledge around it — or, inward, a pocket. This is a
fifth class:

| Class | Where it originates | What the user sees |
| --- | --- | --- |
| **S — silent shape change.** The kernel commits a valid solid that is not the one the gesture meant. Blend- and chamfer-adjacent face offsets are the measured case; no refusal, no warning. | `exact-direct-edit-ops.ts:1108` (`pushPullFace`) | a ledge or step where the face was supposed to move |

Consequences for the plan: an outcome-only corpus cannot see class S, so the
authored scenarios carry a **volume oracle** — the same part rebuilt with its
dimension changed by the offset — and a shape pin records the observed delta
until the kernel or the B1 fallback moves the blends with the face. Two more
observations from the run: fillet, chamfer, and boolean-result faces publish no
v5 reference (recorded `hash-only`), and the replay-after-upstream-edit check
passes only because widening operand A does not re-fingerprint B's cap; the
genuinely brittle variant is already pinned in
`test/direct-edit-face-repair.test.ts`.

All three shape pins from this run were retired the same day by B1: the
blended-plate rows now match their oracle exactly because the corpus routes an
`offset-face` replay through `planFaceOffset`, the same planner the app uses,
and a face that resolves back to a box or cylinder primitive edits that
primitive's dimension instead.

## Phase A — Measure (this PR)

### A1. Interaction diagnostics log

`apps/web/src/lib/interactionDiagnostics.ts` records every direct-edit
attempt outcome as a `DirectEditFixture`
(`apps/web/src/lib/directEditFixture.ts`): the sanitized pre-edit document,
the pick (surface type, normal, vertex-mean centre, area, whether the pick
carried a lineage reference), the op and value, the outcome
(`committed` / `refused` / `preview-failed` / `preview-degraded`), the message
and kernel detail, the producing feature kind, the upstream feature kinds,
and timings.

- Storage is a ring buffer in its own IndexedDB database
  (`openzcad-interaction-diagnostics`), bounded to 40 entries and 8 MiB. It
  never leaves the device; **File → Export interaction log** downloads it as
  one JSON bundle. Documents with imported geometry are recorded without the
  document (`documentOmitted: 'imported-source'`), the same rule the existing
  diagnostic export applies.
- Recording is fire-and-forget and never throws into the gesture; a storage
  failure resolves `false` and modeling continues.
- Wired at the chokepoints, not per gesture: `useDirectEditCommit`'s
  `onValidationFailed` / `onCommitted`, `reportOffsetPreviewFailure`, and
  the live-preview `onDegrade`. The pre-edit document and the interaction
  state are snapshotted at `onValidationStart`, because `commit-complete`
  resets the machine before the success callback reads it.

### A2. Refusal corpus

`test/direct-edit-corpus/` replays fixtures against the exact kernel:

- `fixtures/*.json` — drops from the export above, one fixture per file.
- `authored.ts` — TypeScript scenarios for the failure classes already known:
  control box, blend-adjacent offsets (fillet and chamfer, outward and inward
  past the blend), cylinder cap offsets in both signs, an offset on a
  boolean result, and the same offset after an upstream width change.
- `pins.ts` — every currently refused fixture with its literal message and
  the item that owns closing it. Pins assert both ways, exactly like the
  parity corpus: an unpinned refusal fails, and a pinned fixture that now
  commits fails too, so a fix retires its pin in the same change.
- Faces are re-resolved by surface type, normal, and nearest centre — never
  by hash, because a stale hash is one of the things being measured.

### A3. Acceptance for Phase A

- One week of ordinary modeling on the hosted beta with the log on, then an
  export. The export's `summary.byOutcome` and per-class counts become the
  baseline row of the table above.
- Every distinct refusal in the export becomes a fixture. Fixtures that
  reproduce are pinned; fixtures that do not reproduce are recorded as
  `P`-class candidates (preview/commit races) in this document.
- A 30-minute screen recording of the same session, annotated with the
  timestamp of every stumble, kept outside the repository.

## Phase B — Fix by class

Ordered by expected leverage; each item retires pins and states which.

- **B1. Parametric routing for `offset-face` (class S). Landed 2026-09-01.**
  Specified as a prismatic fallback in the kernel adapter: when `pushPullFace`
  is refused, build the tool from the face's own loops and fuse or cut. The
  measurement says that is the wrong fix. `pushPullFace` is not refused on a
  blended box — it commits, and what it commits already *is* that prism, over
  the trimmed face outline, with the blend rim left standing. The gap is
  semantic, not a missing construction: nothing about the face alone says
  whether "raise the top" means move this surface or make the block thicker.
  Only history knows.

  So B1 landed as routing, in three pieces:

  - `rederiveBoxModifierLineage` in the kernel adapter republishes
    `modifier.box.face.<axis>-<min|max>` for the six axis-aligned sides a
    filleted or chamfered box keeps, the box counterpart of the cylinder
    modifier roles. Before this those faces carried no reference at all.
  - `primitiveBoxFaceAncestor` resolves such a face back to the box primitive
    it descends from, walking only an uninterrupted fillet/chamfer chain and
    proving identity by role rather than geometry, exactly as
    `primitiveCylinderHeightAncestor` does.
  - `planFaceOffset` turns a picked face plus an offset into either a
    primitive dimension edit or the generic push/pull, and is shared by
    `App.tsx` and the corpus replay, so a fixture measures the gesture the
    product performs rather than a corpus-local guess.

  Covers: the max sides of a box primitive, through fillet and chamfer
  chains, plus the cylinder top cap that already routed this way. Does not
  cover: min sides (the box grows from its minimum corner, so moving one
  would have to move the body too), and faces on boolean, imported, or
  otherwise unresolvable bodies. Those keep the local push/pull, with the
  prism semantics intact, and closing *that* class is the kernel M6
  tangent-propagation ask, not an app-side fallback. Kernel dependencies:
  none. Retired all three class-S shape pins
  (`box-all-edges-filleted-top-offset`,
  `box-all-edges-chamfered-top-offset`,
  `box-filleted-top-offset-inward-past-blend`); each now matches its volume
  oracle. Tests: `test/box-face-dimension-drag.test.ts`,
  `test/box-modifier-lineage.test.ts`.
- **B2. Upstream the residual kernel cases (class K).** Every fixture still
  refused after B1 becomes a reproduction bundle in `esaueng/remus`, one per
  session, per the kernel roadmap's S1 playbook — starting with the negative
  cap offset (S1.3).
- **B3. Brittleness before the drag (class L).** *Landed in part (2026-09-01):*
  the region extrude path — the one every UI extrude takes — now names its
  side walls after the sketch segments that drew them (`sweep.face.side.
  region.<token>.<objectId>.<segment>`), so a sketch on the wall of a
  drag-extruded plate attaches associatively and survives a resize of the
  source rectangle (`test/region-extrude-lineage.test.ts`). A wall drawn by
  two pieces of one segment, a bezier wall, and every face of an add/cut
  result stay hash-only. For those, *Sketch* is no longer refused: the sketch
  lands on a fixed frame coincident with the face and the tool card, the
  status line and the capability note all say so
  (`UNSTABLE_FACE_SKETCH_REASON`). *Still open:* surface the same fact on
  the offset handle as a hint, prefer lineage references over the area pin
  wherever a reference exists, and record a repair path for hash-only edits
  the way `staleDirectEditFaceRepair` does. The full fix for boolean and
  add/cut faces is the lineage bridge (kernel roadmap C1).
- **B4. Preview continuity (class P).** *Landed in part:* offset and edge
  drags no longer wait on a 150 ms cadence — every applied value reaches the
  previewer, which keeps one rebuild in flight and drops superseded values;
  offset keeps previewing after a slow frame (`continueAfterSlow`), and the
  chip's `deferred` state now means "the hand is ahead of the published
  geometry" (`LivePreview.lagging`) rather than "stopped". A region extrude
  streams an exact preview whose add/cut follows the drag direction, and its
  rig sweeps the profile every frame so the volume tracks the hand between
  kernel results. *Closed 2026-09-02:* releasing the handle at the value the
  last passing preview showed commits that preview's own command with its
  own rebuild (`useDirectEditCommit.run(..., precomputed)`), reused only
  while the document is still the project and version the preview measured —
  so a preview that passed is never followed by a second wait, or a
  `documentMoved` refusal, for the same value. A fresh plan would carry new
  feature ids and could neither hit the worker cache nor be reused. *Still
  open:* a swept proxy for the offset face between exact frames (the region
  rig has one; offset needs face boundary loops).
- **B5. One refusal surface (class U).** *Landed in part (2026-09-02):* a
  value refused while the hand is moving no longer snaps the shape back to
  the pre-drag state — the last exact preview that built stays on screen,
  the handle keeps tracking, the chip and the rig turn to their warning
  state (edge rigs included), and the tool card carries the one sentence; the
  status line no longer echoes it. Blend previews are now judged the way
  offsets are (`build-failed` on the previewed feature, or its result body
  missing), so an oversize fillet reads "Try a smaller radius" at the handle
  instead of silently dropping the blend. The first value that builds again
  recovers the gesture in place. This is spec S2 of the reference-CAD
  interaction document. *Still open:* an action on the card — open the named
  feature, undo, or retry at the last accepted value — beyond the existing
  `Edit <Feature>`; and rewriting the kernel-adapter refusal strings that
  reach users so none mention censuses, facets, or handles.

## Phase C — Feel

Gated on the interaction probe, not on opinion. The 2026-08-12 plan's open
rows, in the order they should land:

1. Extrude drag off workspace state (needs an imperative extrude preview).
2. Cylinder-radius Inspector throttle.
3. Hover dwell before re-committing preselection.
4. Precomputed move-snap candidates.
5. BVH or prefilter for picking, only if headed numbers justify it.

Structural prerequisite, tracked here because every Phase C row is cheaper
after it: extract gesture controllers out of `App.tsx` (14,100 lines, 243
hooks in one component) and `ModelViewer.tsx` (8,451 lines) into the
`lib/interaction/` machine so a drag re-renders a controller rather than the
workspace. The 22 `react-hooks/exhaustive-deps` warnings on `main` all live
in those two files; the extraction should land with `--max-warnings 0`.

## Metrics

- **Refusal rate per op** = refused ÷ (refused + committed) from the
  diagnostics export, per `edit.op` and per lineage class. Baseline in
  Phase A; each Phase B item states the classes it moves.
- **Corpus status**: pinned ÷ total fixtures, trending to zero pins.
- **Interaction probe**: frame p95 and React commits per gesture
  (`docs/performance-baseline.md`), unchanged or better after every phase.

## Risks and open questions

- B1 changes what a drag on a routed face *records*: a dimension edit on the
  primitive rather than a direct-edit feature in history. That is the point,
  but it means the same gesture writes different history depending on
  lineage, and a face that stops resolving silently reverts to the push/pull
  semantics. The corpus route column and the ancestry tests are the guard.
- The log records documents; a document with a large native sketch-text
  history can approach the byte cap and evict earlier refusals. Acceptable for
  a bounded local buffer, but the export should say how many entries were
  evicted (not in v1).
- Class P is hard to reproduce from a fixture because it depends on timing.
  If the export shows many `preview-failed` entries whose fixtures commit
  cleanly in the corpus, that is the evidence for B4, not a corpus defect.

## Out of scope

- Nearest-face or traversal-order rebinding as a substitute for lineage
  (ADR-013). B3 makes brittleness visible; it does not guess.
- Changing the stored `offset-face` operation shape or the area-pin
  tolerance. Both are replay contracts for existing documents.
- Assemblies, drawings, or sketch-constraint UX — tracked in
  [cad-feature-roadmap.md](../cad-feature-roadmap.md).
