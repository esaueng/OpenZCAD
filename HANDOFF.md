# Handoff — variable-radius fillet and asymmetric chamfer (roadmap M03)

## What shipped

A fillet can now run its radius from one value at the start of each selected
edge to another at the far end, under one of two laws (**Linear**, **S-curve**),
and a chamfer can now take two different setbacks, one on each of the two faces
the edge separates. Both are optional additions to the existing Fillet and
Chamfer tools — the same edge picking, the same preview and viewport size
handle, the same editors — and both are off unless the new field is filled in.

The form gates the feature to what the kernel qualifies. Only the two laws are
offered, the law selector is disabled until an end radius is entered, and a
chamfer shows either an angle or a second distance, never both. A configuration
outside the qualified set cannot be reached through the UI at all, and one that
arrives in a stored document is refused by name.

## Kernel calls adopted

| Call | Replacing | Where |
| --- | --- | --- |
| `filletVariable(solid, json)` | nothing — `fillet` stays the constant path | `applyVariableRadiusFillet`, `exact-variable-blends.ts` |
| `chamferV2(solid, edges, d1, d2)` | nothing — `chamfer`/`chamferDistanceAngle` stay the symmetric and distance-angle paths | `applyEdgeModifier`, `exact-edge-modifiers.ts` |
| `edgeToFaceMap(solid)` | used only in tests, to pin which face each chamfer setback lands on | `exact-variable-blends.test.ts` |

Nothing was removed. A constant fillet and a symmetric chamfer take exactly the
engines they took before, including their evolution-lineage entry points.

## What the probes established (pinned kernel `4bbcd5c7`, `remus-wasm` 2.131.0)

Measured on a 20×20×10 box; all of it is now covered by tests.

**`filletVariable` request shape.** A JSON array, one object per edge:
`{"edge": u32, "law": "constant"|"linear"|"scurve", "start": f64, "end": f64,
"startSetback": f64, "endSetback": f64}`. `startRadius`/`endRadius` are accepted
as aliases for `start`/`end`. Defaults: a missing `start` reads as 1.0, and a
missing `law` auto-detects as linear when the two radii differ.

**The trap that shaped the design: an unrecognized `law` does not refuse.** It
silently produces the CONSTANT blend at the start radius — a valid solid,
`validateSolid` 0, nothing in the result saying the law was dropped. Measured
removed volume with `law:"cubic", start:1, end:3` is 2.180309, identical to
`law:"constant", start:1`. Sending an unqualified law and checking the result
afterwards therefore cannot work, so the qualified-law gate runs *before* the
call (`assertQualifiedVariableFillet`) and fails closed. There is a test that
pins the kernel's degradation, so the gate can be relaxed the day the kernel
starts refusing on its own.

**Setbacks are the unqualified N-way vertex blend.** Writing
`startSetback`/`endSetback` for one edge of a box refuses with
`unsupported-setback-corner: blend: unsupported setback corner at Id(1): 1
stripes meet (every incident selected stripe must declare a positive setback at
a 3+-way corner)`. A per-edge selection cannot promise that every stripe at a
corner is selected, so the request builder never writes a setback field.

**Radius-law volumes** (material removed from one 10 mm right-angle edge):

| request | removed | analytic ∫r²(1−π/4)dz |
| --- | --- | --- |
| `fillet` constant r=2 | 8.584073 | 8.584073 |
| `filletVariable` constant 2 | 8.719340 | 8.584073 (+1.6%) |
| `filletVariable` linear 1→3 | 9.463339 | 9.299 (+1.8%) |
| `filletVariable` scurve 1→3 | 9.790181 | 9.627 (+1.7%) |

The variable engine runs 1.5–2% heavy against the analytic integral across
every case including its own constant law, so the tests allow 3% and treat that
as the engine's known bias, not slack. Note the last row of that bias: a
`filletVariable` constant blend is **not** the same solid as a `fillet` at the
same radius. That is why "clear the end radius" had to become a real deletion
rather than "set the end radius equal to the start radius".

Refusals seen: radius ≤ 0 → `blend-failed: … radius law minimum … must be
greater than 0.0000001`; oversized radius → `invalid-input: … fillet
postcondition validation failed … wire self-intersection`; empty selection →
`invalid-input: invalid input: no edges specified for fillet`.

**`chamferV2` d1/d2 face assignment, confirmed numerically.** `d1` is the
setback measured on the **first** face of the edge's `edgeToFaceMap` pair, `d2`
on the **second**. Proved by area rather than by volume, because the removed
volume is 0.5·d1·d2·L and is identical under a swap: each adjacent face loses
exactly its own setback × the edge length. On every one of the box's 12 edges,
`chamferV2(box, [e], 1, 3)` takes 1·L off the pair's first face and 3·L off its
second, and swapping the arguments swaps the two losses while leaving the volume
unchanged.

## Check results (actual output lines)

```
pnpm lint              ✖ 19 problems (0 errors, 19 warnings)
pnpm typecheck         (clean, no output)
pnpm test              Test Files  243 passed | 2 skipped (245)
                             Tests  2505 passed | 4 skipped (2509)
                       Test Files  156 passed (156)
                             Tests  1184 passed (1184)
pnpm test:parity-corpus Test Files  7 passed (7)
                             Tests  174 passed | 1 skipped (175)
```

`pnpm build` was also run: bundle report `"warnings": [], "failures": []`.

The briefing's baseline named 1182 web tests; this branch adds 2 there
(`edgeModifierEdit.test.ts`) and 16 to the root project across two new files.
Parity is exactly the baseline 174/1 skipped. `pnpm test:e2e` was not run, per
the briefing.

