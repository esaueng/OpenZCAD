---
row: H01
---

Forked histories (two active features replacing the same body, so two
overlapping solids of one part are built) are now reported on the later
branch as an attributed `history-fork` warning that no commit gate reads, and
`CommandManager` refuses an edit that creates or retargets a feature onto a
replaced body, except at the rollback marker; stored logs replay unchanged and
Duplicate no longer offers Pattern (ADR-017 November 2026 "forked histories"
amendment; stable body lineage identity proposed in
docs/adrs/ADR-025-stable-body-lineage-identity.md). Synthetic coverage:
`packages/document-core/src/body-consumption.test.ts`,
`test/history-fork.test.ts`, `test/duplicate-step.test.ts`.
