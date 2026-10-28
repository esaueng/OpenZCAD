---
row: L01
---
Portable backups retain one canonical source payload across the model and
retained history instead of duplicating STEP originals in `files` and
`sources`. Legacy embedded data is externalized in the backup copy without
altering the live document. Original interchange files are opt-in; required
rebuild sources always travel. Bulk downloads offer an explicit choice to
skip extra device recovery records, reuse each project's file catalog across
backups, and collect save coverage without reparsing completed backup JSON.
The existing size/memory bounds, local/cloud separation, verified encrypted
readers and atomic omission reporting remain in force. Tests cover independent
restore, optional originals, duplicate STEP bytes, catalog request counts,
snapshot selection and responsive download controls. Production timing and
affected-account completion remain separate from local/hosted validation.
