# Re-running the fillet probe ladder against the B23 cascade

## What shipped

Remus B23 turned fillet into one transactional cascade — the walking engine,
then a guarded rolling-ball rebuild — and dropped the v1 flat planar bevel as a
fillet fallback. Two things follow for the adapter, and both are in this branch.

1. **A size-bound fillet refusal now carries the kernel's own measured
   ceiling**, and the adapter uses it to aim the probe ladder instead of
   walking down blind. The ceiling is used _only_ to aim: it is never quoted,
   because it is not a bound on what works (see the correction below). What
   the message gained is the size the ladder actually built.

   Before, on a 30x18x24 box with one edge selected at radius 30:

   ```
   Fillet could not be created on 1 selected edge with radius 30.
   Try a smaller radius.
   ```

   After:

   ```
   Fillet could not be created on 1 selected edge with radius 30.
   Try a smaller radius: radius 9 builds here.
   ```

   The saving is **real but smaller than this document first claimed**, and it
   is not uniform. Measured by instrumenting `kernel.fillet` and counting
   calls (pinned now in `edge-modifier-diagnosis.test.ts`):

   | case                         | old ladder                    | ceiling-seeded ladder |
   | ---------------------------- | ----------------------------- | --------------------- |
   | 30x18x24 box, one edge, r30  | 2 (15 refused, 3.75 accepted) | 1 (9)                 |
   | 50x50x2 plate, one edge, r30 | 3 (15, 3.75, 0.469)           | 1 (1)                 |
   | 50x50x2 plate, one edge, r60 | 3 (30, 7.5, 0.9375)           | 3 (25, 6.25, 0.7812)  |

   An earlier draft of this file claimed three old calls on the box example
   and "three round-trips reduced to one on every cliff case measured". Both
   were wrong: the old ladder short-circuits at the first accepted rung, so
   the box case was always two calls, and the plate at r60 saves nothing at
   all. The corrected numbers are above.

2. **A fillet result that is actually a chamfer is now refused.** The adapter's
   acceptance rules (handle identity, relaxed validation, the target bounds
   envelope, the neighbourhood-volume envelope) all pass on a flat planar
   bevel; only the surfaces tell the two apart. A fillet result must now gain
   at least one rolling-ball blend band over its target or it is declined.

3. **An angled chamfer is now probed at its own angle.** The ladder and the
   message took no angle, so under a `distance + angle` chamfer they proved
   and quoted the SYMMETRIC 45° chamfer. On a 30x18x24 box, one edge,
   distance 20 at 80°:

   ```
   Chamfer could not be created on 1 selected edge with distance 20.
   Try a smaller distance: distance 10 builds here.      <- refused at 80°
   ```

   Distance 10 builds symmetrically and is refused at 80°; 10 then answered
   "distance 5 builds here", and 5 answered 2.5 — the same loop item 1 set out
   to remove, on the neighbouring path, and worse than the generic "Try a
   smaller distance." this path emitted before the branch. The angle now
   reaches the ladder, so the quoted distance is proved for the operation
   asked for (1.763 in that case).

   Threading it is only half the fix. An angled chamfer takes `distance ×
tan(angle)` off its second face, so past 45° a ladder measured from the
   distance is aimed tan(angle) times too high — 28x at 88° — and comes back
   empty, and an empty ladder makes the message reach for a structural cause
   that is not there: a cylinder rim at distance 40 and 88° was told "closed
   rim edges cannot be chamfered on this body at any distance" while 0.1746
   chamfers it. `chamferLadderAim` measures the ladder from the setback
   instead, and like the kernel's cliff ceiling it only aims — every rung is
   still proved by `applyEdgeModifier` at the requested angle.

The fillet edge retargeting from PR #311 (`resolveEdgeModifierEdges` and the
`referenceRepairs` it feeds) is untouched.

## Kernel calls adopted

No new kernel entry points. What changed is that the adapter now _reads_ the
kernel's typed blend refusal instead of re-deriving its content:

