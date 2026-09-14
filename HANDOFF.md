# Sketch fillet, chamfer and offset on the kernel's 2D operations

Branch `claude/remus-sketch-2d-ops`. Roadmap row **S05**.

## What shipped

Three new tools in the sketch rail's **Modify** group, beside the draw and
constrain groups, arming and picking exactly like the constraint tools
(Escape cancels the pick sequence first, the status line carries the hint and
every refusal):

- **Fillet** — pick two lines that meet, enter a radius. Both lines are
  trimmed back to their tangent points and a tangent arc is inserted between
  them, in **one** undoable transaction.
- **Chamfer** — pick two lines that meet, enter a setback. Both lines are
  trimmed and a bevel line joins them, in one transaction.
- **Offset** — pick one line of a closed loop of lines, enter a distance
  (positive is outward, whichever way the loop happens to be wound). The whole
  offset loop is added in one transaction. Concave profiles (L, T, U) are in
  scope: the kernel gets the join at a reflex corner backwards, and the repair
  for that is described below.

The fillet is not loose geometry dropped in the gap. Every fillet writes five
constraints: a coincidence at each end of the arc, a **line-to-arc tangency at
that same point**, and the radius the user asked for. A driving-dimension
change on either source line therefore moves the fillet with the corner
instead of leaving it behind — proved in `edits.test.ts`. The chamfer writes
the two coincidences its bevel implies, and the offset chains its own curves
end to end.

The line-to-arc tangency needed a new constraint form. `SketchConstraintData`'s
`tangent` gained an **optional** `at?: SketchPointRef` naming the arc point the
line touches — the kernel's `tangentLineArc` is stated at a contact point,
unlike the point-free `tangentLineCircle`. The field is additive: the existing
line-to-circle form is unchanged, refuses `at`, and replays bit-identically, so
`PROJECT_DOCUMENT_SCHEMA_VERSION` is untouched at 15.

## Kernel calls adopted

| call                                         | used for                                                                                                                                | replaces                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `chamfer2d(coords, distance)`                | the sketch chamfer's setback points                                                                                                     | nothing — ZCAD had no sketch chamfer                        |
| `offsetWire2DWithJoin(wire, distance, join)` | the sketch offset, read back through `getWireEdges` / `getEdgeCurveType` / `getEdgeVertices` / `getEdgeParamSpan` / `evaluateEdgeCurve` | nothing — ZCAD had no sketch offset                         |
| `gcsAddConstraint` type `tangentLineArc`     | the fillet's tangency, via `gcs-sketch.ts`                                                                                              | nothing — line-to-arc tangency was previously unexpressible |
| `fillet2d(coords, radius)`                   | **deliberately not used** — see below                                                                                                   | —                                                           |

## What the probes actually found (pinned kernel 2.131.0)

Probed numerically against `remus_wasm_node.cjs` before any UI was built. The
throwaway scripts are gone; the findings are pinned by
`packages/kernel-adapter/src/sketch-2d-ops.test.ts`, so they cannot rot.

**`fillet2d(coords, radius)` is not a fillet, and is the one blocker here.**

- It treats the input as a **closed polygon** and rounds every corner,
  including the wrap-around one.
- Its `radius` argument is a **corner setback**, not a radius. At a 120°
  corner, `fillet2d(..., 2)` sets each leg back 2.0; a true radius-2 fillet
  sets back `2 / tan(60°) = 1.155`.
- The run it inserts is not tangent to the legs it joins and is not even a
  circular arc: it leaves the leg at a measurable angle, and its samples
  deviate from any circle through them by up to 2.1e-2 at 90° and 1.4e-1 at
  150° (radius 2).

A sketch fillet has to be tangent, because tangency is exactly what the
constraint solver is then told; building on `fillet2d` would have written a
tangency constraint that the geometry does not satisfy, and the first solve
would have torn it apart. So `filletSketchCorner` constructs the exact
inscribed arc (`setback = r / tan(θ/2)`, centre on the bisector at
`r / sin(θ/2)`) and `sketch-2d-ops.test.ts` pins `fillet2d`'s real behaviour in
two tests titled "why the kernel fillet2d is not the sketch fillet" — if a
later kernel makes it a true tangent fillet, those tests fail and the exact
construction can be retired.

