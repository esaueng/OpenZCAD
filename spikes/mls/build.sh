#!/usr/bin/env bash
# Build the three spike WASM packages into spikes/mls/pkg (git-ignored).
# Needs Rust 1.88+ with the wasm32-unknown-unknown target and the
# wasm-bindgen CLI 0.2.126 (matching the pinned crate). No wasm-opt pass.
set -euo pipefail
cd "$(dirname "$0")"

build() { # crate dir, extra RUSTFLAGS, cargo args, target dir, out dir, out name
  local crate=$1 flags=$2 args=$3 target=$4 out=$5 name=$6
  (cd "$crate" && RUSTFLAGS="--cfg getrandom_backend=\"wasm_js\" $flags" \
    cargo build --locked --release --target wasm32-unknown-unknown $args --target-dir "$target")
  local wasm
  wasm=$(ls "$crate/$target"/wasm32-unknown-unknown/release/*.wasm)
  wasm-bindgen --target web --out-dir "pkg/$out" --out-name "$name" "$wasm"
}

# mls-rs needs its async build for the WebCrypto provider; both mls-rs
# variants use it so they run identical code.
build mls-rs-wasm '--cfg mls_build_async' '' target mls-rs openzcad_mls_spike_mls_rs
build mls-rs-wasm '--cfg mls_build_async' '--no-default-features --features rustcrypto' \
  target-rustcrypto mls-rs-rustcrypto openzcad_mls_spike_mls_rs_rustcrypto
build openmls-wasm '' '' target openmls openzcad_mls_spike_openmls
ls -l pkg/*/*.wasm
