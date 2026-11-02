---
row: U07
---
Assembly clipping follows visible model and sketch bounds each frame, including
previews, reopened views and projection switches. Camera framing is unchanged,
and depth precision follows the existing Fit policy. Regression evidence:
`packages/viewport/src/camera/depthRange.test.ts`, `CameraController.test.ts`,
and the rendered cabinet checks in `test/e2e/camera-clipping.spec.ts` (PR #1160).
