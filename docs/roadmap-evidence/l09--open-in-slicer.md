---
row: L09
state: Partial
---

Maker slice 3, "Open in slicer" (PR #1564): a spike found that no slicer URL
scheme accepts a local file the browser made (`bambustudio://` and
`orcaslicer://` take only an http(s) URL; Bambu Connect's `import-file` takes
only a sliced `.gcode.3mf`), so none is used and no file is hosted, which keeps
encrypted projects off the server (L11). The desktop app opens the 3MF in Bambu
Studio, OrcaSlicer or PrusaSlicer through Launch Services from a private
temporary folder (not yet run on a Mac: the shell's tests ran on Linux, and the
Apple Silicon workflow is manual); the browser downloads it to open from there.
Neither uploads or archives it (docs/open-in-slicer.md;
`slicer_handoff.rs` tests, `desktopBridge.test.ts`, `ExportDialog.test.tsx`,
`test/e2e/open-in-slicer.spec.ts`). With slices 1 and 2 the maker slices are
delivered; the CNC-cut layout remains.
