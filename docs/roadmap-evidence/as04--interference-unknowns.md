---
row: AS04
---

Interference results never read as clear unless every pair was decided
clear. A part whose own Configuration names another row than the model's
active one is checked as that row builds it, the geometry Assemble draws
(`assemblyRowDrawnParts`), in both the static check and the sweep: the
adapter builds each such row exactly, carries the part's solids into the
check, and the report names the row beside the part ("Plate (Wide)"). So a
Wide part in a Narrow model reports its 72 mm³ overlap instead of a false
clearance, a Narrow part in a Wide model its gap instead of a false overlap,
a part only its own row builds is checked rather than listed as having no
geometry, a part whose row shows no body is listed as nothing to check, and
a part whose row cannot be built leaves each of its pairs Unknown with the
row named; the document's active row is never changed (#2388). The sweep's
summary line and status message count the pairs that could not be decided
(and at how many of their positions) and the parts with no geometry beside
the overlaps, so a pair Unknown at every sample no longer reads "No overlap
at the 37 positions checked"; a planned position the check returned no
verdict for is Unknown rather than silently clear, and a part with no pose
along the motion is listed (#2183). The static check says which pose it
read: every summary names the rest position (the saved joint values), and
while a study, a scrub or a sweep's Show poses the view elsewhere it says
the view shows another position that the check does not cover (#2154); the
exploded view's offsets count as another position too. A pair a motion
holds in one relative pose is left to the static check only when that pose
is its rest pose: held anywhere else (a study keying two parts to one place
for its whole length), it is checked there once and the verdict stands for
the whole motion, so the sweep no longer reads "No overlap" over parts that
coincide throughout. A refinement the check does not answer is recorded as
Unknown and never asked for again; a pair's details keep the reason it is
Unknown (the configuration row and part that could not be built); a check
that returns after its inputs changed posts that it is out of date instead
of its summary; and one sweep's requests share its builds of the named
configuration rows (one build per row, not one per request).
Regression: `test/assembly-interference-configurations.test.ts` (real
kernel: both false-result controls, the suppressed and unbuildable rows, the
sweep, one row build across five requests, the unbuilt row's reason),
`test/assembly-interference-sweep.test.ts` (the 37-sample Unknown
pair with its all-clear control, unanswered positions and refinements, a
rest pose clear of a 2,400 mm³ clash at a study's playhead, and carriers a
study holds coincident for its whole length),
`packages/kernel-adapter/src/exact-body-clash.test.ts`,
`apps/web/src/lib/assembly/interferenceUi.test.ts`,
`apps/web/src/lib/assembly/assemblyView.test.ts` and
`apps/web/src/components/assembly/AssemblyInterferenceSection.test.tsx`.
