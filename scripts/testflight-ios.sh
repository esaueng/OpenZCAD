#!/usr/bin/env bash
# Archives the universal iPhone and iPad app (apps/ipad) and uploads it to App
# Store Connect, where it becomes a TestFlight build. Used by
# .github/workflows/testflight.yml; it also runs locally on a Mac with Xcode.
#
# Signing is automatic and uses an App Store Connect API key: Xcode fetches or
# creates the profiles with the key. Archiving needs an Apple Development
# identity in the keychain (testflight.yml imports one from a secret); without
# one, Xcode creates a new certificate on every run.
#
# Required environment:
#   APPLE_TEAM_ID                  Apple Developer team ID
#   APP_STORE_CONNECT_KEY_ID       API key ID
#   APP_STORE_CONNECT_ISSUER_ID    API issuer ID
#   APP_STORE_CONNECT_KEY_PATH     path to the key's .p8 file
#   BUILD_NUMBER                   CFBundleVersion; must increase across uploads
# Optional:
#   MARKETING_VERSION              CFBundleShortVersionString; by default the
#                                  app version builds report (docs/versioning.md),
#                                  for example 2026.1.276
#   SKIP_PREPARE=1                 reuse the bundle `pnpm prepare:ipad` staged
#   UPLOAD=0                       export an .ipa instead of uploading it
#   WORK_DIR                       where the archive and logs go
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"
: "${APP_STORE_CONNECT_KEY_ID:?set APP_STORE_CONNECT_KEY_ID}"
: "${APP_STORE_CONNECT_ISSUER_ID:?set APP_STORE_CONNECT_ISSUER_ID}"
: "${APP_STORE_CONNECT_KEY_PATH:?set APP_STORE_CONNECT_KEY_PATH}"
: "${BUILD_NUMBER:?set BUILD_NUMBER}"
test -f "$APP_STORE_CONNECT_KEY_PATH" || { echo "No key file at APP_STORE_CONNECT_KEY_PATH" >&2; exit 1; }

bundle_id="app.esau.openzcad.ios"

if [ -z "${MARKETING_VERSION:-}" ]; then
  # The same number the web bundle stamps into build-meta.json. It needs the
  # history back to the base version's commit, and fails rather than ship the
  # bare base.
  MARKETING_VERSION="$(node --input-type=module -e '
    import { buildAppVersion } from "./scripts/app-version.mjs";
    const build = buildAppVersion(process.cwd(), { fetch: true, required: true });
    console.log(build.version);
  ')"
fi
case "$MARKETING_VERSION" in
  *[!0-9.]* | "" ) echo "MARKETING_VERSION must be numeric (got $MARKETING_VERSION)" >&2; exit 1 ;;
esac

work="${WORK_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/openzcad-testflight}"
rm -rf "$work"
mkdir -p "$work"

destination="upload"
if [ "${UPLOAD:-1}" = 0 ]; then destination="export"; fi

if [ "${SKIP_PREPARE:-0}" != 1 ]; then
  echo "Building and verifying the web bundle"
  pnpm prepare:ipad > "$work/prepare.log" 2>&1 || { tail -40 "$work/prepare.log" >&2; exit 1; }
fi
test -f apps/ipad/Resources/Web/index.html \
  || { echo "No staged web bundle; run pnpm prepare:ipad" >&2; exit 1; }

auth=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$APP_STORE_CONNECT_KEY_PATH"
  -authenticationKeyID "$APP_STORE_CONNECT_KEY_ID"
  -authenticationKeyIssuerID "$APP_STORE_CONNECT_ISSUER_ID"
)

archive="$work/OpenZCAD.xcarchive"
echo "Archiving version $MARKETING_VERSION ($BUILD_NUMBER)"
xcodebuild archive \
  -project apps/ipad/OpenZCAD.xcodeproj \
  -scheme ZCADiPad \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive" \
  "${auth[@]}" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  MARKETING_VERSION="$MARKETING_VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  > "$work/archive.log" 2>&1 || true
grep -E '(error|warning):|\*\* ARCHIVE' "$work/archive.log" || true
if ! grep -q '\*\* ARCHIVE SUCCEEDED \*\*' "$work/archive.log"; then
  echo "Archive failed; see $work/archive.log" >&2
  exit 1
fi

# Fail before uploading an app without its workspace or with the wrong identity.
app="$archive/Products/Applications/ZCADiPad.app"
test -f "$app/Web/index.html" || { echo "The archived app has no web bundle" >&2; exit 1; }
plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$app/Info.plist"; }
[ "$(plist CFBundleIdentifier)" = "$bundle_id" ] \
  || { echo "Archived bundle ID is $(plist CFBundleIdentifier), not $bundle_id" >&2; exit 1; }
[ "$(plist CFBundleShortVersionString)" = "$MARKETING_VERSION" ] \
  || { echo "Archived version is $(plist CFBundleShortVersionString)" >&2; exit 1; }
[ "$(plist CFBundleVersion)" = "$BUILD_NUMBER" ] \
  || { echo "Archived build number is $(plist CFBundleVersion)" >&2; exit 1; }

cat > "$work/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

echo "Exporting ($destination)"
xcodebuild -exportArchive \
  -archivePath "$archive" \
  -exportOptionsPlist "$work/ExportOptions.plist" \
  -exportPath "$work/export" \
  "${auth[@]}" \
  > "$work/export.log" 2>&1 || true
grep -E '(error|warning):|\*\* EXPORT|Upload' "$work/export.log" || true
if ! grep -q '\*\* EXPORT SUCCEEDED \*\*' "$work/export.log"; then
  echo "Export failed; see $work/export.log" >&2
  exit 1
fi
echo "Version $MARKETING_VERSION ($BUILD_NUMBER): $destination done"
