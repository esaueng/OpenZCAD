# Holder workflow acceptance matrix (H01)

Roadmap row [H01](../../../ROADMAP.md#h01) asked for an explicit acceptance
matrix for the imported-holder workflow specified in
[`docs/plans/step-parameter-hammer-holder-plan.md`](../../plans/step-parameter-hammer-holder-plan.md)
(Phase 7, "Required cases"). Each case below names its evidence and its tier:

- **synthetic** — runs in CI on the redistributable synthetic holders
  (`test/fixtures/hammer-holder/*.step`, `test/support/synthetic-holder.ts`,
  `test/support/lettered-holder.ts`);
- **local-private** — runs only with the private hammer on this machine
  (`OPENZCAD_HAMMER_STEP=…`), never in CI;
- **live** — a recorded run against the deployed revision at zcad.app, which
  needs the private source and an account; not something an agent can
  produce.

Status is one of `covered`, `partial`, `limit` (a refusal that is pinned and
explained), `open`, and `pending live` (only the live tier is missing).

## Import and proposal

| Case                                   | Evidence                                                                                                                        | Tier      | Status       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------ |
| Fresh import, verified proposal, Apply | `test/e2e/growing-holder.spec.ts` (both tests); `test/growing-holder-assistant.test.ts` "offers a verified suggestion…"         | synthetic | covered      |
| Duplicate names on import              | `test/growing-holder-assistant.test.ts` (body named "Bracket" twice via retarget refusal); no browser case                      | synthetic | partial      |
| Translated input                       | `test/opening-recognition.test.ts` "measures a translated bracket…"; `test/growing-holder-assistant.test.ts` moved/rotated case | synthetic | covered      |
| Rotated input (world-axis aligned)     | `test/growing-holder-lettering.test.ts` rotated moved holder; `test/e2e/growing-holder.spec.ts` two Moves before Apply          | synthetic | covered      |
| Rotated off the world axes             | `test/opening-recognition.test.ts` "refuses a bracket rotated off the world axes"                                               | synthetic | limit        |
| Equivalent units — recognition         | `test/growing-holder-units.test.ts` (inch document measures 1/25.4 of the millimetre one; margins now scale, PR for H01)        | synthetic | covered      |
| Equivalent units — recipe build        | `test/growing-holder-units.test.ts` "refuses the inch recipe by name…": the exact bridge union refuses at inch scale (K07)      | synthetic | limit        |
| Unsupported model                      | `test/opening-recognition.test.ts` "refuses a solid with no facing pair…"; `growing-holder-assistant` unsupported history       | synthetic | covered      |
| Ambiguous geometry / drawing           | `test/growing-holder-ambiguous.test.ts`: E-shape publishes `ambiguous` + candidates, no suggestion, forged proposal refused     | synthetic | covered      |
| Guided selection after ambiguity       | `test/opening-recognition.test.ts` guided `faces` resolves the E-shape; no product surface offers the pick yet (H03)            | synthetic | partial      |
| Drawing attached to the request        | Phase 4 assistant flow; needs a live provider                                                                                   | live      | pending live |

## Parameter values and limits

| Case                                             | Evidence                                                                                                    | Tier      | Status  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------- | ------- |
| Source width, intermediate, large                | `growing-holder.spec.ts` 60 / 30 / 52; `growing-holder-recipe.test.ts` every placement                      | synthetic | covered |
| Derived minimum and just-below-minimum           | `growing-holder.spec.ts` 10 → clamp; height 1 → "must be at least"; `parameter-validation.spec.ts`          | synthetic | covered |
| Invalid expressions and non-finite inputs        | `parameter-validation.spec.ts`; `apps/web/src/lib/parameterEdit.test.ts`                                    | synthetic | covered |
| Bore diameter grow/shrink limits                 | `growing-holder-holes.test.ts` "shrinks countersunk bores and refuses to widen…"; e2e hole 4                | synthetic | covered |
| Height limits, derived overall width             | `growing-holder.spec.ts` height 40 / 22; `opening-recognition.test.ts` arm height                           | synthetic | covered |
| Parameter combinations, symmetry, hole placement | `growing-holder-holes.test.ts` "binds at any opening"; `growing-holder-recipe.test.ts` holes move with arms | synthetic | covered |
| Protected details (emboss, countersinks)         | `growing-holder-recipe.test.ts` volume deltas; `planar-emboss.test.ts`                                      | synthetic | covered |

## Editing lifecycle

| Case                               | Evidence                                                                                                      | Tier      | Status  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------- | ------- |
| Rapid edits                        | `test/e2e/perf-holder-reload.spec.ts` (OZ_PERF) five successive edits; no CI case                             | synthetic | partial |
| Undo/redo                          | `growing-holder.spec.ts`; `ai-holder-lettering.spec.ts`                                                       | synthetic | covered |
| Invalid-edit recovery              | `parameter-validation.spec.ts` keeps the last valid model                                                     | synthetic | covered |
| Worker interruption during Apply   | `test/e2e/growing-holder-interruption.spec.ts` reload mid-Apply: whole before or after, then edits continue   | synthetic | covered |
| Worker interruption during an edit | `test/e2e/growing-holder-interruption.spec.ts` reload mid-edit: 44 or 60, never a mix, then STEP exports      | synthetic | covered |
| Stale responses                    | `apps/web/src/hooks/useValidatedFeatureCommit.test.tsx` mid-archive project switch; `AssistantPanel.test.tsx` | synthetic | covered |
| Project switching                  | `useValidatedFeatureCommit.test.tsx` "mesh import switched mid-archive refuses in both projects"              | synthetic | covered |
| First edit after the second Apply  | Refused "changed during validation" (perf probe, 3/3); fix in progress under U02                              | synthetic | open    |

## Persistence and export

| Case                                    | Evidence                                                                                          | Tier      | Status  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- | --------- | ------- |
| Save/reopen                             | `growing-holder.spec.ts` reload; `growing-holder-assistant.test.ts` normalize/reload              | synthetic | covered |
| Project backup/import                   | `growing-holder-recipe.test.ts` `parseProjectBackup` round trip                                   | synthetic | covered |
| Source availability after reopening     | `test/e2e/import-cloud-sync.spec.ts`; `growing-holder.spec.ts` export after reload                | synthetic | covered |
| STEP reimport                           | `growing-holder-recipe.test.ts` `importStepBody`; `growing-holder-units.test.ts` (inch → mm)      | synthetic | covered |
| Closed STL output                       | `growing-holder-recipe.test.ts` `inspectTriangleMeshClosure`; `test/saved-project-export.test.ts` | synthetic | covered |
| Strict validity, bounds, hole witnesses | `growing-holder-recipe.test.ts`, `growing-holder-holes.test.ts`                                   | synthetic | covered |
| Existing documents / deprecated recipe  | `growing-holder-assistant.test.ts` "does not offer … unsupported history"; schema tests           | synthetic | covered |

## Private and live tiers

| Case                                                                                                 | Evidence                                                                    | Tier          | Status       |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------- | ------------ |
| Hammer measurement, growing, import, native stages                                                   | `test/hammer-holder-{measurement,growing,imported,native}.test.ts` (skipIf) | local-private | covered      |
| Hammer first-edit-after-reload latency                                                               | `perf-holder-reload.spec.ts` with `OZ_PERF_HOLDER_STEP` (H02 remainder)     | local-private | open         |
| Original-source import → proposal → combined edits → undo/reopen → STEP/STL on the deployed revision | Phase 8 walkthrough on zcad.app                                             | live          | pending live |

## What this PR changed

- Recognition margins are millimetre lengths and now scale by the document's
  unit, so an inch document measures the same physical holder (before, a 2 mm
  minimum straight run became a 2 inch one and every inch holder refused).
- The recipe build in an inch document is refused by the kernel's exact union
  at the bridge; pinned as a named refusal, tracked under K07.
- Ambiguous geometry is pinned end to end: digest verdict, no suggestion,
  forged proposal refused with the recognizer's reason.
- Two browser interruption cases.

## Live checklist (for the maintainer)

On zcad.app with the private hammer, record build commit (`/build-meta.json`),
then: import → "Parameterize the opening" → "Parameterize the mounting holes"
→ width 55, height 64 (if offered), bore 6 → undo twice, redo twice → reload →
export STEP and STL → reimport the STEP into a new project. Note any status
that is not "Parameter … updated." and the wall time of the first edit after
the reload. Record the result in this file under a dated heading.
