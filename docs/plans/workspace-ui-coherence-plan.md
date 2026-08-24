# Workspace UI coherence plan

Status: plan of record for the 2026-08-23 design and UI review. Not started.
Source: a 54.9-second screen recording of the modeling workspace, reviewed
without code access, covering workspace overview, hole-diameter direct edit,
face offset, edge fillet by drag, exact numeric entry, a geometry validation
failure, and a successful hole-edge fillet.

This document reconciles that review against the code, against the UI overhaul
plan already in flight, and against product decisions taken earlier. It governs
the review's findings when they are implemented. Where an implementation detail
below has drifted, verify the current code, record the correction, and preserve
the product intent.

## Execution gate

- One phase per feature branch, merged to `main` before the next starts.
- Phases 1 and 2 are ordered and binding: nothing cosmetic ships before the
  state model is single-sourced.
- Phases 3-7 may be reordered, but each must state which phase it assumes.
- The review's own five-phase ordering is superseded by the phases here.

## Verified baseline corrections

Checked against `origin/main` at `08dc799c` before the plan was written. The
review had no code access, so it is graded rather than assumed. Line references
are a snapshot; verify before relying on one.

### Confirmed defects

| Review finding | Evidence |
|---|---|
| P0-1 contradictory command state | Two independent selection models. `selectedFeatureNodeId` drives the Inspector title, eyebrow, and form (`apps/web/src/components/Inspector.tsx:849-850`); the interaction machine drives the ToolCard title and hint (`apps/web/src/lib/interaction/machine.ts:596-609`). Picking an edge sets both (`apps/web/src/App.tsx:8079`), and the feature id comes from `featureNodeIdForBody` (`App.tsx:7757`), which deliberately walks history backwards to the last feature defining the body. Filleting an edge on a body whose last operation was an offset therefore titles the Inspector `Offset face` and prints `operation: offset face` while the ToolCard says `Fillet`. |
| Disagreeing values in one operation | Inspector numbers come from the committed history node (`initial.size = data.radius`, `Inspector.tsx:1027`); the in-canvas chip comes from live drag state. `R 1 mm` against `2.2` is a new drag against a previously applied fillet. The `cylinderRadiusSetterRef` imperative bridge (`Inspector.tsx:646-670`, wired at `App.tsx:12848`) exists only because the two models were never unified. |
| P0-4 error placement and staleness | 253 `setStatus()` calls in `App.tsx` funnel into one global string, so a fillet failure shares a surface with `Reopened <project>.`. Nothing clears a command diagnostic when its input changes. |
| P0-5 implementation language | `Resize Cylinder Radius` (`machine.ts:596`) against a `Diameter` value label (`Inspector.tsx:1171`); `consumed` reaches the user as a body-group label (`components/Sidebar.tsx:353`) and as a body status (`Inspector.tsx:279` "consumed by boolean") — the sidebar group is at least already collapsible with an explanatory tooltip; "exact geometry kernel" is user-facing (`App.tsx:7218`, `:7267`). |
| 1.4 undo/redo grouped with navigation | Undo/redo live in `components/ViewerToolbar.tsx` alongside `OrientationWidget.tsx`, not in the document toolbar. |
| 8.5 unlabelled commit control | The keypad commit action is icon-only (`components/NumericKeypad.tsx`). |

### Findings that contradict settled decisions

These are not implemented as written. The reviewer could not have known them
from a recording; they are recorded here so they are not re-litigated.

| Review finding | Why it is not adopted |
|---|---|
| P0-2 "remove the top command HUD; make the right inspector the authoritative command panel" | Inverted. The floating top-centre command card and the in-canvas keypad are the deliberate implementation of the demonstrated interaction target: current tool as a small floating card with a one-line hint, numeric override at the point of action, and explicitly never a properties panel. `ToolCard.tsx` documents itself as "the viewport-native companion of the selection-first interaction machine". The review's requirement — one authoritative command surface — is adopted; its prescription is reversed. See decision D1. |
| 8.1 "replace the desktop keypad with inspector typing" | Same reason. The keypad is on-target on desktop. The valid content of this finding is occlusion and size, not existence; it is carried into phase 2 as placement work. |
| 1.1 "rename View / Tweak / Build" | The mode switch and its layout were chosen deliberately, and the mode is a subtraction from the existing shell routed through one existing edit lock. Renaming is out of scope for this plan. |
| P0-3 "commit behaviour is inconsistent because direct edits apply on release" | Half right. The inconsistency is real; the diagnosis is not. `hooks/useDirectEditCommit.ts` rebuilds every direct edit against the exact kernel and refuses results the gesture did not mean, one edit at a time. Phase 2 unifies the commit *gesture*; validate-before-commit is an invariant and does not change. |

### Findings that need a repro before any fix

