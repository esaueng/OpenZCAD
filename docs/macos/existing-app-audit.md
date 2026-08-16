# Existing application audit

Audit baseline: 2026-08-04.

## Frontend and execution model

- React 19 single-page application built with Vite 8.
- The normal web build is served with a Cloudflare Worker/Vite integration.
- The desktop build uses Vite's `desktop` mode, emits static assets to
  `apps/web/dist-desktop`, and omits the Cloudflare development plugin.
- The document/history model remains the source of truth. Exact geometry and
  tessellation continue to run in browser workers; the native host does not
  implement or reinterpret geometry.
- The bundled build includes Remus WASM, pdf.js worker/data, fonts, and all
  normal application chunks. It does not load a hosted web page.
- The current UI is dark-palette only. The existing "System" setting follows a
  dark-capable host; a separate light design system does not exist.

## Browser and storage dependencies

| Area                           | Current use                                                                    | Desktop consequence                                                     |
| ------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| WebGL                          | Three.js viewport, thumbnails, selection, edges, grids                         | Must be proven in WKWebView before Tauri is accepted.                   |
| Web Workers + WASM             | Exact B-rep kernel and geometry orchestration                                  | Must be bundled and permitted by CSP.                                   |
| localStorage                   | Settings, panel layout, workspace session, recovery records, assistant history | Persists under the Tauri application data origin.                       |
| sessionStorage                 | Collaboration client identity                                                  | Per-window behavior is retained.                                        |
| IndexedDB-backed persistence   | Device-local projects and revisions                                            | Remains the local-first data store.                                     |
| WebSocket                      | Collaboration rooms                                                            | Desktop live rooms remain off until a ticketed bearer handshake exists. |
| Blob downloads                 | Browser STEP/STL export fallback                                               | Desktop calls a native save command instead.                            |
| File input/drop                | CAD imports and assistant attachments                                          | Existing drag/drop remains; File menu import uses a native picker.      |
| `beforeunload`-style lifecycle | Save/recovery protection                                                       | Tauri close events now protect an active save.                          |
| Turnstile frame/script         | Email-code login abuse protection                                              | Cannot be treated as a desktop credential flow.                         |

No WebUSB, WebSerial, WebBluetooth, camera, microphone, notification, print, or
service-worker dependency was found in the primary application path. There are
currently no external-link call sites in the frontend.

## Authentication and hosted API

The Worker currently implements email-code authentication. A successful verify
request sets the `__Host-openzcad_session` cookie with `HttpOnly`, `Secure`,
`SameSite=Lax`, and `Path=/`. The frontend calls relative `/api/...` URLs with
`credentials: same-origin`.

That contract is correct for the hosted web app but is not reused by the locally
bundled Tauri origin. The desktop app opens the hosted proof in the system
browser, exchanges a one-time PKCE attempt through Rust, stores only the rotating
refresh credential in Keychain, and proxies HTTP API requests to the fixed beta
origin with an in-memory bearer. No cookie copy, OAuth client secret, or bearer
credential is exposed to the WebView or frontend bundle.

## Desktop decision

Tauri remains the selected shell because the real Apple Silicon WKWebView run
rendered the exact Mounting Bracket model correctly. Electron is retained only
as a fallback if the remaining interaction, long-session, or large-model tests
find a material WebKit difference.
