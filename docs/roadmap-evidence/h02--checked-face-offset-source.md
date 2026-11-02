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

The interacting shoulder/rim case also needs a topology change in the kernel.
Translating the old faces is valid only until the shoulder reaches the fixed
rim. Beyond contact, the rim needs a new contour and corner bands. An earlier
ridge construction also rounded the already rounded seam instead of retaining
the boss as a rolling support, producing a visibly different corner before
the offset began. Remus PR #1489 addresses both bounded construction families.

Offset Face explicitly permits the kernel's sampled cap reconstruction at
256 stations. Ordinary and prepared journaled moves carry the disclosed
quality and complete construction history. Unique surviving face picks retain
their identity; split, merged and deleted faces cannot inherit an old pick.
Unknown quality or incomplete approximate history refuses. A refused prepared
call can retry once through the ordinary quality-aware method; an unverifiable
completed edit cannot repeat or fall through to a plain move. The existing
solid validation and carrier checks still run. A feature advisory discloses
the approximation during preview, commit and replay.

`test/e2e/shoulder-cap-offset.spec.ts` builds a public primitive fixture and
uses the viewport picker to select the shoulder, because two upward planes
make a normal-only test selector ambiguous. It covers contact onset, joining,
further movement, separation, rejoining, undo/redo, durable reload and a held
drag through both directions. Every committed state exports STEP and is
reimported to verify one body, the expected 16/19-face topology, the moved
shoulder height and unchanged cap height. Warning counts and the actual
approximation advisory are checked after reload. This coverage needs the
normal paired kernel-package release and adoption; a local dev overlay alone
does not update the frozen dependency.

The lag investigation found expensive repeated numerical face integration,
including attempts that exhausted the quadrature work cap before refusing.
The kernel preflights that unchanged cap, recognizes complete natural NURBS
domains from boundary authority, and uses a closed-form boundary integral for
the translation's volume-direction guard. It does not seed measured-volume
caches or relax solid validation. Exploratory local traces showed repeated
pre-contact kernel work around 24–33 ms and cold cap reconstruction around
590–750 ms under concurrent test load. These are diagnostic observations,
not quiet-host H02 timing acceptance or a smooth-frame guarantee. Cold joining
still costs more than translation, and target-device responsiveness remains
open.

The reconstructed corners and trim contours are approximate. Local comparison
against the supplied target found matching physical bounds and valid closed
19-face STEP bodies. Finite bidirectional mesh samples had 99th-percentile
distance below 0.0004 mm and a worst sampled distance of 0.0043 mm; this is not
a whole-surface tolerance certificate. A reverse/separation comparison also
showed a roughly 0.38 mm³ discrepancy in an independent periodic-cylinder
volume integral despite much closer meshes. That measurement discrepancy
remains a qualification limit; general freeform reconstruction and formal
geometric equality are not claimed.
