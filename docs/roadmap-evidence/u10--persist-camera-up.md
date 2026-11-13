---
row: U10
---

An upside-down view survives reload: the camera's held up is recorded with
the pose (`ViewportCameraState.up`, omitted when it is world +Z) and kept by
the per-device view, saved views and the cross-device resume state; a saved
view glides onto its roll instead of turning over at the end
(`CameraController.test.ts`, `workspaceSession.test.ts`, `savedViews.test.ts`,
`test/workspace-resume-field-of-view.test.ts`,
`test/e2e/upside-down-view-reload.spec.ts`).
