---
row: I04
---

Repeat STEP downloads can reuse a completed write after a byte-for-byte match
of the serialized solids and matching export metadata. On the 160-face holder,
nine repeat downloads per build had a median of 66.6 ms on the original
baseline, 60.4 ms on main, and 30.9 ms with reuse (2.16× from baseline).
All 36 first and repeat downloads matched the baseline DATA-section digest.
The first download took 83.6 ms on main and 87.0 ms with reuse.
[Browser probe and fixture](docs/browser-test-suites.md).
