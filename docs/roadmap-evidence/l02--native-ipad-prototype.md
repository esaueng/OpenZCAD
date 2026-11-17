---
row: L02
---

Owner-requested native iPad prototype: a Swift/WKWebView host packages the
verified shared CAD/WASM bundle with private-origin resources, persistent local
projects, native Files exports, an app icon, and an edge-to-edge viewport.
Eight Xcode tests pass on the iPad Pro 11-inch (M4) simulator, including touch
sketch/extrude, process-restart persistence, storage copying, and portrait and
landscape canvas bounds. See [simulator evidence](docs/qa/2026-11-17/ipad-prototype.md)
and [build instructions](apps/ipad/README.md). Physical iPad/Pencil acceptance
and measured W01 memory/rendering budgets remain outstanding; this does not
close the existing real-device requirements or add a ninth touch-plan slice.
