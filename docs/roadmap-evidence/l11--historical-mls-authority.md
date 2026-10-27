---
row: L11
---
Historical MLS authorization work in progress (ADR-024 8-C5b). A stateless
Rust/WASM verifier replays the public transcript with the project policy,
checks the independently supplied owner, and returns the exact target roles,
roster, GroupContext and tree. Historical directory views apply each device's
cutoff independently and exclude certifications from future epochs. Archive
joins and rejoins use the same policy replay. Unverified decoded rosters are
only inputs to certification verification, never authorization results.

Native regressions cover exact historical rosters, checkpoint equivalence,
wrong owner/project, signed unauthorized role changes and foreign removals,
and authorization before versus at a revoked device's cutoff. The Linux MLS
workflow now runs the native tests before reproducing the committed WASM.

Application trust persistence, owner checkpoint production/use, document
author integration and complete build verification are not yet complete.
Production activation remains off pending written outside-review clearance;
macOS verification remains deferred.
