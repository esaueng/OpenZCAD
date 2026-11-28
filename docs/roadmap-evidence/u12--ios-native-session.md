---
row: U12
---

Slice 13, Swift session step (ADR-026 rollout step 3): the iPhone and iPad
app signs in to the same cloud account as the web app. Swift runs the PKCE
device authorization as `openzcad-ios` with the code shown natively and the
approval page in a private `ASWebAuthenticationSession`, keeps the refresh
token in the Keychain (`ios-refresh`, after first unlock, this device only)
and the access token in memory, and proxies `/api/*` on `zcad-ipad://app`
(`apps/ipad/Sources/ApiProxy.swift`): workspace admission, the desktop's
route allowlist, rebuilt requests without `Origin` or cookies, single-use
prepared handles for project writes, and non-executable responses. The
`openzcadNative` handler answers `capabilities` and `session.*` to the
workspace's main frame only; the page CSP refuses frames. The web side is
`apps/web/src/lib/nativeShell.ts` and the shell branch of `sendCloudRequest`.
Established first (`apps/ipad/Tests/NativeTransportProbeTests.swift`): the
private origin is a secure context with WebCrypto, and a scheme task gets
string and byte bodies whole but a Blob body empty. Regression:
`apps/ipad/Tests/NativeSessionTests.swift` (session, allowlist, bridge schema,
and the proxy end to end in a real WKWebView) and
`apps/web/src/lib/nativeShell.test.ts`. Passkeys remain step 4.
