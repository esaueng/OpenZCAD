---
row: L11
---
ADR-024 Phase 8-4 adds the deployment-wide E2EE_PLAINTEXT_FROZEN gate,
default off in both deployment configurations. The Worker refuses legacy
document, sharing, measurement, workspace-session and upload writes before
body parsing; persistence and existing room sockets independently fence
plaintext mutation. The server-marked encrypted-blob transport remains usable
for single-part and multipart uploads, including migration staging. Reads,
erasure, access revocation and shelf organization remain available. Reverse
migration closes and the sweep abandons its staging. Preflight requires global
keys and default-on; self-host documentation covers activation and recovery
order. Focused Worker, storage, socket, encrypted-upload and configuration
regressions verify the gate. Production activation remains off pending outside
review and migration/legacy-reader qualification. This slice does not retire
the plaintext pipeline or complete L11.
