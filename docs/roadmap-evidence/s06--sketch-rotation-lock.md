---
row: S06
---

A sketch stays flat after its entry glide: the camera controller now holds the
sketch's rotation lock across the orthographic switch, which rebuilds the orbit
controls and used to turn canvas rotation back on, so a middle-drag set to
Orbit (or a touch orbit) no longer turns the sketch out of its plane. The view
cube still orbits on purpose (`CameraController.test.ts`,
`test/e2e/viewport.spec.ts` "a sketch stays flat").
