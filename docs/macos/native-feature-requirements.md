# Native feature requirements

## Implemented in the local-first MVP

| Capability          | Implementation                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| App identity        | `OpenZCAD`, bundle identifier `app.esau.openzcad`, Graphics & Design category.                                    |
| Apple Silicon       | Explicit `aarch64-apple-darwin` build target.                                                                     |
| Local production UI | Bundled Vite assets; no remote-site wrapper.                                                                      |
| Window behavior     | Minimum 1024 x 700, default 1440 x 900, restored position/size/state.                                             |
| Menus               | Native application, File, Edit, View, and Window menus with standard system items.                                |
| Open                | Native user-selected STEP/STP/STL dialog with extension and 50 MB validation.                                     |
| Export              | Native STEP/STL save dialog with safe name, extension, format, and size validation.                               |
| Close safety        | Close is intercepted while a device save is active and requires confirmation.                                     |
| About               | Standard macOS About item populated from app metadata.                                                            |
| Security boundary   | Narrow CSP and Tauri capability; no filesystem or shell plugin, arbitrary paths, or remote privileged content.    |
| Cloud account       | System-browser email proof, one-time PKCE approval, Keychain refresh storage, and fixed-origin native HTTP proxy. |
| QA automation       | Debug-only embedded WebDriver; it is excluded from release registration and only binds loopback.                  |

The browser build keeps its existing file-download behavior. Desktop checks are
encapsulated in `apps/web/src/lib/desktopBridge.ts` rather than spread throughout
the geometry or document packages.

## Required before a signed beta

- Approved beta migration/deployment and real-account Keychain/relaunch/logout
  verification; see [authentication-flow.md](authentication-flow.md).
- Ticketed bearer authorization for live collaboration WebSockets.
- Signed update client, beta channel manifest, rollback/recovery test, and a
  separately protected updater signing key.
- Actionable native diagnostics for startup, renderer, worker, and API failure.
- Interactive verification of open/save cancel and error paths, Dock reopen,
  full screen, multiple displays, sleep/wake, trackpad, right-click, and
  unsaved-change recovery.
- macOS 14 and 15 hardware/VM coverage plus a clean-machine Gatekeeper test.

Notifications, file associations, Quick Look, Spotlight, Shortcuts, tray mode,
and multiple document windows are later features. They should be added only for
a concrete product workflow, not as blanket native privileges.
