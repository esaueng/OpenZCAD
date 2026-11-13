---
row: U10
---

Viewer navigation and axes: orbiting has no polar limit — a vertical drag
carries over the top and bottom views and turns the view upside down, a
horizontal drag stays a roll-free turntable about world Z that follows the hand
when upside down (`packages/viewport/src/camera/freeOrbit.ts`,
`CameraController.test.ts`). The world axes draw as full lines, positive half
bold and negative half quieter, each clipped to the camera's view volume so it
runs off screen in every perspective and orthographic view instead of stopping
mid-frame (`scene.test.ts`, `updateAxesGizmo`).
