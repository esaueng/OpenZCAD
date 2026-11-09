---
row: U10
---

Follow-up: Settings › Viewport › Tangent edges (Show / Faint / Hide;
default Faint, the shipped 0.42 rim) restyles resting fillet and blend rims
in Shaded + edges. Hidden rims still hover, select and highlight; wireframe,
X-ray, silhouettes and thumbnails are unchanged. Evidence:
`tangentEdges.test.ts` (each style, display modes, body selection,
`suspendHighlights`, silhouettes), `PickService.test.ts` (a hidden rim
still picks), `app-settings.test.ts`, `api-routes.test.ts` (carried across
an older client's save), `SettingsPage.test.tsx`,
`test/e2e/tangent-edge-setting.spec.ts`, and lookdev captures of the
rounded-block and filleted-cylinder scenes in all three styles.
