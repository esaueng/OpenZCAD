---
row: L11
---

Sealed shelf state: an account whose library is encrypted keeps pins, manual
order and the archive in its sealed library record (folder set version 3)
instead of readable project rows; the trash stays readable for sharing,
purging and quotas. The Worker refuses readable shelf state for such accounts
(`PROJECT_SHELF_STATE_SEALED`) on the organization and reorder routes and
starts their copies at order 0; the browser sends only trash moves, sends
pins, order and archive readable only after the library rule answered
plaintext, overlays the account's own sealed state on listings (this
device's rows, which every account signed in shares, add only an unmirrored
trash move, also when the account's listing fails), journals an edit
under the account that made it as the fields it changed over the account's
own state, and migrates readable
rows into the sealed record before a Worker-side conditional reset that
never touches the trash.
Regression evidence: `test/e2ee-sealed-shelf-state.test.ts`,
`test/e2ee-encrypted-copies.test.ts`, `test/persistence.test.ts`,
`sealedShelfState.test.ts`, `sealedShelfAccounts.test.ts`
([ADR-024 amendment 2026-11-14](docs/adrs/ADR-024-end-to-end-encrypted-projects.md)).
