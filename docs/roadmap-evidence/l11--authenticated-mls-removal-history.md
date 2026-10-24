---
row: L11
---
Issue #817 follow-up to the archive verifier in PR #839: provisional Welcome
and external-rejoin admission exposes only archive decryption until the
existing `JoinArchive` verifies; normal operations and confirmation remain
blocked across sealed-state restoration. Malformed downloads preserve an
accepted provisional rejoin for retry after its original PSK expires, while
verified policy rejection or discard restores prior state. Session contents
use version 2 and reject legacy unverified cutoffs; `EpochRecordV1` and the
archive API stay unchanged. Rust refuses revoked directory devices without a
cutoff, preserving zero. Archive messages reject trailing bytes. Evidence:
`packages/mls/src/{scenarios,boundary.test}.ts` and native archive regressions,
plus the regenerated pinned WASM. Application integration and checkpoint
replay remain open.
