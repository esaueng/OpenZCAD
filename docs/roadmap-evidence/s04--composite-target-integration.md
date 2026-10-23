---
row: S04
---

S04-B named composite targets (PR #800) retain an explicit composite identity,
corner/side index and complete ordered topology witness for new held-line
rectangles and polygons. References and snaps fail by name on missing,
ambiguous or changed ownership. Mixed primitive/composite distances and angles,
projected modes, raw expressions and label placement survive resize, replay,
undo/redo and reopen. Integration introduces targets at schema v36, after
reference-distance modes v35, with independent positive carrier-version checks
over current, readable-history and saved/nested replay data. Drawing annotations
and reference images remain authored data. Legacy conversion and boundary
provenance follow in the next slice.

The combined retained-content regression uses actual linked projected edges, named composite corners/sides and all distance modes, plus drawing/image/PNG/folder history. A source resize and composite reshape preserve target identities and exact profiles through undo, replay and native backup (`test/schema-composite-folders-retention.test.ts`). Integer schema proof and collaboration HTTP/WebSocket refusal/acceptance are covered in `test/sketch-composite-reference-commands.test.ts`.

Live reference Add validates canonical target identities and measures the matching
project/version-qualified solved sketch view. It appends only an annotation;
authored geometry, expressions and feature geometry digests stay unchanged.
Composite command replay restores the same strict target identities without
requiring transient solver output, so an annotation may remain unresolved until
the exact build completes, as with saved annotations. Primitive-only replay
keeps numerical validation. No payload flag bypasses live qualification.

`test/sketch-composite-reference-resolved.test.ts` uses a real linked edge and
mixed expression/numeric seeds whose solved width is 32 while canonical seeds
remain 20. Add, full JSON command replay, undo/redo and native reopen preserve the
32-unit reference, exact volume 576, all authored inputs and feature digests.
Missing, stale and foreign geometry proof refuses live Add.
`test/sketch-composite-reference-restoration.test.ts` preserves nonmeeting live
refusals and rejects malformed, reordered, foreign, missing, aliased or ambiguously
owned targets, duplicate annotations, driving values and older schema carriers.
