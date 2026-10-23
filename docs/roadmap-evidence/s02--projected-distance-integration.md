---
row: S02
---

S02-E projected reference distances (PR #797): Horizontal and Vertical modes
measure sketch-local separation, including valid zero projections, while
omitted modes retain legacy absolute distance. Stored identities and label
positions survive edits, undo/redo, replay and reopen. Integration assigns
distance modes schema v35 after drawing annotations v31, reference images v32,
sketch projection v33 and object folders v34; composite targets and conversion
provenance follow separately. Current, readable-history and replay carriers
must satisfy the field's own introduction version. Acceptance evidence and
remaining composite/datum/display-unit scope are recorded in the supporting
sketch-reference-dimensions plan.

Combined integration coverage uses actual linked projections and folder edits with retained drawing/image/PNG history: absolute and horizontal distances follow the source width while vertical stays fixed, with exact geometry, undo, native backup and replay unchanged (`test/schema-distance-folders-retention.test.ts`). Collaboration HTTP/WebSocket boundaries refuse backdated distance carriers before storage (`test/schema-distance-mode-compatibility.test.ts`).
