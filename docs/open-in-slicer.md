# Open in slicer

L09's hand-off of a 3MF to a slicer, and why it takes the routes it does. The
file is the mesh export's 3MF, with each body named and coloured (see
[exchange-loss-contract.md](exchange-loss-contract.md)). No route uploads or
hosts the file, so an end-to-end encrypted project's model never reaches the
server this way (L11).

## Routes (spike, 2026-11-15)

Read from the slicers' public source and their makers' documentation:

| Route                                                                   | Takes                                                                             | A local file the browser just made?                                                                              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `bambustudio://open?file=…`                                             | An http(s) URL, which Bambu Studio downloads (asking first for an untrusted host) | No: a browser `blob:` URL is not reachable from another application, and the page never learns a download's path |
| `orcaslicer://open?file=…` (also `prusaslicer://`, `cura://`)           | An http(s) URL, which OrcaSlicer's downloader fetches                             | No, for the same reason                                                                                          |
| Bambu Connect `bambu-connect://import-file?path=…&name=…&version=1.0.0` | An absolute local path to an already sliced `.gcode.3mf`                          | No: it takes a print job, not a model, and the browser has no path to give                                       |
| The desktop app (Tauri shell)                                           | Writes the 3MF itself and runs `/usr/bin/open -a <slicer> <file>`                 | Yes: Launch Services hands the local file to the installed slicer                                                |
| Download and open                                                       | The browser's download                                                            | Yes, with one step by the user                                                                                   |

So a URL scheme would need the file on a server, which is excluded for
encrypted projects and not built here. What ships:

- **Desktop app:** _Export mesh_ → 3MF → _Open in slicer_ offers Bambu Studio,
  OrcaSlicer and PrusaSlicer. The shell writes the file to a private
  (`0700`) folder under the system's temporary directory, removes hand-offs
  older than a day, and opens it with the chosen application. A slicer that is
  not installed is reported, and _Export 3MF_ remains. The renderer can only
  name a slicer from that fixed list. **Not yet run on a Mac:** the Rust
  module's tests ran on Linux (`rustc --test`), and the Apple Silicon workflow,
  the only check that builds the shell, is manual. The application names
  `BambuStudio`, `OrcaSlicer` and `PrusaSlicer` are those the slicers install
  under, which Launch Services resolves; they were not confirmed on a Mac
  here.
- **Browser:** the same section offers _Download for slicer_: the 3MF is
  downloaded and the status says to open it from the browser's downloads (a
  browser setting can open `.3mf` files with the slicer automatically).

Neither route keeps a copy in the project's export archive.

Tests: `apps/desktop/src-tauri/src/slicer_handoff.rs` (slicer list, file name,
private folder, pruning, the `open` command), `apps/web/src/lib/desktopBridge.test.ts`
(the bridge, and that the web list matches the shell's), `apps/web/src/components/ExportDialog.test.tsx`
and `test/e2e/open-in-slicer.spec.ts` (the browser route downloads and uploads
nothing).