**`chamfer2d` is exact, and silently clamps.** Corner `i` of the input becomes
output points `2i` (incoming edge) and `2i + 1` (outgoing edge); the setback is
equal on both legs at every corner angle. A distance larger than half of an
adjacent edge is clamped to that half **with no error** (a 2.5 chamfer on a
4-long leg comes back as 2.0). `chamferSketchCorner` witnesses the returned
setback against the requested one and refuses the clamp rather than returning
a chamfer the user did not ask for.

**`offsetWire2DWithJoin` is exact for straight-sided closed wires, and fails
open in five ways.** Join types are exactly `"intersection"`, `"arc"` and
`"chamfer"` — anything else raises. Positive is outward for a
counter-clockwise wire; `arc` gives true `CIRCLE` edges. But:

1. It offsets the wire's **vertex polygon**. A slot wire whose ends are real
   arcs offsets to a corner-rounded rectangle: the arcs are polygonised away.
2. An **open** wire (≥ 3 edges) is silently closed and offset as a loop.
3. An inward distance past the collapse point returns a zero-length wire
   (`-5` on a 10 square) or an inside-out one at the wrong distance (`-6`
   returns a valid-looking CCW 2-square whose points are 4 from the source).
4. `arc`/`chamfer` joins on an **inward** offset insert corner loops that
   cross the offset itself.
5. `arc`/`chamfer` joins are inserted at **every** vertex, and the ones at
   **reflex** vertices come back inverted. The six-line L profile
   `(0,0) (10,0) (10,4) (4,4) (4,10) (0,10)` offset outward by 1 with the
   `arc` join returns a `CIRCLE` from `(4,5)` to `(5,4)` at the notch corner
   `(4,4)`: it cuts across the notch rather than going round it, and both its
   ends lie **on** the source loop. Measured at 0.1, 0.5, 1 and 2 — every one.
   The `intersection` join returns the correct six lines for the same loop.

So `offsetSketchLoop` takes closed, straight-sided loops only (the app refuses
anything else by name), normalises the wire counter-clockwise so "positive is
outward" is true whatever the user drew, forces `intersection` on inward
offsets, and witnesses the result: signed area must have moved the right way,
and **no returned point may be nearer the source loop than the offset
distance**. That last witness is what catches case 3 — the area check alone
does not.

Case 5 is repaired rather than refused, because the repair is exact. An
inverted join is the only curve of a correct offset every one of whose points
can be nearer the source than the distance — a legitimate `chamfer` join at a
convex corner has its midpoint inside the distance but both ends on it, and a
legitimate offset line lies at or beyond the distance everywhere — so
"every sample inside" identifies exactly those elements and never a good one.
Each is dropped and its two neighbouring offset lines, **the kernel's own**,
are extended to where they meet. That miter is what the kernel itself returns
for the same corner under the `intersection` join, so no geometry is invented
and convex corners keep their arcs. Anything the repair cannot express — two
inverted elements adjacent, a non-line neighbour, parallel neighbours, or a
miter that consumes a whole offset line — refuses by name rather than guessing,
and the witnesses then run unchanged on the repaired loop.

This was a defect in the first cut of this branch, found by review rather than
by the gates: no test covered a concave loop, so an Offset tool that refused
every L, T and U profile at every distance passed all four gates.

**`tangentLineArc` exists in the GCS** and takes `{line, arc, point}`. A probe
built a filleted right-angle corner with two coincidences, two
`tangentLineArc`s and a radius, then drove one leg's length from 8 to 5 and to
12: converged every time, with the arc still radius 2, still tangent, still
meeting both legs. That is the behaviour the UI is built on.

## The entry-chunk budget, and the three dialogs that paid for it

