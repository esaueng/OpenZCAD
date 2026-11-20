---
row: F03
state: Partial
---

Vocabulary extension started with Hole. The AI patch vocabulary now has an
`add_hole` operation: one simple blind or through hole in one exact planar
face of an existing body, positioned in the face frame from its area
centroid. `commandsForCadPatch` maps it to the manual Hole command
(`feature.hole`, `validateHoleInput`) with the payload the Hole card builds,
so `preflightCadPatch` runs that command's own refusals and the shared exact
warning gate. Apply is one `Apply AI patch` transaction that one undo
reverts. A provider reply must copy a current planar digest face (hash and
reference), and its target cannot be a body created in the same proposal.
Provider exposure is a dark rollout flag (`AI_PATCH_HOLE_ENABLED`, unset in
every deployment) and is offered only to clients that declare `add_hole`.
A provider-free slice follows the "Fillet all edges" precedent: "Drill a
6 mm hole", "… through hole" and "… hole 8 mm deep" on the one selected flat
face use the Hole tool's defaults (⌀6, through, 10 deep) and document units,
and say why when no single flat face is selected. Regression evidence:
`test/selected-face-hole.test.ts` (exact through and blind volumes, payload
equal to the Hole card's submission, single-undo transaction, refusals with
the manual command's own reasons, digest stale/curved-face refusals),
`AssistantPanel.test.tsx` (local preview without a provider; a refused
preview never reaches Apply), `test/assistant.test.ts` (flag and client
negotiation) and the `@ci-smoke` browser case
`test/e2e/selected-face-hole.spec.ts` (select face, preview, Apply, undo,
redo, reload). Counterbore/countersink, standard and tapped holes,
sketch-point holes, split, loft, sweep, helical sweep, draft, thicken and
dimension edits remain.
