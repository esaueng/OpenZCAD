---
row: L07
---

The existing fleet-policy provenance reader normalizes Git's UTC `Z` suffix to
`+00:00` before parsing its shallow-history date. The cold-fixture regression
exposed Python 3.9 rejecting that timestamp before the fetch refusal could run.
The unchanged offline, stale-pin and real six-second deadline assertions pass
with Python 3.9 and 3.12. Explicit timezone offsets, ancestor checks, immutable
workflow pins and test deadlines retain their existing behavior.
