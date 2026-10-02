# L07 dead-code audit — 2026-10-02

Worktree: `claude/muse-l07-dead-code`, base `main` at `90732be5`.
Row L07 asks for removal of obsolete creation/editor machinery or artifact
orchestration **only after proving it unused on current main**, isolated from
feature work. Every removal below carries grep proof; anything that could not
be proved airtight was kept and is listed with its reason.

Proof method for each candidate: word-boundary `rg` for the symbol across the
whole repo (apps, packages, test, e2e, workers, desktop, configs), an
import-path search for the file stem, a dynamic-import/string-reference
search, and — for CSS — a literal search plus a template-literal /
`classList` / `hud.create` construction search in all `.ts/.tsx/.js`. CSS
candidates built by string interpolation (e.g. `` `command-${variant}` ``)
are invisible to naive greps; three such false positives were caught during
this audit (see "Kept").

## Removed code (with proof)

1. `apps/web/src/lib/extrudePreview.ts` + `extrudePreview.test.ts` (deleted).
   Camera 2.3 machinery (`previewExtrudeOperation`, `previewExtrudeInput`,
   `ExtrudePreviewPlaneRef`). Proof: `rg` for all three symbols outside the
   defining file and its own test returns zero hits; the only import-path
   reference repo-wide is the deleted test; no e2e, worker, desktop,
   wrangler-config, `package.json` exports, or dynamic-import reference.
   (`extrudePreviewError` and `regionExtrudePreview` are different, live
   symbols and are untouched.)
2. `apps/web/src/lib/previewBodies.ts` + `previewBodies.test.ts` (deleted).
   `mergePreviewBodies` has zero importers outside its own test
   (`sectionOutline.test.ts` hits are unrelated local variables of the same
   name, not imports).
3. `apps/web/src/lib/holeFacePick.ts`: removed `modelingOperationPicksManyFaces`,
   the deprecated `HoleFacePick` alias, and `resolveHoleFacePick` (zero
   references outside the defining file and its test; `App.tsx` and
   `ModelingOperationsForm.tsx` use only `resolveFormFacePick` /
   `FormFacePick`). The test's two `resolveHoleFacePick` call sites were
   repointed to the live `resolveFormFacePick('hole', …)`, preserving that
   coverage; the rest of the test file is unchanged.
4. `apps/web/src/lib/interaction/cylinderRadius.ts`: removed
   `signedRadialDelta`, `radiusToDiameter`, `diameterToRadius` (zero
   references outside the defining file and its test; all other exports of
   the file are used by `App.tsx`/`ModelViewer.tsx`). Test updates: dropped
   the conversion-only case and the `signedRadialDelta`-only axial case,
   and rewrote the radial-direction assertions against the live
   `cylinderRadialFrame` outputs (`radialDirection`, `radiusAtHit`).
   `dot` is still used internally by the remaining functions.
5. Deferred: `apps/web/src/components/ModelViewer.tsx` still exports the
   unused `ExtrudePreview` interface (`sketchId`, `distance`), the last
   remnant of the Camera 2.3 React-state extrude gizmo path. A bare
   `\bExtrudePreview\b` search finds no consumer, but the file is being
   edited by several open pull requests, so the 5-line deletion waits for a
   quiet moment rather than adding a conflict.

## Removed CSS (each verified dead by literal + construction-aware search)

- `responsive.css`: `.status-bar`, `.status-state`, `.status-hint`,
  `.status-groups`, `.status-filters` (the only code hit for `status-bar`
  is a comment in `stepImportRun.ts`; no `status-${…}` construction exists;
  the status bar era is over — `WorkspaceReadout` now renders the
  `workspace-toast` contentinfo landmark).
- `status-bar.css`: `.status-warning`.
- `topbar.css`: `.artifact-menu*` / `.artifact-menu-panel*` selectors and
  rule blocks (removed from groups shared with the live `.topbar-menu*`
  selectors, whose rules are intact).
- `inspector.css`: `.danger-zone` (+ its `.secondary` compound).
- `motion.css`: `.start-expand` from the shared transition group.
- `view-mode.css`: `.view-mode-rail-launcher` (base hover + media-query rule).
- `workspace-column.css`: `.workspace-column-header .sketch-mark`,
  `.workspace-column-header .spacer`, the `.workspace-column-search` block,
  `.viewport-dock-lane`, `.viewport-dock`, `.viewport-dock .viewer-rail`,
  `.viewport-dock .viewport-scale-indicator`, and the 520 px dock-scroller
  rules (the `.workspace-toast` side of the shared media-query group is
  kept; phone readout behavior is owned by `quiet-stage.css`).
