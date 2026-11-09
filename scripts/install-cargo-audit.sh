#!/usr/bin/env bash
# Official RustSec release, pinned independently of mutable release metadata.
set -euo pipefail

if [[ "$(uname -s)/$(uname -m)" != Linux/x86_64 ]]; then
  echo 'The pinned cargo-audit package requires Linux x86_64.' >&2
  exit 1
fi
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

version=0.22.2
package="cargo-audit-x86_64-unknown-linux-gnu-v$version"
checksum=ab28a1bdb54db4d5d8ad5981cf1f959410370b3d28250dbd35f6a44248620e39
temporary="$(mktemp -d "$RUNNER_TEMP/cargo-audit.XXXXXX")"
trap 'rm -rf -- "$temporary"' EXIT
archive="$temporary/$package.tgz"
curl --fail --silent --show-error --location --retry 3 \
  "https://github.com/rustsec/rustsec/releases/download/cargo-audit/v$version/$package.tgz" \
  --output "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --strict
tar -xzf "$archive" -C "$temporary" "$package/cargo-audit"
binary="$temporary/$package/cargo-audit"
test "$("$binary" --version)" = "cargo-audit $version"
destination="$RUNNER_TEMP/cargo-audit-bin"
mkdir -p "$destination"
install -m 755 "$binary" "$destination/cargo-audit"
printf '%s\n' "$destination" >> "$GITHUB_PATH"
# The advisory database is deliberately not cached: cargo audit refreshes it.
