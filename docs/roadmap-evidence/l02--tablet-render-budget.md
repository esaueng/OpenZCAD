---
row: L02
---

Slice 8, rendering limits. Desktop rendering is unchanged.

- **Smaller shadow map:** touch devices render the key-light shadow at
  2048² instead of 3072².
- **Lower navigation resolution on slow devices:** a device under 45 fps
  navigates at a 1.25 pixel ratio and returns to its full ratio at rest.
- **Context-loss recovery:** a lost WebGL context comes back drawing, with
  its environment and shadow map rebuilt.

Evidence:

- `renderBudget.test.ts`
- `shadowMapSize.test.ts`
- `test/e2e/touch-navigation.spec.ts`, where a real `WEBGL_lose_context`
  loss and restore leaves the viewer drawing with its shadows rebuilt

iPad memory and frame timing remain device measurements under W01.
