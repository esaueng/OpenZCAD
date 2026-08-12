# macOS release strategy

## Target and channels

- Direct-distribution DMG; defer the Mac App Store.
- Apple Silicon only (`aarch64-apple-darwin`) for the first channel.
- Bundle identifier: `app.esau.openzcad` (owner confirmation required before the
  first signed artifact because it becomes part of updates and system state).
- Declared minimum: macOS 14.0, pending tests on macOS 14 and 15.
- `beta` comes first for internal hardware and clean-install validation;
  `stable` is created only after every release gate below passes.

## Build levels

Developer and pull-request builds use the ad-hoc identity `-`. That gives an
Apple Silicon app a local signature but does not establish publisher identity or
remove Gatekeeper warnings for a downloaded artifact.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter @openzcad/web lint
pnpm test:web
pnpm --filter @openzcad/desktop test:e2e
pnpm build:desktop
```

The release output is under
`apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/`.

## Signed distribution build

Direct distribution requires a Developer ID Application certificate and Apple
notarization credentials. Tauri can read the signing identity from
`APPLE_SIGNING_IDENTITY`, overriding the ad-hoc development value. Notarization
can use App Store Connect API credentials (`APPLE_API_ISSUER`, `APPLE_API_KEY`,
and a protected `APPLE_API_KEY_PATH`) or the supported Apple ID flow.

Those secrets must live outside the repository and outside frontend build
variables. No release workflow or artifact publication is enabled yet. When the
credentials and destination are approved, the release job must build from an
immutable reviewed tag, sign, notarize, staple, and inspect the exact artifact
before any upload.

Required inspection includes:

```sh
codesign --verify --deep --strict --verbose=2 OpenZCAD.app
codesign -dv --verbose=4 OpenZCAD.app
spctl --assess --type execute --verbose=4 OpenZCAD.app
xcrun stapler validate OpenZCAD.app
xcrun stapler validate OpenZCAD_*.dmg
lipo -archs OpenZCAD.app/Contents/MacOS/openzcad-desktop
```

## Release gates

- Cloud authentication, refresh, logout, collaboration, and relaunch work with
  Keychain storage and no token leakage.
- CAD interaction and round-trip geometry checks in the compatibility matrix
  pass on every supported macOS version.
- The exact reviewed tag passes frontend, Rust, native WKWebView, and packaging
  CI with locked dependencies.
- App and DMG are Developer ID signed, notarized, stapled, and Gatekeeper-clean
  on a separate limited-permission Mac account.
- Version, release notes, support/rollback instructions, privacy impact, bundle
  identifier, and distribution destination receive owner approval.
- A signed Tauri updater is introduced only with separate beta/stable manifests,
  an offline backup of its private key, and interrupted-update recovery tests.

References: [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/),
[Tauri distribution](https://v2.tauri.app/distribute/), and
[GitHub's Apple Silicon runner](https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/).
