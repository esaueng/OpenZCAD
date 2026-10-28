---
row: L11
---
Encrypted asset uploads and contact discovery now respect the actual D1
runtime. Upload creation and staged part reservations verify the identifier
or token returned by their fenced writes, rather than D1's trigger-inclusive
change count. Session, role, lease, erasure and quota predicates remain in
those same statements. Contact discovery uses smaller membership and
invitation CTEs within D1's compound SELECT ceiling, retaining one snapshot,
the global ordering/cap and the existing email-visibility rule.

`test/e2ee-d1-runtime.test.ts` applies the real migrations to an isolated
workerd D1/R2 instance through the installed Wrangler. Regressions reproduce
the former upload rejection, staged-part reservation failure and contacts
query error; they also cover upload retry, fenced-out writes, ciphertext
round-trip and reservation cleanup. Existing contacts and migration suites
retain their authorization, privacy, quota and stale-lease coverage.
Local staging with synthetic data resumed an interrupted imported-STEP
migration after restoring disk-backed state, completed cutover and plaintext
purge, and reopened the model. Rollout configuration, migrations and the
Remus pin are unchanged. Production activation and outside-review clearance
remain separate requirements.
