---
row: H02
---
Terminal face offsets retain their checked source checkpoint through Apply,
avoiding an unchanged upstream blend's display-only rebuild followed by a
checked rebuild on the next value. `test/drag-source-checkpoint.test.ts`
repeats preview and complete builds with ordinary and two-checkpoint limits,
requires zero upstream extrusion replays, preserves the checkpoint ceiling,
and compares volume, bounds, edges and warnings with a fresh exact build.
Complete syncs still replay and validate the terminal offset; no additional
checkpoint or geometry-only result can satisfy a commit.

Offset handles also recognize the source mesh independently of changing drag
values and operation phases. `useOffsetFaceHandle.test.tsx` covers retained
positive and declined recognition, live values and lifecycle flags, source or
history replacement, selection changes, and refusal of stale topology picks.
Unrelated body updates retain the installed handle. Exact validation and the
supported display-proxy families are unchanged.
