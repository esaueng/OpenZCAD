---
row: M11
state: Partial
---

Status correction (2026-11-15 ledger review): the keep-originals slice above
is merged, so the row is Partial, not Open. Boolean `keepOriginals` and Split
`keepOriginal` are validated in `packages/shared/src/document-validation.ts`
and covered by `test/solid-result-options.test.ts`. Re-picking, toggleable
target/tool badges, a switchable boolean type and multi-tool split remain.
