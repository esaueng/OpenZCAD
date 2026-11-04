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
the offset began. [Remus PR #1489](https://github.com/esaueng/remus/pull/1489)
addresses both bounded construction families.

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
make a normal-only test selector ambiguous. It creates the R5 fillet through
five actual viewport edge picks, then covers independent shoulder and cap
moves from a taller source, contact onset, joining, further movement,
separation, rejoining, undo/redo, durable reload and a held drag through both
directions. Every committed state exports STEP and is reimported to verify
one body, the expected 16/19-face topology, the moved
shoulder height and unchanged cap height. Warning counts and the actual
approximation advisory are checked after reload. Both package specifiers,
the frozen lockfile and the checksum manifest adopt paired `2026.1.104` at
`6b44ca58f16971b32a45c0721e17e4970fd8b0d7`, the merged commit of
[Remus package refresh #1496](https://github.com/esaueng/remus/pull/1496).
Its file tree is identical to the already-qualified package candidate.

The existing stale-gear-reference browser case also reselects the current cap
and retries opening its keypad while import reference repairs rebuild the
stored model. A production-build trace reproduced the correctly refused early
click; the corrected case passes with test retries disabled and retains its
committed-height, History-edit and reload assertions.

At kernel source `e4a67d16`, the normal paired WASM build and both packaged
runtime suites pass. All three public browser regressions pass, as does a
separate browser reproduction using the original dimensions. Its committed
and reloaded STEP exports are valid closed 19-face bodies with shoulder and
cap planes at 24.1 and 28.5 mm. The final local operations suite passes
3,677 tests with 27 skips; one nextest leaky-test report passes cleanly on an
unchanged isolated rerun. Exact-head kernel CI passes 9,663 native tests
across both shards, both packaged runtime suites, size and version guards,
repository policy and CodeQL. Source PR #1489 merged through its queue.

Without a local source overlay, the frozen package passes the app build,
typecheck, all 92 parity cases (one existing skip), and the three browser
flows. The integrated native-union and quality/history regressions pass
44 tests. Full root coverage reports 8,907 passed, seven failed and ten
skipped; all seven failures reproduce on pristine main with its previous
`2026.1.103` pair. Full web coverage reports 5,109 passed and one failed;
the viewport-theme assertion also reproduces on pristine main. Assertions
and protection gates are unchanged. App PR CI and deployment verification
are separate from these local results.

The lag investigation found expensive repeated numerical face integration,
including attempts that exhausted the quadrature work cap before refusing.
The kernel preflights that unchanged cap, recognizes complete natural NURBS
domains from boundary authority, and uses a closed-form boundary integral for
the axial shoulder/rim translation's volume-direction guard. General blend
moves retain their existing cache-backed integral path. It does not seed
measured-volume caches or relax solid validation. One functional trace of kernel candidate
`425438a3` recorded initial translation calls at 197–214 ms, later translations
at 20–29 ms, and rim reconstruction at 432–499 ms. Worker queueing was at most
0.1 ms; the first following presented frame arrived 160–847 ms after its
request. All 17 published candidates succeeded. This is a single diagnostic
trace without a matched baseline or quiet-host qualification, not H02 timing
acceptance or a smooth-frame guarantee. Cold joining still costs more than
translation, and target-device responsiveness remains open.

The reconstructed corners and trim contours are approximate. Local comparison
against the supplied target found matching physical bounds and valid closed
19-face STEP bodies. With 0.002 mm linear tessellation, 20,000 finite samples
in each direction had 99th-percentile distance below 0.0008 mm and a worst
sampled distance of 0.0026 mm; this is not a whole-surface tolerance
certificate. A reverse/separation comparison also
showed a roughly 0.38 mm³ discrepancy in an independent periodic-cylinder
volume integral despite much closer meshes. That measurement discrepancy
remains a qualification limit; general freeform reconstruction and formal
geometric equality are not claimed.
