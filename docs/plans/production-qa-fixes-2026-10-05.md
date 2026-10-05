# Production QA remediation — 5 October 2026

This plan addresses the nine confirmed findings from the production exploratory
and scripted pass. Implementation is based on the current `main`; the QA pass
tested a deployed build. Local regression evidence qualifies the proposed fixes,
not the production deployment. ROADMAP U02 owns the UI work, S03 the solver
refusal, F04 the import route, and W01 the pattern characterization.

| Finding                                              | Change                                                                                                                                                                                                                                                                                                                                        | Regression evidence                                                                                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA-001 · FreeCAD import blocked by CSP               | Route only the hashed FreeCAD converter worker through the asset binding and give its JavaScript response the policy required by the pinned Embind runtime. Keep the document policy strict; refuse writes and retain the policy on HTML fallbacks. Change the worker content so an old immutable response cannot supply its previous policy. | `freecad-worker-csp.test.ts`; real two-solid import, undo/redo and reload in `freecad-import.spec.ts` with the shipped CSP enforced.                                                                                 |
| QA-002 · Sketch session survives project creation    | Clear the interaction session, pending exact entry and document-bound edit drafts when hydrating a project. Abort an active pattern on the same boundary.                                                                                                                                                                                     | `production-qa-regressions.spec.ts`: switch projects while drawing, then create and finish a fresh sketch.                                                                                                           |
| QA-003 · Injected analytics blocked by CSP           | Allow the official analytics script host and beacon destination in their respective directives.                                                                                                                                                                                                                                               | Deployment-policy regression; no broader script/eval exception in the document.                                                                                                                                      |
| QA-004 · Viewport selection label contrast           | Use the existing readable muted-text token.                                                                                                                                                                                                                                                                                                   | Palette checks and rendered light-theme contrast measurement.                                                                                                                                                        |
| QA-005 · Invalid Bodies list children                | Give the empty state and consumed-body disclosure list-item ownership.                                                                                                                                                                                                                                                                        | `Sidebar.column.test.tsx` covers both states and expansion.                                                                                                                                                          |
| QA-006 · Numeric value has no accessible name        | Name the input after the operation's visible label.                                                                                                                                                                                                                                                                                           | `NumericKeypad.test.tsx`; named Distance input in Edge.                                                                                                                                                              |
| QA-007 · Dense circular pattern latency and feedback | Reuse exact overlap measurements only for pairs related by a common rigid rotation in a full-turn ring. Retain every pair's bounds/floor and the full pair sum used by the existing merge-integrity gate. Run pattern create/edit in a disposable abortable worker with elapsed-time feedback and cancellation before commit.                 | Exact cached/uncached pair sums for both directions and multiple source solids; refused-query coverage; existing overlapping-pattern volume/topology tests; Edge cancellation preserves the source and undo history. |
| QA-008 · Perpendicular solve collapses a line        | Refuse non-finite or degenerate solved geometry before publishing it, with a scale-relative precision threshold and an actionable error.                                                                                                                                                                                                      | Pinned GCS reproduction in `kernel-conformance.test.ts` asserts refusal and unchanged input. Existing valid solves and conflict rollback remain covered.                                                             |
| QA-010 · Numeric keypad contrast                     | Use readable tokens for the label, inactive unit buttons and commit text. Give inactive units an opaque surface.                                                                                                                                                                                                                              | Palette and rendered contrast checks against 4.5:1.                                                                                                                                                                  |

QA-009 was an opaque error from the external Turnstile frame in one session;
two fresh attempts did not reproduce it. It is not a confirmed application
defect. No speculative change to authentication or the third-party challenge
is proposed. A future production retest should collect it again if it recurs.

## Execution and acceptance

1. Reproduce each confirmed failure against the pinned code or browser policy,
   then implement the smallest change preserving units, tolerances and model
   integrity. Accessibility fixes use the existing theme palette.
2. Compare the 50-copy box pattern against an unchanged-source baseline on the
   same pinned kernel. Record timing as characterization, not a portable CI
   latency promise. Compare exact volume/bounds and topology; cancellation must
   leave both geometry and history intact.
3. Run the focused regressions in headed Microsoft Edge, including strict-CSP
   FreeCAD import and desktop/smaller-viewport UI checks. Static preview API
   stubs do not replace geometry, persistence or file conversion.
4. Run lint, typecheck, both Vitest projects, parity corpus and the full build
   including its size gate. Prepare a guarded local commit and reviewable PR.
   Deployment and production fix verification remain separate steps.

The cancellation worker is terminated as a whole because a synchronous WASM
operation cannot process an in-worker cancellation message while executing.
No backend traffic or production data is involved in these regressions.

## Local verification record

- Headed Edge 154.0.4258.53 on Windows, using the built app and the local
  Worker asset server. The normal production build passes the existing size
  gate. Browser-test instrumentation is built separately for the Edge flows.
- Full Vitest after integrating latest main: 3,994 root tests and 2,057 web
  tests passed; eight root tests were intentionally skipped. Parity corpus:
  182 passed, one skipped.
  Lint has zero errors and 18 existing hook warnings; typecheck passes.
- The local Worker serves the strict document policy, the dedicated worker's
  policy, and a strict HTML fallback for a missing worker chunk. FreeCAD import
  also checks that a local-only project makes no protected upload request;
  the archival boundary now declines locally until an account copy exists.
- The 50-copy 20 mm box characterization took 256.6 s on unchanged source
  and 235.1 s on the candidate in one run each. Both produced
  47,352.56305472418 mm³, the same bounds, 102 faces, 300 edges, 396 mesh
  triangles, and no warnings. The exact volume/bounds difference is zero
  within a relative tolerance of 1e-6. These samples do not establish a
  portable speedup: exact fusion still dominates this dense arrangement.
  The remedy for the long wait includes visible elapsed time and immediate
  cancellation with the source and undo history intact.
- Accessibility scans of the start screen, empty Bodies workspace, real
  FreeCAD result and pattern progress at 1024×768 and 768×650 returned no
  violations or browser console/network errors.
- Both sketch/keypad themes and a consumed Bodies list also returned no axe
  violations. Settled import notices clear on project switches, and a running
  pattern owns the activity lane so its cancel control stays readable.
- Seven focused Edge regressions pass on the combined candidate, including
  unobscured cancellation at all three viewports. Three existing archival
  project-switch/export-cancel regressions also pass; active transfers retain
  their established behavior, while completed notices clear on navigation.
- Merge review found the holder acceptance fixture still expected two archive
  failures. It now waits for the initial account project before importing,
  identifies that import archive and its exact error source, and asserts that
  the restored local-only copy exports without an extra protected upload. The
  local-only import regression also continues to assert no protected upload.
