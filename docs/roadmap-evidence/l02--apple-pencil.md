---
row: L02
---

Slice 6, Apple Pencil.

- After a Pencil is used, a finger in a sketch drawing tool only navigates.
  This is controlled by Settings › Viewport "Only Apple Pencil draws"
  (default on), a new app-settings field that the Worker carries.
- Palm rejection: fingers are ignored while a pen is down and for 300 ms
  after it lifts, and a landing pen cancels a finger gesture in progress.
- The Pencil keeps the mouse path: precise taps, drags, marquee and hover.

Evidence:

- `touchNavigation.test.ts` (navigation-only fingers, abandoning a palm)
- `app-settings.test.ts`
- `api-routes.test.ts` (the setting is carried across an older client's
  save)
- `test/e2e/touch-navigation.spec.ts`, driving a real pen and fingers
  through Chromium's input domain. Mutation-checked: with Pencil mode
  forced off, the finger draws.

Not yet verified on an iPad: Pencil hover and Safari's own palm rejection.
