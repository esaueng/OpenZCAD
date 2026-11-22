# CAD part QA plan: long direct-edit histories on realistic parts (2026-11-22)

> **Supporting record.** [The master roadmap](../../ROADMAP.md) owns priorities,
> dependencies and delivery status. This plan extends the combination
> qualification program owned by [K10](../../ROADMAP.md#k10) (WS1 in the
> [kernel robustness plan](kernel-robustness-plan-2026-11-05.md)) from one
> follow-up edit per cell to long chains of edits on one part, and feeds the
> preview and refusal feedback work owned by [U02](../../ROADMAP.md#u02). Written
> against OpenZCAD `main` at `da87a7e6`.

## Why

A beta session recorded on 2026-11-22 edited one part through a 63-step
history: a union of a tapered cylinder and a box, blended at the junction and
along its edges, then repeatedly changed with **Offset face** (Top, Right,
Back, Bottom; −14 to +25 mm), **Resize Blend** (4 to 14.3 mm) and **Resize
Cylinder** (20 to 30 mm).

The K10 matrix checks each combination with exactly one follow-up edit. A real
session is dozens of edits on the same body, each changing the topology and
face names the next edit starts from. Failures that need that history to
appear — a face that lost its stable name, a blend resized after its neighbour
moved, a limit that depends on earlier offsets — are invisible to one-step
cells. This plan adds that layer without replacing anything that exists.

## Observations from the recording

These were read from the screen recordings and the Activity log at roughly one
frame per second. They are leads to confirm, not confirmed defects.

| ID  | Observation                                                                                                                                                                                                         | Status                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | Dragging the bottom face to −14 mm showed the moved outline, then "Checking the exact result…", then **Not built** and **Edit not applied**. The value chip kept −14 mm with a warning.                             | Capture with **Save reproduction**; record the **Why?** text. A preview that draws a result the exact check refuses is a U02 finding.                                        |
| O2  | The Activity log shows "Offset face by −18 mm" applied about a minute earlier, then undone. If −18 mm and −14 mm target the same face from the same state, a larger move succeeded where a smaller one was refused. | Unconfirmed: the model state between the two may differ. Test it as a paired authored scenario (see [Triage](#triage)); Save reproduction cannot capture the successful leg. |
| O3  | An earlier offset was refused with "The conical end would collapse at that distance. Try a smaller offset." (kernel: conical cap reaches or crosses its support apex).                                              | Correct behaviour: typed refusal, model kept. Pin it with the distance at which it starts.                                                                                   |
| O4  | Notice: "this selection has no stable name, so it may need re-picking if earlier steps change."                                                                                                                     | Stable-identity risk (WS5). Chains must show that upstream edits either keep the reference resolving or produce a typed re-pick refusal, never a wrong face.                 |

The session's Activity log also counted one error and eighteen warnings.
Exporting it with the interaction log helps reproduce O1 and O2 locally; the export is not committed (see [Privacy of captures](#privacy-of-captures)).

## What already exists

- **Direct-edit corpus** (`test/direct-edit-corpus/`): authored scenarios
  built from `@openzcad/document-core`, captured fixtures dropped from the
  app's **Export interaction log** or **Save reproduction**, and
  `pins.ts`, where every refusal must be pinned with its literal message and
  owning row. `fixtures/` currently holds only its README.
- **K10 combination matrix** (`test/support/combination-matrix.ts`): generated
  cells with independent volume oracles, replay determinism, route
  equivalence, STEP round trip, a committed ledger and opt-in shrinking
  (`K10_SHRINK=1`).
- **Parity specs** (`test/parity/direct-edit-safety.spec.ts`,
  `offset-faces.spec.ts`, `offset-face-fillet-limit.spec.ts`): refused offsets
  keep the last exact body.
- **Browser specs** for offset, blend and resize, including
  `face-offset-rest-validation`, `face-offset-total-refusal`,
  `filleted-union-face-offset`, `shoulder-cap-offset`,
  `chamfered-cylinder-offset` and `undo-history-floor`.

## Reference parts

Each part is built in code the way `authored.ts` builds its scenarios, so it
stays valid as the kernel moves. Part A's face census is also read once from
the recorded part in the app and written into the scenario as its expected
census; if the authored twin differs, the authored part is wrong. The capture
itself stays local (see [Privacy of captures](#privacy-of-captures)).

| Part | Construction                                                                                                                                  | Why                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A    | Tapered cylinder ∪ box, junction blend, all remaining edges blended. Taper built with whichever feature reproduces the recorded conical face. | The recorded part: conical, cylindrical, planar, blend and merged union faces together. |
| B    | Box with all edges filleted.                                                                                                                  | Blends meeting at corners; overlaps existing authored scenarios as a control.           |
| C    | Plate with a cylindrical boss, fillet at the boss root.                                                                                       | Offsets that push a planar face through a blend into a cylinder.                        |
| D    | Cylinder with chamfered caps.                                                                                                                 | Cap offsets bounded by a chamfer instead of a blend.                                    |

## Operations and face classes

| Operation       | Targets                                                                                     | Parameter           |
| --------------- | ------------------------------------------------------------------------------------------- | ------------------- |
| Offset face     | planar cap, cylindrical side, conical side, blend face, merged union face, a face set (M07) | signed distance, mm |
| Resize blend    | junction blend, edge blend, corner blend                                                    | radius, mm          |
| Resize cylinder | radius and height of the cylinder source                                                    | mm                  |
| History actions | undo, redo, edit an earlier step's value, delete an earlier step, reopen                    | —                   |

## Distance ladder

Limits are defined **per operation and per direction**, because the two
directions are usually different problems: moving a chamfered cap inward can
consume the remaining cylindrical wall, while the same move outward adds wall
and builds. For each part, face, operation and direction, the scenario states
a limit `L` (remaining wall or height, blend radius, distance to the cone
apex, neighbouring face it would cross) or records the direction as
unbounded. Resize commands use the same ladder on the **signed change from the
current radius or height**, not on the absolute value.

A bounded direction runs these magnitudes:

`0.1`, `1`, `L/4`, `L/2`, `L − 0.1`, `L`, `L + 0.1`, `2L`.

An unbounded direction runs `0.1`, `1`, and ¼, ½, 1 and 2 times the part's
largest dimension, and every one is expected to build.

Expected: success below the limit and a typed refusal at or past it. The
**monotonic rule**: in one direction from one state, the distances that build
form a single range starting at zero. A success at a larger magnitude after a
refusal at a smaller one is a finding (O2), unless a named topology event
explains it — for example a face merging with its neighbour — in which case
the cell is pinned with that explanation.

## Checks after every step

Reuse WS1 oracles 1–6 (typed outcome, valid solid and closed mesh, volume
oracle, replay determinism, resolving references, route equivalence), plus:

7. **A refusal changes nothing.** Volume, face census and history length are
   identical to the step before.
8. **A refusal explains itself.** It carries `kernelRefusal` and a user
   sentence; "Not built" without a reason fails, as does the generic sentence.
9. **Undo is exact.** Undo after a success restores the previous census and
   volume exactly; redo reproduces the success identically.
10. **Constant-section volume delta.** When the move only lengthens or
    shortens a prism — a planar face whose neighbours are all walls parallel
    to the move — the volume changes by that prism's cross-section × distance.
    The cross-section is not always the moved face's area: part D's
    chamfered cap translates together with its chamfer, so the change is the
    full wall section × distance (π r² × distance, not the smaller cap area).
    The formula applies only where the scenario first establishes that the
    moved end group translates rigidly — its faces keep their shape and only
    move along the offset direction. Blended ends often rebuild instead: the
    existing rounded-union push in `test/cylinder-resize-face-lineage.test.ts`
    joins the shoulder and rim rounds and rebuilds approximate corners. Such
    moves, and any that change the section, use the WS1 oracle.
11. **Preview agrees with exact** (browser layer only): after release, the
    model either matches the previewed outline within the display tolerance
    or shows a refusal. A preview of a result that is then refused is
    recorded as a U02 finding.

## Long chains

A seeded generator walks one reference part through a history, mirroring the
recorded session:

- **Steps.** Default 60. Each step picks an operation that applies to the
  current body, a face by stable selector (`resolve.ts` `faceSelector`), and a
  value: mostly inside the ladder below the limit, about one step in ten near
  or past it.
- **Interleaving.** About one step in ten is an undo, followed sometimes by a
  redo; about one in twenty edits an earlier step's value; every twentieth
  step reopens the document from its saved form.
- **Checks.** Oracles 1–10 after each step. At the end, a rebuild from the
  document alone must equal the incremental body, and a STEP export and
  reimport must keep volume and census.
- **Failures.** The test prints the seed and the step list. The chain suite
  supplies its own `shrink` through the `LedgerRunner` interface in
  `combination-matrix-suite.ts`, opted in with `K10_SHRINK=1` like the matrix.
  The matrix's `shrinkCell` cannot do this: it only simplifies matrix axes and
  drops a cell's single follow-up. The chain shrinker removes steps one at a
  time and rounds values, and keeps a simplification only when the run still
  fails **the same oracle with the same refusal category or wrong-result
  check**, so a different failure cannot replace the original while
  shrinking. The minimal history becomes an authored scenario with a pin.
- **Cadence.** A small fixed-seed slice (three seeds × 20 steps per part)
  joins the root Vitest run, with a target under two minutes; the full
  campaign (fifty seeds × 100 steps) runs on the same schedule as the WS1
  campaign and uploads its ledger as an artifact. The slice's budget is
  measured before it becomes required.

## Browser layer

Two `@ci-smoke` Playwright cases on part A, extending the existing offset
specs where they fit rather than duplicating them:

1. Drag the bottom face to a value that builds and release: the History row
   reads "Offset face · Bottom" with the distance, the top bar returns to
   Saved, and undo restores the previous model.
2. Type a value past the limit: **Not built** and **Why?** show the reason,
   Esc clears the selection, and history and the saved state are unchanged.

An untagged full-suite case loads a 63-step history of part A, checks the
History count and face census, reloads and checks them again. The history is
generated from the authored part with the recorded kinds of operation, not
committed from the user's session. Its values are synthetic; a recorded value
is reused only after the same privacy review as a capture, since a derived
fixture discloses a proprietary dimension as surely as the export would.

Preview-only findings — a preview that disagrees with the exact result, as in
O1 — belong here, because the kernel corpus never sees the preview.

## Manual pass before release

On the beta deployment, a scripted 15-minute session on part A, recorded and
followed by **Export interaction log**:

- The drag arrow points the way the sign says; positive grows the part.
- No flicker between preview and exact result; Checking always resolves to
  Saved or to a refusal.
- The warning badge count matches the Activity log.
- **Why?** text is specific and suggests a value that builds.
- **Save reproduction** produces a file the corpus accepts.
- Undo and redo across ten edits restore the part visually and in History.

## Triage

Each kind of finding has its own route. Owners: K10 for kernel refusals and
wrong results, U02 for preview and feedback, K05 for naming and re-picks.

| Finding                                                            | Route                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A refusal that should not happen, or with the wrong reason         | **Save reproduction** from the refusal's details → privacy review → drop into `test/direct-edit-corpus/fixtures/` with its stem equal to `fixture.name` → pin in `pins.ts` with the literal message and owner.                                                                                                                                                           |
| A wrong result that committed                                      | **Save reproduction** only covers refused builds, and a literal-message pin requires replay to refuse, so neither can hold it. Write an authored scenario with an `expectedVolumeAfter` oracle and a shape pin, plus a face-position or topology assertion on the face that was meant to move: a volume delta alone passes when the wrong face moves by the same amount. |
| A limit that is not monotonic (O2)                                 | A paired authored scenario: one starting document, the larger distance and the smaller distance on the same face. The pair passes only when the smaller distance builds whenever the larger one does, or when a named topology event explains the difference. The successful leg cannot be captured with Save reproduction.                                              |
| Preview disagrees with the exact result (O1); feedback and wording | A browser case (see [Browser layer](#browser-layer)).                                                                                                                                                                                                                                                                                                                    |

Captured fixtures are never edited; a capture that stops reproducing has been
repaired and its pin is retired.

### Privacy of captures

**Export interaction log** keeps project, body and feature names, command
payloads and labels, and the observed message and detail. The project
diagnostic sanitizer drops metadata and ids but not those names, so a
customer's name in a body label would reach a committed fixture even when all
geometry is native. **Save reproduction** replaces every project, part, body,
feature and sketch name with a neutral label, but its parameter names and the
geometry itself stay.

Before any capture — or any fixture derived from one — is committed, someone
reads it for private names, values
and geometry. A capture that contains any is not committed: the finding is
rebuilt as an authored scenario with synthetic names and dimensions that
reproduce the same refusal or result.

## Phases

| Phase | Scope                                                                                                                                | Exit signal                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0    | O1 through Save reproduction and the privacy review, then a pin; O2 as a paired authored scenario that confirms or retires the lead. | O1 pinned with an owner and a browser case asserting the drag no longer previews a result the exact check refuses; O2 confirmed and pinned, or retired. |
| P1    | Parts A–D as authored scenarios; the distance ladder with the monotonic rule.                                                        | Every ladder cell is success or a pinned typed refusal; part A matches the recorded census.                                                             |
| P2    | Chain generator and the PR slice in root Vitest.                                                                                     | Slice green within its measured budget; seeds reproduce.                                                                                                |
| P3    | Full chain campaign and ledger artifact; the two browser smoke cases and the 63-step reload case.                                    | Ledger committed; smoke cases tagged and passing.                                                                                                       |
| P4    | Manual pass each release.                                                                                                            | Checklist complete; every finding triaged into the corpus or a follow-up.                                                                               |

## What not to do

- No widened tolerance, weakened assertion or deleted pin to turn a cell or
  chain green.
- No random seeds in the required slice; only fixed seeds run on pull
  requests, so a failure always reproduces.
- No user projects, recordings or unreviewed captures committed. Captures
  pass the privacy review above; anything with imported geometry stays out
  unless its source is cleared.
