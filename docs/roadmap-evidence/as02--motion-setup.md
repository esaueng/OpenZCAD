---
row: AS02
---

Set up motion: Assemble's Joints section (and the header's Motion button,
once a part moves) opens one card that makes a part slide or turn without
picking joint geometry. You choose what stays put, what moves, a world axis
with Reverse, a range in mm or degrees, and a cycle and speed. The viewport
previews that exact sweep, and Create and play saves an as-built slider or
revolute joint with those limits, fixes a floating base first, and plays it.
Playback stays transient. A supplied tool-in-holder project defaults to
lifting the tool 0–55 mm up Z out of its fixed holder and back. The reference
recording shows the same motion made by hand as 0–50 mm Move steps. A fixed
moving part, an empty range, and a second motion on a part that already moves
(which would close a loop) are refused with the reason; "Pick on the model"
hands over to the Joint tool. Evidence: `motionSetup.test.ts` (exact poses at
0/50 mm, turn pivot, reverse, defaults, refusals, preview sweep),
`MotionSetupCard.test.tsx`, and the `assembly.spec.ts` CI smoke case (preview
moves the part, Create plays back and forth, Pause returns to 0, one undo
removes it).

Floating-base preview parity: `assemblyView.test.ts` verifies that a base
listed after its moving part stays stationary during preview, matches the
committed motion, and restores the saved floating poses on Cancel. Preview
grounding is transient and preserves the saved document. Included in the
web CI smoke selection.
