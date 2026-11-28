---
row: U12
---

Slice 13, Worker step (ADR-026 rollout step 2, sign-in half): the device
authorization at `/api/auth/desktop/*` admits the iPhone and iPad client
`openzcad-ios` beside `openzcad-macos`, through one allowlist
(`NATIVE_CLIENT_IDS` in `apps/web/worker/sessionCredentials.ts`) read by the
request parser, the access-token validator, the refresh path and the E2EE
write guard. An attempt or refresh token stays bound to the client that
started it: exchange refuses an attempt presented as another client, and a
refresh token presented as another client is refused and its session
revoked. The
browser approval page and its code messages name "the OpenZCAD app" instead
of macOS. The passkey `apple-app-site-association` route is left to the
passkey step. Regression: `test/desktop-auth.test.ts` (iOS sign-in, refresh
and `/api/session`; unknown clients refused at start, exchange, refresh and
the token validator) and `test/e2ee-account-keys.test.ts` (an iOS credential
passes the E2EE write guard).
