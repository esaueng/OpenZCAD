---
row: U06
---
History rollback insertion (ADR-017 November amendment): a feature added while
History is rolled back lands at the rollback marker, ahead of the paused tail,
as one undoable edit that replays to the same order
(`test/rollback-insertion.test.ts`).
