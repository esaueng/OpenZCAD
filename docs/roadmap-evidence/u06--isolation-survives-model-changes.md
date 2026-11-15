---
row: U06
---

Isolation across model changes (QA 2026-11-14 finding #17): a body created
while isolated joins the isolated view and Exit isolation still restores the
prior hidden set; a committed change that removes or parameter-hides the
isolated body ends isolation, restores the prior hidden set and says so in the
status line, while a preview never ends it; the device view and the account
resume state save the user's own hidden set rather than isolation's, so a
reload never keeps isolation-hidden bodies (`bodyIsolation.test.ts`,
`objects-isolation.spec.ts`).
