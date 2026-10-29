---
row: W01
---
The device-only library paint shown before account discovery now uses the
same pinned-then-custom-order comparator as the merged listing, so reloading
no longer draws cards in storage key order and reshuffles them when the
account listing lands. Projects only the account holds still appear when that
listing arrives. Coverage: `localProjectStore.test.ts` (saved shelf order, not
key order).
