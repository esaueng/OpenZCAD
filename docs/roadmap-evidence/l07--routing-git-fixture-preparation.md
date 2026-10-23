---
row: L07
---
CI routing tests prepare immutable Git objects and main history in suite setup,
then retain every routing and provenance assertion under the existing five-second
test deadline. An automated six-second fixture fetch reproduces the old timeout;
the prepared case passes with unchanged test, setup and job deadlines. The
no-network regression proves cold evidence fails closed, all routing checks pass
without fetching after preparation with a shallow PR merge HEAD (including when
main equals the pin), and a stale main ref still rejects the pin
(`test/trusted-pr-policy.test.ts`, `scripts/test-fleet-test-fixtures.py`). Active
workflow bytes, pins, runner routing and required checks are unchanged. Full local
repository verification and the protected PR/queue runs remain delivery gates.
