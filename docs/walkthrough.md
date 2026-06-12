# Walkthrough: a parametric bracket in five minutes

1. Start the app with `pnpm dev:web` and create a project on the start screen (pick your units).
2. **Parameters** (left sidebar): add `w = 60`, `t = 8`, and `hole = 6`.
3. **Base plate**: in the right panel choose **Box** and enter width `w`, height `t`, depth `w / 2`. Create.
4. **Boss**: choose **Cylinder**, radius `hole * 2`, height `t * 3`. Create, then choose **Move** and raise it with Move Y `t`.
5. **Drill**: choose **Cylinder**, radius `hole`, height `t * 6`. Create.
6. **Combine**: choose **Union**, pick the plate then the boss. Then choose **Subtract**, pick the union result first and the drill cylinder second. The inputs are consumed; the result is a single watertight body.
7. **Make it parametric**: change `w` to `80` in the sidebar — the whole part rebuilds. Select any feature in the history to edit its inputs, rename it, or delete it; undo/redo covers everything.
8. **Sketches**: choose **Sketch** for profiles (rectangle/circle/polygon on the XY/XZ/YZ planes, with center offsets and plane offsets), then **Extrude** (distance can be an expression) or **Revolve** (offset the profile so it clears the axis).
9. **Export**: the STEP button writes a true ISO 10303-21 AP214 file of the selected body (or all live bodies); STL writes ASCII STL. Open the STEP file in FreeCAD/Fusion/SolidWorks — it imports as a closed solid.
10. Save a revision from the top bar at any point; parameters, features, and edits persist and replay with the document.
