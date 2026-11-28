# ZCAD iPad and iPhone prototype

This native Swift/WKWebView app runs on iPad and iPhone (one universal
target, `TARGETED_DEVICE_FAMILY = 1,2`) and packages the existing React
workspace and verified Remus WASM kernel. Its local projects use the existing document
format, feature history, undo, and persistent IndexedDB store. It works fully
offline; signing in connects it to the same cloud account as the web app
([Cloud account](#cloud-account)). Passkey unlock of encrypted projects,
Pencil double-tap/squeeze, and App Store review are not included. Release
builds go to internal TestFlight ([setup](../../docs/ios-testflight.md)).

## Build and run

Requirements: macOS, full Xcode with an iOS simulator runtime, Node and the
repository's pinned pnpm. No additional native dependencies are needed.

```sh
pnpm install --frozen-lockfile
pnpm dev:ipad
```

The runner chooses an available **iPad Pro 11-inch (M4)**, prefers one already
booted, builds the verified web assets, compiles the native target, installs
in place, and launches it. It preserves existing projects. When that model is
not installed (current Xcode ships the M5), it uses the newest installed iPad,
preferring another iPad Pro 11-inch, and says which. Set
`OPENZCAD_IPAD_SIMULATOR` to select another installed simulator by name or
UDID; an iPhone name runs the iPhone build. Logs and build products stay in
ignored `artifacts/ipad/`.

### iPhone

```sh
node scripts/run-ipad-simulator.mjs --iphone          # build and launch
node scripts/run-ipad-simulator.mjs --iphone --test   # native and UI tests
OPENZCAD_IPAD_SIMULATOR="iPhone Air" pnpm dev:ipad
```

`--iphone` targets an **iPhone 17**, falling back to the newest installed
iPhone in the same way. Both commands need `pnpm` on `PATH`, since they run
`pnpm prepare:ipad` first. The iPhone log is `artifacts/ipad/test-iphone.log`
(or `build-iphone.log`).

To work in Xcode or run on a physical iPad:

```sh
pnpm prepare:ipad
open apps/ipad/OpenZCAD.xcodeproj
```

Select the **ZCADiPad** scheme and an iPad or iPhone destination, then Run. A
physical device additionally requires a development team and device signing configured
in Xcode. Debug builds use the prototype's separate bundle identifier,
`app.esau.openzcad.ipad.prototype`; Release builds are the TestFlight app. Regenerate its icon with `pnpm brand:generate`.
Run `pnpm prepare:ipad` again after any shared web-source changes; Xcode copies
that prepared bundle rather than downloading the hosted site.

## Verification

```sh
node scripts/run-ipad-simulator.mjs --test
```

The shared scheme includes native resource-boundary, app-icon, private-origin,
storage-copy and phone/tablet idiom tests plus Xcode UI smoke tests against the
actual WKWebView. Run it on an iPad and with `--iphone`. On the phone the
smoke reaches header actions (Back to projects, Export STEP) through the
command bar, because the full layout's header sits under the status bar until
the compact header honours the safe area (U12 slice 2). The touch
sketch-and-extrude smoke is skipped on the phone until the compact sketch
layout (slice 6) gives it a phone flow.
The smoke uses a separate persistent WebKit data store and uniquely named
projects, preserving the development app's projects and last-opened model.

The workspace uses an app-private `zcad-ipad://app` origin through
`WKURLSchemeHandler`. Web Workers, WASM, and persistent IndexedDB work on that
origin without a TCP listener. Only immutable packaged files are readable;
there are no document, write, proxy, or directory-listing endpoints. Navigation
and the content security policy keep the workspace on that origin.

The earlier unshipped loopback prototype's local storage is copied once using
native-supplied bootstrap HTML; no HTTP content is fetched. Its original
IndexedDB records remain intact. The copy preserves schemas, indexes, record
keys, history, typed binary arrays, files, blobs, dates, and settings. An
unsupported record or a copy above 64 MiB fails without altering the original.

Exports use the native download delegate and Files export picker. The app's Documents folder is visible
in Files. The workspace fills the screen in portrait and landscape and the
Home indicator auto-hides. The app adopts the scene lifecycle required by
current iPadOS and iOS.

- **iPad:** all four orientations; the status bar is hidden.
- **iPhone:** portrait and both landscapes, never upside down. The status bar
  is shown, and the web content extends under it (`viewport-fit=cover`), so
  the web layout's `env(safe-area-inset-*)` keeps it clear of the notch or
  Dynamic Island. Until the compact layout lands, the full layout ignores
  those insets and its header sits under the status bar.
- **iPhone layout preference:** at document start on the private origin, the
  phone seeds the web app's `openzcad.layout:v1` setting to `compact` when it
  is unset. It never replaces a value the person chose, and does nothing until
  the web app reads that setting (U12 slice 2).

Simulator results qualify the shell and shared application integration. They
do not establish physical iPad or iPhone GPU/WASM memory budgets, Apple Pencil
hardware behavior, or low-memory recovery. Those remain real-device acceptance
work under L02/W01.

## Cloud account

Sign-in follows ADR-026 (proposed in PR #2182): the app reuses the macOS
app's PKCE device authorization at `/api/auth/desktop/*` as client
`openzcad-ios`, against `https://zcad.app` only.

- **Signing in.** Settings › Account › Sign in shows an 8-character code
  (copied to this device's pasteboard for ten minutes), then opens the
  approval page in a private `ASWebAuthenticationSession` sheet. After the
  email code and the app code there, Swift redeems the attempt with its PKCE
  verifier and closes the sheet (`NativeSignIn` in
  `Sources/NativeBridge.swift`).
- **Where the session lives.** The refresh token is a Keychain item
  (`ios-refresh`, after first unlock, this device only); the access token is
  in memory. Neither enters the WebView (`Sources/NativeSession.swift`).
- **Cloud requests.** The web app fetches `/api/*` on its own origin;
  `BundleServer` hands those to `ApiProxy`, which admits only the workspace,
  mirrors the desktop's route allowlist, rebuilds each request (content type
  and share token only, no `Origin` or cookies), attaches the bearer where the
  desktop does, and makes responses non-executable
  (`Sources/ApiProxy.swift`). A project write carries a single-use
  `x-openzcad-prepared` handle; one without the header is refused.
- **Message handler.** `openzcadNative` answers `capabilities` and
  `session.status|signIn|signOut|prepare` (schema version 1) to the
  workspace's main frame only. The page CSP refuses every frame.
- **Cloud switch.** Builds before this forced the web app's cloud switch off
  on every load; the first launch with the session releases it once, and the
  person's own choice in Settings applies from then on. UI tests keep it off.

WebKit facts this relies on, pinned by `Tests/NativeTransportProbeTests.swift`:
the private origin is a secure context with WebCrypto, and a scheme task
receives string and byte bodies whole but a `Blob` body empty (the web side
sends bytes). WebKit stores non-extractable WebCrypto keys in IndexedDB only
in a signed build, so simulator runs are signed to run locally.

## Not done yet

- **App Store release.** Release builds ship to internal TestFlight as
  OpenZCAD (`app.esau.openzcad.ios`) from the manual TestFlight workflow; see
  [iPhone and iPad builds on TestFlight](../../docs/ios-testflight.md). Debug
  builds keep the prototype identity. App Store review is not started.
- **Passkeys.** Unlocking encrypted projects with a passkey needs the
  `passkey.*` operations and the associated-domains entitlement (ADR-026,
  step 4). Until then `capabilities` reports passkeys unsupported, and the
  recovery key or another device unlocks.
- **Sign-in on a real device.** Simulator tests stub the cloud; the
  `openzcad-ios` client is admitted by the Worker in PR #2442.
- **Real-iPhone memory and GPU budgets.** Device evidence under W01; the
  simulator cannot show them.
