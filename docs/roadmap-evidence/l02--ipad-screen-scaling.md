---
row: L02
state: Partial
---

Slice 1, screen scaling and iOS basics:

- The shell and stage size to `100dvh`, so Safari's toolbars no longer cut
  off the bottom of the workspace.
- Touch pointers get 44px rail, command and Done/Cancel targets, and 16px
  fields so iOS does not zoom the page into a focused value.
- Over the model, a press-and-hold no longer selects text or shows a
  callout, and the page no longer rubber-bands.
- The numeric keypad no longer raises the system keyboard over its own keys.
  A touch on the field itself raises it, and the keypad stays above it.

Evidence:

- `touchContracts.test.ts` and `NumericKeypad.test.tsx`.
- `test/e2e/tablet-layout.spec.ts`: six iPad sizes under Chromium touch
  emulation.

Real-iPad verification is still pending.
