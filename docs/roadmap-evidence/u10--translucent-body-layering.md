---
row: U10
---

Translucent bodies sit over the stage instead of under it: named backdrop, ground-shadow, grid and world-axes render orders below `BODY_FACE` stop the grid, shadow catcher and axes painting over a translucent housing (sorted through three.js's own render list from four camera sides in `packages/viewport/src/render/scene.test.ts`); bodies below full opacity cast no ground shadow and thaw the frozen shadow map when that flips; the face-hover film drops its slope-scaled depth offset on translucent bodies, which drew a full-strength arc over opaque parts just in front of a grazing fillet (`SelectionManager.test.ts`). Doubled wall outlines through glass are follow-up #2018.
