---
row: L03
---

A previewed save state no longer lets the project stand in for it: model
exports (STEP, IGES, mesh, 3MF, CNC, face and sketch DXF/SVG, flat pattern)
are refused with Close/Branch guidance instead of silently writing the live
model, Measure keeps the preview and says how to measure, the viewport scale
and section readouts use the version's own stored unit, and kept measurement
pins are not drawn over it. Links without history are not frozen from the
project behind a preview, the viewport outlines the version's own sketches,
selection readouts read the version's stored unit, a cut moved over the
version is kept in the project's unit, and a preview still building is
dropped when the workspace changes
(`apps/web/src/lib/saveStatePreview.test.ts`,
`apps/web/src/components/ProjectSharingDialog.test.tsx`,
`test/e2e/save-state-versions.spec.ts`,
`test/e2e/convert-stored-units.spec.ts`; issues #2364, #2365, #2366).
