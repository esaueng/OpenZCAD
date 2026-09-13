# Re-running the fillet probe ladder against the B23 cascade

## What shipped

Remus B23 turned fillet into one transactional cascade — the walking engine,
then a guarded rolling-ball rebuild — and dropped the v1 flat planar bevel as a
fillet fallback. Two things follow for the adapter, and both are in this branch.

1. **A size-bound fillet refusal now carries the kernel's own measured
   ceiling**, and the adapter uses it instead of walking down to it blind. The
   ceiling aims the probe ladder rather than replacing it, so the failure
   message quotes both the limit the kernel measured and a size this adapter
   actually built. On the common oversized-radius path that is **three kernel
   round-trips reduced to one**: the first rung is half the kernel's ceiling,
   which is accepted.

   Before: `Fillet could not be created on 1 selected edge with radius 30. Try
   a smaller radius.` — after three fillet calls at 15, 3.75 and 0.469.

   After: `Fillet could not be created on 1 selected edge with radius 30. Try a
   smaller radius: the kernel's blend runs off its support face at radius 18,
   and radius 9 builds here.` — after one fillet call at 9.

2. **A fillet result that is actually a chamfer is now refused.** The adapter's
   acceptance rules (handle identity, relaxed validation, the target bounds
   envelope, the neighbourhood-volume envelope) all pass on a flat planar
   bevel; only the surfaces tell the two apart. A fillet result must now gain
   at least one rolling-ball blend band over its target or it is declined.

The fillet edge retargeting from PR #311 (`resolveEdgeModifierEdges` and the
`referenceRepairs` it feeds) is untouched.

## Kernel calls adopted

No new kernel entry points. What changed is that the adapter now *reads* the
kernel's typed blend refusal instead of re-deriving its content:

| Adopted | Replacing |
| --- | --- |
| the `available radius` field of a `cliff-encountered` refusal from `kernel.fillet` / `kernel.filletWithEvolution`, parsed by `blendCliffLimit` | a blind ladder of 1/2, 1/8, 1/64 of the *refused* size, walking down until something was accepted |
| `countBlendFaces` (existing `isBlendFace` surface test) over the fillet result | nothing — there was no check that a fillet was rounded rather than bevelled |

`edgeModifierSucceedsSmaller` is renamed to `acceptedEdgeModifierProbe` and
returns the accepted size (`number | null`) instead of a boolean, because the
message now quotes it.

## Check results

Run from the worktree root on the final tree.

```
pnpm lint                 ✖ 19 problems (0 errors, 19 warnings)
pnpm typecheck            clean (no output)
pnpm test                 Test Files  241 passed | 2 skipped (243)
                          Tests  2491 passed | 4 skipped (2495)
                          Test Files  156 passed (156)          [web project]
                          Tests  1182 passed (1182)             [web project]
pnpm test:parity-corpus   Test Files  7 passed (7)
                          Tests  174 passed | 1 skipped (175)
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

**But the ceiling is not a radius to hand back.** `r17.999` builds a body whose
bounding box is `0,0,0 .. 30,35.998,35.998` against an input of
`0,0,0 .. 30,18,24` — the distorted oversized-radius result the adapter's bounds
guard already rejects. Everything from r10 up on that edge is rejected the same
way. So the kernel's ceiling is an upper bound on what *could* work, not a value
that does, and the message quotes a probed size alongside it. This is the one
place the task's "prefer the kernel's own reason" had to be qualified: the
kernel's number is relayed verbatim as a limit, never as advice.

**Every ladder rung still discriminates, so none was removed.** Same box, all
twelve edges selected — `unsupported-vertex-blend` at every size from r9 up,
with no ceiling reported, so the ladder is the only evidence available:

| refused size | 1/2 | 1/8 | 1/64 |
| --- | --- | --- | --- |
| 16 | accepted | — | — |
| 20 | refused | accepted | — |
| 100 | refused | refused | accepted |
| 600 | refused | refused | refused (structural message) |

A rung dropped here would turn a true "try a smaller radius" into a false
structural claim. What the ladder no longer has to do is *find* the ceiling:
seeded with the kernel's own, rung 1 is accepted on every cliff case measured
(box edge 18→9, plate edge 6→3, cylinder rim 9.9999999→4.999).

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

## Deliberate limits

- **The chamfer path is left alone.** `chamfer` reports its own typed size
  limit (`invalid input: chamfer setback does not fit: 20.000000 of material
  must be taken from an edge only 18.000000 long. Reduce the chamfer distance
  below 18.000000.`), which is the same opportunity, but it is a different
  refusal shape from a different builder and the task is the fillet ladder.
  A chamfer refusal still spends the full blind ladder.
- **The non-cliff message is unchanged.** A size-bound refusal with no reported
  ceiling — `unsupported-vertex-blend`, say — still says only "Try a smaller
  radius", even though the ladder now knows which size was accepted. Naming it
  there would be a strictly better message and is a small follow-up; it is out
  of this change so the message diff stays to the case the kernel measures.
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
- **`blendCliffLimit` parses a kernel sentence.** A kernel that renames its
  refusal prefix or its `available radius` field silently reverts the message to
  the old blind-ladder wording; nothing breaks, but the new sentence quietly
  stops appearing. The diagnosis test pins both the prefix and the field against
  the pin, so a kernel bump that changes either turns it red rather than
  degrading in silence.
- **Probe sizes are now rounded down to four significant digits** so that the
  size the ladder proved is also a size worth printing. This moves the deepest
  rung by a fraction of a percent (`0.1/64 = 0.0015625` becomes `0.001562`).
  Always downward, never across the kernel's ceiling.

## Follow-ups

- Relay the chamfer builder's own `setback does not fit` limit the same way and
  skip the blind ladder for chamfers.
- Name the accepted probe size in the non-cliff size-bound message too.
- `unsupported-vertex-blend` is the remaining size-bound refusal with no
  reported ceiling. If Remus grows one for it, the plumbing here takes it with
  a one-line change to `blendCliffLimit`.
