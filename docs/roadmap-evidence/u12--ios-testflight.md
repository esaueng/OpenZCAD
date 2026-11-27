---
row: U12
---

iOS release path, internal TestFlight: the manual `TestFlight` workflow (`.github/workflows/testflight.yml`, `scripts/testflight-ios.sh`) archives the universal app and uploads it to App Store Connect with automatic signing and an App Store Connect API key. Release builds are OpenZCAD, `app.esau.openzcad.ios`, with exempt encryption declared; Debug keeps the prototype identity. The version is the app version builds report and the build number the UTC time. The App Store icon has no alpha channel (`scripts/opaque-png.mjs`, `test/brand-assets.test.ts`). Setup: `docs/ios-testflight.md`.
