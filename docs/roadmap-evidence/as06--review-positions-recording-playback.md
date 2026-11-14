---
row: AS06
---

Design review 2026-11-13 I58/I59 and the playback half of I57: saved
positions move out of one joint's details into their own Positions section
(they save every joint) and rename on double-click; with a motion study open
the timeline says "Recording keys at 2.00 s" the whole time (plus "move a
part to set it, then Play" before the study moves) and a joint's details say
a typed value is keyed into the study, not the rest pose; joint details, Set
up motion and the study timeline set playback with one shared Playback
select and one set of named speeds (`PlaybackControl.tsx`,
`AssemblyPanel.test.tsx`, `MotionStudyTimeline.test.tsx`,
`MotionSetupCard.test.tsx`, `test/e2e/assembly.spec.ts`).
