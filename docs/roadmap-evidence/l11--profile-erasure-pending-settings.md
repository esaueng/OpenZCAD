---
row: L11
---

Confirmed profile/all-data erasure suspends cloud-settings autosave and drains
in-flight writes without requiring a locked device to upload preferences that
the erasure removes. Device settings remain pending locally; failed erasure
restores only the unchanged account session. Existing project retention, key
cleanup, logout flushing and projects-only deletion behavior are preserved.
Regressions cover failed settings saves, in-flight responses, failed erasure
and account switching (`cloudSettingsAutosave.test.ts`).
