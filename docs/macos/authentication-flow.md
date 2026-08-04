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

## Required desktop design

1. Rust generates a high-entropy state value, PKCE verifier/challenge, and a
   short-lived login attempt identifier.
2. The app opens an approved HTTPS OpenZCAD login URL in the system browser.
3. The hosted page completes the existing Turnstile and email-code flow.
4. The Worker binds a one-time authorization code to the attempt, state,
   challenge, account, expiry, and desktop client identifier.
5. The browser redirects to the registered
   `openzcad://auth/callback` application URL.
6. The native layer rejects callbacks with the wrong scheme, host, path, state,
   shape, size, expiry, or already-consumed code.
7. Rust exchanges the code and PKCE verifier directly with the Worker over TLS.
8. The Worker returns a short-lived access token and rotatable refresh token.
9. Rust stores only the refresh credential in macOS Keychain. Access tokens stay
   in memory and are never exposed through localStorage.
10. Desktop API and WebSocket requests use scoped bearer authorization. Logout
    revokes the server session, deletes the Keychain item, clears in-memory
    access, and leaves unsaved local documents intact.

No client secret belongs in the app. Callback input is untrusted. Tokens must be
audience-bound, revocable, rate-limited, and excluded from URLs, logs, crash
reports, frontend bundles, and GitHub Actions output.

## Backend work required

- Add one-time desktop authorization attempt and exchange records/routes.
- Add narrowly scoped CORS for the desktop transport where WebView fetch is
  used; prefer native Rust HTTP for token exchange and refresh.
- Allow authenticated API and collaboration requests to resolve the new bearer
  session without weakening existing cookie authentication.
- Add revocation, refresh rotation/reuse detection, expiry, and account-device
  inventory.
- Register and validate the custom URL scheme and single-instance behavior.
- Add Keychain, deep-link, system-browser, and redacted logging integrations to
  the Tauri host with least-privilege capabilities.

This work changes the hosted authentication schema and API contract. It requires
its own security review, migration plan, beta deployment approval, and end-to-end
tests before cloud features can be declared working in the desktop app.
