# ZCAD iPad prototype

This native Swift/WKWebView app packages the existing React workspace and
verified Remus WASM kernel. Its local projects use the existing document
format, feature history, undo, and persistent IndexedDB store. This is an
offline prototype: account login, cloud synchronization, native encryption
keys, Pencil double-tap/squeeze, and App Store distribution are not included.

## Build and run

Requirements: macOS, full Xcode with an iOS simulator runtime, Node and the
repository's pinned pnpm. No additional native dependencies are needed.

```sh
pnpm install --frozen-lockfile
pnpm dev:ipad
```

The runner chooses an available **iPad Pro 11-inch (M4)**, prefers one already
booted, builds the verified web assets, compiles the native target, installs
in place, and launches it. It preserves existing projects. Set
`OPENZCAD_IPAD_SIMULATOR` to select another installed simulator by name.
Logs and build products stay in ignored `artifacts/ipad/`.

To work in Xcode or run on a physical iPad:

```sh
pnpm prepare:ipad
open apps/ipad/OpenZCAD.xcodeproj
```

Select the **ZCADiPad** scheme and the iPad destination, then Run. A physical
iPad additionally requires a development team and device signing configured
in Xcode. The prototype's separate bundle identifier is
`app.esau.openzcad.ipad.prototype`. Regenerate its icon with `pnpm brand:generate`.
Run `pnpm prepare:ipad` again after any shared web-source changes; Xcode copies
that prepared bundle rather than downloading the hosted site.

## Verification

```sh
node scripts/run-ipad-simulator.mjs --test
```

The shared scheme includes native resource-boundary, app-icon, private-origin,
and storage-copy tests plus Xcode UI smoke tests against the actual WKWebView.
The smoke uses a separate persistent WebKit data store and uniquely named
projects, preserving the development app's projects and last-opened model.

The workspace uses an app-private `zcad-ipad://app` origin through
`WKURLSchemeHandler`. Web Workers, WASM, and persistent IndexedDB work on that
origin without a TCP listener. Only immutable packaged files are readable;
there are no document, write, proxy, or directory-listing endpoints. Navigation
and the content security policy keep the workspace on that origin.

The earlier unshipped loopback prototype's local storage is copied once using
native-supplied bootstrap HTML; no HTTP content is fetched. Its original
IndexedDB records remain intact. The copy preserves schemas, indexes, record
keys, history, typed binary arrays, files, blobs, dates, and settings. An
unsupported record or a copy above 64 MiB fails without altering the original.

Exports use the native download delegate and Files export picker. The app's Documents folder is visible
in Files. The workspace fills the tablet in portrait and landscape; the
status bar is hidden and the Home indicator auto-hides. The app adopts the
scene lifecycle required by current iPadOS.

Simulator results qualify the shell and shared application integration. They
do not establish physical iPad GPU/WASM memory budgets, Apple Pencil hardware
behavior, or low-memory recovery. Those remain real-device acceptance work
under L02/W01.
