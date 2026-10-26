---
row: L11
---

Phase 8, slice 8-0, the outside-review packet:
`docs/reviews/adr-024-e2ee-review-packet.md`, linked from ADR-024's Delivery
phases. It gives the reviewer the target (a frozen review tag and commit,
still to be set), the in-scope code, the verified pins (`mls-rs` =0.56.0,
`mls-rs-core` =0.27.0, `mls-rs-codec` =0.7.0, `mls-rs-crypto-rustcrypto`
=0.22.1, `wasm-bindgen` =0.2.126, Rust 1.96.0, cipher suite 0x0002, the
committed WASM's hash), how to reproduce `packages/mls/pkg` with
`packages/mls/build.sh --check`, the threat model and what product copy may
and may not claim, every key flow and MLS integration point with code
pointers, the tests, vectors, fuzzing and browser runs, the known
limitations and open deferred findings, questions for the reviewer, and the
intake rule that any open P0 or P1 finding blocks the default-on flag and
the held deletion PR (8-5). Writing it found one divergence from the ADR,
recorded there for the reviewer: a fresh device receives no contacts head in
the approval exchange and accepts the server's newest identity-signed
contacts list as verified. Checkpoint replay (slice 8-C5b) is marked in
progress. Docs only; no flag, migration or code changed.
