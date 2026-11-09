---
row: L10
---

Account membership, storage usage and per-project limits use locale-grouped
counts and adaptive binary KB/MB/GB sizes without trailing zero decimals.
The existing Project properties formatter now shares its implementation with
Account and cloud deletion while retaining their explicit IEC labels.
Formatter boundary/fraction/locale tests and Settings regressions cover
Premium's 10,000 projects, 100 GB allowance and 24 MB usage; membership browser
assertions cover both Free and Premium effective limits. Server quotas and
persisted formats are unchanged.
