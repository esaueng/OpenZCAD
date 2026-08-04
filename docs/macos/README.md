# OpenZCAD for macOS

OpenZCAD's desktop target is a Tauri 2 application for Apple Silicon. It bundles
the existing React/Vite workspace and keeps geometry execution in the existing
browser workers. The Rust host is deliberately narrow: native menus, user-picked
CAD files, exports, and window-state restoration.

## Local development

Prerequisites:

- Apple Silicon Mac running macOS 14 or newer
- Xcode Command Line Tools
- Node 20.19+ or Node 22.12+ (Node 22 is used in CI)
- pnpm 10.8.0
- stable Rust with the `aarch64-apple-darwin` target

From the repository root:

```sh
pnpm install --frozen-lockfile
./script/build_and_run.sh
```

Other useful commands:

```sh
pnpm dev:desktop
pnpm build:desktop:app
pnpm build:desktop
pnpm --filter @openzcad/desktop test:e2e
```

`build:desktop:app` produces an Apple Silicon `.app`. `build:desktop` also
produces a DMG. Local and CI artifacts are ad-hoc signed for validation only;
they are not approved distribution builds.

## Release boundary

The current target is a working local-first desktop MVP. Cloud account features
are intentionally unavailable from the bundled origin until the dedicated
desktop authentication transport described in
[authentication-flow.md](authentication-flow.md) is implemented. Developer ID
signing, Apple notarization, stapling, and signed automatic updates are also
release gates, not hidden assumptions.

The remaining audit and release evidence lives in this directory:

- [existing-app-audit.md](existing-app-audit.md)
- [desktop-compatibility-matrix.md](desktop-compatibility-matrix.md)
- [native-feature-requirements.md](native-feature-requirements.md)
- [authentication-flow.md](authentication-flow.md)
- [release-strategy.md](release-strategy.md)