| Review finding | Status |
|---|---|
| 6.2 body appearance shifts between salmon, orange, and cream | Unverified. Bodies carry a user-editable appearance (colour and opacity) in node metadata plus a drag-phase appearance patch (`Inspector.tsx:144-149`), so the recording may show deliberate edits rather than state leakage. Reproduce before changing anything. |
| 6.6 hover inconsistent by geometry type | Unverified against the shipped hover path, which pre-highlights the complete analytic face and treats a closed circular edge as one topological edge. Capture a repro naming the geometry and camera angle. |

## What has already shipped

The review describes a build that already contains the visual-selection work.
Two earlier plans cover this ground and are partly closed.

**Closed by the visual-selection and direct-edit plan** (`docs/plans/visual-selection-direct-edit-plan.md`, phases 0-7, merged): shaded selection film with boundary-edge emphasis, occluded x-ray pass and analytic cylinder ghost, the disambiguation pick list, `Ø`/`R` dimension labelling, live exact previews for planar offsets, invalid-preview state, fillet select-to-edit, and a visual acceptance suite.

**Closed by the UI overhaul plan**: the React-free `packages/viewport` framework (about 14,278 lines — camera controller, pick service with depth cycling, selection manager, snap engine, gizmo rigs, gesture router with device bindings), the stylesheet split into 22 component sheets, status-bar selection filters, box select, edge-chain selection, the marking menu, the measure tool, and `ShortcutsOverlay` reading shared control groups.

**Not closed, and the tax every phase below pays**: the app-side decomposition.
`App.tsx` was 4,499 lines when it was named the hard prerequisite; it is now
**13,347**. `ModelViewer.tsx` is **8,449** against a stated target of under 400.
Its props interface still carries **30** loose `on*` callbacks
(`ModelViewer.tsx:355-560`) with no typed `ViewportIntent` union in the
codebase. Three of the six planned hook extractions exist.

The review's complaints are substantially the cost of that gap: each
visual-selection phase added a surface — pick list, dimension chip, ghost,
tool-card actions, invalid-preview tint — and each hung off a different state
owner, because no single owner exists.

## Decisions

**D1. The floating command card is the authoritative command surface.** It
already renders the interaction machine's model, which is the only state that
knows what command is running. The Inspector reverts to what it is good at:
object and history properties. Phase 1 removes the Inspector's mirror of the
active command rather than removing the card. This satisfies the review's
acceptance criterion — one command name everywhere, one live value everywhere —
in the direction the product's interaction target already set.

**D2. One command session object, derived, never duplicated.** Every surface
that shows the active command reads the same object. Surfaces do not hold
their own copy of the value, and no surface writes into another through an
imperative ref.

**D3. Body-defining feature and pinned feature are different things.**
`featureNodeIdForBody` is a correct answer to "what operation currently defines
this body" and a wrong answer to "what command am I running". Both survive; only
the second may title a panel.

**D4. The command session owns its diagnostics.** The status bar keeps document
and session events. A command's validation failure belongs to the command, is
shown where the value is, and is cleared when the value changes.

**D5. Naming comes from one vocabulary.** `apps/web/src/lib/topologyLabels.ts`
already names entities for the pick list (`ModelViewer.tsx:3028`, `:3516`), the
selection chip (`App.tsx:3442`, `:3473`), and the Inspector (`faceLabel`). It is
the single source of user-facing entity names. Phase 3 extends it; it does not
add a second.

**D6. Validate-before-commit is unchanged.** No phase may commit a direct edit
that has not been rebuilt and judged against the exact kernel.

## Phases

### Phase 1 — One command session

Closes P0-1, the value disagreements, and the ownership half of P0-4. No visual
redesign; a visual diff is the signal that something leaked.

- Derive a `CommandSession` from `lib/interaction/machine.ts`: command id and
  label, target description, live value with unit and dimension mode, baseline
  value, phase, and diagnostic. It is the machine's existing `ToolCardModel`
  widened to carry the value and the diagnostic.
- `ToolCard` renders it (near-unchanged). The in-canvas chip and the keypad
  render the same object.
- Remove the Inspector's active-command mirror: the `Direct edit` live-radius
  section (`Inspector.tsx:1162-1184`) and the `cylinderRadiusSetterRef` bridge
  (`Inspector.tsx:646-670`, `App.tsx:12848`).
- Split feature selection per D3. A tree click pins a feature; a viewport pick
  does not. The body-defining feature becomes a subdued readout, not a title.
  Call sites to revisit: `App.tsx:1848`, `:8079`, `:8106`, `:8126`, `:8158`,
  `:8208`, `:10417`, `:10625`.
