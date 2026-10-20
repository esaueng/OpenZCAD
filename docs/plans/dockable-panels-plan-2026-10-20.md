# Dockable model panels (U08)

Status: planned; no slice merged. Roadmap row: [U08](../../ROADMAP.md#u08).
Replaces the single model drawer from [U04](../../ROADMAP.md#u04) slice 4 once
slice 3 below merges. Every other quiet-stage decision in the
[quiet-stage plan](quiet-stage-workspace-plan.md) still applies.

## Intent

Today Parameters, Objects, History, Revisions and Diagnostics share one drawer
next to the instrument rail. You open it on one section and fold the others.
You can't see Parameters and Objects side by side, and nothing stays open
except by keeping the whole drawer open. With this change each one becomes an
**independent panel**. A panel can be opened for a moment, pinned so it stays,
stacked with other panels, docked at either edge of the screen, or floated as a
window over the model. The layout is remembered per device.

The design was settled on 2026-10-20 on a design canvas: an interactive
prototype plus anatomy, drag-state and layout boards. The canvas is private to
its owner, who can share it; this document is the contract and stands without
it.

## Decisions

### Panels and states

- **Five panels:** Parameters, Objects, History, Revisions, Diagnostics. Every
  panel has the same header:
  - drag grip
  - icon
  - **title and count** (a heading, e.g. "History 85")
  - **Pin**: filled when pinned, outlined when unpinned
  - **Pop out**
  - **Close**
- **No folding.** An open panel is fully open. Room comes from resizing,
  closing or moving panels. The section chevrons and `collapsed` state go away.
- **States:** closed, **unpinned**, **docked**, **floating**.
  - **Unpinned.** A rail click opens the panel unpinned, beside the inner edge
    of the right rail.
    - Only one panel can be unpinned at a time; opening another replaces it.
    - Clicking the model does not close it. It stays until its rail button is
      pressed again.
    - Its footer reads "Unpinned — the next panel you open replaces it" and
      offers Pin.
  - **Docked.** Pinning docks the panel.
  - **Floating.** Pop-out floats the panel.
- **Close remembers where the panel was** (dock side, column and index, or its
  floating rectangle). The rail button reopens it there.

### Docks and rails

- **Two docks.**
  - The right dock holds up to three columns, the left up to two.
  - Columns sit against the screen edge.
  - Each dock's rail sits on its **inner** edge: the instrument rail for the
    right dock, the verb rail for the left.
  - Adding a column moves the rail inward.
- **Columns stack panels** and split the height by weight.
  - Dragging the gap between two panels resizes them, with a 90 px minimum per
    panel.
  - Double-clicking the gap splits those two neighbours evenly; the rest of the
    stack keeps its share.
  - **Short stages.** When a column can't give every panel its 90 px minimum
    (five panels need 450 px plus gaps; the 390 px short-window height can't
    fit them), the column scrolls as one, with each panel held at its minimum
    and gap resizing off until it fits again. Every header and control stays
    reachable. Stored weights are untouched, so a taller window gets the
    split back. Floating windows are clamped to the stage height the same way.
- **Column width** is one setting: S/M/L = 256/296/360 px. 296 px is today's
  drawer width.

### Floating windows

- A floating panel is a window over the model. It moves by its header and
  resizes from its bottom-right corner (width 260–600 px, height ≥ 160 px).
- Dropping a panel onto a floating window **stacks** the two in one window.
  - The window grows by 240 px, within the stage.
  - A grip bar on the window's frame moves the whole stack.
  - The gap between its panels resizes like a docked column's gap.
- **Stacking order.** Floating windows keep a stored z-order (the order of
  the float groups in the layout, last on top). A window comes to the front
  when it is pressed, when focus moves into it, when its panel is activated
  from the rail or from ⌘K, and when a panel is dropped or moved into it.
  The order survives a reload.

### Dragging

- **Start a drag** from a panel header, or by dragging a rail icon out (this
  opens the panel if it was closed). A press that moves less than 4 px is a
  click.
- **Over a drop target:**
  - The panel shrinks to a title chip beside the cursor.
  - A **slot preview** appears exactly where it will land, and the neighbouring
    panels move apart to make room.
  - Hit-testing uses the layout without the preview, so the preview can't move
    the target away from the cursor.
- **Drop targets:**
  - a docked column (stack at the slot)
  - a floating window (stack in it)
  - the area just past either rail (new column)
  - anywhere else: the panel floats where it is dropped
- **Nothing else moves while dragging.**
  - A column emptied by the drag keeps its place until the drop.
  - The rails stay where they are, except that a rail slides inward while its
    new-column target is hovered. That target spans the rail plus one column
    width, so the slide can't make it flicker.
  - A drag out of the rail ignores targets until the cursor is 60 px away;
    otherwise the rail's own new-column target would trigger at once.

### View options menu

The menu replaces the rail's Layout button.

- **Presets:**
  - **Essentials** (the default): Objects left, Parameters right
  - **Full workspace**: Objects over History left, Parameters over Revisions
    right (Revisions about a quarter of the column)
  - **Modeling**: Objects over a taller History left, Parameters right
  - **Review**: History over Revisions, right
  - **Model only**
- **Settings:**
  - **Hide all panels** (layout kept, a "Panels hidden · Show" pill while
    active). The default key is `Ctrl+\` (`⌘\` on macOS), not `Tab`: the
    global keymap calls `preventDefault()` for bare-key commands when focus
    is on a button, so binding `Tab` would break keyboard focus traversal.
    `Ctrl+\` is unbound today, and a Ctrl chord also works while a field has
    focus.
  - **Lock layout**: no rearranging or resizing by any input. Pointer drags,
    the Move menu's placement items (Dock, New column, Move to, Move
    up/down, Float), gap and floating-window resizing, and the keyboard move
    and resize keys are all off. Pin, Pop out and Close still work.
  - **Compact rows**
  - **Panel width**
- Picking a preset keeps the settings and turns Hide off.

### Defaults chosen 2026-10-20 (owner: "use your defaults")

1. **Small screens.**
   - The **complete dock footprint** is capped at 60% of the stage width, so
     the model always keeps at least 40%. The footprint is everything between
     the screen edges and the model: both sides' columns, both rails, and
     every gap. It is measured from the real tokens (`--rail-w`,
     `--island-gap`), not assumed.
   - With today's 40 px rails and 10 px gaps, each side's rail costs 60 px
     whether or not it has columns, and each 296 px column adds 306 px:
     - Essentials (732 px) stays fully docked from 1220 px stage width
       upward, which includes 1280 px (57% footprint, 43% model).
     - At 1219 px its left column (Objects) is parked (below) and Parameters
       stays docked on the right.
     - One column (426 px) still docks at 721 px.
   - The 40% guarantee covers the resting layout: everything the app places
     on its own. Two things are outside it by design because the user opens
     them and closes them with one press, like a menu: floating windows
     (Pop out, Float, a drop) and the unpinned panel (a rail press, closed by
     the same button). They may cover the model while open, and closing them
     restores the guaranteed space. The app never turns a column into a
     float, and it never opens the unpinned panel on its own.
   - **Parking.** When the window shrinks, the columns that no longer fit are
     **parked**: not drawn, and their panels' rail buttons show a parked
     state. Clicking a parked panel's rail button shows it in the unpinned
     slot, one at a time, as any unpinned panel. Columns park in a fixed
     order: **all left-dock columns before any right-dock column**, because
     the right dock beside the instrument rail is the primary one; within a
     side the outermost column goes first. Parking happens at render time
     only: the stored layout keeps them docked, so a wider window gets them
     back.
   - **One place per panel.** Every width change re-runs the projection
     from the stored layout, and a panel is drawn in exactly one place. A
     parked panel shown in the unpinned slot goes back to its column the
     moment the column fits again: the slot closes and the panel appears
     docked, never both.
   - A pin or drop that would go past the cap docks nothing: the panel stays
     where it was (unpinned, if it came from the rail) and a status line says
     the docks are full at this width.
   - At 720 px stage width and below there are no docks and no floating
     windows: a panel opens one at a time in the existing phone lane. Docking
     starts at 721 px.
     - Every open panel — docked, floating or unpinned, stored or arrived at
       by resizing — is projected into that lane: only the panel opened or
       focused most recently shows, and the stored layout (including the
       unpinned panel) is kept for a wider window.
       The layout stores that recency (an ordered list of panel ids, updated
       on open, focus and rail press), so the choice survives a reload and is
       the same after any resize.
     - Pop out, Float and drop-to-float are not offered there. A drag ends
       back in the lane.
2. **Persistence.**
   - Layouts are per device, Build only. View and Tweak keep their own rails.
   - A new storage key, `openzcad-panel-layout:v1`, sits beside
     `openzcad-panel-state:v1`. The old key is left unchanged so rolling back
     restores the old drawer.
   - First load migrates: a device whose drawer was open starts with a right
     column of the sections it had open; a device whose drawer was closed starts
     in Model only. New devices start in Essentials.
   - Until slice 4 ships the left dock, new devices start in a transitional
     right-only Essentials: Objects over Parameters in one right column.
     Slice 4 switches the default to the two-sided form for devices that
     have not stored a layout yet. A layout already stored is never
     rewritten; the preset menu in slice 5 offers the two-sided form.
   - Migration runs in the same slice that first reads the new layout
     (slice 3), before anything writes the new key. Its absence is the signal
     to migrate, so a stored default must never come first and hide the old
     state.
3. **Keyboard.**
   - The grip is a focusable button, "Move <Name>", that opens a menu. The
     menu is the keyboard equivalent of every drop target:
     - **Dock left / Dock right** put the panel at the end of that side's
       first column. **New column left / right**, **Float**, **Close**.
     - **Move to ▸** lists every docked column and floating window by the
       panels in it, e.g. "Right 1: Parameters, Revisions" or "Window:
       History". Choosing a column puts the panel at its end; choosing a
       window stacks the panel into it.
     - **Move up / Move down** reorder the panel within its column or
       window, so any slot is reachable. The same moves are on
       `Alt+↑`/`Alt+↓` while the grip has focus.
   - Gaps are `role="separator"` with `aria-valuenow`; arrow keys resize them
     and Home splits evenly.
   - Floating windows move with the arrow keys while the grip has focus, and
     resize with `Shift` plus the arrow keys (10 px steps, within the
     260–600 px width and ≥ 160 px height bounds). The corner grip is also a
     focusable control named "Resize <Name> window" that takes the same keys.
4. **Rail buttons.**
   - Revisions and Diagnostics get rail buttons.
   - Diagnostics shows a warning-count badge and **does not** open by itself.

### Contracts kept

- **Accessible names.** The toolbar "Model panels" and the "<Name> panel" rail
  buttons keep their names. Each panel is a region named after itself. The row
  classes the e2e suite reads stay the same: `.feature-row`, `.body-row`,
  `.param-row`, `.revision-row`, `.diagnostic-row`.
- **Suspension.** Sketch and drag suspension (`usePanelSuspension`) applies to
  every open panel — docked, floating and the unpinned one — as it does to the
  drawer today. A rail press releases it.
- **Inspector and command card.** They keep the right lane, now inside the
  right rail. `--lane-end` grows by the right dock's width. They stop sharing a
  lane with the panels.
- **Bottom lanes.** The command bar, toasts, activity lane and tour start after
  the left dock: `--lane-inset` grows by the left dock's width.
- **Obstacles.** The selection callout, fit frame, keypad, drag-chip clamp and
  sketch-dimension occluders read the dock and float selectors in place of
  `.stage-right > .model-drawer-float`.
- **Search.** Picking a feature or parameter in ⌘K opens History or Parameters
  unpinned if the panel is closed, and focuses it if it is open. It always
  makes the target visible: it turns Hide all off, and a parked or
  phone-projected target shows in the unpinned slot or the phone lane.
- **No document change.** No document format, unit or tolerance changes. Only
  the per-device preference key above is new.

## Architecture

- **`apps/web/src/lib/panelLayout.ts`** (new, pure). It holds:
  - `PanelId`, `DockSide`, `PanelLayout` (left and right columns, float
    groups, weights, the unpinned id, homes, the recency list, options)
  - the operations: `open`, `close`, `pin`, `unpin`, `popOut`, `place(target)`,
    `previewOf(target)`, `resizeGap`, `resizeFloat`, `applyPreset`,
    `clampToStage`
  - `normalize`/`load`/`save` and the migration from v1

  These carry over the prototype's `detach`/`place`/`previewOf`/`hitZone`
  algorithms. Hit-testing takes rectangles, not DOM nodes, so it can be unit
  tested.

- **Drag state stays local.**
  - `PanelDock` owns the pointer interaction: `setPointerCapture`, moves
    throttled to animation frames, chip position and preview.
  - It commits to the App's layout state only on drop, gap-resize end or
    float-resize end.
  - App.tsx (23k lines) must not re-render on every pointer move, and the
    viewer must not re-render during a drag at all.
- **Components:**
  - `PanelFrame`: header, Move menu, unpinned footer
  - `ParametersPanel`, `ObjectsPanel`, `HistoryPanel`, `RevisionsPanel`,
    `DiagnosticsPanel`, extracted from `Sidebar.tsx`'s inline sections
  - `PanelDock`: both docks, float groups, the unpinned panel, slots
  - `ViewOptionsMenu`
- **Shell.**
  - AppShell's `drawer` slot becomes a `panels` slot.
  - `PanelDock` publishes `--left-dock-w` and `--right-dock-w` on `.workspace`.
  - The instrument rail, sketch relations rail and verb rail are positioned
    from those variables.
- **Bundle.** The entry chunk is at 498,234 of 512,000 bytes.
  - Panel bodies stay lazy, as `Sidebar` is today. The dock shell and the
    layout module go in the entry chunk and must fit.
  - Each slice reports `scripts/report-bundle-sizes.mjs` before and after.

## Slices

Each slice is one PR and records its evidence in the U08 row.

### 1. Layout model and persistence (no UI change)

- **Work.** `panelLayout.ts` with every operation, the presets, the stage
  clamp and the v1 migration.
- **Tests:** a new `test/panel-layout.test.ts`. It covers:
  - placement into every target kind on both sides
  - column limits (three right, two left)
  - preview/commit equivalence (`place` gives the layout `previewOf` showed)
  - home restored after close
  - float growth, clamp and resize bounds
  - gap weights with minimums, and the even split
  - the 60% dock-footprint cap (columns, rails and gaps): a pin past it docks
    nothing, and a shrunken stage parks columns (left before right, outermost
    first) without changing the stored layout
  - the recency list, and the phone-lane choice it drives after a reload
  - migration from sample v1 states
  - hostile or corrupt storage

### 2. Panel extraction (no behaviour change)

- **Work.**
  - Split `Sidebar.tsx`'s Parameters, Objects, History, Revisions and
    Diagnostics into their own components, with the Objects filter/search and
    the revisions' local save-state loading moving along with them.
  - `Sidebar` keeps composing them in the current drawer, so the visible UI and
    every existing test are unchanged.
  - Update the `UNSTYLED_ALLOWANCES` entries tied to `Sidebar.tsx` in
    `scripts/check-css-classes.mjs` if their reasons change.
- **Tests.** `Sidebar.column.test.tsx` passes unchanged, plus a small render
  test per panel.

### 3. Right dock replaces the drawer

- **Behaviour.**
  - Independent panels in right columns: stacking, gap resize and even split,
    pin/unpin/close/home, the unpinned panel, the headings.
  - The header's Pop out button is not rendered until slice 4 ships floating
    windows, so this slice has no control that would send a panel to an
    unrendered float.
  - The instrument rail moves to the dock's inner edge and gains Revisions and
    Diagnostics (with its badge).
  - The inspector lane, obstacles, suspension and search hand-off as above.
  - The column scroll for short stages.
  - The no-dock policy at 720 px stage width and below (one panel at a time in the
    phone lane), since the drawer's small-screen behaviour goes away here.
  - The transitional right-only Essentials default for new devices.
  - The first-load migration from `openzcad-panel-state:v1`, run before the
    new key is ever written.
- **Deletions.**
  - `drawerOpen` and `sidebarSections` stop being read for the UI (the v1 key
    keeps them for rollback).
  - `toggleDrawerSection*` and the `.model-drawer-float`/`.sidebar-section` CSS
    are removed.
  - Sidebar's double-click-to-close is removed.
- **E2E migration, in the same PR.** About 130 specs get the open drawer from
  `stubApi()`.
  - `seedOpenModelDrawer` becomes `seedPanelLayout(page, layout)`. Its default
    docks all five panels in one right column, so specs that read content keep
    passing.
  - `revealModelDrawer` and `selectBodyFromItems` become panel helpers.
  - Count readouts change from `getByRole('button', { name: 'History 2' })` to
    `getByRole('heading', …)`. This is a mechanical change, about 80 sites in
    about 25 specs.
  - Selectors that read the `.sidebar` container are updated in
    `build-reach`, `workspace-polish`, `feature-delete`, `fit-view`, `viewport`
    and `settings`.
  - `quiet-stage-drawer.spec.ts` and `drawer-disclosure-targets.spec.ts` are
    rewritten as `panel-dock.spec.ts`, and `test/e2e/shard-weights.json`
    updated (`test/e2e-shards.test.ts` fails on a stale weight).
  - The workspace tour keeps its `History panel` target. `WorkspaceTour.test`,
    `AppShell.test`, `fitFrame.test`, `sidebarContracts.test`,
    `viewerResponsiveContracts.test` and `usePanelSuspension.test` follow.
- **Acceptance.** `panel-dock.spec.ts` covers:
  - opens unpinned and stays through clicks on the model
  - pin docks, close then reopen returns home
  - two pinned panels stack
  - gap drag and double-click split
  - the inspector stays clear of the dock
  - sketch hides and restores the dock and an open unpinned panel, and a
    drag on the model suspends both
  - headers carry Pin and Close but no Pop out
  - ⌘K opens a parameter
  - the rail is reachable at 1280×720
  - a five-panel column at the supported 390 px window height scrolls and
    keeps every header and control reachable inside the stage
  - devices seeded with an open and a closed v1 drawer migrate as above,
    and a reload after migration keeps the new layout
  - a new device opens with Objects over Parameters in one right column
  - at 600×800 and 720 px stage width no panel docks and a rail press opens
    one panel in the phone lane; at 721 px the column docks

### 4. Drag and drop, left dock, floating windows

- **Behaviour.**
  - Header drags, rail drag-out, the chip and slot preview, new columns on
    both sides with the rail slide, emptied columns holding their place.
  - Floating windows and stacks, the frame grip, corner resize.
  - The keyboard Move menu, separator keys, floating-window move and resize keys, and Pop out in the header.
  - The 60% dock-footprint cap, which matters from this slice on because it adds
    extra columns and the left dock.
  - The two-sided Essentials default for devices with no stored layout.
- **Tests.**
  - E2E with `page.mouse` steps: dock right/left/new column/float/stack/rail
    drag-out, plus the same moves through the keyboard.
  - The cap's boundary widths, computed from the tokens rather than
    hard-coded: 1220 px and 1219 px today (Essentials fully docked, then
    Objects parked while Parameters stays docked on the right), and 721 px
    (one column docked). At each width the model keeps at least 40% of the
    stage unobscured, measured from the rendered dock rectangles, and a
    parked panel opens from its rail button in the unpinned slot. Pressing
    that rail button again closes it, and the measured model space returns
    to at least 40%.
  - A pin past the cap docks nothing and shows the status line.
  - At 720 px a seeded layout with several open panels shows the one at the
    head of the stored recency list, before and after a reload; the same
    holds when one of them is the unpinned panel, and resizing back to
    1440 px restores every panel to its stored place, the unpinned one
    included.
  - With Objects parked at 1219 px and opened from its rail, widening to
    1220 px closes the slot and shows Objects docked, exactly once.
  - Keyboard placement through the Move menu: into a named column at a
    chosen slot (Move to, then Move up/down), into a floating window, a new
    column on each side, and Float.
  - Keyboard moving and resizing of a floating window, from the grip and
    from the resize control, stopping at the bounds.
  - Two overlapping floating windows: pressing, focusing, and activating the
    covered one from the rail and from ⌘K each bring it to the front, and
    the order survives a reload.
  - At 720 px a stored floating layout shows one panel in the phone lane,
    Pop out is not offered, and widening the window restores the windows.
  - Unit tests for the hit-test thresholds.
  - A render-count check that `ModelViewer` doesn't re-render during a drag.

### 5. View options

- **Behaviour.**
  - The menu: presets, Hide all (`Ctrl+\`, added to `lib/keymap.ts` as a
    global command so U05 can list and remap it), Lock, Compact, Width.
  - Width changes re-run the cap, so a wider setting can park a column.
- **Tests.**
  - E2E for every preset, Hide all, Lock and Compact at 1440×900 and
    1280×720, and Width L at 1280×720 parking the outer column.
  - With Lock on, a header drag, a gap drag, the Move menu's placement items
    and the keyboard move/resize keys all leave the layout unchanged, while
    Pin, Pop out and Close still act.
  - With Hide all on, picking a feature and a parameter in ⌘K turns Hide off
    and shows and focuses the target panel.
  - Tabbing from the rail through the panel headers, gaps and menu moves focus
    without hiding the panels; `Ctrl+\` hides and shows them.

### 6. Documentation

- Update the quiet-stage plan (slice 4 superseded), `README.md` (the
  drawer/screenshot caption) and `docs/design/README.md`. Mark U04's drawer
  wording superseded in its row.
- Add fresh captures.

## Risks

- **E2E churn** is concentrated in slice 3.
  - Mitigation: content class names don't change, the fixture swap is one file,
    and the count-readout change is mechanical.
  - Shards rebalance from the slice's `e2e-report-N` artifacts.
- **Re-render cost while dragging.**
  - Mitigation: the drag state stays local, with a render-count check in
    slice 4.
  - Dragging must hold the 60 Hz interaction floor U07 records.
- **Overlay lanes.** Both docks now push the bottom lanes and the right lane.
  `viewport-overlay-lanes.spec.ts` and `stage-reach.spec.ts` are the
  regression guard and need left-dock cases.
- **Desktop shell.**
  - Pointer capture and drag-out in WKWebView are only exercised by the
    maintainer-dispatched `apple-silicon` workflow.
  - Whether to request it before desktop distribution is the maintainer's call;
    agents don't dispatch it.
- **Touch.** Headers and grips need `touch-action: none`. Phones never dock,
  which keeps drag-to-dock off small touch screens.

## Out of scope

- Tabbed panels.
- Saved custom layouts. The menu's "Save current layout…" is not built; a
  later slice can store named layouts under the same key.
- OS-level windows on desktop.
- Per-project layouts.
