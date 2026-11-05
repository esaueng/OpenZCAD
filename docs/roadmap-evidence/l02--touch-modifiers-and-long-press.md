---
row: L02
---

Slice 4, stand-ins for hover, keys and right-click.

- **Viewer-bar toggles**, shown to a coarse pointer only:
  - Multi-select: taps add or remove, as Shift or Ctrl does.
  - Free values: no snaps or inference, as Shift does.
- **Long press**: a finger held 550 ms anywhere in the chrome opens that
  element's context menu (History rows, Assemble parts and joints), or
  else shows its tooltip. The click from the lift is swallowed.
- **Settings › Viewport** gains "Undo with two fingers" (default on). It
  is a new app-settings field: the Worker accepts it as optional and keeps
  the stored value when an older client saves without it.

Evidence:

- `touchLongPress.test.ts`
- `Tooltip.test.tsx`
- `ViewerToolbar.test.tsx`
- `app-settings.test.ts`
- `api-routes.test.ts`, with a mutation check that the stored value is
  carried
- `test/e2e/touch-navigation.spec.ts`, covering the Multi-select toggle and
  a held History row
