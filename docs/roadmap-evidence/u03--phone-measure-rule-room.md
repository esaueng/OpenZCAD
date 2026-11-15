---
row: U03
---

13 November design review I47 recheck: View's and Tweak's measurement
workbench mounts inside the viewer shell, so the scale rule now watches the
shell's children too and re-measures when a phone's sheet opens; at 390×844
it no longer keeps its 175 px length over the sheet's text until the window
next resizes (`measure-phone.spec.ts`).
