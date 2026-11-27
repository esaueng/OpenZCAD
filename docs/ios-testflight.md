# iPhone and iPad builds on TestFlight

The universal app in [`apps/ipad`](../apps/ipad/README.md) goes to TestFlight
from GitHub Actions ([`testflight.yml`](../.github/workflows/testflight.yml)).
It uses `xcodebuild` and automatic signing with an App Store Connect API key,
so there are no profiles or fastlane setup to maintain. The one certificate it
needs is a long-lived Apple Development identity stored as a secret.

The Release configuration ships as **OpenZCAD** with bundle ID
`app.esau.openzcad.ios` (the identity recorded in ADR-026). Debug builds keep
the prototype identity, `app.esau.openzcad.ipad.prototype` and the name ZCAD
Prototype, so simulator and Xcode runs never replace an installed TestFlight
build or its projects. The app declares exempt encryption
(`ITSAppUsesNonExemptEncryption` false), so uploads skip the export-compliance
question.

TestFlight builds are the offline app: projects stay on the device and there
is no sign-in or sync until the native sign-in bridge (U12 slice 13).

## Shipping a build

Actions → TestFlight → Run workflow, on `main` (needs write access). It uses a
paid macOS runner, so it is manual only and never runs on pull requests.

- **Version** (`CFBundleShortVersionString`): the app version builds report,
  for example `2026.1.276` ([App versioning](versioning.md)). It matches the
  version the bundled web app shows in Settings.
- **Build number** (`CFBundleVersion`): the UTC time of the build
  (`20261127.91530` for 09:15:30), so it always increases, even when an older
  run is re-run.

The workflow uploads only main's current tip and stops otherwise: another
branch, or a re-run of an older run, would ship a lower version than one
already uploaded.

Apple processes an upload in about 10–30 minutes. Testers in an internal
TestFlight group with automatic distribution get it without further steps.

## One-time setup

1. In App Store Connect, create the iOS app: Apps → + → New App, platform iOS,
   name **OpenZCAD**, bundle ID `app.esau.openzcad.ios`. If the bundle ID is not
   in the list, register it first in Certificates, Identifiers & Profiles →
   Identifiers (an explicit App ID, no extra capabilities).
2. In the app's TestFlight tab, add an internal group, turn on automatic
   distribution, and add yourself as a tester.
3. In Users and Access → Integrations → App Store Connect API, use a team key
   with the **Admin** role (one key serves every app in the team). Admin is
   required: Xcode signs with a cloud-managed distribution certificate, and App
   Store Connect refuses that to App Manager keys ("Cloud signing permission
   error").
4. Add these repository secrets (Settings → Secrets and variables → Actions):

   | Secret                        | Value                                            |
   | ----------------------------- | ------------------------------------------------ |
   | `APPLE_TEAM_ID`               | Team ID (developer.apple.com → Membership)       |
   | `APP_STORE_CONNECT_KEY_ID`    | The key's ID                                     |
   | `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID shown above the keys                   |
   | `APP_STORE_CONNECT_API_KEY`   | Contents of the `.p8`                            |
   | `APPLE_SIGNING_P12`           | Base64 of an Apple Development identity's `.p12` |
   | `APPLE_SIGNING_P12_PASSWORD`  | That `.p12`'s password                           |

   ```sh
   gh secret set APP_STORE_CONNECT_API_KEY < AuthKey_XXXX.p8
   base64 -i signing.p12 | gh secret set APPLE_SIGNING_P12
   gh secret set APPLE_SIGNING_P12_PASSWORD
   ```

   Each runner starts with an empty keychain, and without an identity automatic
   signing creates a new Apple Development certificate on every run, until the
   account reaches Apple's limit. Create the certificate once (Xcode → Settings
   → Accounts → Manage Certificates → + → Apple Development), export it with its
   private key as a password-protected `.p12`, and store it as above. It
   expires after a year: make a new one, update both secrets, and revoke the
   old one.

The repository is public: the workflow masks the certificate holder's name in
the console and redacts the team, key and issuer IDs from failure logs before
uploading them. Keep the `.p8` in a password manager, never in the repository.

## Building locally

The same script runs on a Mac with Xcode and the repository's dependencies
installed:

```sh
APPLE_TEAM_ID=… APP_STORE_CONNECT_KEY_ID=… APP_STORE_CONNECT_ISSUER_ID=… \
APP_STORE_CONNECT_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_….p8 \
BUILD_NUMBER="$(date -u +%Y%m%d).$((10#$(date -u +%H%M%S)))" UPLOAD=0 \
scripts/testflight-ios.sh
```

It runs `pnpm prepare:ipad` first (set `SKIP_PREPARE=1` to reuse a staged
bundle). `UPLOAD=0` exports a signed `.ipa` without uploading. Leave it out to
upload, with a build number higher than any already in App Store Connect. Set
`MARKETING_VERSION` to override the computed version.
