#!/usr/bin/env bash
# Build the MLS WASM package into packages/mls/pkg (committed).
#
#   packages/mls/build.sh          rebuild pkg/ and BUILD.json
#   packages/mls/build.sh --check  rebuild into a temp dir and fail unless the
#                                  result is byte-identical to the committed pkg/
#
# Reproducible only with the toolchain in crate/rust-toolchain.toml, the
# locked dependency tree (crate/Cargo.lock, --locked) and wasm-bindgen CLI
# 0.2.126 (the version Cargo.toml pins). Absolute paths are remapped so the
# output does not depend on where the repository or Cargo home live.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
crate="$here/crate"
check=0
[[ "${1:-}" == "--check" ]] && check=1

toolchain="$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$crate/rust-toolchain.toml")"
bindgen_version="0.2.126"
if command -v rustup >/dev/null 2>&1; then
  toolchain_bin="$(dirname "$(rustup which --toolchain "$toolchain" cargo)")"
else
  toolchain_bin="$HOME/.rustup/toolchains/$toolchain-$(uname -m | sed 's/arm64/aarch64/')-apple-darwin/bin"
fi
[[ -x "$toolchain_bin/cargo" ]] || {
  echo "Rust $toolchain is not installed (rustup toolchain install $toolchain --target wasm32-unknown-unknown)" >&2
  exit 1
}
export PATH="$toolchain_bin:$PATH"
actual_bindgen="$(wasm-bindgen --version | awk '{print $2}')"
[[ "$actual_bindgen" == "$bindgen_version" ]] || {
  echo "wasm-bindgen CLI $bindgen_version is required (found $actual_bindgen): cargo install wasm-bindgen-cli --version $bindgen_version --locked" >&2
  exit 1
}

cargo_home="${CARGO_HOME:-$HOME/.cargo}"
target="$(mktemp -d)"
trap 'rm -rf "$target"' EXIT
# rustc sees native paths, so under Git Bash, MSYS2 or Cygwin the remaps need
# the Windows form or local paths end up in the WASM. (A Windows build still
# differs from a macOS or Linux one: the embedded paths keep `\` separators.)
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}
export RUSTFLAGS="--cfg getrandom_backend=\"wasm_js\" --remap-path-prefix=$(native_path "$crate")=/openzcad-mls --remap-path-prefix=$(native_path "$cargo_home")=/cargo --remap-path-prefix=$(dirname "$toolchain_bin")=/rust"
export SOURCE_DATE_EPOCH=0
# --check always builds from scratch; a normal build reuses crate/target.
cargo_target="$crate/target"
[[ $check == 1 ]] && cargo_target="$target/cargo"
(cd "$crate" && cargo build --locked --release --target wasm32-unknown-unknown --target-dir "$cargo_target")

out="$here/pkg"
[[ $check == 1 ]] && out="$target/pkg"
rm -rf "$out"
wasm-bindgen --target web --out-dir "$out" --out-name openzcad_mls \
  "$cargo_target/wasm32-unknown-unknown/release/openzcad_mls.wasm"

sha() { shasum -a 256 "$1" | awk '{print $1}'; }
manifest() {
  local files
  files="$(cd "$1" && find . -type f ! -name BUILD.json | sed 's|^\./||' | LC_ALL=C sort)"
  printf '{\n  "toolchain": "%s",\n  "target": "wasm32-unknown-unknown",\n  "wasmBindgen": "%s",\n  "files": {\n' "$toolchain" "$bindgen_version"
  local first=1
  while IFS= read -r file; do
    [[ $first == 1 ]] || printf ',\n'
    first=0
    printf '    "%s": "%s"' "$file" "$(sha "$1/$file")"
  done <<< "$files"
  printf '\n  },\n  "sources": {\n'
  # The inputs the WASM is built from, so pkg.test.ts (in CI, which has no
  # Rust) fails when a source change is committed without rebuilding pkg/.
  local sources
  sources="$(cd "$crate" && { printf '%s\n' Cargo.toml Cargo.lock rust-toolchain.toml; find src -type f; } | LC_ALL=C sort)"
  first=1
  while IFS= read -r file; do
    [[ $first == 1 ]] || printf ',\n'
    first=0
    printf '    "%s": "%s"' "crate/$file" "$(sha "$crate/$file")"
  done <<< "$sources"
  printf '\n  }\n}\n'
}
manifest "$out" > "$out/BUILD.json"

if [[ $check == 1 ]]; then
  if diff -r "$here/pkg" "$out" >/dev/null; then
    echo "pkg/ is reproducible: identical to a fresh build with Rust $toolchain."
  else
    diff -r "$here/pkg" "$out" | head -20 >&2
    echo "pkg/ differs from a fresh build. Run packages/mls/build.sh and commit the result." >&2
    exit 1
  fi
else
  ls -l "$out"
fi
