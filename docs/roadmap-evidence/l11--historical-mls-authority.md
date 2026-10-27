---
row: L11
---
Historical MLS authorization (ADR-024 8-C5b, #959). A stateless
Rust/WASM verifier replays the public transcript with the project policy,
checks the independently supplied owner, and returns the exact target roles,
roster, GroupContext and tree. Historical directory views apply each device's
cutoff independently and exclude certifications from future epochs. Archive
joins and rejoins use the same policy replay. Unverified decoded rosters are
only inputs to certification verification, never authorization results.

The app establishes owner intent independently at creation and from verified
recipient-bound invitations. An owner-signed manifest binds immutable roots,
generation bases and periodic owner checkpoints; each account transfers its
accepted state with an account-key MAC, certified-device signature and CAS.
Durable local pins reject rollback, withdrawal and same-sequence forks.
Historical head, revision, log and replaced-envelope checks require the exact
author device in the replayed epoch roster. D4 readers need no MLS leaf.

Replay also reaches the independently accepted terminal context and tree,
refusing a policy-valid competing fork that retains a demoted editor's role.
Unknown-time revocations count only within that exact authenticated prefix;
live admission remains fenced and document-author signed cutoffs remain
independent. V2 identity-authorized resets hash-bind the prior roots and
terminal state, retain old generations, and permit cold solo recovery after
the last writer is revoked. Wrong-identity approvals mutate neither group
nor local authority pins.

Native regressions cover exact historical rosters, checkpoint equivalence,
wrong owner/project, signed unauthorized role changes and foreign removals,
per-device cutoff boundaries, and the authenticated-prefix boundary. Real
Worker/SQLite regressions in `test/e2ee-authority-*.test.ts` cover owner intent,
MAC/signature/CAS pins, D4 history, forks, revoked checkpoint fallback and
cold identity recovery. Replay is bounded to 8,192 records and 64 MiB. The
Linux MLS workflow runs the native tests before reproducing committed WASM;
candidate-wide build and CI verification are required before merge.
Production activation remains off pending written outside-review clearance;
macOS verification remains deferred.