- `direct-manipulation.css`: `.sketch-rail-group-label` (base + media
  rule; the only test reference asserts its absence),
  `.sketch-entity-constraint-tools` (+ button/hover/active states).
- `quiet-stage.css`: `.workspace-column .sketch-rail-group-label`.

## Kept, with reason

- **Camera 2.3 remainder is live**: `resolvedExtrudePreviewKey` /
  `reuseResolvedExtrudePreview` (region-rig reuse cache used by `App.tsx`),
  `extrudePreviewError`, the `ExtrudeForm` edit path, the region-rig
  `LivePreview`, and viewport's `createExtrudePreviewGeometry`.
  `ExtrudeOverlay`, `profileExtrudePreview`, `confirmExtrude`, the
  `extrudePreview` state, and the no-sketch picking mode are already absent
  (zero hits) — that part of Camera 2.3 closed before this audit.
- **E6 artifact orchestration**: `JOB_QUEUE`, `OpenZCADExportWorkflow`, and
  `queues`/`workflows` keys in both `wrangler.jsonc` files are already
  absent. The live presigned-upload/finalize → `ARTIFACTS` + `ArtifactRecord`
  pipeline (`PROJECT_ARTIFACTS_ROUTE`, `archiveArtifact.ts`,
  `artifactUpload.ts`, `cloudflare-adapters`) is live and untouched.
- **Feature flags**: no dead flags exist. All 13 `CLOUDFLARE_BOOLEAN_FLAGS`
  have registry + env + worker + test references; `VITE_E2E`, `OZ_PERF`,
  `OZ_BUILD_COMMIT`, `OZ_REMUS_*` are live build-time defines;
  `UNSTABLE_*` are plain constants, not flags.
- **CSS false positives caught before deletion** (kept, live via dynamic
  construction): `.command-tile` (rendered via `` `command-${variant}` ``),
  `.phase-*` / `.pill-*` (via `` `phase-${model.phase}` `` /
  `` `pill-${model.phase}` ``), all `is-*` state classes (via
  `` `is-${saveState}` `` / `` `is-${accountState}` `` /
  `` `is-${sectionStatus.kind}` `` — `WorkspaceSaveState` includes
  `device-failed`, `local-source`, `repair`, etc.), measurement
  `.measurement-quality.*` / `.measurement-status.*` modifiers (via
  `` `${entry.quality}` `` / `` `${entry.status}` `` with values including
  `exact-analytic`, `unresolved`, `stale`), `.selection-band.crossing`
  (`classList.toggle`), `.sketch-center-axis .horizontal/.vertical`
  (render loop), `.is-synced` (`StartScreen`), `.shapr-status` /
  `.collaboration-state` / `.activity-pill` modifiers (dynamic status
  values), and all generic names (`unreadable`, `applied`, `stale`, …)
  that cannot be proved dead. Bare `.viewport-dock` was removed but every
  `viewport-dock-*` child segment class is live and kept.
- **Packages**: no orphan non-test source file exists (259 files checked).
  Five misnamed `packages/kernel-adapter` test files import sibling modules
  rather than a namesake file, but they cover live code, so they stay.
  `AI_CAD_OPERATION_CAPABILITIES` and `mergeCollaborationDocuments` are
  prod-unreferenced but ambiguous (registry / public-API surface) — kept.
  Test-only helpers (`growingHolderPreview`, `measurementUnits`) are
  imported by live-covering tests — kept.
- **Not attempted this pass**: further `sketch-mode.css` orphans
  (e.g. `.sketch-workspace`, `.sketch-canvas`, `.sketch-tools`,
  `.sketch-setup*`, `.plane-picker`, `.extrude-direction`,
  `.extrude-profile-field`, `.extrude-actions`, `.profile-pick-prompt`). Spot greps show zero
  JS references, but each grouped-with-live rule needs the same careful
  selector surgery as above; left as a bounded follow-up.

## Verification

Local runs on the cleanup branch (before the deferred `ModelViewer.tsx` edit
was dropped, which removes only an unused type):

- `pnpm typecheck`: clean.
- `pnpm lint`: 0 errors; 19 warnings, all in untouched files.
- Root `pnpm exec vitest run`: 305 files passed (3 skipped), 3227 tests passed
  (7 skipped).
- `pnpm test:web`: 184 files, 1519 tests passed.
- `node scripts/check-css-classes.mjs`: every classed element is styled
  (305 files against 879 classes from 29 stylesheets).
- Bundle-size budget: removal-only; not measured.
- Not run: `pnpm build`, Playwright. The CSS removals in
  `workspace-column.css` have no browser evidence behind them beyond CI.
