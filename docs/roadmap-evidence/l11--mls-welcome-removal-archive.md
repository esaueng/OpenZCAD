---
row: L11
---
Issue #817 follow-up: Welcome joins and external rejoins require a complete
epoch archive. Public MLS transcript replay derives removals and binds them
to the authenticated joining context and tree, refusing omitted or fabricated
GroupInfo records. Failed joins restore one-use KeyPackages for a valid retry.
ADR-024 records the original limitation and the remaining fork-consistency
and historical-authorization limits. Local verification: five Rust regressions,
126 MLS Vitest tests, and 57 scenario steps each in Chromium and WebKit; a
fresh Rust 1.96.0 build reproduces the committed WASM byte-for-byte. Existing
live policy rules and assertions, deployment flags, archive V1 and sealed-state
formats are preserved; no migration or standalone deployment was performed.
