---
row: S04
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
synthesizes no provenance. The supported S04 contract and named refusal boundaries are recorded
in the composite-identity plan; ROADMAP.md remains the delivery-status ledger.

Actual predecessor integration is covered by `test/schema-provenance-folders-retention.test.ts`: mixed-unit legacy conversion inside a linked projected outline preserves p1/b1 boundaries, aliases and raw source expressions. Source resize follows exact volume576→936 and an attached boss from x10→16 while v35/v36 measurements, folders, drawing/image/PNG/history content, undo, native backup and replay remain consistent. Collaboration HTTP/WebSocket refusal and acceptance use the same v37 proof (`sketch-provenance-validation.test.ts`).

Conversion of a legacy shape beside source-driven ordinary geometry qualifies
selected profiles against the current exact read view. A versioned command
witness carries only changed numeric analysis geometry and a compact digest of
authored model inputs. It is used only during profile analysis; source witnesses,
neighboring expressions, geometry tolerances and persistent nodes are not
replaced with solved coordinates. Live preparation requires current exact
projection verdicts. Missing/stale/broken proof, changed model inputs, foreign
entities, malformed numeric fields and topology mismatches refuse atomically.
The existing resolver still enforces ordered outer/hole provenance and repeated
boundary occurrences. Payloads without this optional witness keep their path.

Native copies rebind project identity and artifact locations without changing
model geometry, so those locations are excluded from the stale-input digest.
Source checksums, modeling identities, parameters, constraints, consumer
references and units remain bound. The digest is a content guard, not
authentication of solver coordinates.

`test/sketch-conversion-qualification-exact.test.ts` verifies the real solved
32-unit outline containing a 2x2 hole at x24..26: exact volume564 survives
conversion, full replay, native backup import, copied-project replay and
undo/redo while raw neighboring `2 cm` and `h` remain intact. Editing typed
height afterward produces volume660 and replays identically. The browser
regression in `test/e2e/sketch-legacy-conversion.spec.ts` drives the actual action
and checks unchanged typed neighbors, volume, history and reopen.
