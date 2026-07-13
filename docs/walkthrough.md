# Walkthrough: a parametric bracket in five minutes

1. Start the app with `pnpm dev:web` and create a project on the start screen (pick your units).
2. **Parameters** (left sidebar): add `w = 60`, `t = 8`, and `hole = 6`.
3. **Base plate**: press **B** (or click **Box** in the toolbar) and enter width `w`, height `t`, depth `w / 2`. Enter creates it.
4. **Boss**: press **C** for **Cylinder**, radius `hole * 2`, height `t * 3`. Create, then press **M** (**Move**) and raise it with Move Y `t`.
5. **Drill**: press **C** again, radius `hole`, height `t * 6`. Create.
6. **Combine**: click the plate, Shift+Click the boss, press **U** (**Union**) — the picked bodies are pre-filled in order. Then click the union result, Shift+Click the drill cylinder, and press **X** (**Subtract**); the first pick is the base the rest are cut from. The inputs are consumed; the result is a single watertight body.
7. **Make it parametric**: change `w` to `80` in the sidebar — the whole part rebuilds. Select any feature in the history (or click its body in the viewport) to edit its inputs, rename it, or delete it; undo/redo covers everything.
8. **Sketches**: press **S** for a profile (rectangle/circle/polygon on the XY/XZ/YZ planes, with center offsets and plane offsets) — profiles show as outlines in the viewport — then **E** to **Extrude** (distance can be an expression) or **R** to **Revolve** (offset the profile so it clears the axis).
9. **Finish an edge**: click an exact edge in the viewport. Its stable edge ID appears in the inspector with contextual **Fillet** and **Chamfer** actions (also enabled in the toolbar while an edge is selected). Choose **Fillet**, enter a radius, and create it. Click a face to verify face-level selection in the same inspector.
10. **Repeat a body**: choose **Linear pattern** or **Circular pattern** from the toolbar, select the latest live body, and set the count, axis, and spacing/angle. The source becomes consumed and the exact compound result remains editable in history.
11. **Import and keep editing**: use **Import** to choose a STEP file. It becomes an `Imported STEP` feature backed by the embedded exact source, so it can participate in transforms, booleans, finishing, patterns, and export after replay. STL remains a mesh compatibility import.
12. **Look around**: keys **1/2/3/4** jump to Front/Top/Right/Iso views, **F** (or double-click) fits, **G** toggles the grid, **W** cycles shaded/edges/wireframe.
13. **Export**: the STEP button asks the same OpenCascade browser worker that built the viewport to write an exact ISO 10303-21 AP214 file of the selected body (or all live bodies); STL export follows the same path. Open the STEP file in FreeCAD, Fusion, or SolidWorks — it imports as a closed solid.
14. Keep modeling while IndexedDB autosaves every document change. Use **Save** (Ctrl+S) to create a durable beta-cloud checkpoint when the API is available. A green collaboration badge shows room presence; newer edits from another authenticated tab are applied live, while conflicts preserve the local copy for recovery.

Press **Ctrl+K** for a searchable palette of every command, or **?** for the keyboard cheat sheet.