| Adopted                                                                                                                                                                                     | Replacing                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the `available radius` field of a `cliff-encountered` refusal from `kernel.fillet` / `kernel.filletWithEvolution`, parsed by `blendCliffLimit`                                              | nothing — it re-aims the existing 1/2, 1/8, 1/64 ladder at the kernel's ceiling instead of at the _refused_ size. The ladder itself, and its role as the only evidence a smaller size works, are unchanged |
| `countBlendFaces` (existing `isBlendFace` surface test) over the fillet result                                                                                                              | nothing — there was no check that a fillet was rounded rather than bevelled                                                                                                                                |
| `chamferDistanceAngle` / `chamferDistanceAngleWithEvolution` on the PROBE path, and the `distance × tan(angle)` setback the kernel states in its own `chamfer setback does not fit` refusal | the probe ran the symmetric `chamfer` under an angled request, and aimed its ladder at the requested distance                                                                                              |

`edgeModifierSucceedsSmaller` is renamed to `acceptedEdgeModifierProbe` and
returns the accepted size (`number | null`) instead of a boolean, because the
message now quotes it.

## Check results

Run from the worktree root on the final tree.

```
pnpm lint                 ✖ 19 problems (0 errors, 19 warnings)
pnpm typecheck            clean (no output)
pnpm test                 Test Files  241 passed | 2 skipped (243)   [root project]
                          Tests  2496 passed | 4 skipped (2500)      [root project]
                          Test Files  156 passed (156)               [web project]
                          Tests  1182 passed (1182)                  [web project]
pnpm test:parity-corpus   Test Files  7 passed (7)
                          Tests  174 passed | 1 skipped (175)
pnpm build                "warnings": [], "failures": []  (bundle-size gate)
```

The 19 lint warnings and the parity 174/1-skipped are the `origin/main`
baseline. One unrelated flake was seen once on the first full run —
`test/auth.test.ts > consumes an email code once…` failed with
`AUTH_CODE_INVALID` under load and passed on its own and on every rerun. It
touches no code on this branch.

## What was probed on the pin, and what it showed

All numbers below are from throwaway node scripts against the installed
`remus-wasm` (`4bbcd5c7`, package 2.131.0), since deleted.

**The refusal is typed and names the limit.** A 30x18x24 box, one edge:

```
fillet(r30)  -> cliff-encountered: blend: blend cliff on face Id(0) at edge
                Id(0): requested radius 30, available radius 18
fillet(r18)  -> the same refusal (the ceiling is EXCLUSIVE)
fillet(r17.999) -> builds
```

**But the ceiling is not a radius to hand back, and it is not even a bound.**
`r17.999` builds a body whose bounding box is `0,0,0 .. 30,35.998,35.998`
against an input of `0,0,0 .. 30,18,24` — the distorted oversized-radius result
the adapter's bounds guard already rejects. Everything from r10 up on that edge
is rejected the same way.

Worse, the reported ceiling is measured against whichever support face the
cascade stopped on first, so it moves with the requested size. On a 50x50x2
plate, one edge:

```
fillet(r60) -> cliff-encountered: ... requested radius 60, available radius 50
fillet(r30) -> cliff-encountered: ... requested radius 30, available radius 2
fillet(r2)  -> refused as well; r1 is the first size that builds
```

A user told "the limit is 50" would be refused again at 40, at 20 and at 5.
So the message quotes **only the size the ladder built**, never the kernel's
number. This is where the task's "prefer the kernel's own reason" had to be
qualified: the ceiling is good enough to aim a probe, where a wrong guess
costs one rung, and not good enough to print, where a wrong guess is bad
advice.

**Every ladder rung still discriminates, so none was removed.** Same box, all
twelve edges selected — `unsupported-vertex-blend` at every size from r9 up,
with no ceiling reported, so the ladder is the only evidence available:

| refused size | 1/2      | 1/8      | 1/64                         |
| ------------ | -------- | -------- | ---------------------------- |
| 16           | accepted | —        | —                            |
| 20           | refused  | accepted | —                            |
| 100          | refused  | refused  | accepted                     |
| 600          | refused  | refused  | refused (structural message) |

