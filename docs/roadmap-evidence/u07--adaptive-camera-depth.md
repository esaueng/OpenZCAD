---
row: U07
---
Assembly clipping follows visible model and sketch bounds each frame, including
previews, reopened views and projection switches. Camera framing is unchanged,
and depth precision follows the existing Fit policy. Regression evidence:
`packages/viewport/src/camera/depthRange.test.ts`, `CameraController.test.ts`,
and the rendered cabinet checks in `test/e2e/camera-clipping.spec.ts` (PR #1160).

Close inspection preserves Fit's camera-to-target precision floor when a moving
assembly's coarse bounds straddle the camera. Regression coverage resolves a
0.05 mm blade clearance at three model scales and checks opaque pivot/blade
pixels through joint limits and continuous playback, without moving the camera
(`depthRange.test.ts`, `camera-clipping.spec.ts`). Orthographic clipping and
microscopic inspection remain covered by the same camera tests.
