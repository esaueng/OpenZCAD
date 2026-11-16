# Temporary beta QA Turnstile capability

This owner-authorized exception is restricted in code to `qa@esau.bot` and
`https://beta.zcad.app`. Its hard deadline is **2026-11-23 00:00 UTC**.
It does not sign anyone in: normal emailed codes, their attempt limits and
all existing requester/email/IP limits still apply.

## Activation

1. Generate a cryptographically random 32-byte base64url token (43 characters).
   Keep it in a private local file; never put it in Git, URLs, shell arguments,
   browser storage or reports.
2. On **openzcad-beta** only, set the Worker secret `QA_TURNSTILE_BYPASS` to
   JSON with `token` and `expiresAt` (an ISO timestamp at or before the hard
   deadline). Use the secret store, never Wrangler `vars`. Leave the stable
   Worker and preview environments unconfigured. The default is disabled.
3. In the QA browser, POST `/api/auth/qa-turnstile` with the token in the
   `Authorization: Bearer` header and a same-origin `Origin` header. Do not
   include a request body. The endpoint is rate limited and returns 204 with
   a host-only, Secure, HttpOnly, SameSite=Strict cookie expiring at the
   configured deadline. It creates no user or session. Never log the header
   or returned cookie. Request headers must be redacted from any diagnostics.
4. Reload Account settings and enter the QA email. This browser receives
   `qaTurnstileBypassEmail` from the non-cacheable auth configuration and
   sees a QA security-check status instead of the widget. Request and verify
   the emailed code normally. Other emails continue to require Turnstile.

Every login-code request validates the cookie, configured expiry, hard
stop, hostname and email again; frontend state is never authorization.
An existing login session remains governed by its normal session expiry.

## Revocation and removal

Delete `QA_TURNSTILE_BYPASS` from **openzcad-beta**, or rotate its token, to
invalidate every provisioned QA cookie on the next request. Expiry also
fails closed without deployment. A refused QA request restores the normal security widget; reload settings
to refresh the capability hint proactively. No persistent project data or encryption keys are removed.
After QA, remove the temporary route, capability helpers and UI hint in a
follow-up PR. Retain the regressions for the normal email-code flow.

## Evidence

`test/auth.test.ts` exercises expiry, rotation, hostname, configuration,
credential and account boundaries, real email-code verification and send
limits on migrated SQLite. `test/worker-public-request-limits.test.ts`
exercises route cookies, cache controls, cross-origin refusal and provisioning
rate limits. `SettingsPage.test.tsx` covers account scoping and code resend.
These are local regressions; deployment and live sign-in need separate proof.
