---
row: S04
state: Complete
---

S04-C explicit legacy conversion and boundary provenance (PR #801): converting
rectangles or regular polygons creates independent owned primitive constraints,
stable aliases and inert authored witnesses in one undoable command. Release
shape constraints retains user constraints and aliases. Complete outer/hole
boundary loops retain cyclic order and split-edge tokens; precise matching
precedes legacy fallback. Conversion preserves selected and first-object
consumers, source lineage, raw expressions and native replay/backup behavior.
Integration introduces these fields at schema v37, preserving distance modes
v35 and composite targets v36 as separate carrier boundaries. Current,
readable-history and saved/nested replay copies require supported ownership
and version proof; opening legacy documents performs no conversion and
synthesizes no provenance. This completes the supported S04 contract recorded
in the composite-identity plan, including its named refusal boundaries.

Actual predecessor integration is covered by `test/schema-provenance-folders-retention.test.ts`: mixed-unit legacy conversion inside a linked projected outline preserves p1/b1 boundaries, aliases and raw source expressions. Source resize follows exact volume576→936 and an attached boss from x10→16 while v35/v36 measurements, folders, drawing/image/PNG/history content, undo, native backup and replay remain consistent. Collaboration HTTP/WebSocket refusal and acceptance use the same v37 proof (`sketch-provenance-validation.test.ts`).
