---
row: L02
---

Slice 3, touch on the 3D viewport. On empty space:

- one finger orbits (it pans in a sketch);
- two fingers pan and pinch-zoom about their midpoint;
- a tap selects;
- a double tap acts as a double click;
- a held finger opens the pick list or context menu;
- two- and three-finger taps undo and redo.

A first finger that lands on a handle, gizmo, footprint, armed face or
sketch-tool stroke keeps the mouse behaviour, and other fingers cannot
disturb it. Touch picks edges in a band about 15 px wide. Safari's page
pinch is suppressed over the viewport.

Evidence:

- `touchNavigation.test.ts`
- `CameraController.test.ts` (touch pinch)
- `PickService.test.ts` (touch edge band)
- `test/e2e/touch-navigation.spec.ts`, real multi-touch through Chromium's
  input domain

The existing touch and mouse viewport specs are unchanged. Device timing is
not yet verified on an iPad.
