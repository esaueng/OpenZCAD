# ADR-026: Native iOS sign-in and passkey bridge

## Status

Proposed (2026-11-26). Gates slice 13 ("Native sign-in bridge") of the
[compact mobile workspace plan](../plans/compact-mobile-workspace-plan-2026-11-26.md)
under [U12](../../ROADMAP.md#u12). Nothing here is implemented. It applies
the owner decisions of 2026-11-26 recorded in that plan: native iOS sign-in
and sync use a native AuthenticationServices bridge, and the bundled offline
`zcad-ipad://app` origin stays. It extends
[ADR-012](ADR-012-email-code-identity.md) (sign-in) and
[ADR-024](ADR-024-end-to-end-encrypted-projects.md) (passkey unlock). It
changes neither one's model. The App Store identity, the domains and
every deployment remain owner decisions; see
[Owner decisions and authorizations](#owner-decisions-and-authorizations).

## Context

### What the native app does today

- `apps/ipad` is a Swift `WKWebView` shell. It serves the built web app
  from the app bundle through a `WKURLSchemeHandler` on the private origin
  `zcad-ipad://app` (`apps/ipad/Sources/BundleServer.swift`). The handler
  answers only `GET` and `HEAD` for files under the bundle's `Web` folder.
  Every response carries a CSP with `connect-src 'self'` and no
  `frame-src` directive, so frames fall back to `default-src 'self'`.
- Navigation is refused unless the URL is exactly the workspace origin
  (`WorkspaceViewController.isWorkspaceURL` in
  `apps/ipad/Sources/WorkspaceViewController.swift`). `blob:` URLs and
  workspace URLs may become downloads.
- A document-start user script writes
  `openzcad-cloud-functions-enabled:v1 = 'false'` to `localStorage` on every
  load (`WorkspaceViewController.swift`). That is the web app's device-local
  cloud switch (`apps/web/src/lib/cloudMode.ts`). With it off, every
  network-backed function throws `CloudFunctionsDisabledError`, so the app
  is offline-only.
- The app has no entitlements file, no development team, no URL types in
  `Info.plist`, and no script message handlers. Its bundle identifier is
  `app.esau.openzcad.ipad.prototype` and its deployment target is iOS 17.0
  (`apps/ipad/OpenZCAD.xcodeproj/project.pbxproj`).

### How the web app authenticates

- **Sign-in is email codes only** (ADR-012). A successful verification sets
  the host-only `__Host-openzcad_session` cookie: `HttpOnly; Secure;
SameSite=Lax`, 30 days by default, sliding, capped at 90 days
  (`apps/web/worker/auth.ts`, `createSessionCookie`;
  `apps/web/worker/sessionCredentials.ts`).
- **The macOS app already has a native sign-in.** It uses a PKCE
  device-authorization flow (`apps/web/worker/auth.ts`;
  `apps/web/worker/index.ts`, `/api/auth/desktop/*`):
  - `start` takes a client id, a state and a PKCE challenge, and returns an
    8-character user code and a browser URL `/?desktopAuth=<attempt>`.
  - The person signs in with an email code in the system browser and
    approves the attempt there by typing the user code (`approve`).
  - The app redeems the attempt with its PKCE verifier (`exchange`). The
    exchange is single-use.
  - It gets a 15-minute bearer access token and a refresh token.
    `refresh` rotates the refresh token. Reusing a rotated or revoked
    refresh token revokes the whole session. `logout` revokes it.
- **The desktop keeps credentials out of the WebView.** Only one client id,
  `openzcad-macos`, is accepted (`DESKTOP_CLIENT_ID`). Tokens live in
  `desktop_access_tokens` and `desktop_refresh_tokens`. The refresh token
  is a macOS Keychain generic-password item
  (`apps/desktop/src-tauri/src/desktop_auth.rs`). Every cloud request goes
  through Rust (`desktopFetch` and `desktop_api_request` in
  `apps/web/src/lib/desktopBridge.ts`), "so bearer credentials never enter
  the WebView, localStorage, URLs, logs, or frontend bundles". Rust checks
  each path against an allowlist (`renderer_api_destination`).
- **Live rooms on the desktop.** The WebView opens the room WebSocket
  itself. Rust supplies a URL that carries a single short ticket
  (`desktopCollaborationUrl`). The desktop CSP allows only
  `connect-src … wss://zcad.app`
  (`apps/desktop/src-tauri/tauri.conf.json`).
- **The Worker sends no CORS headers.** No `Access-Control-Allow-*` header
  appears anywhere in `apps/web/worker`.
- **Server-side session ends.** A device-list write that removes a device
  deletes every other browser session and revokes every other desktop
  session (`endOtherSessions` in `apps/web/worker/e2ee.ts`). Account
  deletion deletes the desktop tokens (`apps/web/worker/accountDeletion.ts`).
- `DESKTOP_AUTH_ENABLED` is `"true"` for beta (`wrangler.jsonc`) and stable
  (`wrangler.stable.jsonc`).

### What passkeys are today

Passkeys are **not a sign-in method** in OpenZCAD. They are a local unlock
ceremony for ADR-024 account keys.

- `apps/web/src/lib/e2ee/passkeys.ts` (`browserPasskeys`) creates and
  asserts discoverable credentials. User verification is required. The RP
  ID is `location.hostname`.
- The challenge is 32 random bytes made in the browser (`challenge()`).
  **No Worker endpoint issues or checks a WebAuthn challenge, and no
  assertion is sent to the Worker.** The file says so ("WebAuthn is a local
  unlock ceremony, not email-session authentication").
- The secret is the **PRF extension** output (`prf.eval.first`). The input
  is fixed: `passkeyPrfInput()`, the UTF-8 bytes of
  `OpenZCAD E2EE v1 passkey unlock` (`packages/crypto/src/keys.ts`). The
  code does not use `largeBlob`.
- If creation enables PRF without evaluating it (Safari does), a second
  assertion is made, restricted to the new credential.
- The PRF output is accepted as an `ArrayBuffer`, an `ArrayBufferView`, or a
  plain `Array` of exactly 32 integers. It is copied and the provider's copy
  is erased in place (`prfBytes`).
- The credential is identified to ADR-024 as
  `pk_<sha256(rawId) hex>`. That id must match a target that the
  identity-signed device list certifies.
- Callers pick the implementation through the `PasskeyPrf` interface
  (`create`, `get`). `accountKeys.ts` and `SetupDialog.tsx` already accept
  an injected `ctx.passkeys` and fall back to `browserPasskeys`.
- `passkeysAvailable()` is false in the desktop app and in insecure
  contexts. ADR-024 records that "the desktop WebView has no WebAuthn and
  relies on the other methods".

### Why the plan's premise needs one correction

The plan describes Swift running passkey ceremonies "then hand[ing] the web
app a session". That joins two things the code keeps apart:

- **The session** comes from an email code.
- **Passkeys** unlock keys locally.

There are no Worker passkey endpoints to fetch challenges from. Making a
passkey into a sign-in credential would mean new server routes, a new
credential table and a change to ADR-012's identity boundary. This ADR
keeps the two apart. Sign-in reuses the existing desktop authorization.
The native passkey bridge does exactly what `browserPasskeys` does today,
for the same RP IDs. Passkey sign-in stays a possible later decision
([Alternatives](#alternatives-considered), item 4).

### Why passkeys cannot run in the WebView as it is

On `zcad-ipad://app`, `location.hostname` is `app`, which is not a domain
that any passkey could be bound to. WebAuthn there would fail, at best with
a `SecurityError`. It is unverified whether WebKit exposes
`PublicKeyCredential` on a custom-scheme origin at all.

The same is true of cookies. The session cookie is host-only on the web
domain and `SameSite=Lax`, and the Worker answers no CORS. So a request
from the custom origin carries no session and is not readable even if
sent.

## Decision

### 1. Bridge flow

#### Two native capabilities, one message handler

The shell registers one `WKScriptMessageHandlerWithReply`, named
`openzcadNative`, in the `.page` content world. It is added only once the
workspace has finished its bootstrap and is on `zcad-ipad://app`. It never
exists in the legacy loopback bootstrap state.

It offers:

- **Session operations.** Sign in, read status and sign out. The session
  token itself never crosses the bridge (see [Session](#3-session)).
- **Passkey operations.** Create and get, each returning a PRF output for
  ADR-024 unlock.

Cloud HTTP requests do **not** go through the message handler. They go
through the scheme handler (see [Session](#3-session)).

#### Message schema (version 1)

Request, posted with
`window.webkit.messageHandlers.openzcadNative.postMessage(request)`:

```ts
type NativeRequest =
  | { v: 1; op: 'capabilities' }
  | { v: 1; op: 'session.status' }
  | { v: 1; op: 'session.signIn' }
  | { v: 1; op: 'session.signOut' }
  | { v: 1; op: 'session.prepare' }
  | { v: 1; op: 'passkey.create' }
  | { v: 1; op: 'passkey.get'; allowCredential?: string }; // base64url raw id
```

Reply (resolved by the `postMessage` promise):

```ts
type NativeReply =
  | { ok: true; result: unknown }
  | { ok: false; error: { name: string; message: string } };

// capabilities  → { bridge: 1, passkeys: 'supported' | 'unsupported',
//                   realm: 'beta' | 'stable', apiHost: string }
// session.status, signIn, signOut → { signedIn: boolean } (no token, no email)
// session.prepare → { handle: string | null } (opaque single-send handle, never a token)
// passkey.*     → { rawId: string /* base64url */, prf: number[] /* 32 */,
//                   label?: string /* create only */ }
```

The rules for these messages:

- **Validation.** Native validates every field. It refuses an unknown `v`,
  an unknown `op`, extra keys, and any `allowCredential` that is not
  1–1023 bytes of base64url. A refusal is
  `{ ok: false, error: { name: 'NotSupportedError', … } }`.
- **Error names.** Errors use the WebAuthn `DOMException` names that
  `ceremonyFailure` in `passkeys.ts` already maps to messages:
  `NotAllowedError` for cancelled or timed out, `InvalidStateError`,
  `NotSupportedError`, `SecurityError` and `ConstraintError`. Existing copy
  and tests therefore apply unchanged.
- **PRF output is a plain array.** `prf` is an `Array` of 32 integers
  because the reply bridge carries strings, numbers, arrays and
  dictionaries, not `ArrayBuffer`. `prfBytes` already accepts that exact
  shape and zeroes the array in place after copying it. A base64 string is
  forbidden: JavaScript strings cannot be erased.
- **Native owns the ceremony inputs.**
  - The PRF input is a Swift constant equal to `passkeyPrfInput()`. A test
    compares the two byte for byte.
  - The challenge is 32 bytes from `SecRandomCopyBytes`.
  - The random user handle and its label are made natively, in the same
    form as the web's: `OpenZCAD encryption <12 hex>`.
  - The page cannot choose the RP ID, the PRF salt, the challenge or the
    user. A compromised page can therefore obtain only the secret the real
    app would obtain, and only after the person's own Face ID, Touch ID or
    passcode check in system UI that names the domain.
- **`passkey.create` mirrors `browserPasskeys.create`.** It makes a platform
  credential with user verification required and the PRF extension. If
  registration enables PRF without an output, it makes a second assertion
  restricted to that credential, and checks that the same credential was
  returned. It returns one result. If it fails after the credential was
  created, the reply's error carries `rawId`. The web side then gives the
  same cleanup advice it gives today (`failedPasskeyEnrollment`).
  AuthenticationServices has no `signalUnknownCredential`
  (unverified), so the advice is the manual form.
- **One ceremony at a time.** A second passkey request while one is open is
  refused with `InvalidStateError`. After a cancellation, a new request is
  refused for one second, so a hostile page cannot loop system prompts.

#### Origin check

Native handles a message only when **all** of these hold. Otherwise it
replies with `SecurityError` and does nothing else.

- `message.webView` is the workspace's own `WKWebView`.
- `message.frameInfo.isMainFrame` is true.
- `message.frameInfo.securityOrigin` is scheme `zcad-ipad`, host `app` and
  port 0.
- `message.frameInfo.request.url` passes `isWorkspaceURL`.
- The controller is in its workspace bootstrap state, not legacy or copy.

To make "main frame only" a design property rather than a filter, the
bundle CSP gains `frame-src 'none'` and `child-src 'none'`, as the desktop
CSP already has `frame-src 'none'`. Workers stay on `worker-src 'self'
blob:`. Workers cannot post to message handlers.

#### Web-side adapter

`apps/web/src/lib/nativeShell.ts` (new) detects the bridge.
`window.webkit?.messageHandlers?.openzcadNative` must exist and
`capabilities` must answer `bridge: 1`.

- `nativePasskeys: PasskeyPrf` calls the bridge. It computes `targetId`
  from `rawId` with the existing `selected()` path, and copies `prf` with
  the existing `prfBytes()`. Every ADR-024 check after that is unchanged.
- The account-key context passes `passkeys: nativePasskeys` where today it
  falls back to `browserPasskeys`.
- `passkeysAvailable()` and `passkeyPrfSupport()` return the bridge's
  answer in the shell.
- **The shell never calls `navigator.credentials`.** On
  `location.protocol === 'zcad-ipad:'`, a missing bridge means "no
  passkeys", never "try WebAuthn". See downgrade in the
  [threat model](#5-threat-model).

### 2. Entitlement and server

#### App entitlement

The release app gets an entitlements file with one associated domain per
RP ID it uses:

```xml
<key>com.apple.developer.associated-domains</key>
<array>
  <string>webcredentials:zcad.app</string>
</array>
```

A beta or TestFlight build uses `webcredentials:beta.zcad.app` instead.
Development builds may add `?mode=developer` while a device is in developer
mode. Only `webcredentials:` is declared. There is no `applinks:` and no
`appclips:`. The app claims no web URLs and receives no universal links.

#### RP IDs per realm

The native RP ID must equal the hostname that the same realm's web app
uses as `location.hostname`. A passkey synced through iCloud Keychain then
unlocks both Safari and the app:

| Realm  | Web host        | Native RP ID / API host | Notes                                                                                                                                                                                            |
| ------ | --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stable | `zcad.app`      | `zcad.app`              | Same host as the desktop API (`DESKTOP_API_HOSTNAME` in `apps/web/src/lib/deploymentRealm.ts`). Passkeys made on `stable.zcad.app` have that RP ID and do not work here (ADR-024, host binding). |
| beta   | `beta.zcad.app` | `beta.zcad.app`         | A separate build configuration with its own bundle ID.                                                                                                                                           |

#### The `apple-app-site-association` file

The Worker serves `GET /.well-known/apple-app-site-association` with status
200 and `Content-Type: application/json`, with no redirect. The body is:

```json
{ "webcredentials": { "apps": ["<TEAM_ID>.<BUNDLE_ID>"] } }
```

- **Served by the Worker, not as a static asset.** The path joins
  `run_worker_first` so the content type is explicit and the body comes
  from configuration.
- **Configuration.** The body comes from a new optional variable,
  `APPLE_WEBCREDENTIALS_APP_IDS`: a comma-separated list, each entry
  checked against `^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$`. When the variable is
  unset, the route answers 404.
- **Exact hosts only.** The file is served only on the hosts the
  entitlement names: `zcad.app` for stable and `beta.zcad.app` for beta.
  The stable Worker also answers `stable.zcad.app`, and there the route
  answers 404.
- **No secrets.** The file holds no secret. Apple fetches it through its
  own CDN when the app is installed and periodically after that, so a
  change takes effect with a delay (unverified for how long; Apple's
  documentation governs).

| Environment                                   | AASA                                                                                                                                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| beta (`wrangler.jsonc`)                       | The beta app ID, once the owner provides it and authorizes the deploy.                                                                                                                                                              |
| stable (`wrangler.stable.jsonc`)              | The release app ID, once the owner provides it and authorizes the deploy.                                                                                                                                                           |
| self-host (`wrangler.selfhost.example.jsonc`) | Off: the variable is unset. An App Store build's entitlement lists fixed domains, so it cannot use a self-hosted domain. A self-hoster with their own Apple team can build the app with their own entitlement and set the variable. |
| local dev                                     | Off. Device testing uses a developer-mode entitlement against beta.                                                                                                                                                                 |

**Owner decisions:** the Apple Developer team ID, the bundle IDs (release
and beta), and the realm-to-domain mapping above.

### 3. Session

#### How a session is obtained

The app reuses the desktop PKCE authorization unchanged in shape:

- **A second client id.** The Worker accepts `openzcad-ios` as well as
  `openzcad-macos`, as an allowlist instead of the single
  `DESKTOP_CLIENT_ID`. The allowlist applies at **every** layer that checks
  the client today, not only the request parser:
  - the access-token validator (`apps/web/worker/auth.ts`, the
    `row.client_id !== DESKTOP_CLIENT_ID` check on `desktop_access_tokens`);
  - the refresh path, which already compares against the requesting client;
  - the E2EE write guard (`apps/web/worker/e2eeWriteAuthorization.ts`, the
    literal `client_id = 'openzcad-macos'` in its transaction SQL).

  Missing any one of them issues a token that `/api/session` or an
  encrypted key write then rejects. The approval page names the client being approved
  ("OpenZCAD for iPhone and iPad"). Its user-code messages stop saying
  "macOS" for that client.

- **Starting.** `session.signIn` makes Swift generate the state and the
  PKCE verifier and call `start`. Native UI shows the user code, then
  opens the returned approval URL in an `ASWebAuthenticationSession`. That
  page is on the real https origin, so Turnstile and the email code work
  as they do on the web.
- **Never prefill the code.** The user code is never put in the URL. A
  link carrying an attacker's attempt and code is exactly the phishing
  shape the code exists to stop.
- **Finishing.** Swift then calls `exchange` with the verifier, as
  `poll_desktop_sign_in` does, and closes the sheet once the exchange
  succeeds. No callback URL carries anything. The verifier never leaves
  the process, so another app that registers a look-alike scheme gains
  nothing.
- **Ephemeral browser session.** `prefersEphemeralWebBrowserSession` is
  `true`, so the sheet does not share Safari's cookies. The person enters
  an email code each time they sign the app in. That costs one code per
  app sign-in, which happens rarely because the refresh lasts 30 days. In
  return, a Safari session someone left signed in on a shared device
  cannot approve the app silently. **Owner decision:** whether to accept
  that cost, or allow the shared Safari session for one-tap approval.

#### How the session reaches requests

Two options were compared.

| Option                                    | How                                                                                                                                                                                                                                                                                                    | Security                                                                                                                                                                                                                                                                                                                                                                                                                | Cost                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **A. CSP and CORS**                       | Add `https://<api host>` to `connect-src`. The Worker answers CORS for the app's origin. The web app holds a bearer token in JavaScript, because the cookie is not sent: it is host-only, `SameSite=Lax` and third-party from the custom scheme.                                                       | The token is readable by any script in the content process, and by every log or error path in the web app. That is what the desktop design explicitly forbids. CORS becomes a new surface on every API route for every web user. It is unverified whether WebKit serialises a custom-scheme origin as `zcad-ipad://app` or as `null`. Allowing `null` would admit sandboxed frames and `data:` documents from anywhere. | A Worker change across all routes. Preflights on every write.                                |
| **B. Native proxy in the scheme handler** | The web app fetches `zcad-ipad://app/api/…`, which is same-origin and satisfies `connect-src 'self'` unchanged. `BundleServer` sends `/api/*` to a separate native client. That client attaches the bearer, follows no redirects, enforces size limits and a path allowlist, and returns the response. | The token never enters the WebView, as on the desktop. The Worker and its CORS posture are unchanged. The web gate `checkProjectRequest` still runs immediately before the `fetch`.                                                                                                                                                                                                                                     | Swift work equal to `desktop_api_request`. HTTP only: WebSockets need the ticket path below. |

**Decision: B.** It is the desktop's posture, already reviewed, on a
different native host.

Its requirements:

- **Routing.** `sendCloudRequest` in `desktopBridge.ts` gains a shell branch
  that rewrites `/api/…` to `zcad-ipad://app/api/…` and calls `fetch`. The
  `prepared` single-send handle that protects project writes
  (`sendNativeProjectRequest`) becomes a request header
  (`x-openzcad-prepared`), obtained from a `session.prepare` bridge call.
  Native strips that header before forwarding.
- **Prepared sends keep the desktop contract** (`send_authenticated` in
  `apps/desktop/src-tauri/src/desktop_auth.rs`):
  - `session.prepare` readies one credential, the access token and the
    session it belongs to, under a fresh handle. A send carrying that handle
    uses **exactly that credential**, never the proxy's current one, so an
    account switch between the page's project check and the send cannot put
    the old account's queued data under the new account.
  - A handle is single-use and short-lived. A missing, unknown, used or
    expired handle, or one whose session has ended, sends nothing; the page
    gets a 401.
  - A 401 on a prepared send drops that credential. Native never retries a
    prepared send. The page readies a new handle and runs
    `checkProjectRequest` again before any retry (`desktopBridge.ts`).
  - Only requests without a handle may refresh an expiring credential and,
    after a 401, refresh and send once more.
- **Methods and paths.** The proxy accepts `GET`, `HEAD`, `POST`, `PUT`,
  `PATCH` and `DELETE` only under `/api/`. It mirrors the Rust
  `renderer_api_destination` allowlist and its share-token header
  handling. Navigation to `/api/*` is refused in `decidePolicyFor`.
- **Admission before the bearer.** Scheme tasks do not pass through the
  message handler's main-frame check, so the proxy admits a request itself
  before attaching any credential:
  - the URL is exactly `zcad-ipad://app/api/…` (scheme, host, no port or
    user info), the method and path are on the allowlist, and the web
    view's committed main document is the workspace origin;
  - anything else fails with no upstream request.
- **Upstream requests are rebuilt, not copied.** Native builds each upstream
  request from an explicit header allowlist (content type, accept,
  conditional-request headers, the share-token header and the web app's own
  `x-openzcad-*` headers, enumerated in PR 3 against
  `renderer_api_destination`), then adds the bearer. It never forwards
  `Origin`, `Referer`, `Cookie` or `Sec-Fetch-*`. The Worker's
  `assertSameOrigin` (`apps/web/worker/index.ts`) rejects a foreign
  `Origin`, and like the desktop's native client the proxy sends none: the
  request carries no ambient credential, only the bearer native chose after
  admission, so the cross-origin signal has nothing to protect.
- **No cookies.** The proxy's `URLSession` uses an ephemeral configuration
  with `httpShouldSetCookies = false`, `httpCookieAcceptPolicy = .never` and
  no URL cache. Native drops `Set-Cookie` from every response it returns to
  the page.
- **Responses are never executable.** API responses would be same-origin,
  and `script-src 'self'` would otherwise allow
  `<script src="/api/…">` or `new Worker('/api/…')`. So the proxy:
  - passes through only `application/json`, `application/octet-stream` and
    the project frame types the web app negotiates, and replaces any other
    type with `application/octet-stream`;
  - adds `X-Content-Type-Options: nosniff`;
  - adds `Content-Security-Policy: default-src 'none'; sandbox`.
- **Request bodies.** It is unverified whether `WKURLSchemeTask` exposes
  every body the web app sends: `httpBody` versus `httpBodyStream` for
  `Blob` and `ReadableStream` bodies. The first Swift PR must establish
  this. Where it does not, those requests use the desktop's byte-array
  form over the message handler, as `desktop_api_request` does.
- **Live rooms.** As on the desktop, native fetches a project's collaboration
  ticket and returns `wss://<api host>/api/projects/<id>/collaboration?ticket=…`.
  The web side validates that URL exactly as `desktopCollaborationUrl`
  does. The bundle CSP adds only `connect-src 'self' wss://<api host>`.
  The ticket is in the URL, so it is visible to the content process. That
  is accepted on the desktop and is no wider here.
- **Cloud switch.** The document-start script that forces the cloud switch
  off is kept for builds without the bridge. Once a build has the bridge,
  the script is removed and the web app's own device-local switch applies.

#### Where the session lives

- **Refresh token.** A Keychain generic-password item:
  - service: the bundle ID;
  - account: `ios-refresh`;
  - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`;
  - `kSecAttrSynchronizable = false`.

  It is never in `localStorage`, IndexedDB, `UserDefaults`, a file, a URL
  or a log. `ThisDeviceOnly` keeps it out of iCloud Keychain and out of
  backups restored to another device.

- **Access token.** Native process memory only.
- **Keychain items survive app deletion.** On first launch after an
  install (no `UserDefaults` marker), the app deletes any leftover item.

#### Lifetime

The server rules are unchanged:

- The access token lasts 15 minutes (`DESKTOP_ACCESS_TOKEN_TTL_SECONDS`).
- Each refresh rotates the refresh token and sets its expiry to
  `AUTH_SESSION_DAYS` (30 by default).
- Reusing a rotated token revokes the session.

Whether a desktop refresh chain has an absolute cap, like the browser's 90
days, is unverified. This ADR adds none; it would apply to both clients.

**Refreshes are serialised.** Reusing a rotated refresh token revokes the
session (`apps/web/worker/auth.ts`), so two requests that both find an
expired access token must not both refresh:

- One refresh is in flight at a time, shared by every request that needs
  it, as the desktop's `refresh_guard` does. Requests that waited use the
  credential it produced.
- Each sign-in starts a new session generation. A refresh that completes
  after its session ended (sign-out, revocation or another sign-in) is
  discarded: its tokens are never stored in the Keychain or used.

#### Sign-out and revocation

- **Signing out in the app.**
  1. The web app calls `session.signOut`.
  2. Native calls `/api/auth/desktop/logout`.
  3. Native deletes the Keychain item and the in-memory access token
     **whether or not the call succeeded**, then replies.
  4. The web app then runs its existing sign-out teardown. Ending the key
     session aborts pending passkey ceremonies, as on the web
     (`subscribeKeySession` in `passkeys.ts`).
- **Revocation from the server or another device.** Three things revoke an
  app session:
  - a device removal elsewhere (`endOtherSessions`);
  - account deletion;
  - a detected refresh reuse.

  The app then gets a 401, and native's refresh fails. Native deletes the
  Keychain item and answers the original request 401. The web app reads
  `session.status`, finds `signedIn: false`, and signs out locally. Nothing
  is pushed into the page.

- **Visibility.** App sessions are rows in the desktop token tables under
  their own `client_id`, so they appear wherever desktop sessions do, for
  example in the account export (`apps/web/worker/accountExport.ts`).

### 4. E2EE key material (ADR-024)

- **What crosses the bridge.**
  - Only `passkey.*` replies carry secret material: one 32-byte PRF output
    per ceremony, as a plain array, in the reply to the main-frame call
    that asked for it.
  - Nothing else crosses: no account key, identity key, device key or
    recovery key, in either direction.
  - Nothing secret goes to native.
- **Native handling.**
  - The PRF output (a CryptoKit `SymmetricKey`) is read once into the
    reply array. Native keeps no reference to it after replying.
  - It is never logged. The handler logs, in DEBUG builds only, the op and
    whether it succeeded, never a payload. It is never written to the
    Keychain, `UserDefaults`, a file or a crash breadcrumb.
  - Swift cannot guarantee memory erasure of CryptoKit storage. This is the
    same best effort ADR-024 accepts for browser memory.
- **Web handling.** This is unchanged and already enforced in
  `passkeys.ts` and `accountKeys.ts`:
  - `prfBytes` copies the output and zeroes the array it was given.
  - The secret opens the target's private key and is then erased in the
    caller's `finally`.
  - The account key and encryption key stay in the key session's memory.
  - The identity key is opened only for an operation and never cached.
  - Pending ceremonies are invalidated when the key session ends.
- **Ceremonies expire with their key session.** The browser path aborts its
  credential request and erases late results when the key session ends
  (`passkeys.ts`). The native path must match it:
  - Every `passkey.*` call carries a ceremony id, and the adapter records
    the key-session generation that started it.
  - When the key session ends, the adapter sends `passkey.cancel` for each
    pending ceremony. Native cancels the `ASAuthorizationController`
    request and drops any reply for a cancelled ceremony.
  - A reply that still reaches the adapter for a cancelled ceremony, or
    after the generation changed, is zeroed at once and never delivered to
    a caller.
  - Test: locking during an open system prompt delivers no PRF bytes, and
    the late array is zeroed.
- **Other frames.** There are none: `frame-src 'none'` plus the main-frame
  check. Workers cannot reach message handlers.
- **Device keys.** The app is its own ADR-024 device. Its device signing
  and unlock keys are non-extractable WebCrypto keys in the app origin's
  IndexedDB, the web model, in the WebView's persistent data store. A
  native Keychain or Secure Enclave device store, like the desktop's
  `device_keys.rs`, is a possible later change and not part of this
  decision.
- **Prerequisite.** ADR-024 needs WebCrypto, which needs a secure context.
  It is unverified whether WebKit treats `zcad-ipad://app` as a secure
  context (`isSecureContext`, `crypto.subtle`). The first Swift PR must
  establish it. If it is not one, E2EE cannot run in the app and this
  decision must be revisited before any key code ships.
- **Multiple devices.** Safari on the same iPhone is a different origin and
  therefore a different device with different IndexedDB. Unlocking the
  app is a new-device unlock:
  - a passkey (the common path, if the person has one for that RP ID);
  - approval from another device by the six-digit compare (the QR scan
    needs a camera flow the app does not have);
  - or the recovery key.

  ADR-024's first-sight freshness limit applies, as for any new browser.

- **Recovery.** Unchanged. Typing the recovery key in the app works as on
  the web. Removing the app's device elsewhere revokes its session
  (`endOtherSessions`). Deleting the app deletes its WebKit data store and,
  through the first-launch rule, its Keychain item. Its device entry stays
  until it is removed in Settings › Encryption, which offers removal after
  30 unused days.
- **Platform minimum.** AuthenticationServices exposes PRF from iOS 18
  (`ASAuthorizationPublicKeyCredentialPRFAssertionInput` and the matching
  registration input; to be confirmed against the SDK when implemented).
  The app's deployment target is 17.0. On iOS 17, `capabilities` reports
  `passkeys: 'unsupported'` and Settings offers the other methods, as on
  the desktop. **Owner decision:** whether to raise the minimum to iOS 18
  instead.
- **Gating device test.** A credential created in Safari on the RP ID must
  yield the same PRF output in the app, and the reverse. Native PRF must
  apply WebAuthn's salt transform, `SHA-256("WebAuthn PRF" ‖ 0x00 ‖ input)`,
  as browsers do. Otherwise a passkey enrolled on the web will not unlock
  the app. This is unverified until a real-device test passes. That test
  gates the passkey PR.

### 5. Threat model

- **A compromised web content process** can do what the page can already
  do:
  - send API requests through the proxy with the person's authority, as
    the desktop renderer can;
  - read decrypted data and unlocked keys in memory. ADR-024 already
    excludes altered application code from what encryption protects.

  The bridge adds no new reach:
  - The process **cannot** read the access or refresh token.
  - It cannot pick the RP ID, PRF salt, challenge or user.
  - It cannot reach paths outside the proxy allowlist.
  - It can get a PRF output only after the person passes a system
    biometric or passcode prompt that names the domain.
  - Prompt loops are bounded by one ceremony at a time and the cooldown.

- **Injected scripts.** The web app runs only bundled, immutable files.
  This ADR keeps that:
  - The `BundleServer` file path stays `GET`/`HEAD` on the bundle folder.
    `/api/*` is a separate code path that never reads files.
  - Its responses are made non-executable (content-type allowlist,
    `nosniff`, sandbox CSP).
  - `script-src 'self' 'wasm-unsafe-eval'` gains no remote source.
  - Navigation stays on the workspace origin.
  - The user script that forces the cloud switch off is removed, not
    replaced. No new user script is injected.
- **Malicious deep links.** The app registers no URL schemes and no
  `applinks:`, so no link can drive it. `zcad-ipad` is a WebKit scheme
  handler, not a `CFBundleURLTypes` entry. Email and approval links keep
  opening in Safari. The sign-in sheet's result travels by the PKCE
  exchange, not a callback, and the user code is never accepted from a URL.
- **Downgrade to the web flow.**
  - The shell never calls `navigator.credentials`, so it cannot fall back
    to a WebAuthn ceremony on a hostname an attacker chose. WebAuthn on
    `zcad-ipad://app` would fail anyway.
  - The shell never uses cookies, so there is no cookie session to fall
    back to.
  - A missing or broken bridge means offline mode or the other unlock
    methods, never weaker ones.
  - Old app builds without the bridge stay offline-only.
- **Replay.**
  - Passkey assertions are not verified by any server, so a replayed
    assertion proves nothing. What matters is the PRF output, which is as
    sensitive as on the web and handled the same way.
  - The sign-in exchange is single-use and bound to the PKCE verifier.
  - Refresh tokens rotate, and reuse revokes the session.
  - Each bridge reply is one-shot: `WKScriptMessageHandlerWithReply` calls
    its reply handler once.
  - The `x-openzcad-prepared` handle is single-send, as the desktop's is.
- **Lost or stolen device.** The refresh token is
  `AfterFirstUnlockThisDeviceOnly`. Removing the device from another device
  revokes the session and rotates keys (ADR-024).

### 6. Rollout and testing

PRs, in order. Each is reviewed as security-sensitive work regardless of
size (plan, slice 13):

1. **This ADR.**
2. **Worker.**
   - The client-id allowlist (`openzcad-macos`, `openzcad-ios`) at every
     layer: the request parser, the access-token validator, the refresh
     path and the E2EE write guard. Per-client approval wording.
   - Tests that an iOS credential reads `/api/session` and writes E2EE key
     records, and that an unknown client id fails at each layer.
   - The AASA route behind `APPLE_WEBCREDENTIALS_APP_IDS`, off by default,
     with exact-host checks.
   - Unit tests for unknown clients, the AASA body, 404 when unset, the
     content type and no redirect.

   Merging deploys nothing new by itself until the variable is set.

3. **Swift session and proxy, plus the web transport.**
   - The `/api/*` proxy in the scheme handler, the Keychain store, and
     sign-in and sign-out through `ASWebAuthenticationSession`.
   - The `openzcadNative` handler with `capabilities` and `session.*`, and
     the origin check.
   - The CSP changes (`frame-src`, `child-src`, `wss:`), and removal of the
     forced cloud-off script for bridge builds.
   - `nativeShell.ts` and the `sendCloudRequest` shell branch.
   - Establishes the secure-context and request-body questions first.
4. **Swift passkeys, plus `nativePasskeys`.**
   - The entitlements file and the `passkey.*` ops.
   - The PRF constant parity test and the adapter.
   - Passkeys disabled below iOS 18.
5. **Device QA.** An "OpenZCAD iOS app" row in
   `docs/qa/passkey-compatibility.md`, and the real-device script results.

| What                                                                                        | Simulator                | Real device + signed build |
| ------------------------------------------------------------------------------------------- | ------------------------ | -------------------------- |
| Message schema, validation, origin check (XCTest); web adapter with a fake bridge (Vitest)  | yes                      | —                          |
| Proxy allowlist, content-type rewriting, `nosniff`/sandbox headers, navigation refusal, CSP | yes                      | —                          |
| Proxy admission, header allowlist (no `Origin`/`Cookie`), cookies off, `Set-Cookie` dropped | yes                      | —                          |
| Prepared handle: exact credential, single use, no native retry, stale handle sends nothing  | yes                      | —                          |
| One shared refresh; a refresh finishing after sign-out is discarded                         | yes                      | —                          |
| Locking during a passkey prompt delivers nothing and zeroes a late reply                    | unverified (treat as no) | **required**               |
| Keychain store and first-launch cleanup                                                     | yes (simulator Keychain) | confirm                    |
| PKCE sign-in against beta through `ASWebAuthenticationSession`                              | yes, with beta access    | confirm                    |
| Secure context and `crypto.subtle` on `zcad-ipad://app`                                     | yes                      | confirm                    |
| Associated-domains verification through Apple's CDN                                         | no                       | **required**               |
| Passkey create and get with PRF, Face ID, iCloud Keychain sync                              | unverified (treat as no) | **required**               |
| Same PRF output for one credential in Safari and in the app                                 | no                       | **required** (gates PR 4)  |
| Revocation: device removal elsewhere signs the app out                                      | yes, with beta access    | confirm                    |

### Owner decisions and authorizations

Needed before the PRs that depend on them:

1. **Apple Developer team ID and bundle IDs** for the release and beta
   builds, replacing `app.esau.openzcad.ipad.prototype`. Needed for the
   entitlement and the AASA (PRs 2–4).
2. **Domains:** confirm stable → `zcad.app` and beta → `beta.zcad.app` as RP
   IDs and API hosts, and that `stable.zcad.app` is excluded.
3. **Worker deploys:** authorization to set `APPLE_WEBCREDENTIALS_APP_IDS`
   and deploy the AASA route to beta, then to stable. Self-host stays off.
4. **App Store and TestFlight:** the submission itself, the export-compliance
   answer (the app performs end-to-end encryption), and a sign-in path for
   App Review. Email codes need a reviewer-reachable mailbox; ADR-012's QA
   capability is beta-only. Whether guideline 4.8 (Sign in with Apple)
   applies to first-party email-code sign-in is unverified and the owner's
   call.
5. **Policy choices made in this ADR:** an ephemeral sign-in sheet versus
   the shared Safari session, and iOS 18 as the minimum for passkeys versus
   gating passkeys by version.
6. **Whether passkey sign-in is wanted later.** That is a separate ADR
   amending ADR-012, not part of slice 13.

## Consequences

- The iOS app can sign in, sync, join live rooms and unlock encrypted
  projects. Its bundle stays immutable and offline-capable, and no session
  credential is in the WebView.
- No new server authentication model. The Worker gains a second desktop
  client id and an optional, configuration-driven AASA route.
- The web app gains a third transport beside the browser and Tauri, and a
  second `PasskeyPrf` implementation. ADR-024's key handling is untouched.
- `BundleServer` stops being "files only". Its README statement ("no
  document, write, proxy … endpoints") must be revised in PR 3, and the
  proxy path is held to the desktop's allowlist discipline.
- Passkey unlock in the app depends on iOS 18, Apple's AASA CDN and PRF
  parity with Safari. Until the device test passes, the app relies on
  device approval and the recovery key.
- A self-hosted deployment cannot use passkeys in the App Store build.

## Alternatives considered

1. **Serve the app from the https domain.** The WKWebView would load
   `https://zcad.app`, where WebAuthn works with associated domains and
   the cookie session works unchanged. **Rejected.**
   - It loses the bundled offline origin, which the owner decided to keep,
     and moves the app's IndexedDB to a different origin than today's
     local projects.
   - It turns the app into a remotely updated web wrapper. ADR-024 counts
     server-delivered code as the web's weaker trust position, and the
     signed bundle as the stronger one.
   - It invites App Store review questions about minimum functionality
     (unverified).
2. **Run the passkey ceremony in `ASWebAuthenticationSession`.** The sheet
   would open a page on the real domain that runs WebAuthn.
   **Rejected for passkeys; kept for the email-code approval step.**
   - The PRF output would have to come back to the app through the
     callback URL. URLs are logged, kept in history and readable by other
     handlers.
   - The keys it unlocks live in the app's WebView storage, which that page
     cannot reach.
   - For sign-in, the sheet returns nothing secret: the PKCE exchange
     carries the result. So it is the right tool there and is the
     mechanism in [Session](#3-session).
3. **CSP and CORS with a bearer in JavaScript.** **Rejected**; see option A
   in [Session](#how-the-session-reaches-requests).
4. **Passkeys as a sign-in method.** The Worker would issue and verify
   WebAuthn challenges, and Swift would run them as the plan first
   described. **Deferred.** It is a new identity method: routes, a
   credential table, enrollment and recovery rules, and an ADR-012
   amendment. The app does not need it, because email codes already
   produce a session and passkeys already unlock keys. It can follow
   without changing this bridge's schema beyond new ops.
5. **Native device keys in the Keychain or Secure Enclave**, as the desktop
   does with `device_keys.rs`. **Deferred.** It would add more native key
   code than the slice needs. WebCrypto in the app origin is the web
   model, which ADR-024 already reviews.
