---
row: L11
---

ADR-024 Phase 8, automatic sign-in migration: the authenticated browser checks all four availability gates before loading key or migration code. With default-on, it opens the existing mandatory recovery-key setup/unlock/certification UI when necessary, verifies and pins the MAC-protected new-project preference as enabled, then runs the existing journaled migration controller once per signed-in page session. An untrusted preference requires explicit true-only repair in Settings. Unfinished cutover purges are included after reload. Existing member-readiness, journal resume, Web Locks, progress, errors and pause controls remain in use; readiness notifications never restart a manual run or paused automatic run in the same session.

Settings reads now have their own cancellation scope, so closing Settings preserves an independent background run. Account/key-session teardown still invalidates every scope and zeroes cached secrets; the automatic run's abort signal also prevents a delayed Web Lock callback from starting work. Migration staging refuses a different account returned by the session endpoint and is fenced to the initiating key session.

Focused coverage includes closed gates, setup/certification continuation, real MAC verification and preference pinning before migration, forged-setting refusal, true-only repair, discovery errors, unfinished purges, manual runs, delayed account responses, delayed locks, in-flight cancellation, independent view scopes and cross-tab secret teardown. This does not activate production flags, run a production migration, implement the legacy read/freeze/removal slices, or replace the required outside crypto review.
