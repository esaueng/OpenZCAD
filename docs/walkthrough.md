# Walkthrough: a parametric bracket in five minutes

1. Start the app with `pnpm dev:web` and create a project on the start screen (pick your units).
2. **Parameters** (left sidebar): add `w = 60`, `t = 8`, and `hole = 6`.
3. **Base plate**: press **B** (or click **Box** in the toolbar) and enter width `w`, height `t`, depth `w / 2`. Enter creates it.
4. **Boss**: press **C** for **Cylinder**, radius `hole * 2`, height `t * 3`. Create, then press **M** (**Move**) and raise it with Move Y `t`.
5. **Drill**: press **C** again, radius `hole`, height `t * 6`. Create.
6. **Combine**: click the plate, Shift+Click the boss, press **U** (**Union**) — the picked bodies are pre-filled in order. Then click the union result, Shift+Click the drill cylinder, and press **X** (**Subtract**); the first pick is the base the rest are cut from. The inputs are consumed; the result is a single watertight body.
7. **Make it parametric**: change `w` to `80` in the sidebar — the whole part rebuilds. Select any feature in the history (or click its body in the viewport) to edit its inputs, rename it, or delete it; undo/redo covers everything.
8. **Sketches**: press **S** for a profile (rectangle/circle/polygon on the XY/XZ/YZ planes, with center offsets and plane offsets) — profiles show as outlines in the viewport — then **E** to **Extrude** (distance can be an expression) or **R** to **Revolve** (offset the profile so it clears the axis).
9. **Look around**: keys **1/2/3/4** jump to Front/Top/Right/Iso views, **F** (or double-click) fits, **G** toggles the grid, **W** cycles shaded/edges/wireframe.
10. **Export**: the STEP button writes a true ISO 10303-21 AP214 file of the selected body (or all live bodies); STL writes ASCII STL. Open the STEP file in FreeCAD/Fusion/SolidWorks — it imports as a closed solid.
11. Save a revision with **Ctrl+S** at any point (the dot next to the project name marks unsaved changes); parameters, features, and edits persist and replay with the document.

Press **Ctrl+K** for a searchable palette of every command, or **?** for the keyboard cheat sheet.
