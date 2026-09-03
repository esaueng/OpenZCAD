# UI refinement plan — plan of record (2026-09-02)

Status: not started. Source: the 2026-09-02 UI refinement audit of the web app
(browser pass at 1440/1024/900 px in both themes, plus a static pass over the 25
stylesheets and 82 components), reconciled against the code on `main` at
`699d98bd`. Line references are a snapshot; verify before relying on one.

This plan does not compete with `workspace-ui-coherence-plan.md`. It lands
several of that plan's phase 6 and 7 items as small independent branches, and it
finishes one phase 1 item (D3) whose first slice shipped as `inspectorHeading.ts`.
Where the two disagree, the coherence plan's decisions D1–D6 govern.

## Ground truth that shaped the plan

Checked against the code after the audit, because an audit read off the screen
can be wrong about the cause.

- There is **no toast, snackbar or transient notice anywhere** in `apps/web`.
  `.status-pulse` in `motion.css:184-195` is dead CSS. The nearest thing is the
  import card, which is manually dismissed. Every "did that work?" answer today
  is one global string (`status`, `App.tsx:1490`, 268 `setStatus(` sites) with no
  timestamp, tone or lifetime; tone is regexed off the text (`App.tsx:12210`).
- Feature delete has five entry points and none is guarded: sidebar row
  (`Sidebar.tsx:582`), inspector overflow (`Inspector.tsx:1337`), two context
  menus (`App.tsx:11509`, `:11661`) and Del/Backspace (`App.tsx:11963`). All run
  `handleDeleteFeature` (`App.tsx:11266`). The dependents machinery already
  exists: `affectedFeatureTargets(doc, id).slice(1)` (`lib/affectedFeatureTargets.ts`)
  is used by eight commit gates and by none of the delete paths. Undo is a
  whole-document snapshot stack (`packages/command-system`, depth 100) and the
  entry label is `Delete <name>`, but `handleUndo` overwrites the status with the
  bare word `Undo` (`App.tsx:6654`).
- Every unclaimed left press on the canvas starts a box select
  (`ModelViewer.tsx:5504-5700`); at release a rect under 4 px in *both* axes
  becomes a click (`boxSelect.ts:63-70`). The gesture router's own click
  threshold is 5 px (`GestureRouter.ts:2`). The e2e at `viewport.spec.ts:1457`
  asserts the "Nothing in the box" text.
- The inspector's "Offset Face / Active command" header is deliberate
  (`inspectorHeading.ts`, coherence D3): an inferred feature is *demoted* under
  a running command. What was not finished is the body: the demoted feature's
  full `EdgeModifierForm` still renders (`Inspector.tsx:1061-1085`) with Apply,
  Cancel and `Delete <feature>` in the overflow (`:1328-1338`).
- The Build sidebar parameter row is a five-column grid
  (`sidebar.css:89-96`, `minmax(0,1fr) 76px auto 20px 20px`); the readout is the
  evaluated value and only differs from the input for expressions, exponents
  or errors (`ParameterRows.tsx:118`, `model.ts:64`). Tweak mode drops the two
  20 px slots (`view-mode.css:77`).
- The tool card's hint is built in `machine.ts:734-830`; the 200-character
  lineage caveat is `UNSTABLE_FACE_OFFSET_REASON` (`lib/directEdit.ts:22`)
  appended at `machine.ts:778`. The ellipsis rule at
  `direct-manipulation.css:45` targets `> span`, so the `<small>` hint clips
  without an ellipsis. Nothing repositions the orientation stack when the
  inspector docks; both sit at `top:10px; right:10px` and z-index decides.
- **Sketch orbit needs a repro.** `ModelViewer.tsx:8141` sets
  `controls.enableRotate = false` on sketch entry and `applyPointerMove`
  returns for left-button moves in sketch mode (`:5037-5046`). The audit saw the
  view tilt after a Line-tool drag in a hidden browser pane where camera tweens
  do not tick; treat it as unverified until reproduced with a real pointer.
