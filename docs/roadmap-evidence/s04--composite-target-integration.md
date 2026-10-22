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
