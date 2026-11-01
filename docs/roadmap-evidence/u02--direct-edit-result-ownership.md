---
row: U02
---

A direct edit's result stays with the selection it was made on (production QA
2026-10-31): a refusal or commit that lands after another pick no longer marks
the new pick failed with the earlier value, or takes the pick back; the refusal
is reported against the edited body (`machine.test.ts` `operationSelectionKey`,
`test/e2e/direct-edit-ownership.spec.ts`).
