# Desktop compatibility matrix

Validation host: Apple M5 Pro (`arm64`), macOS 26.5.2, Retina display. Minimum
declared support remains macOS 14.0; this host does not prove the minimum OS.

The automated native smoke test starts the debug Tauri binary, connects to its
embedded WebDriver endpoint, opens or restores the Mounting Bracket demo, checks
the real WKWebView DOM, and captures a full-resolution screenshot.

| Area                          | State                    | Evidence / remaining gate                                                                                       |
| ----------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Bundled startup               | Verified                 | App launches without the Vite server or hosted website.                                                         |
| WKWebView 3D rendering        | Verified                 | Shaded Mounting Bracket, edges, axes, and grid rendered in the native window.                                   |
| Exact kernel                  | Verified                 | Workspace reported `Exact B-rep`, one body, revision 32, and zero warnings.                                     |
| Retina scaling                | Verified                 | Native capture was 3024 x 1898 with a correctly scaled viewport and controls.                                   |
| Worker/WASM loading           | Verified                 | Bundled BrepKit completed the demo evaluation in WKWebView.                                                     |
| Persisted desktop state       | Verified                 | Relaunch restored the previous workspace and window state.                                                      |
| Native menus                  | Verified                 | macOS application, File, Edit, View, and Window menus were present.                                             |
| STEP/STL picker/export        | Unit/build verified      | Native commands validate extensions and a 50 MB boundary; interactive cancel/write paths still need release QA. |
| Command shortcuts             | Inherited                | The web app already treats Control and Command as equivalent; native menu events route undo/redo/settings.      |
| Selection/hit testing         | Automated at 2x backing scale  | Native smoke selects exact geometry in CSS coordinates at 2x scale and box-selects after a capture request.     |
| Orbit/pan/trackpad zoom       | Automated; hardware QA remains | Smoke covers Shift orbit, secondary pan, and pixel-delta zoom; minimum-OS physical trackpad QA remains.         |
| Right-click/context menus     | Not yet release-verified | Test native and application menu interaction together.                                                          |
| STEP/STL round trip           | Not yet release-verified | Validate exported geometry with the existing parity/corpus rules.                                               |
| Large models/long sessions    | Not yet release-verified | Measure memory growth, worker recovery, and the current 50 MB IPC import ceiling.                               |
| Full screen/multiple displays | Not yet release-verified | Exercise monitor changes, sleep/wake, and window restoration.                                                   |
| macOS 14 and 15               | Not yet tested           | Required before declaring the configured minimum supported.                                                     |
| Cloud sync/collaboration      | Blocked                  | Requires the dedicated desktop authentication and API transport.                                                |

Run the native gate with:

```sh
pnpm --filter @openzcad/desktop test:e2e
```

Screenshots are written to `apps/desktop/artifacts/` and intentionally ignored
by Git. CI exercises the same smoke without publishing the capture or package.
