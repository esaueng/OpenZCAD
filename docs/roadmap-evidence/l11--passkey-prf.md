---
row: L11
---

Phase 3 passkey follow-up: recovery-authorized discoverable WebAuthn PRF enrollment, fresh-browser unlock and certification, and passkey/device/read-only revocation reuse the identity-certified unlock-target protocol and rotate both account and encryption keys when revoking. Credential-id hashes are bound by the signed target list; provider-visible metadata contains only random handles and labels. Failed enrollment identifies the provider credential and any possibly committed target for cleanup. Evidence: `test/e2ee-passkeys.test.ts`, passkey cases in `test/e2ee-account-keys.test.ts`, and real Chromium PRF controls in `test/e2e/encryption-passkeys.spec.ts`.

Integration preserves the parent snapshot, pin CAS, session authority and same-device writer lock. Delayed PRF prompts cannot resume after their settings view closes, cross-tab session teardown or a subsequent authenticated session. Recovery/passkey certification re-reads durable device state and retains approval cancellation and compare-and-swap replacement. Temporary PRF and raw key buffers are cleared. `E2EE_KEYS_ENABLED` stays off; enabling it or manually applying migration 0029 still needs separate authorization. Real provider/browser qualification and the remaining E2EE phases are not claimed.
