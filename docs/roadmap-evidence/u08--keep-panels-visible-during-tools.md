---
row: U08
---

Tool selection and switching preserve open model panels, including docked,
unpinned, floating and phone-lane panels. Model-panel visibility follows the
user's layout and Hide all choice; only the More tools drawer folds for a new
command. Browser regressions cover Fillet/Chamfer switches without unmounting,
moving panels or reframing the model, manual close/Hide all, sketch sessions,
Extrude relaunch and Done, and command-chip/keypad access beside visible panels.
Active command options open above floating panels so their fields remain
clickable without hiding or moving the panel.
The Fillet/Chamfer regression fails on the original implementation with zero
panels instead of four. The dockable-panel specification records the corrected
tool-session contract.
