---
row: L11
---
Migration stages canonical rebuild data instead of requiring legacy original
import archives. Embedded STEP and mesh payloads, import commands and undo/redo
fragments become the existing checksum-addressed source form in the staging
copy. Referenced sources can recover from a verified local copy; unavailable
or mismatched required data still prevents cutover and preserves plaintext.
Source work is reused by kind/checksum/length across imports and save states,
and independent initial reads overlap. Regression coverage includes fresh
device readback, historical-only imports, source recovery/refusal, one download
and encryption for duplicate content, pause/resume and unchanged exact-kernel
mesh/topology after source conversion (`test/e2ee-project-migration-engine.test.ts`,
`test/project-source-preparation.test.ts`). No key protocol, schema version,
deployment flag or production migration is changed.
