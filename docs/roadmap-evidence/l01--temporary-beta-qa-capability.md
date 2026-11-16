---
row: L01
---

Owner-authorized temporary beta QA capability permits the designated QA
account to request email codes without Turnstile only on the beta hostname
and only from a secret-provisioned browser. Each issuance expires within seven days, preserves
email verification and rate limits, and supports immediate secret revocation.
Renewal rotates the Worker secret and reprovisions the browser without a PR. Boundary and real SQLite code-flow coverage:
`test/auth.test.ts`, `test/worker-public-request-limits.test.ts`,
`SettingsPage.test.tsx`. Activation and live QA remain separate evidence;
see [the runbook](docs/qa/temporary-turnstile-capability.md).
