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

Review regressions preserve raw-storage negotiation on older native hosts
through the existing query protocol, without a Rust protocol change. Asset
fetch and response-stream failures retain their original transport errors;
HTTP asset failures preserve their status, while invalid/checksum-mismatched
content retains the account-copy-unavailable classification. Migration reads
use the same distinction. macOS verification remains deferred.

The static-preview API fixture now retains successful creations (including
prepared-document overrides) and hydrated saves, and serves those account
heads on reload. Raw-read negotiation exposed the previous missing API,
which had relied on the preview server's HTML fallback. The existing error
assertions remain intact: fillet/reload journeys, both raw-reader journeys,
six object journeys and all three unit-bearing text reopen journeys pass.
Asset HTTP errors also preserve bounded JSON error codes and details, so
finalizing encryption between the frame and asset reads takes the existing
encrypted-format fallback immediately. The race regression failed before
that correction and passes afterward for both account and migration reads.
The holder import/reload/export regression explicitly removes its account
copy before reopening, checks the exact expected missing-copy response, and
still proves the restored local copy exports without a cloud upload.
Copied-source alias metadata shares the importer's 128 MiB source limit,
independently of document/frame download limits. Boundary regressions accept
sources above the document-write cap through 128 MiB and refuse larger ones.
