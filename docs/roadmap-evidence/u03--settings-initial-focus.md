---
row: U03
---
Settings initially focuses its heading instead of the selected sidebar button,
avoiding an unsolicited nav focus ring after reload while preserving keyboard
focus indicators. `SettingsPage.test.tsx` covers new and restored opens with
ready and delayed content, Enter, Tab/Shift+Tab, section activation, modal
containment, Escape and return to the opener; the existing modal-focus, export
and sharing regressions also pass. The shared focus hook and Settings overlay
loading path are unchanged.
