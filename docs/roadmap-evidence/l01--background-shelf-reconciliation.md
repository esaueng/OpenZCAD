---
row: L01
---

Shelf background reconciliation (PR #814) bounds admission across tabs, keeps
discovery independent of network backlog and preserves pending edits through
cancellation and retention. The source design and regression record is in
`docs/reviews/shelf-reconciliation-background-2026-10-21.md`.

Local retention is owned by the current discovery generation, including signed-out
work, separately from permission to send account writes. Superseded discovery is
checked before purging and after awaited metadata reads inside each delete
transaction. Current metadata eligibility, alias fences, pending tombstones and
explicit permanent deletion remain intact. Regression coverage includes account
changes before purge, during metadata reads and between rows, cross-tab markers,
restored/newer metadata and legitimate signed-out expiry.
