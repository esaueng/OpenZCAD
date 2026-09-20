# F01 through-all extrusion qualification

This is the bounded design and kernel qualification for the through-all slice
of F01. It does not add an end-condition field or UI. The implementation PR
must update the F01 row in [ROADMAP.md](../../ROADMAP.md#f01) with the schema,
history, and browser evidence described here.

## Current contract and pinned capability

The current pinned pair is `remus-wasm` and `remus-wasm-io` at commit
`325c5bc3624750399171bd44a45837d58beed785`, as recorded in
`packages/kernel-adapter/package.json` and `pnpm-lock.yaml`. The adapter already
builds a profile face and calls the exact kernel sweep
(`packages/kernel-adapter/src/exact-profile-builders.ts:1685-1714`). Region
extrudes use the same path (`:706-756`). A negative span is moved to a far
plane and swept forward because the pinned kernel can otherwise create an
inside-out shell that fails a later boolean
(`packages/kernel-adapter/src/exact-profile-builders.ts:170-180`).

The persisted extrude currently stores `distance`, optional `symmetric` or
`backDistance`, the explicit `operation`, and one `targetBodyId`
(`packages/shared/src/index.ts:715-749`). `extrudeSketch` rejects a mixed
`symmetric`/`backDistance` input before changing the document
(`packages/document-core/src/index.ts:1530-1568`). Stored add/cut operations
resolve that one target at history position and refuse a missing, consumed, or
mesh target before invoking the exact boolean
(`packages/kernel-adapter/src/exact-feature-builders.ts:390-467`). These are the
contracts through-all must extend, not replace.

The qualification probe in
`packages/kernel-adapter/src/through-all-qualification.test.ts` passed against
the pinned pair. It covers a rotated and translated target, an exact finite
one-sided cut, a target straddling the sketch plane for two-sided cutting, and
a selected direction that misses the target. The probe reports a valid exact
solid after each cut and does not use a large fixed depth.

## Proposed first slice

Additive schema fields should be introduced in the F01 implementation PR:

```ts
endCondition: 'blind' | 'through-all' | 'to-face' | 'to-next' | 'offset-from-face'
throughAllSide?: 'forward' | 'backward' | 'both'
```

Absence of `endCondition` normalizes to `blind`, preserving every legacy
document byte and replaying the existing `distance`/`symmetric`/
`backDistance` path. `throughAllSide` is required for new through-all data and
defaults to `forward` only in the command constructor; a hand-written or
future-version document that omits it fails closed. Through-all must not reuse
`symmetric`: symmetric means equal user-supplied blind distances, while
through-all computes two potentially different target extents.

The first through-all implementation is deliberately limited to
`operation: 'cut'` with exactly one explicit `targetBodyId`, the same body that
the resulting cut consumes today. A missing target, more than one target, a
new-body/add operation, a mesh target, a consumed target, or a target that does
not reach the selected side is a typed refusal. There is no implicit
"all bodies" search and no operation re-inference. Multi-body through-all and
through-all add are separate slices because they need an explicit result-body
and consumption contract.

Direction is the resolved sketch-plane normal. `forward` uses `n`, `backward`
uses `-n`, and `both` uses both rays. The basis and target are resolved at the
feature's history position, after expressions and face/datum attachment
resolution; display frames and the latest current body are not inputs.

## Finite exact bound

For each selected target solid, obtain its world-space bounding box from the
exact history shape. Let `p` be the sketch-plane origin and `d` the selected
unit direction. Project all eight AABB corners:

```text
t(c) = dot(c - p, d)
forward  = max(0, max(t(c)))
backward = max(0, -min(t(c)))
```

The AABB is conservative for a transformed solid, so every target point lies
between the two support values. The resulting cutter is therefore finite and
provably spans every target point on the requested ray. It may be longer than
the body's minimal support, but it is derived from the resolved target and
contains no arbitrary large-distance constant. The two-sided tool starts at
`p - d * backward` and has length `forward + backward`; one-sided tools use the
corresponding endpoint and length. This mirrors the existing `forwardSweep`
orientation rule so negative/world-reversed directions do not publish an
inside-out shell.

If the selected ray has no positive support (`forward` or `backward` is zero),
the feature refuses with a message naming the feature, target, and selected
side. If an exact endpoint lands in a kernel coplanar-contact failure, the
first implementation must surface the typed exact-boolean refusal. It may
adopt a scale-derived `geometryTolerance` endpoint policy only after a separate
probe proves that it preserves volume, topology, and the finite-bound proof;
it must not fall back to a fixed overshoot.

The exact profile is then cut from the target through the existing typed
boolean/refusal path. The feature remains a normal replayable history entry;
the computed span is derived state and is never persisted as a substitute for
the end condition or target identity.

## Replay, edits, and undo

Every rebuild recomputes the support bounds from the target resolved at that
history position. Moving or resizing the target therefore changes the finite
tool span while preserving the stored target ID and side intent. Deleting,
suppressing, or consuming the target makes the through-all feature refuse at
that feature, with the document and prior exact projection left unchanged.
Changing a parameter that moves the sketch or target follows the same atomic
preflight path as existing extrude edits. A refused edit does not write the
new end-condition payload, target ID, or derived geometry. Undo and redo must
restore and replay the complete command payload, then recompute the bound;
they must never restore a cached arbitrary depth.

## Acceptance plan for the implementation PR

1. Add one shared additive schema normalizer and legacy fixture proving that
   absent `endCondition` replays byte-compatibly as blind. Coordinate its
   version envelope with the active schema work instead of introducing a
   competing bump.
2. Add command validation for the explicit side, cut-only/single-target
   first slice, missing target, mesh/consumed target, and no-reach cases. Check
   refusal atomicity and undo/redo.
3. Add kernel-adapter tests for forward, backward, and both-side spans; a
   translated/rotated target; a target edit that changes the derived span; and
   a deleted target. Assert exact volume, `validateSolid === 0`, closed mesh
   topology, and no approximate boolean fallback.
4. Add replay tests for both whole-profile and region-profile extrudes. The
   persisted `throughAllSide` and target identity must survive save/reopen and
   rebuild in history order.
5. Add browser coverage for explicit target selection, one-sided and both-side
   cuts, a moved target, a typed refusal, and undo restoring the prior body.
   The browser test must assert the displayed operation and target agree with
   the committed feature payload.
6. Run the focused adapter/document tests, then the required repository gates
   (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:parity-corpus`, and
   `pnpm build`) plus the relevant Playwright shard. Hosted CI remains the
   merge evidence for the full matrix.

To-face, to-next, offset-from-face, per-side draft, multi-target through-all,
and through-all add/new-body semantics remain later F01 slices. They must reuse
the same history-position resolution, exact refusal, and atomic replay
contracts established here.
