---
row: L11
---
Phase 8-C2 browser follow-ups use an account/project-scoped IndexedDB journal
with transactional updates and cross-tab locks. Interrupted registrations
retry the same grant, id and project-key-wrapped share key; partial reissues
retain both completed replacements and unfinished sources across reloads.
Revoked grants cannot be recreated by a saved job, verified source modes govern
reissue, and identity retirement preserves current-identity links. Removal
notices persist the affected link IDs while the sharing dialog is closed,
exclude post-removal grants, and acknowledge only the epoch shown. Empty sets
leave no notice for future links. Unit, real-Worker integration and UI
regressions cover these failure paths. Notifications deliver their affected
IDs after journal completion without
waiting for remote upkeep; an unavailable journal retains a transient prompt
and warning in an open dialog. Older background responses cannot erase a newer
notice, including while the initial list is pending or a later list has no
persisted notice. Discarding device keys and confirmed account erasure clear
all of that account's journal records; keeping the device preserves them.
Cleanup failure keeps the device record for retry. Owner-device statement
refresh and fresh-browser share-set ancestry
remain separate work; this slice does not complete L11 or activate production
encryption.
