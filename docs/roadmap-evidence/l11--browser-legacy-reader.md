---
row: L11
---
ADR-024 Phase 8-3 adds a browser legacy plaintext reader. Account and migration
head/revision loads negotiate a raw storage frame on the existing URLs, with
JSON compatibility for older Workers. The Worker relays inline D1 text or the
compressed R2 snapshot and copied-source alias metadata without parsing CAD.
Authenticated asset reads accept only exact project-scoped storage keys.
The browser bounds downloads and decompression, checks lengths and checksums,
hydrates imported payloads, normalizes history and reconciles source aliases.
Existing account format refusals, project authorization, missing-revision
semantics and the frozen-plaintext write gate remain enforced.

Real-Worker regressions disable the old CAD loader and exercise inline/R2
heads and revisions, migration, malformed data, missing/corrupt assets,
scope/format refusals and frozen reads. Browser API tests retain older JSON
responses and transfer measurements. Chromium journeys open both storage
forms and reconstruct an imported mesh. Types, focused lint and the complete
production build with bundle budgets pass. Server pipeline retirement and
production activation remain held for outside-review clearance; this slice
does not complete the remaining historical MLS authorization work.
