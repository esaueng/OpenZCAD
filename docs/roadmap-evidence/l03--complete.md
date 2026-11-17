---
row: L03
state: Complete
---

All L03 slices the plan takes up are on main:
- save-point names and a versions list with editor, device and sync columns (#1668);
- a read-only preview, a per-checkpoint thumbnail and diffs between save states (#1674).

Each is safe under end-to-end encryption, since names and authors live in the encrypted, signed document, thumbnails stay on the device, and previews and diffs read the trusted history without sending anything. Optional content dedup was not taken up, as docs/plans/l08-l03-review-and-versions-plan.md (#1667) records.
