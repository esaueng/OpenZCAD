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
version is read in the version's unit, and a preview still building is
dropped when the place it was asked from is left (a workspace, a tool, the
Revisions panel). One central gate (`PREVIEW_LIVE_OUTPUTS`) refuses every
export, link, invitation, account save and saved-view write during a
preview; the project's view (camera, fit, cut, display, visibility) is held
and put back unchanged when the preview closes, with nothing remembered in
between; the Inspector reads each body in the stored unit of the document
its geometry is from; and the version's own consumed sketches, reference
images and datums are what the viewport draws
(`apps/web/src/lib/saveStatePreview.test.ts`,
`apps/web/src/hooks/useProjectView.test.tsx`,
`apps/web/src/components/ProjectSharingDialog.test.tsx`,
`apps/web/src/components/Inspector.test.tsx`,
`apps/web/src/components/SavedViewsSection.test.tsx`,
`test/e2e/save-state-versions.spec.ts`,
`test/e2e/convert-stored-units.spec.ts`,
`test/e2e/reference-images.spec.ts`; issues #2364, #2365, #2366).
