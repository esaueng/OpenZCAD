---
row: L01
---

Data downloads skip unavailable or oversized project copies and continue with
the remaining projects. The completion UI and the ZIP's `NOT-INCLUDED.txt` and
manifest list every omitted backup by name, ID, copy and reason. Project/history
files commit atomically, failed projects spend no archive budget, report space
is reserved, and portable backups take priority over the optional raw snapshot.
Archive and UI regressions cover failed reads, missing history, capacity,
later-project success, raw snapshot omission and account-change cancellation.