A rung dropped here would turn a true "try a smaller radius" into a false
structural claim. What the ladder no longer has to do is _find_ the ceiling
from the refused size: seeded with the kernel's own, rung 1 is accepted
wherever the reported ceiling is close to the real one (box edge 18→9,
cylinder rim 9.9999999→4.999). Where it is not — the 50x50x2 plate at r60,
ceiling 50 against a real limit between 1 and 2 — the seeded ladder walks the
same three rungs the blind one did.

**Structural failures still fail everywhere.** The notched body from the
existing diagnosis test (box 30x18x24 minus an r14 cylinder, all 15 edges) gives
the same `edges-not-blended` refusal at r2, r1, r0.25, r0.03125 and r0.01 — the
ladder costs three round-trips there and learns nothing, but nothing cheaper is
sound, and the kernel names no limit.

**Blend bands separate a round from a bevel cleanly.** Counting `isBlendFace`
before and after: box all-12 fillet `0 -> 12`, box single fillet `0 -> 1`,
cylinder rim fillet `0 -> 1`, a filleted box re-filleted `1 -> 2`; box single
chamfer `0 -> 0`, box all-12 chamfer `0 -> 0`, cylinder rim chamfer `0 -> 0`.
Chamfer results are all-planar on this kernel.

**An angled chamfer is a different operation from the symmetric one, and the
difference is a factor of tan(angle).** 30x18x24 box, one edge:

| distance | symmetric (`chamfer`) | 80° (`chamferDistanceAngle`) |
| -------- | --------------------- | ---------------------------- |
| 20       | refused               | refused                      |
| 10       | **builds**            | refused (setback 56.712818)  |
| 5        | **builds**            | refused (setback 28.356409)  |
| 2.5      | builds                | builds                       |

The reported setbacks are exactly `distance · tan(80°)`, which is where
`chamferLadderAim` comes from. Aiming was then measured over every refused
angled chamfer on five bodies (30x18x24 box, 50x50x2 plate, 40x3x3 sliver,
r10 h20 cylinder, r10→r4 h20 cone), every edge of each, angles 60°, 75°, 80°,
85°, 88°, 89°, 89.5° and distances 0.5, 2, 8, 40, 100 — 1232 refusals:

```
unaimed ladder finds no size, aimed ladder does:   412
aimed ladder finds no size, unaimed ladder does:     0
aimed ladder empty while the symmetric ladder works: 0
```

The last line is why no "reduce the angle instead" branch was added: across
those 1232 refusals there was no case where the aimed ladder came back empty
and a symmetric chamfer of a laddered size would have built. Without the aim
that third number is not zero, and the message reaches a structural cause
instead — the cylinder rim at distance 40 and 88° is the case pinned in the
tests.

## Deliberate limits

- **The chamfer ladder carries the angle and an aim, but not the kernel's
  reported numbers.** An earlier draft of this file said "the chamfer path is
  left alone"; that was true of the first two commits and is no longer true.
  The probe now runs `chamferDistanceAngle` at the requested angle, and aims
  from `distance / tan(angle)`. What it still does NOT do is parse the
  kernel's own `chamfer setback does not fit: 56.712818 of material must be
