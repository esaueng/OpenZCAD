---
row: L11
---

The app's Content-Security-Policy no longer allows Cloudflare Web Analytics
(script or beacon), so no edge-injected analytics script can run in the
origin that holds decrypted models, unlocked keys and share-link keys; only
Turnstile on the sign-in form remains. The privacy page says so (effective
November 14, 2026). Regression evidence: `test/deploy-safety.test.ts` pins
`script-src` and `connect-src`; `privacyPolicyPage.test.ts`.
