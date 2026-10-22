# Third-party notices

OpenZCAD is licensed under the Apache License 2.0. The application also
distributes or depends on the following material components. Versions reflect
the lockfile at the time this notice was prepared; the lockfile remains the
authoritative dependency inventory.

## Geometry kernels

- **Remus / `remus-wasm` 2.130.0** — Copyright its contributors; Apache-2.0
  as declared by the pinned package. OpenZCAD installs the committed WASM
  package from an immutable Remus commit recorded in `pnpm-lock.yaml`.
  Source and license text: <https://github.com/esaueng/remus>.
- **`occt-wasm` 3.8.4 build tooling and TypeScript wrapper** — Copyright its
  contributors; MIT OR Apache-2.0. Source:
  <https://github.com/andymai/occt-wasm>.
- **Open CASCADE Technology compiled WebAssembly output** — LGPL-2.1-only as
  identified by `occt-wasm`; OCCT is distributed under LGPL-2.1 with the OCCT
  additional exception. It is used by the development parity corpus and by
  the disposable FreeCAD BREP-to-STEP import worker. Its separately loaded WASM
  asset is emitted in the production bundle; Remus remains the modeling kernel.
  Wrapper and WASM build source: <https://github.com/andymai/occt-wasm/tree/v3.8.4>.
  License and source information:
  <https://dev.opencascade.org/resources/download/occt-public-license> and
  <https://github.com/Open-Cascade-SAS/OCCT>.

## User interface, rendering, and document support

- **Geist Sans and Geist Mono 5.3.0** (Fontsource packages) — Copyright 2023
  Vercel, made with basement.studio; SIL Open Font License 1.1. Source and
  license: <https://github.com/vercel/geist-font>.
- **Noto Sans Math 3.000 and Noto Sans Symbols 2 2.008, subset** — Copyright
  2022 Google LLC and Copyright 2022 The Noto Project Authors; SIL Open Font
  License 1.1. `apps/web/src/theme/fonts/` redistributes glyph subsets of each
  as the "OpenZCAD Symbols" fallback faces, with the license text in
  `LICENSE-Noto.txt` beside them. Source: <https://github.com/notofonts>.
- **PDF.js / `pdfjs-dist` 6.2.108** — Copyright Mozilla and contributors;
  Apache-2.0. PDF.js distributions also contain Liberation fonts under the SIL
  Open Font License. Source and notices:
  <https://github.com/mozilla/pdf.js>.
- **three.js 0.185.1** — Copyright three.js authors; MIT. Source and license:
  <https://github.com/mrdoob/three.js>.
- **Lucide 1.27.0** — Copyright Lucide contributors; ISC. Icons derived from
  Feather are covered by the MIT license included in Lucide's license file.
  Source and license: <https://github.com/lucide-icons/lucide>.

## Interchange file parsing

- **SQLite Wasm / `@sqlite.org/sqlite-wasm` 3.53.0-build1** — Apache-2.0 as
  declared by the wrapper package. The embedded SQLite library is dedicated to
  the public domain. Used only in an isolated browser worker to inspect bounded
  Shapr3D workspace databases. Source and terms:
  <https://github.com/sqlite/sqlite-wasm> and
  <https://www.sqlite.org/copyright.html>.
- **`fast-xml-parser` 5.11.2** — Copyright its contributors; MIT. Parses
  bounded FreeCAD XML with document types/entities refused. Source and license:
  <https://github.com/NaturalIntelligence/fast-xml-parser>.
- **`fflate` 0.8.3** — Copyright Arjun Barrett; MIT. Used for bounded streaming
  ZIP decompression after independent central-directory validation. Source and
  license: <https://github.com/101arrowz/fflate>.

## Text-on-model fonts

OpenZCAD redistributes the following font binaries in
`packages/geometry/assets/fonts/`, so that text sketch objects can be expanded
to outlines offline. The full license text and the copyright line taken from
each font's own name table are in the matching `LICENSE-<family>.txt` beside
the binaries; `manifest.json` records each file's exact Google Fonts source
URL and the license its name table points at. Note that these are not all the
same license — Roboto Slab is Apache-2.0, not OFL.

- **Inter** — Copyright 2016 The Inter Project Authors; SIL Open Font License
  1.1. <https://github.com/rsms/inter>.
- **Open Sans** — Copyright 2020 The Open Sans Project Authors; SIL Open Font
  License 1.1. <https://github.com/googlefonts/opensans>.
- **Lora** — Copyright 2011 The Lora Project Authors, with Reserved Font Name
  "Lora"; SIL Open Font License 1.1.
  <https://github.com/cyrealtype/Lora-Cyrillic>.
- **Roboto Slab** — Copyright 2018 The Roboto Slab Project Authors;
  **Apache-2.0**. <https://github.com/googlefonts/robotoslab>.
- **JetBrains Mono** — Copyright 2020 The JetBrains Mono Project Authors; SIL
  Open Font License 1.1. <https://github.com/JetBrains/JetBrainsMono>.
- **Oswald** — Copyright 2016 The Oswald Project Authors; SIL Open Font License
  1.1. <https://github.com/googlefonts/OswaldFont>.
- **Pacifico** — Copyright 2018 The Pacifico Project Authors; SIL Open Font
  License 1.1. <https://github.com/googlefonts/Pacifico>.

- **opentype.js 2.0.0** — Copyright Frederik De Bleser; MIT. Parses the bundled
  font binaries into glyph outlines. Source and license:
  <https://github.com/opentypejs/opentype.js>.

## End-to-end encryption

`packages/mls` compiles these Rust crates into one WebAssembly module
(`packages/mls/pkg/openzcad_mls_bg.wasm`). The application does not load it
yet. `packages/mls/crate/Cargo.lock` is the authoritative inventory.

- **`mls-rs` 0.56.0, `mls-rs-core` 0.27.0, `mls-rs-codec` 0.7.0,
  `mls-rs-crypto-rustcrypto` 0.22.1, `mls-rs-crypto-hpke` 0.21.1,
  `mls-rs-crypto-traits` 0.22.0** — Copyright Amazon.com, Inc. or its
  affiliates and contributors; Apache-2.0 OR MIT. Source:
  <https://github.com/awslabs/mls-rs>.
- **RustCrypto crates** (`p256`, `p384`, `elliptic-curve`, `aes-gcm`,
  `chacha20poly1305`, `sha2`, `hkdf`, `hmac` and their support crates) —
  Copyright the RustCrypto developers; Apache-2.0 OR MIT.
  <https://github.com/RustCrypto>.
- **`curve25519-dalek`, `ed25519-dalek`, `x25519-dalek`** — Copyright Isis
  Agora Lovecruft, Henry de Valence and contributors; BSD-3-Clause.
  `subtle` — Copyright Isis Agora Lovecruft and Henry de Valence;
  BSD-3-Clause. <https://github.com/dalek-cryptography>.
- **`wasm-bindgen` 0.2.126 and `js-sys`, `serde`, `serde_json`, `hex`,
  `zeroize`, `thiserror`** and the remaining build and support crates —
  Apache-2.0 OR MIT or MIT; `memchr` is Unlicense OR MIT and
  `unicode-ident` adds Unicode-3.0.

The complete license texts shipped by npm packages remain available in each
package's `LICENSE` file. This notice does not alter the terms of those
licenses.
