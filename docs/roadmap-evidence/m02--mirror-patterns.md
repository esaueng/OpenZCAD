---
row: M02
---

Slice 4, mirror patterns (schema v115, up from v112; v113 and v114 are claimed by #1786 and #1792; no kernel change). A
`pattern` with `patternKind: 'mirror'` stores `mirrorPlane`, a datum plane
or an origin and normal as Mirror takes it, and makes one copy: the whole
body, or with `sourceFeatureIds` the repeated holes, bosses and cuts,
reflected in the plane (x ↦ x − 2((x − p)·n)n). The copy is labelled "1",
so slice 1's per-copy proofs, bore checks and names apply unchanged (a
mirrored hole's bore is `pattern.face.instance.1.source.<hole>.hole.face.bore`);
it is the rigid copy-and-transform build, fused with the original where
they overlap. Refused: a plane on another kind, a mirror pattern without
one, a plane that is neither a datum plane nor an origin and normal, a
later or missing datum plane, below v115 by the content gate, and at build
a zero normal and a skipped copy (no copy would be left). The plane's
expressions are renamed with their parameters, a datum plane it reads
counts as used and as its parent in History, and an edit to the datum
revalidates it. UI (U11 pick-and-drag): a Mirror pattern tool in the
Pattern group with Repeat (Body, Features). After the body or the feature,
the plane is a principal or datum plane, or a flat face (under Features,
one no repeated feature made), slid by the same offset arrow as Mirror's,
or typed in Options. A History edit reopens with the plane as stored and
writes it back unchanged; History reads "Mirrored". Evidence:
`test/mirror-pattern.test.ts` (a hole mirrored across the plate with
closed-form volume, bore axes and its copy's name; whole-body copies apart
and overlapping, fused to 1600 mm³; a skipped copy refused; the document and
v115-gate refusals); `apps/web/src/lib/inPlace/tools.test.ts` and
`edit.test.ts`; `test/e2e/mirror-pattern.spec.ts`, which drills a hole in
place, picks its bore under Repeat Features, picks the plate's end face,
drags the plane back over the plate and checks the stored plane and its
"Mirrored" History row.
