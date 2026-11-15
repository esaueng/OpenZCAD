---
row: U01
---

A drag- or keypad-committed fillet re-arms only its own band: an earlier band
it trimmed (new hash, same identity or carrier) is never picked, so a typed
radius edits the new Fillet, not the previous one (QA 2026-11-14 finding #10;
`apps/web/src/lib/blendRearm.test.ts`, `test/fillet-rearm-adjacent.test.ts`).