- The sketch palette's open state is component-local (`SketchToolRail.tsx:172`),
  not in `lib/panelState.ts`. The dashed snap guides are HUD DOM at `200vmax`
  (`direct-manipulation.css:596-618`) while the WebGL guides are sized from the
  canvas; sketch hints exist twice (`prompt.ts:43-49`, `machine.ts:823-833`).
- The command palette filter is a boolean AND of substrings over
  `label + group` with no ranking (`CommandPalette.tsx:25-32`); there is no
  test file for it. There is no tooltip component; every tooltip is `title=`,
  and the e2e suite keys on the composed accessible name
  (`/^Box \(B\)/`, `modeling.spec.ts:2533`).

## Decisions

**P1. Undo, not a dialog, for feature delete.** A confirm would fire on every
delete; the cost of a wrong delete is one Ctrl+Z. Ship a transient toast with
the dependents count and an Undo action. The confirm setting keeps its current
scope (its copy enumerates four actions and feature delete is not one).

**P2. An empty box sweep is silent.** Clearing the chip is the feedback. The
status message goes, and the click threshold is shared with the gesture
router so a click is the same size everywhere.

**P3. Status messages get an owner and a lifetime.** Informational messages
expire; mode text (sketching, view mode, rebuilding) is derived, never set,
and does not expire. This is the remainder of coherence P0-4.

**P4. The inspector is an object panel** (coherence D1). Under a running
command an inferred feature is a one-line readout with an Edit action that
pins it; it is never a form and never offers Delete.

**P5. American spelling in UI strings.** Settings and Start already say
"Millimeters". Comments stay as written.

**P6. Sketch palette collapsed by default, remembered per device.**

**P7. Additive token work lands first, the replacement sweep lands last.**
The sweep touches every stylesheet and conflicts with everything else.

## Branches

