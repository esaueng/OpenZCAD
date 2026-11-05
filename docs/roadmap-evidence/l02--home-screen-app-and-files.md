---
row: L02
---

Slice 7, the Home Screen app and files.

- **Installable:** a web manifest and Apple Home Screen tags.
- **Installed-app only:** persistent storage and an offline shell (`sw.js`).
  The shell is network-first for pages and cache-first for content-hashed
  assets. It is never registered by a browser tab, the desktop shell or a
  test build.
- **Exports** open the share sheet on a touch screen that can share files,
  and otherwise download.
- **Import pickers** drop the `accept` filter on iPad and iPhone, so
  `.step`, `.openzcad` and `.shapr` files can be chosen.
- **Download fix:** blob URLs are no longer revoked at click time (WebKit).

Evidence:

- `saveFile.test.ts`, including the revoke regression
- `desktopBridge.test.ts`
- `appleTouch.test.ts`, covering the manifest, pickers and storage
- `offlineShell.test.ts`, which runs the shipped `sw.js` against an
  in-memory cache and a scripted network

Not yet verified on an iPad: installing to the Home Screen, launching
offline, and the share sheet.
