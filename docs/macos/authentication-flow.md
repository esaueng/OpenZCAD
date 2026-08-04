# Desktop authentication flow

## Current web contract

The hosted application uses Turnstile-protected email codes and an
`HttpOnly; Secure; SameSite=Lax` host cookie. The frontend calls relative API
routes with same-origin credentials. The Worker authenticates collaboration
WebSocket upgrades from the same cookie.

The bundled desktop origin cannot use that contract safely or reliably. Copying
the cookie into JavaScript, storing it in localStorage, weakening SameSite/CORS,
or embedding a production URL would all cross the security boundary. None of
those shortcuts is implemented.

## Implemented desktop design

1. Rust generates a high-entropy state value, PKCE verifier/challenge, and a
   short-lived login attempt identifier.
2. The app opens an approved HTTPS OpenZCAD login URL in the system browser.
3. The hosted page completes the existing Turnstile and email-code flow.
4. The signed-in browser explicitly approves the one-time attempt. The Worker
   binds it to the state hash, PKCE challenge, account, expiry, and fixed macOS
   client identifier.
5. Rust polls the exchange route over TLS. Until browser approval, the route
   returns only `pending`; no account identity or credential is exposed.
6. Rust presents the state and PKCE verifier. The Worker consumes the attempt
   once and returns a short-lived access token plus a rotatable refresh token.
7. Rust stores only the refresh credential in macOS Keychain. Access tokens stay
   in memory and are never exposed through localStorage.
8. Desktop HTTP API requests pass through a fixed-origin Rust proxy that adds
   the scoped bearer credential outside the WebView. Logout
   revokes the server session, deletes the Keychain item, clears in-memory
   access, and leaves unsaved local documents intact.

No client secret belongs in the app. Callback input is untrusted. Tokens must be
audience-bound, revocable, rate-limited, and excluded from URLs, logs, crash
reports, frontend bundles, and GitHub Actions output.

## Implemented backend boundary

- Migration `0012_desktop_auth.sql` adds attempt, access-token, and rotating
  refresh-token records. Only SHA-256 token/state hashes are stored.
- `/api/auth/desktop/config` fails closed unless the migration and
  `DESKTOP_AUTH_ENABLED` rollout gate are both present.
- Start, approve, exchange, refresh, and logout routes enforce the fixed
  `openzcad-macos` client, ten-minute attempts, PKCE, one-time consumption,
  refresh reuse revocation, expiry, and an IP start-rate limit.
- Existing authenticated HTTP routes accept the opaque desktop bearer without
  weakening the hosted cookie flow or adding cross-origin browser access.
- The native proxy is pinned to `https://zcad.esau.app`; it validates every API
  path and system-browser handoff before making a request or opening a URL.

## Remaining release gates

- Apply migration 0012 and deploy the gated Worker only with explicit beta
  rollout approval; source and local tests do not prove the hosted environment.
- Add a ticketed native collaboration WebSocket handshake. Browser WebSockets
  cannot attach the in-memory bearer header, so desktop currently uses HTTP
  project synchronization and keeps live rooms disabled.
- Validate Keychain save/relaunch/rotation/logout and a real email-code round
  trip on macOS 14, 15, and the current release host.
