---
row: L07
---
The disposable fleet Git fixture dispatches ordinary reads directly to real Git,
avoiding a Python interpreter launch for each operation. Delayed fetches retain
the same Python implementation, and the dispatcher retains the missing immutable
object guard before preparation. Offline, stale-pin, main-ancestry, exact-fetch
count and real Vitest control/prepared assertions remain intact.

This addresses interpreter overhead observed alongside a Hosted cold-evidence
test timeout and deadline-control setup failure. A serial local comparison reduced
the cold regression from 3.31 to 2.71 seconds and the nested deadline experiment
from 7.83 to 7.53 seconds; those measurements do not guarantee Hosted timing.
The five-second test, ten-second setup, nine-second child-process limit and
six-second delayed-fetch control are unchanged, as are active workflow pins and
runtime routing. Focused verification passes all 34 policy/history tests.
Required local lint, type checking, root tests (7,312 passed, eight skipped), web
tests (3,828 passed), parity corpus and build pass. The Python 3.9 fixture and
the direct/queue policy suites also pass.