## Schema changes (all additive)

`FeatureData` gains three optional fields and no constant changes:

- `fillet.endRadius?: ParamValue` — absent means the constant fillet.
- `fillet.radiusLaw?: VariableFilletLaw` — read only with `endRadius`; absent
  reads as `'linear'`. The union is `'linear' | 'scurve'`.
- `chamfer.distance2?: ParamValue` — absent means the symmetric chamfer;
  mutually exclusive with `angleDeg`.

A document that carries none of them serializes and replays byte-for-byte as
before; there is a test asserting the created feature data is deep-equal to the
pre-change object and that the new keys are absent.

`FeatureUpdateInput` gains `clearData?: readonly string[]`, validated against a
new per-kind `FEATURE_DATA_CLEARABLE_KEYS` list (`fillet: endRadius, radiusLaw`
/ `chamfer: angleDeg, distance2`). This exists because a patch cannot express a
removal — `undefined` values are skipped, which is what keeps a partial patch
from wiping fields it does not mention — and, per the measurement above, "end
radius equal to start radius" is a different solid from "no end radius".

## Deliberate limits

- **One law and one pair of radii per feature, not per edge.** The kernel's
  JSON can carry a different law per edge; the document stores one selection
  with one law, so a per-edge payload would be a shape the document cannot
  round-trip. Per-vertex radius controls in the viewport are not built.
- **No setbacks.** They are the N-way vertex blend, which the kernel refuses
  unless every stripe at a corner declares one and which is outside the
  qualified set even then. The request builder cannot emit one.
- **The chamfer form does not name the two faces.** It cannot honestly: the
  pair order is the kernel's own `edgeToFaceMap` order, and the published
  `EdgeTopology.adjacentFaceHashes` sorts it away by design. The form instead
  gives live preview plus a **Swap the two faces** button, which is how a user
  actually resolves it in one click. Naming them would need an ordered
  adjacency field on the published topology — see follow-ups.
- **The `angleDeg` 45° workaround was left alone.** `clearData` could now clear
  it properly, but changing existing chamfer edit behaviour is not this PR's
  job.
- **No variable-blend evolution lineage.** The kernel has no
  `filletVariableWithEvolution`, so a variable fillet derives lineage the same
  way an engine that reports no construction history already does (primitive
  re-derivation). The existing witness checks are untouched.
- **`auto-parameterize` does not propose the new fields.** It does not propose
  the existing `chamfer.angleDeg` either; staying consistent with that.
- **`ROADMAP.md` M03 left as `Open`.** Whether this closes the row is the
  maintainer's call.

## Risks for the reviewer

1. **The silent-degradation gate is the load-bearing claim.** If
   `assertQualifiedVariableFillet` is ever bypassed — a new call site that
   reaches `kernel.filletVariable` directly — an unqualified law becomes wrong
   geometry with no error anywhere. Everything goes through
   `applyVariableRadiusFillet`, which asserts; please keep it that way.
2. **The 3% oracle tolerance.** It is the measured bias of the variable engine
   against the analytic integral, consistent across constant/linear/scurve. It
   is wide enough that a *small* future regression in the engine would not trip
   it. The direction and bracket assertions in the same test are the tight ones.
3. **`clearData` is a new general capability on `updateFeature`.** It is
   constrained by an allow-list, but it is a contract addition, not just a
   fillet detail.
4. **The failure path for these two blends deliberately does not use
   `edgeModifierFailureMessage`.** That function's "try a smaller size" answer
   comes from a probe ladder that runs the CONSTANT engine, so on a variable
   request it would report success for a blend the user did not ask for.
   `variableBlendFailureMessage` relays the kernel's own named reason instead.
   If someone later teaches the ladder a second engine, that branch should go.

## Concurrent-work overlap (asked for explicitly)

Another agent is reconciling the fillet **probe ladder** in
`packages/kernel-adapter/src/exact-edge-modifiers.ts` on a different branch.
This branch touches that file in four places, all in the top half and all away
from the ladder:

- the import of `exact-variable-blends` (4 lines);
- two new optional trailing parameters on `applyEdgeModifier` plus their doc
  comments (~15 lines);
- one `if` branch at the top of the fillet engine selection (8 lines);
- one `if` branch at the top of the chamfer engine selection (8 lines);
- one line in the volume-envelope guard, widening the neighbourhood radius to
  `Math.max(size, variableRadius?.endRadius ?? 0)` so a variable fillet is
  bounded by its LARGER radius.

`EDGE_MODIFIER_PROBE_RATIOS`, `edgeModifierSucceedsSmaller`,
`blendSubsetRemedy` and `edgeModifierFailureMessage` are **not** modified.
If the ladder's reconciliation changes `applyEdgeModifier`'s parameter list,
the two new parameters must stay last and stay optional, and the volume-envelope
line must keep the `Math.max`.

## Follow-ups this unblocks or leaves open

- Publish the kernel's **ordered** edge-to-face pair (alongside the existing
  sorted `adjacentFaceHashes`) so the chamfer form can name the two faces and
  the viewport can highlight the one each setback lands on.
- Per-edge and per-vertex radius control, once the kernel qualifies more than
  the two monotone laws — the request builder already takes a list.
- Variable-blend evolution lineage, if a `filletVariableWithEvolution` binding
  appears.
- A drag handle at each end of the edge for the two radii, reusing the existing
  edge-drag rig, which currently drags only the start radius.
