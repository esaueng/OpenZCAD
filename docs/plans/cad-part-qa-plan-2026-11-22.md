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

| ID  | Observation                                                                                                                                                                                                         | Status                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| O1  | Dragging the bottom face to −14 mm showed the moved outline, then "Checking the exact result…", then **Not built** and **Edit not applied**. The value chip kept −14 mm with a warning.                             | Capture with **Save reproduction**; record the **Why?** text. A preview that draws a result the exact check refuses is a U02 finding.                        |
| O2  | The Activity log shows "Offset face by −18 mm" applied about a minute earlier, then undone. If −18 mm and −14 mm target the same face from the same state, a larger move succeeded where a smaller one was refused. | Unconfirmed: the model state between the two may differ. The distance ladder below tests this property directly.                                             |
| O3  | An earlier offset was refused with "The conical end would collapse at that distance. Try a smaller offset." (kernel: conical cap reaches or crosses its support apex).                                              | Correct behaviour: typed refusal, model kept. Pin it with the distance at which it starts.                                                                   |
| O4  | Notice: "this selection has no stable name, so it may need re-picking if earlier steps change."                                                                                                                     | Stable-identity risk (WS5). Chains must show that upstream edits either keep the reference resolving or produce a typed re-pick refusal, never a wrong face. |

The session's Activity log also counted one error and eighteen warnings.
Exporting it with the interaction log is part of capturing O1 and O2.

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
stays valid as the kernel moves. Part A is also captured once from the app
with **Export interaction log**, and the authored twin must match its face
census; if they differ, the authored part is wrong.

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

For every part, face and operation, run both signs at these magnitudes, where
`L` is the geometric limit computed for that face (cylinder height, blend
radius, distance to the cone apex, wall thickness):

`0.1`, `1`, `L/4`, `L/2`, `L − 0.1`, `L`, `L + 0.1`, `2L`.

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
10. **Planar volume delta.** Offsetting a planar face with no adjacent blend
    changes the volume by face area × distance; other faces use the WS1
    oracle.
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
- **Failures.** The test prints the seed and the step list. Shrinking reuses
  the K10 path (drop steps, round values) and the minimal history becomes an
  authored scenario with a pin.
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

An untagged full-suite case loads the captured 63-step fixture, checks the
History count and face census, reloads and checks them again.

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

Every finding goes the same way: **Save reproduction** → drop the file into
`test/direct-edit-corpus/fixtures/` with its stem equal to `fixture.name` →
add a pin in `pins.ts` with the literal message and its owner: K10 for kernel
refusals and wrong results, U02 for preview and feedback, K05 for naming and
re-picks. Captured fixtures are never edited; a capture that stops
reproducing has been repaired and its pin is retired.

## Phases

| Phase | Scope                                                                                             | Exit signal                                                                         |
| ----- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| P0    | Capture O1 and O2 from the app; pin them; confirm or retire the non-monotonic lead.               | Both reproductions in the corpus with pins and owners.                              |
| P1    | Parts A–D as authored scenarios; the distance ladder with the monotonic rule.                     | Every ladder cell is success or a pinned typed refusal; part A matches its capture. |
| P2    | Chain generator and the PR slice in root Vitest.                                                  | Slice green within its measured budget; seeds reproduce.                            |
| P3    | Full chain campaign and ledger artifact; the two browser smoke cases and the 63-step reload case. | Ledger committed; smoke cases tagged and passing.                                   |
| P4    | Manual pass each release.                                                                         | Checklist complete; every finding triaged into the corpus or a follow-up.           |

## What not to do

- No widened tolerance, weakened assertion or deleted pin to turn a cell or
  chain green.
- No random seeds in the required slice; only fixed seeds run on pull
  requests, so a failure always reproduces.
- No user projects or recordings committed. Captures go through the export,
  which sanitizes names; anything with imported geometry stays out unless its
  source is cleared.
