# Imported hammer opening recipe

The AI patch operation `add_imported_opening_recipe` compiles a measured opening
edit into ordinary document history. It retains the imported STEP geometry and
uses Remus exact booleans. It does not infer regions or restore the original CAD
feature tree. The existing Auto-parameterize recognizer is unchanged.

For the 46 mm hammer holder, the qualified values are **46 and 50 mm only**.
A 48 mm replay currently fails the left shifted intersection. The generated
expressions reject unsupported values before publishing a result; there is no
continuous-range support claim. The 74 mm outside width, 58 mm height and two
5 mm bores remain fixed. Those dimensions are not independently parameterized.

## Assistant proposal

After importing the holder, use its actual body ID as `targetBodyId`. The
following operations belong in a normal reviewed AI patch proposal. The explicit
regions below are measured in this source file's millimetre coordinate system;
they are not transferable to an arbitrary STEP model.

```json
[
  { "kind": "set_parameter", "name": "opening_width", "expression": "50" },
  {
    "kind": "add_imported_opening_recipe",
    "name": "Hammer opening",
    "localId": "opened",
    "targetBodyId": "<imported body ID>",
    "sourceWidth": 46,
    "editedWidth": 50,
    "width": "opening_width",
    "axis": "x",
    "regions": [
      {
        "min": { "x": -18, "y": -10, "z": 0 },
        "max": { "x": 11, "y": 43, "z": 70 }
      },
      {
        "min": { "x": 11, "y": -10, "z": 0 },
        "max": { "x": 40, "y": 43, "z": 70 }
      }
    ]
  }
]
```

Only one recipe is allowed per proposal. Its target must be an unmodified
imported source. Source/edited width fields are construction inputs, not proof
of geometric feasibility: every new source or edited width still requires exact
preflight. Do not present successful command compilation as a successful edit.

Each side keeps the body outside its region and intersects the inside with a
shifted copy of the original import, then reassembles it. This produces 16
ordinary features, with normal parameter replay, save/load, undo and redo.
`require_one_of(value, sourceWidth, editedWidth)` bounds the allowed values.
An optional Boolean `activeWhen` expression makes zero an identity of the first
operand, consuming all operands normally. This avoids coincident Boolean work
when restoring the original width. Omitted activation retains existing behavior.
These expressions and Boolean data require this application version or newer.

## Verification and remaining work

The opt-in regression uses a local source file; neither the private STEP nor the
generated project belongs in Git:

```sh
OPENZCAD_HAMMER_STEP="$HAMMER_STEP" OPENZCAD_HAMMER_WIDTH=46 \
  pnpm exec vitest run test/hammer-holder-imported.test.ts
OPENZCAD_HAMMER_STEP="$HAMMER_STEP" OPENZCAD_HAMMER_WIDTH=50 \
  OPENZCAD_HAMMER_OUTPUT=/tmp/hammer-opening-50.openzcad \
  pnpm exec vitest run test/hammer-holder-imported.test.ts
```

Both values pass strict solid validation, mesh closure, opening-wall dimensions,
fixed bounds and bore checks, STEP round-trip, backup parsing and undo/redo.
The 50 mm WASM replay takes roughly six minutes on the development machine;
interactive latency remains a limitation. The browser rebuild watchdog allows
fifteen minutes of silence because synchronous WASM operations cannot emit
heartbeats; the previous two-minute budget repeatedly killed this valid replay.
Startup and kernel-loading budgets remain unchanged. Browser assistant
interaction and production deployment are not verified by this test.

The paired Remus packages are pinned to
`9bee897f296171c09c99797b63eaa3afcd16f3f7` (2.130.20), from
[Remus #374](https://github.com/esaueng/remus/pull/374) and its prerequisite stack.
Release integration must account for that dependency. The next kernel target is
the 48 mm left shifted intersection, followed by qualifying additional widths.
General region recognition and the other independent dimensions remain future
work.

The pin also changes exact-only Boolean and fillet behavior. Overlap inference
can prove shared volume using an exact union when exact intersection is refused;
if both fail it still refuses. Dense-pattern warnings use the multiplicity bound
on pairwise overlap. The vertex-identity regression scales an ordinary exact
fillet to microscopic size because direct sub-tolerance fillet construction now
refuses; it does not claim that construction is supported.

## Browser rebuild diagnostics

The workspace status and activity log identify the current source-loading,
history feature, checkpoint or body-measurement stage. Completed stages carry
elapsed milliseconds through request-tagged worker state messages. The browser
console retains each completion under `[geometry rebuild]`, including timings
that React may batch out of the visible status log. These diagnostics remain
session-local and are not added to the document or uploaded as telemetry.

Progress is emitted only at real operation boundaries. It refreshes the worker
silence watchdog while a multi-feature build advances, but does not fabricate
heartbeats during a blocked synchronous kernel call. Observer failures cannot
alter the geometry result. A started stage without a corresponding completion
identifies where to investigate next; it does not alone prove that operation
will never finish.

Initial-render background work is bounded: automatic planar-distance trial
edits and optional mass properties run only for bodies with at most 64 faces.
Consumed history bodies do not run imported-feature recognition. Complex bodies
still receive their exact mesh, face/edge topology, volume and validation;
live complex imports retain hole recognition. They omit unproven planar-distance
suggestions and optional centre-of-mass/inertia data. This is a background-work
limit, not a claim that the kernel cannot perform those operations on demand.

The hammer trace completed all 17 construction features in 327.9 seconds, then
blocked in planar-distance trial edits during source measurement. With trial
edits bounded, source mass properties took another 35.6 seconds. Applying both
background limits reduced the full original-source adapter sync to 15.8 seconds.
The opt-in `test/hammer-holder-measurement.test.ts` covers that complete source
measurement path; the synthetic 66-face prism regression runs in ordinary CI.
