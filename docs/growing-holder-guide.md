# Parameterizing an imported holder

OpenZCAD can turn a STEP import of a holder or bracket into a part with
editable dimensions without rebuilding it by hand. This page says what is
supported, what the numbers mean, and where the app refuses.

## What you do

1. Import the STEP file (File menu, or drop it on the viewport).
2. Open the assistant. When the app has measured an opening it offers
   **Parameterize the opening** with a **Verified** badge. Send it, read the
   proposal, and apply it. No AI provider request is made for a verified
   suggestion: every value in it is the app's own measurement.
3. Once applied, **Parameterize the mounting holes** appears when the part
   carries two matching through bores, one per arm. Apply it the same way.
4. Edit the parameters in the Parameters list. The viewport shows a preview
   while the exact geometry rebuilds; the status reads "Parameter preview ·
   exact geometry pending" until the exact result lands.
5. Save, reopen, undo, redo and export as usual. The result is ordinary
   history: rigid pieces carved from the import, straight sections rebuilt
   at the parametric length, and one union.

## The controls

| Parameter       | What it is                                                                                                                                         | Minimum                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `opening_width` | The distance between the two inner arm faces. Both ends move apart symmetrically about the measured center; the overall width follows the opening. | Where the two ends would meet, stated in the proposal.        |
| `holder_height` | The height of the arms, when the app finds a straight run on both arms above the base. Everything above the run moves up rigidly.                  | The source height minus the run, stated in the proposal.      |
| `hole_diameter` | The two mounting bores, resized together on each end before the ends move, so they stay aligned with their arms at every opening.                  | Set by the kernel: a bore it cannot resize reports a warning. |

Values below a minimum are clamped by the expression (`require_min`), so
the build stays valid; the parameter keeps the value you typed.

## What is measured, and what is not

- The opening is a pair of inward-facing planar faces along one world axis
  with nothing between them, confirmed by mirror symmetry about the center.
- The straight section is the longest run between the ends whose cross
  section does not change; every hole, blend, boss or letter stays on its
  end and moves rigidly. The proposal states the cut positions.
- On an arm with embossed lettering the straight run for the height is the
  widest gap between two letters, and that gap widens with the height. The
  proposal says so.
- Nothing is inferred from a drawing or a name. If a required measurement
  is missing the suggestion is not offered.

## Where the app refuses

- **No facing pair.** A part without two inward-facing planar faces across
  an empty gap is not offered. Text on a drawing does not change this.
- **Rotated parts.** Recognition works along the world axes. A part rotated
  off them is refused with that reason; re-export it aligned.
- **Two equal openings.** The app reports the ambiguity instead of picking
  one.
- **Height on drilled arms.** When a bore passes through the arm at the
  straight run the kernel cannot split the arm, so only the opening is
  offered on that part. The proposal explains the missing control.
- **Bores the kernel cannot resize.** A countersink that breaks out of a
  thin arm cannot be widened; some bores cannot be shrunk. The feature
  reports "The hole kept its original diameter" rather than pretending.
- **Edited history.** If you change or suppress one of the recipe's own
  features, the preview stops and only exact rebuilds are shown.

## Latency

Measured on a 2026 laptop with a part of about 100 faces: the preview
appears well under a quarter of a second after an edit; the exact result
typically lands in one to four seconds. The first edit after opening a
project can take longer while the history cache warms.
