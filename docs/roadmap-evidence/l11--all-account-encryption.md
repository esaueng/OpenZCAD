---
row: L11
---

The official beta offers opt-in encryption to every authenticated account through `E2EE_KEYS_ENABLED=true`, alongside the existing project and migration flags. Key setup, encrypting new projects and migrating existing projects remain separate user choices. Default-on encryption, plaintext freeze and reverse migration remain disabled; the outside review and remaining L11 acceptance are still open. `test/e2ee-cohort-config.test.ts` verifies availability without a canary selection and preserves coverage of the scoped fallback when global keys close. Existing Worker route coverage in `test/e2ee-account-keys.test.ts` verifies unauthenticated reads are refused when global keys are enabled. The public privacy page describes the all-account opt-in rollout, with `privacyPolicyPage.test.ts` tying that statement to the official flags. No account identifiers, migrations or dependencies are added.
