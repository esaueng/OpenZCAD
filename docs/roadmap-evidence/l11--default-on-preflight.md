---
row: L11
---

Phase 8 rollout follow-up: deployment preflight recognizes the merged `E2EE_DEFAULT_ON` Worker flag, requires migration to be enabled first, validates string values, and rejects enabling reverse migration alongside default-on. The self-host example keeps the flag false. The shutdown instructions disable default-on before authenticated opt-outs while keeping key and project routes available. `E2EE_PLAINTEXT_FROZEN` remains explicitly unimplemented and accepted only while off. The documentation distinguishes the implemented Worker gate from the unfinished browser rollout and mandatory outside review; no flag is enabled or remote migration run. Evidence: `test/deployment-config-validator.test.ts` covers the ordered rollout, default-on prerequisites, invalid values, reverse conflict and shipped configuration.
