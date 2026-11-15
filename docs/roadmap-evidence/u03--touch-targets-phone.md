---
row: U03
---

13 November design review I1, I12 and I23, touch and the phone: under
`pointer: coarse` the start screen (tile pick box, pin and menu, settings,
shelf tabs, New project and Import, Grid/List, Sign in, menu rows), the top bar
(brand, name, save state, Share, File, Settings), the View, Tweak and Measure
rails and panel, Box's dimension chips, the drawer filters, the tour, the
keymap and assistant header controls are 44 px touch targets, by an invisible
reach where a control stands alone and at 44 px where it is packed against
others (`apps/web/src/styles/components/touch-targets.css`). A demo card's
Save a copy and Reset show without hover. On a touch-only device (no hover)
the command bar's hint lane, the File menu and the command list drop key
hints, and the bar and the first-run tour speak of taps, Done and a held row
instead of keys, clicks and right-clicks (`workspaceTour.test.ts`); at a
phone's width the hint lane and a disabled command's reason wrap instead of
being cut. On an upright phone the tour card keeps to the stage between the
two rails, on screen, with History beside it in view. Coverage:
`touch-targets.spec.ts` scans every control from its centre the way a finger
meets it at 390 × 844 with touch (start screen, library, tile menu, Build,
Box armed, File, View, Measure, Tweak, each tour step and the command list),
and `phone-stage.spec.ts` keeps the taller search bar, View's two-column bar
over Tweak's sheet and the bar's help clear of the rails at 390 × 844 and
360 × 640.
