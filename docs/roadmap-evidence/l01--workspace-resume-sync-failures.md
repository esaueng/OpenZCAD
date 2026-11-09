---
row: L01
---
Workspace view sync retains HTTP status and refusal codes, keeps the last
failure until a successful acknowledgement, backs off transient failures, and
waits for a subsequent model-sync acknowledgement after a document-version
fence. Permanent payload/auth refusals stop automatic retries; normalized view
state and document-version acknowledgement suppress duplicate writes. A single
grace-delayed notice uses the viewer's expiring, dismissible ToastHost instead
of covering drag guidance from the shell overlay. Regression coverage:
`useWorkspaceResume.test.tsx`, `workspaceResume.test.ts`,
`useWorkspaceResumeNotice.test.tsx`, and the drag-guidance bounds check in
`test/e2e/cloud-sync.spec.ts`. Live cross-device delivery remains unverified.