Wiring three tools into `App.tsx` costs about 1.7 KB of entry chunk, and the
machine, the worker hook and the document validation cost another 1.2 KB.
Measured on this branch:

| build                         | `assets/index-*.js` | budget            |
| ----------------------------- | ------------------- | ----------------- |
| `origin/main`                 | 510,304             | 512,000           |
| this branch, before the split | 513,265             | **over by 1,265** |
| this branch                   | **510,066**         | 1,934 spare       |

All the logic already loads lazily — `lib/sketch/edits.ts` is reached from
`App.tsx` only through `await import(...)`, and statically only from the
already-lazy `SketchToolRail` — so what is left is irreducible wiring: the
reducer cases, the pick routing, the keypad, the worker request.

`scripts/report-bundle-sizes.mjs` says of its own budget that "the next raise
should come with an actual split of the entry chunk, not another bump", so
this branch does the split rather than the bump: `ResumeSessionDialog`,
`SaveRevisionDialog` and `ProjectConflictDialog` now load on the gesture that
opens them, the same treatment the sharing and export dialogs already had.
Three modal dialogs nobody sees in an ordinary session, ~3.2 KB, and the entry
chunk ends up smaller than it started. It is a second concern in one branch,
so it is a commit of its own.

## Check results

Run from the worktree root.

```
pnpm lint                 ✖ 19 problems (0 errors, 19 warnings)
                          [baseline: 0 errors / 19 warnings]
pnpm typecheck            clean, no output
pnpm test                 root:  Test Files 242 passed | 2 skipped (244)
                                 Tests 2514 passed | 4 skipped (2518)
                          web:   Test Files 157 passed (157)
                                 Tests 1210 passed (1210)
                          [baseline root: 241 files / 2489 passed + 2 skipped;
                           baseline web: 156 files / 1182 tests]
pnpm test:parity-corpus   Test Files 7 passed (7)
                          Tests 174 passed | 1 skipped (175)
                          [baseline: 174 passed, 1 skipped]
pnpm build                "warnings": [], "failures": []
                          entry chunk 510,066 bytes against a 512,000 budget
```

`pnpm test:e2e` was not run (out of scope per the briefing), so the tools have
no Playwright coverage — see Follow-ups.

## Deliberate limits