taken from an edge only 24.000000 long` numbers into a ceiling. Two reasons:
  the setback the aim needs is already derivable from the angle (the same
  arithmetic, without parsing a sentence), and the refusals that most need
  aiming do not carry numbers at all — a cylinder rim at 88° refuses with
  `partial-result: chamfer produced a partial result: 0 succeeded, 1 failed`.
- **The aim does not try to be tight.** `distance / tan(angle)` is where a
  symmetric ladder would have started, not a limit; the rungs below it are
  what prove a size. On a body whose real limit is close to the requested
  distance the quoted distance can therefore be smaller than it needed to be.
  It is still a distance that builds, which is the property the message
  promises; a tighter aim would be a second ceiling to be wrong about.
- **Every size-bound message now names the size that built**, cliff-reported
  or not. Once the ceiling was out of the sentence there was no reason left to
  word the two cases differently: the probed size is proven in both.
- **No ladder rung was removed.** The evidence above says all three still
  discriminate on the pin. Removing one on the theory that it existed for the
  old bevel fallback would have made a message false, and correctness comes
  first.
- **The anti-bevel guard is a surface test, not a lineage test.** When the
  evolution payload is available its `generated` set would answer the question
  exactly; the guard deliberately does not depend on it, because the plain
  `kernel.fillet` path (used when evolution is not requested, and as the
  fallback when the payload fails to encode) has no payload to consult.

## Risks for the reviewer

- **The anti-bevel guard costs two face scans per accepted fillet.**
  `isBlendFace` is O(faces) for a cylindrical face, so the guard is O(faces²)
  in the worst case on a cylinder-heavy body. The builder already ran the same
  scan over the result when evolution was present, so this adds one scan of the
  target and one of the result on the other path. No runtime regression was
  visible in the suites (parity 16.5s, root suite 139s, both in line with the
  pre-change run), but a very large imported body is the case not covered here.
- **The guard could in principle refuse a legitimate fillet** that consumes as
  many blend bands as it creates — filleting an edge of an existing band at a
  radius that swallows it, say. Nothing in the test suites or the parity corpus
  hits it, and the kernel refuses the cases I could construct (`re-fillet` on a
  filleted box gives `trimming-failure` on most edges). If it ever fires on the
  pinned kernel, the warning text is `fillet produced no blend band: the result
is bevelled rather than rounded`, which is greppable.
- **The reported ceiling is per-face and not monotone in the requested
  size.** Proven on the plate above: 50 at r60, 2 at r30, on the same edge.
  Nothing in the adapter treats it as a bound any more — it seeds the ladder
  and nothing else — but anyone reaching for it for a slider limit or a
  clamped input should read that measurement first. It is pinned by the
  `never quotes a ceiling the kernel has not proved` test.
- **The aim assumes the kernel's angle convention.** `chamferLadderAim`
  divides by `tan(angle)` because `chamferDistanceAngle(d, a)` takes `d` off
  the first face and `d·tan(a)` off the second. That is measured, not assumed:
  the kernel's refusal reports 56.712818 for `d=10, a=80°` (10·tan80°) and
  28.575131 for `d=2.5, a=85°` (2.5·tan85°), and the adapter's existing
  `builds distance-angle chamfers with the exact bevel volume` test already
  pins the removed wedge at legs `d` and `d·tan(a)`. If a kernel bump changed
  which face the angle is measured from, the aim would point the wrong way —
  it would cost rungs, not truth, because every rung is still proved.
- **Angles approaching 90° aim very low.** At 89.9° the aim is 1/572 of the
  requested distance, and the deepest rung is 1/64 of that. Those probes stay
  above `GEOMETRY_EPSILON` for any distance a person would type, and the
  builder already refuses an angle at or past 90°, but a message on such a
  request will name a very small distance.
- **`blendCliffLimit` parses a kernel sentence.** A kernel that renames its
  refusal prefix or its `available radius` field silently reverts the ladder to
  its blind aim; nothing breaks and the message is unaffected, but the
  round-trip saving quietly stops happening. The diagnosis test pins both the prefix and the field against
  the pin, so a kernel bump that changes either turns it red rather than
  degrading in silence.
- **Probe sizes are now rounded down to four significant digits** so that the
  size the ladder proved is also a size worth printing. This moves the deepest
  rung by a fraction of a percent (`0.1/64 = 0.0015625` becomes `0.001562`).
  Always downward, never across the kernel's ceiling.

## Follow-ups

- The chamfer ladder is aimed from the angle, not from the kernel's reported
  setback. If Remus grows a typed, numeric refusal for the `partial-result`
  chamfer failures too, the same `blendCliffLimit` plumbing would take it.
- The probe ladder now has two aims (the fillet cliff ceiling and the chamfer
  setback) and one shape. If a third arrives it is worth giving the ladder an
  explicit "aim" argument rather than another optional parameter.
- `unsupported-vertex-blend` is the remaining size-bound refusal with no
  reported ceiling. If Remus grows one for it, the plumbing here takes it with
  a one-line change to `blendCliffLimit`.
