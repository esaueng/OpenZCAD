---
row: U10
---

Orbit mode preference: Settings → Controls → Orbit chooses Free (the default:
no polar limit, a drag tumbles over the top and bottom views) or Turntable
(world Z stays up, a vertical drag stops at the top and bottom views, and an
upside-down view is turned back right way up as an orbit starts). It is read
live by the camera, syncs with account settings, and an older client's save
keeps the stored choice (`viewport.orbitMode`, `CameraController.test.ts`,
`test/e2e/orbit-mode-setting.spec.ts`).
