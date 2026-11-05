---
row: L02
---

Follow-up to [#1230](https://github.com/esaueng/OpenZCAD/pull/1230): keep a
long press's release click suppressed for the entire hold, then start the
one-second delayed-click grace period when its pointer ends. A new deliberate
press clears leftover suppression after a cancelled hold or a missing click.

The focused `touchLongPress.test.ts` suite passes all eight cases using the
repository's Vitest 5.0.5 and happy-dom 21.0.4 versions in an isolated local
runner. Regressions cover holding the menu open for five seconds, a new tap
after cancellation, and expiry after release. Restoring the original module
makes the long-hold and cancellation regressions fail. This is local regression
evidence; the updated PR heads still require the full CI gates.
