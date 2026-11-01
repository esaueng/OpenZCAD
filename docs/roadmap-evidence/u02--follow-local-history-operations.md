---
row: U02
---

History follows newly created local operations while the user is following the
list. Browsing older rows, finding/filtering, renaming, or reordering preserves
the reading position and exposes a sticky Show new operation control instead.
Revealing the operation resumes following without changing the edited selection;
Enter activates the control without also opening an armed face-offset keypad.

The notification identifies the operation created by a successful local command
or transaction rather than its older geometry publisher. Peer appends do not
trigger it or replace an unseen local target. Project changes and deleted/undone
targets clear it; unchanged Total entry creates no arrival.

`localHistoryAppend.test.ts` and `HistoryTimeline.test.tsx` cover provenance,
selection, filtering, older reading, remote appends and undo/redo.
`history-local-append.spec.ts` exercises real face-offset drags in a synthetic
long history, keyboard reveal, resumed following, and an unchanged Total entry.
This closes the recording's offscreen-history feedback gap; broader H02 latency
qualification and live collaboration acceptance remain separate.
