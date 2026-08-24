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
- **`occt-wasm` 3.8.1 build tooling and TypeScript wrapper** — Copyright its
  contributors; MIT OR Apache-2.0. Source:
  <https://github.com/andymai/occt-wasm>.
- **Open CASCADE Technology compiled WebAssembly output** — LGPL-2.1-only as
  identified by `occt-wasm`; OCCT is distributed under LGPL-2.1 with the OCCT
  additional exception. It is used by the development parity corpus and is
  not emitted in the production OpenZCAD bundle. License and source information:
  <https://dev.opencascade.org/resources/download/occt-public-license> and
  <https://github.com/Open-Cascade-SAS/OCCT>.

## User interface, rendering, and document support

- **IBM Plex Sans and IBM Plex Mono 5.3.0** — Copyright IBM Corp.; SIL Open
  Font License 1.1. Source and license:
  <https://github.com/IBM/plex>.
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
- **`fflate` 0.8.2** — Copyright Arjun Barrett; MIT. Used for bounded streaming
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

The complete license texts shipped by npm packages remain available in each
package's `LICENSE` file. This notice does not alter the terms of those
licenses.
