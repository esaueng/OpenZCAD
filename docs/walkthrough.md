# Walkthrough: a parametric bracket in five minutes

1. Start the app with `pnpm dev:web` and create a project on the start screen (pick your units).
2. **Parameters** (left sidebar): add `w = 60`, `t = 8`, and `hole = 6`.
3. **Base plate**: in the right panel choose **Box** and enter width `w`, height `t`, depth `w / 2`. Create.
4. **Boss**: choose **Cylinder**, radius `hole * 2`, height `t * 3`. Create, then choose **Move** and raise it with Move Y `t`.
5. **Drill**: choose **Cylinder**, radius `hole`, height `t * 6`. Create.
6. **Combine**: choose **Union**, pick the plate then the boss. Then choose **Subtract**, pick the union result first and the drill cylinder second. The inputs are consumed; the result is a single watertight body.
7. **Make it parametric**: change `w` to `80` in the sidebar — the whole part rebuilds. Select any feature in the history to edit its inputs, rename it, or delete it; undo/redo covers everything.
8. **Sketches**: choose **Sketch** for profiles (rectangle/circle/polygon on the XY/XZ/YZ planes, with center offsets and plane offsets), then **Extrude** (distance can be an expression) or **Revolve** (offset the profile so it clears the axis).
9. **Finish an edge**: click an exact edge in the viewport. Its stable edge ID appears in the inspector with contextual **Fillet** and **Chamfer** actions. Choose **Fillet**, enter a radius, and create it. Click a face to verify face-level selection in the same inspector.
10. **Repeat a body**: choose **Linear pattern** or **Circular pattern**, select the latest live body, and set the count, axis, and spacing/angle. The source becomes consumed and the exact compound result remains editable in history.
11. **Import and keep editing**: use **Import** to choose a STEP file. It becomes an `Imported STEP` feature backed by the embedded exact source, so it can participate in transforms, booleans, finishing, patterns, and export after replay. STL remains a mesh compatibility import.
12. **Export**: the STEP button asks the same OpenCascade browser worker that built the viewport to write an exact ISO 10303-21 AP214 file of the selected body (or all live bodies); STL export follows the same path. Open the STEP file in FreeCAD, Fusion, or SolidWorks — it imports as a closed solid.
13. Keep modeling while IndexedDB autosaves every document change. Use **Save** to create a durable beta-cloud checkpoint when the API is available. A green collaboration badge shows room presence; newer edits from another authenticated tab are applied live, while conflicts preserve the local copy for recovery.