- **Fillet and chamfer take two lines only.** Arcs are refused by name
  ("Fillet between an arc and another entity is not available yet. Pick two
  lines."), distinctly from the composite refusal. A line-to-arc fillet is a
  closed-form but branch-heavy construction (up to four candidate centres) and
  a line-to-arc chamfer has no kernel call behind it at all — `chamfer2d` is
  polygonal. Shipping a guessy branch selection would have been worse than
  refusing.
- **Offset takes closed, straight-sided loops only**, for the kernel reasons
  above. An arc anywhere in the loop, an open run, or a branching junction is
  refused with its own sentence. Concave loops **are** in scope — they were
  not in the first cut of this branch, and the limit was stated here as
  "closed, straight-sided loops only" when the effective limit was also
  _convex_; that was wrong and is fixed, not reworded.
- **An outward offset that closes one of the profile's inside corners is
  refused**, by name: "That offset is too large for one of the loop's inside
  corners. Use a smaller distance." A U profile with a 6-wide slot offsets
  outward up to 2.9 and refuses from 3; a plus profile with 4-wide notches
  offsets up to 3.5 and refuses from 4. The offset is geometrically
  well defined past that point — the notch simply fills in and the two offset
  lines either side of it vanish — so this is a real false negative, not a
  kernel limit. Expressing it needs the offset loop to be re-walked and
  self-intersections removed, which is a larger job than this row. The remedy
  the message names does work: a smaller distance always succeeds.
- **Composite objects are refused by name for every tool** — rectangle,
  polygon and text have no stable constrainable point identity (roadmap row
  S04). The message says so and says what to do instead.
- **Trim and extend are not here.** `polygonBoolean2d` does not give them
  cleanly: it is an area boolean on closed polygons, and trim/extend are
  curve-curve intersection plus partial-curve deletion on open geometry, with
  the user's click choosing which piece survives. Nothing in the polygon
  boolean answers "which side of the intersection did they click". Left out.
- **No automatic solve after a modify.** The geometry the tools commit already
  satisfies every constraint they write, so there is nothing to solve; this
  also matches the existing constraint tools, which say "Solve applies it".

## Risks for the reviewer

- `SketchCornerResolution` carries `aPoint`/`bPoint` alongside the three
  points the kernel op needs, and is passed straight into
  `geometry.sketchPlanarOperation`. The extra fields are inert, but they do
  cross the worker boundary.
- The offset witness "no point nearer the source than the distance" is a
  necessary condition for a true offset, not a sufficient one. It catches
  every failure mode I could produce from the pinned kernel; a differently
  pathological result could in principle pass it.
- It also has **false positives**, and that is what bit this branch: the
  witness is a _curve_ test applied to a kernel result that contains elements
  the kernel got wrong, and it correctly rejected them while giving the user a
  remedy ("use a smaller distance") that did not exist. The reflex-join repair
  fixes the case that was found; the general lesson — a witness that refuses
  must be checked against a case it ought to accept, not only against cases it
  ought to reject — applies to the rest of this module too.
- The repair keys on "every sample of the curve lies inside the distance". The
  argument that this can only be an inverted join holds for the straight-sided
  loops this tool accepts, and the convex-corner `chamfer` join (midpoint
  inside, ends on the distance) is the near miss it has to survive — there is a
  test for exactly that. Five samples per curve is enough for a line or a
  circular arc; it would not be for a general curve, and `readOffsetWire`
  refuses anything but `LINE` and `CIRCLE`.
- The miter is taken from the kernel's original lines rather than from the
  running result, so a line mitered at both ends (a slot wall, for instance)
  gives the same answer in either order. That is deliberate and load-bearing;
  the U-profile test is what covers it.
- `resolveSketchLoop` chains by endpoint proximity with a 1e-6 tolerance and
  refuses a junction where more than two lines meet. A sketch with two loops
  sharing a vertex is refused rather than disambiguated.
- The fillet writes a `radius` driving constraint. On an already
  fully-constrained sketch that is one more equation, so such a sketch will
  report redundant on the next solve. Real CAD does the same thing, but it is
  a judgement call worth confirming.
- The three newly lazy dialogs are the one part of this branch that is not the
  feature. Each renders behind `Suspense fallback={null}`, so the first time a
  session hits a resume offer, a named checkpoint or a save conflict there is
  now a chunk fetch before the dialog appears. That is the same trade the
  sharing and export dialogs already make, but it is worth a look.
- The entry chunk has 1,934 spare bytes after this branch, against 1,696
  before it. The gate is still tight enough that the next App-level feature
  will hit it.

## Follow-ups

- **A real entry-chunk split.** Three dialogs bought this branch its room;
  the chunk is still 99.6% of budget, so the next feature pays again.
- **Playwright coverage for the three tools** — the pick → keypad → commit
  path is only covered by unit tests here.
- **Line-to-arc and arc-to-arc fillets**, once someone decides how the branch
  is chosen from the pick points.
- **Trim / extend** as their own row; they need curve-curve intersection, not
  a polygon boolean.
- **An outward offset larger than an inside corner can carry.** Refused today
  (see Deliberate limits). Doing it properly means walking the offset loop,
  finding its self-intersections and dropping the pieces that fall inside —
  the standard offset-loop cleanup — which the kernel's wire offset does not
  do for us.
- **Composite explode (S04)** would let the tools work on rectangles and
  polygons, which is the refusal users will hit most.
- If a future kernel makes `fillet2d` tangent and radius-parameterised, the
  two pinning tests in `sketch-2d-ops.test.ts` will fail, and the exact
  construction in `filletSketchCorner` can be replaced by the kernel call.
