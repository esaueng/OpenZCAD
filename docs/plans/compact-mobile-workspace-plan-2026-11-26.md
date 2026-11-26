# Compact mobile workspace plan

Proposed and decided with the owner 2026-11-26 (see
[Owner decisions](#owner-decisions)). Owns [U12](../../ROADMAP.md#u12). Each slice below is one
bounded PR that records its evidence as a U12 fragment in
[docs/roadmap-evidence/](../roadmap-evidence/README.md).

## Intent

Today a phone gets the desktop workspace, shrunk to fit. The quiet-stage
islands ([U04](../../ROADMAP.md#u04)), the dockable panels
([U08](../../ROADMAP.md#u08)) and the touch work ([L02](../../ROADMAP.md#l02))
all reach a phone. The phone only has room for them because of about 54 media
blocks in `quiet-stage.css`, 560 lines in `phone-stage.css`, a phone lane in
`lib/panelLayout.ts`, and width checks spread through `App.tsx`.

This plan replaces that with a **compact workspace** built for a phone. It
keeps the same document, kernel, commands and history, and every capability
stays reachable. It has:

- a simpler structure: one stage, one sheet and one tool tray;
- a softer and friendlier look;
- much less text on screen.

The desktop and tablet ("regular") workspace keeps its layout. It takes on
the softer look only in slice 14, after the compact shell ships.

## Starting point (survey of `main` at `fd46ea8d`)

What a phone shows today, measured on an iPhone 17 simulator and in the
existing phone specs:

- **Two vertical rails take about a third of a 390 px width.** The model is
  pushed off-centre, and a floating panel covers it. History opens over the
  part with its step names truncated.
- **Phone fixes are piecemeal.** They live in four places:
  - CSS bands for width (≤520), height (541–620, 621–819, ≥820) and landscape
    (≤540 tall);
  - `App.tsx` effects keyed on 520 and 620 px;
  - the `restPhoneLane`/`dismissPhonePanel` reducers;
  - per-component queries in `ViewerToolbar`, `NumericKeypad`, `TweakPanel`,
    `CommandCard` and `WorkspaceReadout`.

  Each fix in `phone-panel-conflicts.spec.ts` (1,644 lines: UX-001, -003, -010,
  -011, #1945, #1947, #1953, #1957) settles one overlap between islands that
  were never designed for this size.

- **Problems still open** from the 12 and 13 Nov design reviews
  (`docs/reviews/design-review-2026-11-1{2,3}.md`):
  - the sketch canvas is about 205 px wide (I41);
  - Measure hides what it measures (I47);
  - the tour runs off-screen (I12);
  - the top bar is clipped at 390 px (I23);
  - flyouts swallow taps (I37);
  - Settings has no search on a phone;
  - Export mesh falls below the fold.
- **The iOS shell** (`apps/ipad`) builds unchanged as a universal app and runs
  on an iPhone. The web app reserves no top safe area, so the Dynamic Island
  covers the title (see the 2026-11-26 investigation).
- **Some capabilities have no touch path** (functionality survey):
  - The selection filter (Q) and sketch select-all, copy and paste are
    keyboard-only.
  - So are the motion-study `[`/`]` key steps.
  - View, Tweak, Assemble and Draw have no undo button.
  - Draw's 25 single-letter tools are hard-coded keys that sit outside the
    keymap and the command bar.
  - Duplicate feature, re-pick repairs and Look at face are context-menu
    only.
  - A connected edge run and a body selection from a face are double-click
    only.

### Architecture seams

- There is no state store. `App()` spans about 40.8k lines, with about 211
  `useState` calls. Tool and command dispatch are closures inside App:
  `executeCommand` (`App.tsx:12951`), `launchTool` (`:13442`), the keydown
  if-chain (`~37185`) and `paletteCommands` (`:38785`).
- What is reusable:
  - `CommandManager` and `commandFactories`;
  - the 26 workspace hooks (`useInPlaceCommand`, `useGeometryWorker`,
    `useMeasurementWorkbench` and others);
  - `ModelViewer` and the touch input layer (`touchGestures.ts`,
    `touchNavigation.ts`, `touchLongPress.ts`, `pointerSlack.ts`,
    `touchLoupe.ts`);
  - the typed `app={…}` bundles that cards already receive.
- `AppShell` is a stateless frame of named slots, so the compact workspace can
  branch there.
- Three registries describe commands, and none is complete:
  - `KEYMAP_COMMANDS`, 92 entries;
  - `TOOL_META`, 45 tools;
  - `paletteCommands`, 93 fixed rows.

## Decisions

1. **A layout size class, not device detection.** The workspace is compact
   when the window is at most 600 CSS px wide, or at most 500 px tall in
   landscape. Settings › Appearance › Layout offers Automatic (the default),
   Compact and Full. Input still follows `pointerType`, as in L02. A phone
   with a mouse keeps mouse input in the compact layout, and a narrow desktop
   window gets the compact layout with mouse input. iPad full screen stays
   regular. A narrow iPad Split View window becomes compact by the same rule.
2. **One action registry is the source of parity.** A typed registry
   (`apps/web/src/lib/actions/`) holds each user-reachable action: an id,
   title, short label, icon, group, availability and `run`. The keymap, the
   command bar, context menus, both shells, Draw's tool keys and the sketch
   clipboard all read it. Each entry names its compact entry point. A
   contract test fails when an action has none. This is also the route for
   lifting dispatch out of App's closures.
3. **The compact shell is a second slot filling of `AppShell`, not a fork.**
   It reuses the document, worker, hooks, viewer and cards. It is loaded
   lazily, so the entry-chunk budget in `report-bundle-sizes.mjs` holds.
   Persisted regular state (`panelLayout`, `panelState`) is never read or
   rewritten by the compact shell. Switching back restores the desktop layout
   untouched.
4. **One sheet at a time.** Everything that is a panel, card, drawer, flyout,
   inspector or menu on desktop becomes content in a single bottom sheet. The
   sheet has three heights:
   - **peek**, one row of about 88 px;
   - **half**;
   - **full**.

   It keeps a back stack for drill-in. Nothing else floats over the model
   except the view cube, undo and redo, and the selection chip. Overlaps
   between islands stop being possible.

5. **Keep the five modes.** View, Tweak, Build, Assemble and Draw become a
   bottom tab bar with icons and one short word each. Share links keep their
   mode contract unchanged.
6. **Undo and redo are always on screen** in every mode, as a floating pair
   on the stage. The two-finger and three-finger taps stay as shortcuts.
7. **Softer visual language, on the compact shell first** (see below). It is
   scoped to `[data-shell="compact"]` while the compact shell is built. After
   slice 12, a token-only follow-up (slice 14) brings the same radii, colors
   and type to the regular workspace, keeping desktop density. This
   supersedes the U04 "near-square" decision: for compact now, everywhere
   after slice 14.
8. **Retire, don't stack.** When the compact shell becomes the default for
   the compact class, a deletion PR removes:
   - `phone-stage.css`;
   - the phone-only parts of `quiet-stage.css`;
   - the phone lane in `panelLayout.ts`;
   - the 520/620 effects in App;
   - the phone specs and contracts that pin them.

## Information architecture (compact)

```
┌──────────────────────────────┐  safe-area top (Dynamic Island)
│ ‹  Bracket ●        ⌕   ⋯   │  header: library, name (tap = project sheet),
│                              │  save dot, search, overflow
│                       [cube] │
│          (model,             │  full-bleed stage
│           full bleed)        │
│ [↶][↷]          [● 2 faces] │  undo/redo · selection chip
├──────────────────────────────┤
│ ◐ ◐ ◐ ◐ ◐ ◐  ⊞              │  sheet at peek: context tray (verbs, or the
├──────────────────────────────┤  running tool's step + ✕ / ✓)
│  ◎    ⚙    ⬚    ⚭    ✎     │  mode tabs: View Tweak Build Assemble Draw
└──────────────────────────────┘  safe-area bottom
```

**Header.**

- The back chevron returns to the library.
- Tapping the name opens the **project sheet**: rename, properties (today
  reachable only from a library tile), revisions, share, export and import,
  units, comments and storage.
- Search opens a full-screen command search covering commands, features,
  parameters and the assistant.
- The overflow menu holds Settings, Help and the modeling guide.

**Stage.**

- The model fills the screen, with no rails.
- The view cube sits top-right at 56 px.
- The scale bar stays and is hidden while a sheet is above peek.
- The selection chip names the current pick. Tapping it opens the selection
  sheet: verbs, details, Select other, the selection filter, Isolate and
  Hide.

**Context tray (the sheet at peek).**

- At rest it shows the mode's verbs: the `commandContext` suggestions as a
  row of 44 px icons, then ⊞ for All tools or the mode's panel switcher.
- While a tool runs it shows the tool's icon, its current step as a short
  chip ("Profile", "Axis"), Options, ✕ and ✓. This replaces
  `InPlaceCommandBar`, the `ToolCard` header and the operation card.
- Value chips on the model open the numeric keypad as sheet content.

**Mode content**, with each desktop surface mapped to its compact home:

| Mode     | Tray at rest                            | Sheet content (half/full)                                                                                                                                                                                             |
| -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View     | Measure, Section, Display, Views, Parts | Measure readings (I47: the sheet sits below the model, which reframes above it), section controls, display/analysis, standard and saved views, parts list                                                             |
| Tweak    | Parameters, Configuration, Export       | Exposed parameters as large rows with steppers and keypad, configuration rows, STEP/mesh export, activity                                                                                                             |
| Build    | Context verbs + All tools               | All tools grid (45 tools, 5 groups, icons with one-word labels, search on top, pinned row first); History, Objects, Parameters, Revisions, Diagnostics as one segmented panel sheet; Inspector as the selection sheet |
| Assemble | Joint, Motion, Explode, Play            | Parts, joints, limits, motion setup, gears, positions, interference, studies/timeline (key step buttons replace `[` `]`), BOM                                                                                         |
| Draw     | Annotate, Views, Sheets                 | 22 annotation tools in five icon groups (dimensions, symbols, notes, tables, tolerances), view creation (section, detail, auxiliary), sheet list with actions, properties, PDF/SVG/DXF export                         |

**Sketch** takes over the whole shell while it is open.

- The mode tabs hide.
- The header shows the sketch name, Solve state as a dot, and ✓ Finish.
- The tray is the draw tools as a scrollable icon row: Select, Line, Arc,
  shapes with their variant on long-press, Text, Project.
- The modify tools, palette and constraint list are in the sheet.
- Relations are a contextual chip row above the tray, shown only for the
  current selection. Relations that don't apply are left out rather than
  greyed. This removes the 205 px canvas (I41).
- Select all, copy and paste become sheet actions on the selection.
- The touch loupe and Pencil mode are unchanged.

**Panels as lists.**

- History rows are full-width with an icon, name and value, and never
  truncate mid-word (they wrap to two lines).
- Tap opens the step's edit form. This replaces double-click.
- Swipe left offers Suppress and Delete. Swipe right offers Roll back to
  here.
- Long-press opens the full row menu: duplicate, re-pick repairs,
  visibility, Export DXF and the rest.
- Drag to reorder uses a grip on the row.
- Objects follow the same pattern.

**Menus.** Context menus become action sheets, opened by long-press on the
model or a row. Their items come from the same `viewportMenu.ts` and
registry entries.

**Library.**

- Two-column thumbnail grid or a list.
- Shelves as a segmented control.
- Swipe actions on rows, and the selection bar as a bottom toolbar.
- Import by a file button and the share sheet.

**Settings.** A pushed navigation list of the 12 sections with search on top.

### Touch paths for today's keyboard-, hover- and double-click-only actions

| Action                                  | Compact entry                                                      |
| --------------------------------------- | ------------------------------------------------------------------ |
| Selection filter (Q)                    | Selection sheet › Filter                                           |
| Undo/redo outside Build                 | Floating pair, every mode                                          |
| Sketch select all / copy / paste        | Sketch selection sheet actions                                     |
| Motion key step `[` `]`                 | Timeline buttons                                                   |
| Shortcut overlay, reopen guide          | Header overflow › Help, Modeling guide                             |
| Export face outline DXF                 | Selection sheet (face) › Export DXF                                |
| Duplicate project in workspace          | Project sheet                                                      |
| Duplicate feature, re-pick repairs      | History row long-press and selection sheet                         |
| Look at face                            | Selection sheet (face) › Look at                                   |
| Show all bodies                         | Objects sheet header and View tray                                 |
| Connected edge run (double-click)       | Selection sheet (edge) › Select connected                          |
| Whole body from face (double-click)     | Selection sheet › Select body                                      |
| Fit (double-click empty space)          | Double-tap empty space (kept) and View tray                        |
| Edit sketch from History (double-click) | Tap the row                                                        |
| Rename (double-click)                   | Row long-press › Rename                                            |
| Draw's 25 letter keys                   | Draw tool groups; registered as actions so they are remappable too |
| Tooltips and disabled reasons           | Long-press shows them; a disabled verb taps to an inline reason    |

## Visual language (compact)

The target is friendlier and softer: less outline, more fill, rounder shapes
and fewer words.

**Shape.** The radius scale is replaced under `[data-shell="compact"]`:

| Token                                           | Today  | Compact |
| ----------------------------------------------- | ------ | ------- |
| `--radius-sm` (chips, keys)                     | 2 px   | 8 px    |
| `--radius-md` (controls, rows)                  | 3 px   | 12 px   |
| `--radius-lg` (cards, panels)                   | 4 px   | 16 px   |
| `--radius-xl` (new: sheet top corners, dialogs) | —      | 24 px   |
| pills, tray buttons, chips on the model         | 999 px | 999 px  |

- About 490 of the 560 `border-radius` declarations in `styles/` already use
  the three tokens, and 37 are 999 px pills.
- The remaining literal values (2 px ×11, 3 px ×7, 1 px ×5, 5–8 px ×10) move
  onto tokens in slice 3, so the override reaches everything.
- `--radius-xl` is defined in the regular workspace too (4 px there), so
  shared components can use it.

**Color.**

- Keep one signal hue for selection and the primary action. It is
  softened: cobalt `#6798ff` becomes a slightly lighter, less saturated blue
  on dark, and `#1c64c2` becomes a brighter blue on light. Final values are
  chosen against `theme/contrast.test.ts` (4.5:1 text, 3:1 UI).
- Neutrals drop the steel tint (hue 214) toward a near-neutral with a slight
  warm cast. Surfaces separate by tone and soft shadow rather than 1 px
  borders. Borders remain only where two surfaces touch with the same tone.
- Selected and active states use a tinted fill (signal at about 14%) instead
  of an outline plus a fill.
- Add and cut colors (`#48cd8f`, `#ff644d`) are kept as hues and softened in
  the same way, keeping their contrast pairs. Construction magenta is
  unchanged.
- Model, edge and environment colors are not changed here. They belong to
  viewport lookdev ([U10](../../ROADMAP.md#u10)).
- Light and dark both ship. The system theme is followed, as today.

**Type.**

- Geist stays.
- Compact sizes:
  - body 17 px (iOS's default, and above the 16 px no-zoom floor);
  - secondary 15 px;
  - caption 13 px;
  - mono values 17 px.
- Weights are 400 and 600 only.
- No all-caps eyebrows or letter-spaced headers (`HISTORY 17` becomes
  "History" with a count badge). Titles are in sentence case.

**Less text.** These rules are enforced by a contract test where they can
be measured:

- Controls are icon-first. A label is one word, under the icon, in tabs, the
  tray and the tools grid only. Everything else carries its accessible name
  only. The accessible names the specs use do not change.
- The stage at rest shows no sentences. Guidance appears as a single step
  chip, never a paragraph. The current hint line ("Search commands · ?
  shortcuts", "Panels share this space.") is removed.
- Status goes to a transient toast and the activity log, not a persistent
  line.
- Peek content is one line of at most about 40 characters.
- Numbers are monospaced and units are dimmed.
- Budget test: at rest in each mode, the visible text on the compact stage
  (excluding the project name and the selection chip) is at most 12 words.
  With a tool running, the tray is at most 4 words.

**Icons and motion.**

- One 24 px stroke icon family at 1.75 px stroke. Icons are filled when
  active.
- The sheet moves with a short spring. Reduced-motion users get a cross-fade.
- The native iOS shell may add light haptics on detents, snaps and Done,
  through a `desktopBridge`-style message handler. This is optional and off
  in the browser.

## Native iOS app

The compact workspace is what makes an iPhone build of `apps/ipad` worth
shipping. The iOS work runs alongside the shell slices:

- `TARGETED_DEVICE_FAMILY = 1,2`.
- Show the status bar on iPhone.
- Drop upside-down portrait on Face ID iPhones.
- The compact shell honours `env(safe-area-inset-*)` on all four sides.
  `viewport-fit=cover` is already injected by the shell.
- An iPhone 17 / iPhone SE-class UI smoke joins the shared scheme.
- `run-ipad-simulator.mjs` falls back to any installed iPad or iPhone when
  the named simulator is missing.
- **Sign-in and sync use a native bridge** (owner decision). The bundled
  `zcad-ipad://app` origin stays, so the app remains fully offline-capable,
  but passkeys cannot run there: their RP ID comes from `location.hostname`.
  Swift performs the passkey ceremonies through AuthenticationServices
  against the web domain (associated domains `webcredentials:`), then hands
  the web app a session through a narrow message handler. The web app's
  passkey and E2EE code (`lib/e2ee/passkeys.ts`) then calls the bridge
  instead of `navigator.credentials` when the bridge is present. This needs
  an ADR before code, because it touches authentication and the
  [ADR-024](../adrs/ADR-024-end-to-end-encrypted-projects.md) key flow. The
  ADR must settle:
  - how the session is scoped and stored (Keychain, never `localStorage`);
  - which origins the bridge accepts messages from (the app origin only);
  - how PRF or key-derivation outputs used by encryption cross the bridge
    without being logged or persisted;
  - how sign-out and revocation reach both sides.

  Until that slice (13) lands, the native app stays offline-only.

- Out of scope here: App Store identity and signing (an owner decision), and
  real-iPhone memory budgets (device evidence under
  [W01](../../ROADMAP.md#w01)).

## Slices

0. **This plan** and the U12 row.
1. **Action registry, no UI change.**
   - `lib/actions/` with entries for the keymap's 92 commands, the 93 fixed
     palette rows, context-menu verbs, Draw's 25 tools and the sketch
     clipboard.
   - The keymap, command bar and context menus read it.
   - `executeCommand`, `launchTool` and the keydown chain dispatch through
     it.
   - A parity manifest test: every action is reachable from the regular
     shell today, and declares its compact entry (initially `pending`).
   - Desktop behaviour and every existing spec stay unchanged.
2. **Compact frame behind a setting.**
   - The size-class hook and Settings › Appearance › Layout (a new
     app-settings field carried by the Worker, like slice 6 of L02).
   - A lazy `CompactWorkspaceShell` rendered into `AppShell`'s slots.
   - Header, mode tabs, full-bleed stage, floating undo/redo, cube and
     selection chip, and safe areas.
   - The `BottomSheet` host: three heights, back stack, focus trap at full,
     `inert` stage under a full sheet, and Escape/back to close.
   - Automatic still resolves to Full until slice 12.
   - Evidence: unit tests for the size class and sheet state; a `@compact`
     Playwright project at 390×844, 375×667, 360×640, 430×932 and 844×390.
3. **Visual tokens.**
   - Compact radius, color, type and shadow overrides.
   - The literal radii moved to tokens.
   - Contrast and `tokens-defined` tests extended to the compact set.
   - The text-budget contract helper.
   - Regular screenshots must not move.
4. **Build.**
   - The context tray, the All tools sheet, tool runs in the tray (step
     chip, Options, ✕/✓) and the keypad as sheet content.
   - The selection chip and selection sheet: filter, Select other, Select
     connected, Select body and face verbs.
   - Action sheets for long-press.
   - Covers all 45 tools by registry; the e2e is driven by taps only.
5. **Panels.**
   - History (tap to edit, swipes, grip reorder, long-press menu, History as
     text), Objects, Parameters and configurations, Revisions, Diagnostics
     and Comments, all in the segmented panel sheet.
   - The Inspector as selection-sheet detail.
6. **Sketch.**
   - The compact sketch layout: tools tray, contextual relations row,
     modify and palette in the sheet, Finish in the header, and clipboard
     actions.
   - Evidence: a sketch-and-extrude e2e at 360×640; the canvas keeps at
     least 90% of the stage width.
7. **View and Tweak.**
   - Measure, section, display and analysis, views and saved views, and the
     parts list.
   - Tweak parameters, configurations and exports.
8. **Assemble.** Parts, joints, motion, gears, positions, interference,
   studies with timeline step buttons, BOM and player.
9. **Draw.** The sheet canvas with pinch and pan (existing), annotation
   groups, views, sheets, properties and exports, plus Draw's actions in the
   command search.
10. **Library, project, settings, search and guide.**
    - The compact start screen and the project sheet: properties, share,
      export and import, revisions, units and storage.
    - Pushed Settings with search, full-screen command search and assistant,
      and the modeling guide redrawn as step chips in the tray (I12).
11. **iOS universal app**, as above.
12. **Default and retirement.**
    - Automatic resolves to Compact for the compact class once the parity
      manifest has no `pending` entries and the owner signs off on device.
    - The deletion PR removes the old phone layer and rewrites or deletes
      `phone-stage.spec.ts`, `phone-panel-conflicts.spec.ts`,
      `measure-phone.spec.ts`, `phoneStageContracts.test.ts`,
      `stageFootClaimContracts.test.ts` and the phone parts of
      `viewerResponsiveContracts.test.ts`.
    - `touch-targets`, `touch-navigation` and `touchContracts` are kept.
13. **Native sign-in bridge.**
    - The ADR first:
      [ADR-026](../adrs/ADR-026-native-ios-passkey-sign-in-bridge.md)
      (proposed). Then the Swift AuthenticationServices bridge, the
      associated-domains entitlement and the web-side bridge adapter for
      passkeys and the session.
    - It is reviewed as security-sensitive work, independently of slice
      size.
    - It is independent of slices 2–12 and can start after slice 11.
14. **Softer look in the regular workspace.**
    - The compact radius, color and type tokens move to the global `:root`
      at desktop density, and the `[data-shell="compact"]` overrides shrink
      to the sizes that differ.
    - The regular screenshots move deliberately in this one PR, and contrast
      tests cover both shells.

Slices 4–10 each turn their registry entries from `pending` to a named compact
entry, so the parity test tracks progress. They may run in parallel once 1–3
have merged, one surface per PR. Coordinate with
[U11](../../ROADMAP.md#u11), the tool interaction overhaul: a tool reworked
there keeps the same picks and handles in the compact tray, and only the
chrome differs.

## Acceptance

- **Parity:** every registry action has a compact entry, a test opens each
  one with taps only, and none needs a keyboard, hover, right button or
  double-click.
- **Regular workspace unchanged:** the existing desktop and tablet suites
  pass without edits through slice 11, and regular screenshots do not move.
- **Stage:**
  - At rest, the model's clear share of the screen below the header is at
    least 80% at 390×844 and at least 75% at 360×640 (today the phone spec
    requires 60%).
  - No element overlaps another; one sheet shows at a time by construction.
  - Every target is at least 44 px.
  - The text budget above holds.
- **Accessibility:** accessible names are unchanged, VoiceOver order runs
  header → stage controls → tray → tabs, the sheet is announced with its
  height, and contrast passes for light and dark.
- **Device:** the iPhone simulator smoke passes on the universal app. Owner
  acceptance on a real iPhone records first-load time, memory headroom (W01)
  and the gestures Safari and WKWebView handle differently from emulation.

## Owner decisions

Decided 2026-11-26:

1. **The softer look comes to desktop and iPad after the phone ships.** It is
   a token-only follow-up (slice 14) that keeps desktop density.
2. **Compact class threshold:** at most 600 px wide, or at most 500 px tall
   in landscape. This includes narrow desktop windows and iPad Split View,
   with Settings › Appearance › Layout to force Compact or Full.
3. **Mode tabs show an icon and one word**, as in the mockups.
4. **Native iOS sign-in and sync use a native AuthenticationServices
   bridge** (slice 13, ADR first). The bundled offline app origin is kept.

Still open: the App Store identity and signing of the native app.