- Route command diagnostics per D4: set from the validation path
  (`useDirectEditCommit`'s `onValidationFailed`), cleared on any value or
  selection change, no longer pushed into the global status string.
- Scope note: this is the command-path slice of the owed `App.tsx`
  decomposition, taken deliberately as a vertical slice. The rest stays owed.

**Gate.** Existing suites pass unchanged, plus new tests asserting: the command
label is one string across every surface that shows it; a value change clears
the previous diagnostic; and selecting an edge on a body whose last feature is a
direct edit does not title the Inspector with that feature.

### Phase 2 — One value, one commit gesture

Closes P0-2 and P0-3 and the real content of §8. Assumes phase 1.

- The chip and the keypad are two renderings of `CommandSession.value`; nothing
  else offers an editable copy of it.
- One commit contract everywhere: `Enter` and the commit control commit, `Esc`
  and cancel revert, and the existing innermost-first Escape ladder
  (`escapeTarget()`) is extended rather than paralleled. Release-to-commit
  survives only where the command has no options to set, and stays behind
  validate-before-commit per D6.
- Label the commit control (`Apply`, or the operation's verb). Keep `Enter`.
- Collision-aware placement for the chip and keypad so exact entry stops
  covering the geometry it edits, including near the inspector edge.
- Verify and document the expression support that already exists in
  `lib/keypad.ts` (parameter scope, unit chips) rather than rebuilding it; add
  typed unit suffixes so `1 in` and `25 mm` parse in the value field.
- Disable duplicate submission while validating and show the phase on the
  control itself rather than only as a pill.

**Gate.** A Playwright pass over drag, type, commit, and cancel for offset,
hole resize, and fillet, asserting identical keyboard behaviour across all
three, plus the existing visual acceptance suite unchanged.

### Phase 3 — Object-aware language

Closes P0-5 and §3.7. Assumes phase 1 for the label source; otherwise cheap and
independent.

- `Resize Cylinder Radius` becomes the operation the user sees — `Resize hole
  diameter` where the face publishes `featureType: 'through-hole'` and
  `editableDimension: 'diameter'`, `Resize boss diameter` otherwise — and the
  command label and the value label stop disagreeing.
- Selections are named from published geometry through the D5 helper:
  `Through hole · Ø15 mm`, `Circular hole edge · Ø15 mm`, in place of
  `Edge 25` and `Through hole #15`.
- `consumed` becomes a labelled `Source bodies` group with an explanation on
  hover (`Sidebar.tsx:425`, `Inspector.tsx:257`).
- Kernel identifiers and "exact geometry kernel" move behind an advanced
  diagnostics view; the user-facing string is `Checking geometry…`
  (`App.tsx:6236`, `:6276`).

**Gate.** End-to-end selectors that assert on these strings are updated in the
same branch; no test may keep asserting an old label.

### Phase 4 — Errors that name a next action

Closes the remainder of P0-4 and §9. Assumes phase 1.

- Progressive disclosure: one plain sentence naming the cause, a row of
  actions, and `Details` holding the kernel text. Not a red paragraph.
- Recovery actions where one exists. `Edit earlier fillet` focuses the
  producing feature — the fillet select-to-edit work already tracks a producing
  feature id, so this is routing, not new attribution.
- Show invalidity at the control: the handle and the value badge take the
  invalid state, the last valid preview is retained, and the commit control is
  disabled. The machine already has `validating` and `failed` phases, and the
  handle rigs already carry a warning tint
  (`packages/viewport/src/gizmo/rigs.ts:312`) — confirm it fires during the drag
  rather than after release, and fix it there if it does not.
- Clamp to a valid range where the range is cheap to compute, and say the
  limit (`Max 2.2 mm`). Where it is not cheap, retain the last valid preview.
- Raise error contrast: neutral high-contrast text with a red icon and border
  on a tinted surface.
- Highlight the failing entity in the viewport, and the conflicting earlier
  feature distinctly from it.

**Gate.** A test per recorded failure mode asserting that the message names an
action, that the action reaches the named feature, and that the message clears
on the next input.

### Phase 5 — Selection semantics and viewport polish

Closes §6 and §10 and folds in the visual-system phase of the UI overhaul plan.
Assumes phases 1 and 4 for state naming.

- A semantic token set for hover, selected, active handle, added preview,
  removed preview, and invalid — replacing ad-hoc colours, and preserving the
  established colour language rather than redesigning it.
- Object appearance does not change to communicate state. Reproduce 6.2 first
  and fix only what the repro shows.
- Selected-face fill opacity lowered with outline emphasis raised, so a large
  selected face stops hiding its own edges and holes.
- Cavity shading, silhouette treatment, line weight, and anti-aliasing, with
  `Shaded`, `Shaded with edges`, and `Wireframe` as explicit styles.
- Pick tolerance on thin edges, and preselection normalised across straight,
  circular, silhouette, and occluded edges — measured against the existing
  hover path, not assumed broken.
- One tooltip anchored to the hovered entity, retired once the command surface
  names the selection.
- Orientation cube optical size and label contrast; the right-hand navigation
  controls grouped into one labelled cluster; world axes faded with distance;
  grid made context-sensitive.
- Fit and focus account for open docks so the manipulator is never framed
  under a panel.

### Phase 6 — Application chrome

Closes §1-§4 except the renamed workspaces. Assumes phase 1, because the
Inspector cannot be reorganised as an object panel until it stops being a
command panel.

- Undo and redo move from the viewer toolbar to the document toolbar; the
  viewport controls keep only camera and navigation.
- Document status consolidates beside the project name; `Local only` and the
  offline chip become one meaningful state with detail on click.
- Left browser: resizable, tabbed, with a parameter table carrying full names,
  expression, evaluated value, and units, and an explicit add-parameter action.
- History rows gain feature-type icons, dependency indentation, semantic
  auto-naming, fast rename, and unmistakable failed and suppressed status.
- Tool palette docked with labelled and compact densities, instant tooltips
  carrying name and shortcut, and disabled tools that explain their
  requirement.
- Inspector reordered as object properties with engineering metadata collapsed
  by default, and `Delete feature` moved out of permanent full-width prominence
  into a feature menu with immediate undo.

### Phase 7 — Design system and accessibility

Closes §11 and §12.

- Type scale, surface levels, spacing scale, row heights, radii, icon sizing,
  and button hierarchy defined in `theme/tokens.css` and applied across the 22
  component stylesheets.
- Accessibility targets: WCAG AA contrast for text and essential controls,
  desktop icon targets of at least 32 px and touch targets of 44 px, visible
  focus states, accessible names on every icon-only control, and a non-colour
  indicator for hover, selected, preview, invalid, and suppressed.
- Keyboard reachability for command search, model tree, inspector, commit and
  cancel, and viewport selection filters.
- Screenshot regression for the primary flows, extending the existing visual
  acceptance suite rather than adding a second harness.

## Owned elsewhere

Not in this plan, and not blocked by it: camera and navigation feel,
direct-modeling parity, sketch deepening and the constraint solver, and the
performance budgets — all still owned by the UI overhaul plan. The E1-E7
expansion program (`docs/plans/expansions-e1-e7.md`) runs on its own
one-expansion-per-branch gate and is untouched by this document.

## Risks

1. **Every phase pays for the decomposition that never landed.** `App.tsx` more
   than doubled since it was named the hard prerequisite. Phase 1 takes a
   vertical slice; if that slice cannot be cut cleanly, the honest answer is to
   land the owed `App.tsx` and `ModelViewer.tsx` extraction first rather than
   thread a command model through 11,000 lines.
2. **Inverting the review's headline prescription is a product call.** D1 is
   recorded with its rationale so a future review does not re-derive the
   opposite from a fresh recording.
3. **The visual-selection surfaces are new and load-bearing.** Consolidating
   them risks regressing their acceptance suite; that suite is the oracle for
   phases 1, 2, and 5, and must pass unchanged where no behaviour was intended.
4. **Terminology changes break end-to-end selectors.** Phase 3 updates them in
   the same branch.
5. **Two findings have no repro.** 6.2 and 6.6 stay unfixed until one exists.

## Verification

Per phase, from the repository root:

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm test:web && pnpm build && pnpm test:e2e
```

Then in the browser, driven through the preview tools rather than by asking for
a manual check: reproduce the recorded sequence — hole-diameter direct edit,
face offset, edge fillet by drag, exact entry, the validation failure, and the
hole-edge fillet — and confirm the phase's acceptance items on live geometry.
Capture a screenshot as evidence for any visual change, and read the console and
network logs for errors.

## Acceptance

The review's criteria, kept as written except where a decision above supersedes
them:

- An active operation has exactly one command name everywhere.
- Every visible representation of a dimension shows the same live value and
  unit.
- Changing selection immediately clears stale operation metadata and
  diagnostics.
- Hovering, selecting, previewing, invalid, validating, and committed are each
  distinguishable without relying on colour alone.
- Invalid geometry is explained at the control that caused it.
- Every failure message names a concrete next action where one exists.
- Body appearance does not change merely because a feature is previewed or
  selected.
- Text and icon sizes are readable at 100% zoom on a normal desktop monitor.
- Tree, palette, inspector, and viewport share one spacing and surface system.
- Opening a panel does not cover the active manipulator.
- Commit and cancel behave identically across direct edit, offset, and fillet.

Superseded: "desktop exact entry requires no large calculator overlay" — exact
entry stays in the canvas per D1, and is judged on placement and occlusion
instead.

## Scope limits

The recording did not cover sketch creation, constraints, assemblies,
import/export dialogs, onboarding, account flows, touch behaviour, small-screen
responsiveness, screen-reader output, full keyboard navigation, undo/redo
recovery, or performance under large models. Nothing in this plan should be read
as having assessed them.
