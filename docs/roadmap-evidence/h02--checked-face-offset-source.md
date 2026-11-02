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