One branch per row, each independently shippable and green on
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e`.
Sizes are working days for one person including tests and the browser check.

| # | Branch | Closes | Size |
| --- | --- | --- | --- |
| 1 | `toast-and-undoable-delete` | delete guard, export feedback, undo label | 1.5 |
| 2 | `click-threshold` | box-select jitter | 0.5 |
| 3 | `status-lifetime` | stale status bar | 1 |
| 4 | `tokens-additive` | shadow/z tokens, undefined-token test, viewport border token | 0.5 |
| 5 | `inspector-object-panel` | face pick shows fillet editor | 1.5 |
| 6 | `param-row-names` | clipped parameter names | 0.5 |
| 7 | `tool-card-fit` | hint overflow, 280 px clamp, cube under panel | 1 |
| 8 | `palette-tooltips` | native title tooltips, ⌘K/Ctrl+K | 1.5 |
| 9 | `palette-ranking` | "fil" lists the File group; orange reasons | 0.5 |
| 10 | `sketch-chrome` | repro orbit, normal-to-sketch, palette default, Finish, hints, guides | 2 |
| 11 | `motion-pass` | dialog entrance, exits, hover transitions, focus rings | 1.5 |
| 12 | `copy-and-icons` | casing, spelling, glyphs, Hole form labels | 1 |
| 13 | `start-screen-layout` | cramped new-part tile | 1 |
| 14 | `token-sweep` | rgba literals, eyebrow/pill/menu/close classes, palette class collision, disabled state | 2 |

Order: 1 → 2 → 3 → 4, then 5–9 in any order, 10 after the repro, 11 and 12
any time after 4, 13 whenever, 14 last. Branches 1–3 all touch the selection
and status paths in `App.tsx`; keep them serial.

### 1. `toast-and-undoable-delete`

- Add `components/Toast.tsx` + `hooks/useToasts.ts`: one visible toast, bottom
  centre above the selection chip slot (`viewer.css:329`, +40 px; view mode
  +52 px per `view-mode.css:261`), `role="status"`, 6 s lifetime, paused on
  hover, optional action button, Escape dismisses. Entrance `oz-pop`, exit
  fade (this branch introduces the `useDelayedUnmount` hook branch 11 reuses).
- `handleDeleteFeature`: compute
  `affectedFeatureTargets(doc, featureId).slice(1)` before executing; toast
  `Deleted <name>` / `Deleted <name> · N dependent features now fail` with
  **Undo** calling `handleUndo`. All five entry points go through it already.
- `handleUndo`/`handleRedo`: status from the stack entry label
  (`Undo Delete Boss`), not the bare word.
- Export STEP/mesh: toast `Exported <file> (1 body)`; fix `body(ies)` at
  `App.tsx:7658`, `:7746`.
- Delete the dead `.status-pulse` rule.
- Tests: `Toast.test.tsx` (lifetime, hover pause, action, Escape);
  `affectedFeatureTargets` count wired into the toast text (unit, happy-dom);
  e2e: sidebar row delete on the Mounting Bracket demo → toast names 5
  dependents → Undo restores 16 features and warnings 0.
  `scripts/check-css-classes.mjs` must see the new classes.

### 2. `click-threshold`

- One exported `CLICK_THRESHOLD_PX = 6` in `packages/viewport/src/input`;
  `boxSelect.ts` and `GestureRouter.ts` both read it. `isBoxSelectDrag`
  requires the threshold in *either* axis as today.
- `handleBoxSelectFromViewer` (`App.tsx:8357`): an empty sweep clears
  selection and status silently. Update `viewport.spec.ts:1454-1457` to
  assert the chip is gone rather than the text; `boxSelect.test.ts:74-92`
  thresholds.

### 3. `status-lifetime`

- `status` becomes `{ text, at, tone?, sticky? }` behind the same
  `setStatus(text)` signature (a wrapper stamps `at`), so the 268 call sites
  do not change. `StatusBar` renders the message only while
  `now - at < 8 s` or `sticky`; a single interval in `StatusBar` drives expiry.
- Derived mode text (`visibleStatus`, `App.tsx:12201`) is sticky by
  construction; nothing else is.
- Clear on state change: `selectFeatureNode`, `clearSelection`,
  `inferFeatureNodeFor`, the `'clear'` / `'exit-sketch'` dispatches and the
  Escape ladder call `expireStatus()`.
- `useValidatedFeatureCommit.ts:434` stops echoing the raw kernel sentence
  to the status bar; the command owns the diagnostic (coherence D4) and the
  card already shows the translated one.
- Tests: `StatusBar.test.tsx` fake timers (expires at 8 s, sticky does not,
  hover on the log button does not extend); e2e: status text is empty after a
  face pick that follows a cleared box select. Audit the e2e list that reads
  the bar (`viewport.spec.ts:208, 1223, 1277, 1289, 1409, 1452, 1478`,
  `modeling.spec.ts:1344, 1388, 1426`, `cloud-sync.spec.ts:414-482`) for any
  assertion that waits longer than the lifetime; keep those sticky if they
  are mode text, otherwise shorten the wait.

### 4. `tokens-additive`

- `tokens.css`: `--shadow-1` (chips, cards), `--shadow-2` (menus, popovers,
  tool card), `--shadow-3` (dialogs); `--shadow-popover: var(--shadow-2)`;
  `--z-popover: 40` → set to `calc(var(--z-modal) + 1)` and document why the
  overflow menu must clear a dialog; `--z-assistant-float: 6`;
  `--color-viewport-border: rgba(230,237,243,0.18)` for overlay borders.
- Replace only the seven duplicated modal shadows (`modals.css:33, 85, 175,
  226, 411, 570, 671`), `inspector.css:562/568`, `responsive.css:79`, and the
  orientation-roll border (`viewport-overlays.css:104`). Everything else
  waits for branch 14.
- New test `theme/tokens-defined.test.ts`: every `var(--x…)` in
  `styles/**` resolves to a token declared in `tokens.css` or in the same
  stylesheet. This is what would have caught `--z-popover`.
- Extend `viewport-overlays.test.ts` to borders: an overlay rule that paints
  a dark stage may not read `--color-border`.

### 5. `inspector-object-panel`

- In `Inspector.tsx`, when `heading.demoted`: title from the D5 label helper
  (`topologyLabels` → `Front face`), eyebrow the body name; body is
  Measurements + Mass properties + one row `Defined by <feature>` with an
  **Edit** button calling `selectFeatureNode(id, 'pinned')` (which today
  already switches the heading and shows the form). No `EdgeModifierForm`, no
  `deleteAction` in the overflow while demoted; Del key likewise ignores an
  inferred feature.
- The hand-rolled "New feature" panel in `App.tsx:13582-13600` is unchanged.
- Tests: new `Inspector.test.tsx` (demoted → readout, Edit pins, overflow has
  no Delete; pinned → form and Delete); `inspectorHeading.test.ts` gains the
  selection-label case. Check `visual-selection-acceptance.spec.ts:543`
  (`Delete Lower rim fillet` from the overflow): if that selection is
  inferred, the test must pin the feature first, and that is the intended
  behaviour change, not a regression.

### 6. `param-row-names`

- `ParameterRow`: render `.param-value` only when `formatNumber(value)` is
  not the canonical form of the expression text, or on error. Grid columns
  become `minmax(0,1fr) 76px minmax(0,max-content) 20px 20px` so an absent
  readout collapses; same for the Tweak override. Row `title` keeps the full
  `name = expression`.
- Tests: new `ParameterRows.test.tsx` (readout hidden for `80`, shown for
  `plate_t + 4` and for `err`); e2e `modeling.spec.ts:2531/2715` unaffected;
  add an assertion at 252 px that `.param-name` `scrollWidth <= clientWidth`
  for `mount_inset`.

### 7. `tool-card-fit`

- `machine.ts:778`: the hint is one sentence; `offsetNote` becomes
  `model.badge?: { label: 'Geometry-anchored', detail }` rendered as a small
  chip with the detail as its tooltip (branch 8 supplies the component; until
  then `title`). Same for `UNSTABLE_FACE_SKETCH_REASON`.
- `direct-manipulation.css`: ellipsis rule covers `small`; card gets
  `flex-wrap: wrap` and the submode row drops to a second line when
  `--tool-card-room < 400px`; floor `left` at `170px`.
- `.viewer-area.has-inspector .viewer-rail-stack { right: calc(var(--context-w) + 20px) }`
  so the cube moves left of a docked panel; below 820 px hide the stack
  instead.
- Tests: `ToolCard.test.tsx` (hint has no note, badge present with detail);
  `machine.test.ts` titles unchanged; e2e at 1024×700 with a face selected:
  `elementFromPoint` over the cube centre returns the cube, and the submode
  tab's box does not intersect the copy's box. `workspace-polish.spec.ts:209`
  keeps passing.

### 8. `palette-tooltips`

- `components/Tooltip.tsx`: portal, hover/focus, 300 ms open delay, instant
  when moving between siblings within 200 ms, Escape closes, respects
  reduced motion. Content: label, `<kbd>` shortcut, muted reason or hint.
- `ToolBar.tsx`, the viewer rail, the sketch rail and the tool-card badge
  use it. **Keep the `aria-label` composition from `toolTitle()`** unchanged
  so `/^Box \(B\)/` selectors survive; drop `title`. Platform-aware
  shortcut glyph fixes the `⌘K` vs `Ctrl+K` mismatch (`ToolBar.tsx:52-61`).
- Tests: `Tooltip.test.tsx` (delay, focus, Escape, sibling hand-off);
  `ToolBar` accessible names unchanged (`tools.test.ts`).

### 9. `palette-ranking`

- `CommandPalette.tsx`: score each command (label prefix 4, label word start
  3, label substring 2, group word start 1); a command with score 0 is
  hidden; stable sort by score then source order. Add optional `keywords`
  to `PaletteCommand` for later.
- `.palette-reason` colour → `--color-text-subtle`; the row keeps its
  reduced opacity.
- Tests: new `CommandPalette.test.tsx` (`fil` → Fillet first, no File-group
  entries; `exp` → Export STEP, Export mesh; disabled row not runnable).

### 10. `sketch-chrome`

- **Repro first.** With a real pointer (not the hidden pane): enter a sketch,
  Line tool, left-drag. If the camera moves, find the path (`OrbitControls`
  still receives the pointerdown because the line branch does not capture,
  `ModelViewer.tsx:5547-5555`) and capture the gesture the way the rectangle
  branch does. If it does not move, close the item.
- `Normal to sketch` button on the rail: a `normalToSketchRequest` nonce
  prop mirroring `normalToFaceRequest` that re-runs the framing tween from
  the sketch-entry effect (`framedPose ?? sketchEntryPose`).
- Sketch palette: `paletteOpen` moves to `lib/panelState.ts`
  (`sketchPaletteOpen`, default false, per device).
- Finish Sketch becomes a `.primary` button at the end of the first rail row;
  Diagnostics and Extrude stay secondary.
- One source for sketch hints: `machine.ts:823-833` reads
  `SKETCH_TOOL_STEPS` from `prompt.ts`; `drawing` hint is only for chain
  tools (line, arc), rectangle/circle keep their drag hint. Card title
  `Editing sketch · <name>`.
- Snap guides: axes sized from the HUD container (`hud` root width/height),
  opacity 0.82 → 0.55, unchanged under `data-engaged`.
- Do not dim the sidebar in this branch; that is a coherence phase 6 call.
- Tests: `SketchToolRail.test.tsx` (`keeps Finish Sketch permanently
  available` still passes, palette default collapsed, normal-to-sketch
  calls the prop); `prompt.test` for the hint source; e2e
  `modeling.spec.ts:709-713` waits for `.sketch-palette` — it still mounts
  collapsed, so assert the aside rather than its content.

### 11. `motion-pass`

- `motion.css`: `oz-rise var(--dur-base)` on the eight dialog cards
  (`modals.css:24, 76, 166, 217, 400, 562, 663, 693`), marking menu, top-bar
  and panel-overflow menus, keypad (`visibility` → opacity), import card,
  refusal surfaces. Tool card entrance moves onto `--dur-fast`/`--ease-out`.
- Exits: `useDelayedUnmount(open, 100)` from branch 1 wraps the inspector
  float, context menu, tool card and keypad; a `closing` class runs
  `oz-fade` reversed.
- Extend the transition list at `motion.css:11-36` with the 25 hover-only
  controls (`file-menu > summary`, `status-filter`, `param-expose`,
  `topbar-menu-item`, `panel-overflow-item`, `palette-row`, `tool-button`,
  `keypad-key`, `assistant-icon-button`, `settings-nav nav button`, …).
- Focus: the seven `:focus-visible { outline: none }` sites
  (`topbar.css:156, 322`, `start-screen-demos.css:35`, `view-mode.css:127`,
  `viewer.css:516`, `start-screen.css:277`, `revisions.css:121`) keep the
  hover background and drop the `outline: none`.
- Tests: stylesheet test — no `:focus-visible` rule sets `outline: none`
  unless it is on an allowlist with a reason (`shell.css:85` is the one
  entry); `AppShell.test.tsx` unmount-after-delay for the inspector float.

### 12. `copy-and-icons`

- Casing: `Fit View` → `Fit view` (`App.tsx:11378, 11492`), `Show All Bodies`
  (`:11409`), `Fillet Edge…`, `Chamfer Edge…`, `Hide Body`, `Show Body`,
  `Edit Properties`, `Re-pick Face…` → sentence case; `AI Assistant` →
  `AI assistant` (`SettingsPage.tsx:1316`); `Finish Sketch` → `Finish sketch`
  (`SketchToolRail.tsx:336`; update `SketchToolRail.test.tsx:77`);
  `Editing Sketch:` in `machine.ts`.
- Spelling: `millimetres` (`ExportDialog.tsx:249`), `metre`
  (`ShaprImportDialog.tsx:137`), `from centre` (Hole form).
- Import control: one name for title, aria-label (no trailing ellipsis) and
  palette label. Close buttons: `Close`.
- Glyphs → lucide: `ProjectSharingDialog.tsx:232, 270, 531` (`X`, `Mail`,
  `Link`), `ShortcutsOverlay.tsx:51`, `ImportProgressCard.tsx:165`,
  `inspector.css:534` caret → `ChevronRight`. Rail icons stroke 1.5 → 2.
- Hole form: face list labels through the D5 helper (`faceLabel`), fieldsets
  → the panel's field groups, "Select the entry face." only after the list
  has been touched.
- Tests: e2e selectors that assert an old label are updated in the same
  branch (coherence phase 3 rule); `Sidebar`/context-menu labels in
  `useMenuKeyboard.test.tsx:11`; `ExportDialog.test.tsx` string.

### 13. `start-screen-layout`

- New-part form becomes a single row in the shelf bar (name · units ·
  Create); the tile grid fills the column so saved parts and demos share one
  rhythm; the 1024 px layout is the reference. `StartScreen.test.tsx`
  covers the form; add a 1440 px e2e that the grid is not narrower than the
  demo row.

### 14. `token-sweep`

- Replace the 35 rgba literals that duplicate a token
  (`viewer.css:421` first), the 19 white/black overlays on themed surfaces
  (`inspector.css:587`, `direct-manipulation.css:102-791`,
  `keypad-commit` colour → `--color-on-accent`), and the three tint idioms
  with `color-mix(in srgb, var(--token) N%, transparent)`.
- Extract `.eyebrow`, `.pill`, `.menu-item`, `.close-button` and delete the
  22 / 12 / 4 / 6 copies; five dialog `h2` sizes → two (`--fs-lg` dialogs,
  `--fs-xl` settings); disabled state → the global rule, keeping the
  documented exception at `viewport-overlays.css:341`.
- Rename the command palette's `.palette-*` classes to `.command-palette-*`
  to end the collision with `tool-palette.css`; `settings.css:67-80` stops
  redeclaring the button box model.
- `.selection-chip` uppercase moves to the label span; units stay as typed.
- Icon sizes: 14 in rows and menus, 16 in toolbars; `strokeWidth` left to
  lucide's default.
- Tests: `contrast.test.ts` and `tokens-defined.test.ts` pass unchanged;
  `check-css-classes.mjs` clean; the visual acceptance e2e suite passes
  unchanged (it is the oracle that the sweep changed nothing it should not).

## Verification

Per branch, from the repository root:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e
```

Then in the browser pane, at 1440×900 and 1024×700, dark and light: reproduce
the audit step that motivated the branch (row delete + undo, jitter click,
face pick, parameter names, tool card with the inspector docked, sketch entry)
and capture a screenshot as evidence. Measure overlap with
`getBoundingClientRect`, not by eye. The pane runs hidden, so any check that
depends on a camera tween or a hover state needs a screenshot to force a
frame, and the sketch-orbit repro needs a real pointer.

## Acceptance

- Deleting a feature is reversible from the toast without keyboard knowledge,
  and the toast names how much depends on it.
- A click that moves less than the shared threshold never changes selection.
- No informational status message outlives its action by more than 8 s;
  mode text never expires.
- A viewport pick titles the inspector with the picked entity; no form and
  no Delete appear for a feature the user did not pin.
- Every parameter name in the demo projects is fully visible at 252 px.
- With the inspector docked at 1024 px the tool card does not overdraw
  itself and the orientation cube is clickable.
- Every icon-only control shows a styled tooltip with its shortcut within
  300 ms; no `title=` remains on `.palette-item`.
- `fil` in the command palette lists Fillet first and nothing from the File
  group.
- Every dialog rises in, and the inspector, context menu, tool card and
  keypad fade out.
- `tokens-defined.test.ts` and the `:focus-visible` allowlist test are in
  the suite and green.

## Not in this plan

Selection-driven tool visibility, the constraint rail, the assistant panel,
the App.tsx decomposition, and the coherence plan's phase 2 (one commit
gesture) and phase 5 (viewport semantics). Those keep their existing owners.
