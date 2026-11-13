# OpenZCAD design review — 13 November 2026

**Build reviewed:** a local production build of `main` at `cb25aa27`. Signed-in, cloud, sharing and encryption flows ran against a `VITE_E2E=1` build of the same commit with the e2e suite's mocked API and its in-Node Worker fixtures. The deployed site was not reviewed.

**How it was tested:** eight reviewers each took one slice of the product and drove it by hand in headless Chromium (SwiftShader) through Playwright. They worked at 1440×900 in the dark and light themes, at 1024×768, and at 390×844 with touch. The viewport slice also covered 768×1024, 1024×600 and 360×640. Each reviewer also made a keyboard-only pass. A finding marked **code** was read from source and not reproduced by hand.

**What this review adds:** the 12 November review did not cover drawing inside a sketch, drawing sheets, the assistant, or anything signed in. All four are covered here.

**Harness caveats:**

- Pointer input was synthetic, so latency and drag feel were not judged.
- The run was interrupted twice: once when the session restarted, and once when the temporary-disk quota filled. Because of that, Build, Assemble and Draw, and the chrome slice were cut short (see [Coverage](#coverage)).
- Draw is reviewed from code only.
- Not tried: a real phone, Safari, Firefox, and the desktop shell.

**Follows up:** [the 12 November review](design-review-2026-11-12.md) (H1–H16). Rechecks are listed under [Rechecks](#rechecks-of-the-12-november-review). The findings below are numbered I1–I87.

**Counts:** 27 Major, 45 Medium and 15 Polish, from 135 reviewer findings merged by root cause. No Blockers.

---

## Coverage

| Slice                      | By hand                                                                                                                                                                                                                            | Code only, or not reached                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Start screen and library   | Empty and populated library, grid and list, every tile action, folders, Archive, Trash, demo cards, import, startup screens, offline create, the whole tour on desktop and phone                                                   | Resume-session and conflict dialogs (need sign-in); ResumeHistoryDialog                                                  |
| Chrome, menus and commands | Top bar at four sizes, every File item, Panel layout, about 30 command-bar queries, Help & controls, viewport context menus, toasts, undo and redo, Tab order                                                                      | History-row, parameter-row and panel-header context menus; demos other than Mounting Bracket                             |
| Build                      | Box in depth, Fillet, Hole, every other tool opened with Options and Escape, History (suppress, delete, rollback, reorder), Parameters                                                                                             | Booleans, Extrude, Revolve, Loft and Sweep (need a second body or a sketch); Inspector; the unapplied-card dialog        |
| Sketch                     | Plane prompt, the drawing tools, typed values, relations, driving dimensions, under-, fully and over-constrained states, profiles, hand-off to Extrude, re-edit, DXF import, phone                                                 | A datum-plane sketch; mirror and patterns applied; Revolve hand-off                                                      |
| Viewport, panels, Tweak    | View cube, every instrument, section on three demos, Measure, saved views, panel docking and floating, face drag, six viewport sizes                                                                                               | Move gizmo, frame stats, isolate                                                                                         |
| Assemble and Draw          | Scissors demo, the Joint card and its type tiles, Set up motion, motion studies, first-run card, Add parts                                                                                                                         | Creating a joint by viewport picks, gear card, View player. **Draw from code only.** Assemble only at 1440 dark          |
| Settings, I/O, assistant   | All 11 Settings sections changed and reloaded, keymap editor, every export format, every import dialog, nine bad files, assistant via mocked `/api/assistant/*`                                                                    | Encryption settings and cloud deletion signed out, ColorPicker, UnusedMeshPayloads, the assistant consent dialog         |
| Account, cloud, sharing    | Sign-in, save chip states, two-device conflict, revisions, sharing as owner, editor and viewer, edit lease, SharePage states, Make a copy, encryption setup, devices, new-device lock, encrypt and stop encrypting, cloud deletion | Encrypted invitations, contact verification, passkeys, a full device-approval handshake, an encrypted share-link visitor |

---

## Findings

Format: **Where** · **What** · **Severity** · **Fix**. Findings that recur across slices are merged under [Cross-cutting](#cross-cutting) and are not repeated in the area sections.

### Cross-cutting

**I1 · Touch targets outside the Build rails are still desktop-sized.** Build rails and command-card buttons are 44 px on touch, but almost everything else is not:

- Start-screen tile ⋯ and Pin are 24 px, the select checkbox is 20, the settings gear 28, Sign in 50×24, and menu items 28 tall. The demo cards' Save a copy and Reset appear only on hover.
- View and Tweak rail buttons are 30 px (carried over from the 12 November list), and the Measure panel's controls are 28.
- Both sketch rails are 30 px.
- Box dimension chips are 93×24, and the drawer filters are 22 tall.
- In the top bar, Share, File and Settings are 28 px.
- The tour card's controls are 28 px, and its Next button is 58×25.
- The keymap editor's remove × is a bare 12 px icon.
- The assistant header buttons are 24 px.
- Revision Restore and Branch are 12 px icons that appear only on hover.

**Major.** Fix: one `pointer: coarse` rule that gives every control a 44 px hit area, and nothing that is reachable only by hover.

**I2 · Destructive actions are confirmed three different ways, or not at all.**

- **Native `window.confirm()`:** Delete forever, Empty trash, multi-select delete and demo Reset in the library, plus Clear conversation in the assistant and Reset settings. `App.tsx` records that feature delete moved off `confirm()` because embedded and automated browsers answer it with Cancel unseen. These call sites did not follow.
- **No confirm and no undo message:**
  - Delete sheet (**code**).
  - Deleting a drawing view, which also deletes its section views and every dimension and note on them (**code**, `deleteDrawingView`).
  - Revoking a share link, whose token was "shown once" (**code**).
  - Activity log Clear, even with "Confirm destructive actions" on.
- **No Undo:** Move to trash and Archive in the library.
- **Joints:** Delete exists only in the right-click menu.
- **Feature Delete:** the dialog puts default focus on the red Delete button, so one Enter deletes a feature with dependents.

**Major.** Fix: one in-page confirm (the DeleteFeatureDialog pattern, with focus on Cancel), or an Undo toast that names what went, for example "Deleted Front view, Section A-A and 4 dimensions · Undo".

**I3 · Parser, transport and kernel text reaches the user.**

- Start-screen Import of an `.stl`: "Project import failed: Unexpected token 's', "solid x endsolid x " is not valid JSON". A STEP file gives "…"ISO-10303-"… is not valid JSON".
- Share dialog and Download your data, after a proxy or HTML error: "Unexpected token '<', "<!doctype "… is not valid JSON".
- SharePage: "Failed to fetch".
- Watertightness check on `samples/parametric-bracket.step`, shown in red: "check: distance computation failed: circular trim ray-event endpoint is unresolved". It gives no verdict, and Export stays enabled.
- Shapr: "SHAPR archive has no valid ZIP central directory."
- A 500 reads "Internal error. Check your connection and try again", which blames the network.

**Major.** Fix: map these to plain outcomes, for example "This is a STEP file, not a project backup — open a project and use Import CAD files", or "The check could not run; the export is unaffected". Put the raw text under a Details disclosure.

**I4 · Feedback lands far from what caused it.**

- **Library:** every notice, failures included, is one truncated grey line in the sidebar foot. A failed import shows only "Project import failed: Unexpected to…" at the bottom left.
- **Box width:** typing −5 or 0 in the Width keypad closes it with no error. The chip goes back to "Width 30 mm", and the bar turns amber with "Box width takes at least 0.001.", which has no unit. The typed value is shown nowhere.
- **Import card:** it keeps showing the previous failure ("Not imported empty.stl"), while later rejections of `.FCStd`, `.txt` and two-file drops appear only in the status line.
- **Sign-in:** a wrong code is reported only in small mono text beside the Settings title. The field gets no error state.
- **Removing a device:** a wrong recovery key is reported about 500 px above the field.

**Major.** Fix: put each error at the field, with `aria-invalid` and `aria-describedby`. Keep a keypad open with an inline range message ("Width must be more than 0 mm"). Send library failures through the toast host in a warning tone.

**I5 · A failed lazy load while offline is a dead end.** Two routes lead there:

- On the start screen, go offline and click Create your first project. You get a full-screen "LOADING INTERRUPTED · Part of OpenZCAD could not load" with Reload as the only action and no way back to the library. StartupScreen's own offline copy never appears.
- Go offline in a cloud project and return Home. The footer reads "Load failed · Reload", the tile shows "No geometry", and a toast suggests reloading.

Both states stay after the connection returns. Reloading while offline risks losing the app shell.

**Major.** Fix: catch chunk failures in the startup flow and show the offline state with Back to projects. Retry on the `online` event, and never suggest Reload while offline.

**I6 · Views are framed for the whole window, not the stage left uncovered.**

- **Docked panels:** with Parameters, Objects and History docked, the Mounting Bracket opens with its right half under the column and the rail.
  - At 768×1024 that hides half the boss and the second hole.
  - Turning Section on puts its 300 px toolbox over the cut it controls.
- **Sketch re-edit:** a 34×24 mm rectangle fills the window height, with both side edges under the panels.
- **Assistant proposals:** the proposal card says "in the viewport", but the panel covers most of the preview (x 446–993 at 1440). On a phone the preview is entirely hidden behind Apply and Reject, and the camera never reframes.

**Major.** Fix: compute one clear-stage rectangle and use it for opening a project, Fit, re-edit and proposal previews. Place the section toolbox clear of the model.

**I7 · Overlays stack in the wrong order.**

- **Floating panel over its own card (Major):** in a popped-out History, clicking "Mount hole L" opens the Edit feature card behind the float. Labels read "e center Y" and "epth / 2", and Apply is half covered. A new float also opens with its bottom row below the window.
- **Box card over the cube:** at 768×1024 with panels docked, the Box card now covers the view cube completely. This was "touching" in the 12 November review, so it got worse.
- **Toast over the timeline:** "New motion study Motion 1 added." sits on the Revolute 1 track.
- **Rail over a panel:** at 1024×600 the two-column rail covers about 22 px of the docked Objects panel.
- **Sketch chips under the rail:** "40 × 31 mm / … Shift no sna…" is clipped under the Relations rail.

**Major.** Fix: cards above floats, toasts above the timeline lane, new floats clamped inside the stage, and the cube lifted above a lane that holds a card.

**I8 · "Cloud unavailable" is described five different ways.**

- **Start screen:** "On this device only · Sign in". Sign in leads to Settings › Account, which says "Sign-in could not be reached", with "Cloud unreachable" in its sidebar.
- **Workspace top bar:**
  - a "Local only" chip;
  - an "Unavailable" person chip that looks like a button;
  - an icon-only "Offline · Sign in to share".
  - At 1024 and on a phone all three are bare glyphs.
- **Settings › Saving:** Cloud autosave shows ON at 3 s while signed out.
- **Settings › Account:** "Preferences follow your account" sits next to a "Device only" badge.
- **File menu:** "Archive local sources · 1 file" appears with an amber dot. It can only fail ("upload failed … try again"), and the dot stays.
- **Assistant:** a question typed while signed out ends as "No matching command." and is dropped.
- **Save chip:** a 500 from `/document` is labelled "Offline". The top bar says "Saved" where the status bar says "Synced" (**code**).

**Medium.** Fix: one vocabulary for each state. Label cloud-only settings "Applies after sign-in". Hide actions that cannot succeed, and tell a server error apart from offline.

**I9 · Keyboard focus falls to `<body>`.**

- When the assistant answers, focus lands on `<body>`. The next keystroke hits the workspace's single-key shortcuts.
- After removing a key in the keymap editor.
- In the Text tool, clicking the placement point first moves focus to the canvas. Typed text is lost, and Place stays disabled.
- The toast is a button named "Open activity log." with `tabindex=-1`, so it can't be reached from the keyboard.

**Medium.** Fix: keep focus in the prompt or move it to the card's primary action; move focus to the next chip; refocus the Text field after the placement click.

**I10 · Internal names and jargon reach the user.**

- **Sketch:**
  - "Coincident · line profile 2.end = line profile 3.start";
  - "Lock · line profile 4.start";
  - a conflict reported as "line profile.start ↔ line profile.start";
  - reference-dimension pickers that list each corner twice.
- **Edit lease:** "Waiting for the project edit lease" replaces all 35 tool descriptions while a lease is pending, and B toasts "Box: Waiting for the project edit lease."
- **Analytics:** "Allow Glimpse to count … DNT/GPC and turning off cloud features suppress sending while preserving this choice …". Glimpse is never explained.
- **Fillet refusal:** 'Feature "Fillet": Fillet could not be created … with radius 50. Try a smaller radius: radius 6.25 builds here.' It gives no units and no one-click Use.

**Medium.** Fix: human names for sketch entities, with highlight on hover. One "Connecting to the live session…" banner that offers Retry or Work offline after a few seconds. A plain sent / never sent / how to stop list for analytics.

**I11 · Units are dropped or doubled.**

- In Parameters, `width = 40 mm` is stored as unitless "any", shown as "40" with an amber dot.
- The keypad reads "= 30 mm mm".
- The sketch text field is labelled "Size (em)" but takes a document length (**code**).
- Sketch coordinate fields show no unit, and neither does Settings › Linear snap.

**Medium.** Fix: keep the typed unit through parameter creation, and label every length field in document units.

### Start screen and library

**I12 · On a phone the tour card runs off-screen and covers the rail it points to.** At 390×844 the card spans x 116–412, so "press Ente" and Next are clipped and the Skip ✕ is half off-screen. Step 3, "Open History from the rail on the right", sits on top of History. The copy assumes a keyboard: "press B, then press Enter", "right-click a row". **Major.** Fix: dock the card full-width above the command bar on phones, and write touch wording for each step.

**I13 · Dropping a file on the start screen hands it to the browser.** `FileDropTarget` is mounted only in the workspace, and the start screen does not prevent the default on dragover. The browser then opens or downloads the file, and there is no drop cue. The "Import" button accepts only `.openzcad`, while the workspace offers "Import CAD files". **Major** (synthetic drag plus **code**). Fix: accept a drop on the start screen and create a project from it. Label the button "Import project", or accept CAD files there too.

**I14 · A project can't be renamed from the library, and duplicate names pass silently.** The tile menu has no Rename, and Properties shows the name read-only, so renaming means opening the project. A second "Bracket A" is accepted with no hint. A demo copy is named "Demo · Mounting Bracket (copy)". **Medium.** Fix: add Rename to the tile menu, make the Properties name editable, and drop the "Demo ·" prefix from copies.

**I15 · List view breaks once folders exist.**

- The grid's folder tab is drawn as a 300–480 px strip above each folder row.
- "2 projects · Nov 13, 2026" wraps inside the STATUS column, and EDITED and SAVES stay empty.
- The count badge covers the thumbnail, which renders black in the light theme.

**Medium.** Fix: a list template for folder rows of their own.

**I16 · The tour's later steps don't show where to look.**

- Step 1 says "Tools at its foot", but the foot is an unlabelled ⋯.
- Step 3 advances the moment History opens, as a 90 px strip, so its tips vanish (the #1374 trade-off, now seen in context).
- Step 4 never points at File or Export.
- The tour restarts at 1/4 in every new empty project until it is skipped.

**Medium.** Fix: label the rail foot, hold step 3's tips briefly, point step 4 at File, and keep tour progress per device.

**I17 · Polish: library details.**

- Copies show a bare cube thumbnail.
- "Back to projects" on the startup screen is plain grey text, though it is the only way out of a slow open.
- The folder notice pushes the grid down and stays after the folder is named.
- Escape while naming keeps a folder called "New folder".
- "Ungroup" is red, as if destructive.
- Switching to Archive or Trash moves the shelf header 5 px and the search 128 px.
- A phone shows "Projects" three times.
- Tiles are announced as "No geometryLidNov 13, 2026" and take 4 Tab stops each.
- Help & controls describes a five-step "Modeling guide" but launches the four-step tour.
- At 1024 the demo cards squeeze to 175 px.
- The Properties dialog's Close sits below the fold at 900 px.

**Polish.**

### Workspace chrome, menus and command bar

**I18 · Right-click near an edge never reaches the action menu.** On the Mounting Bracket, right-click the front-bottom edge. "SELECT OTHER · 2 under pointer" opens every time. Choosing an entry selects it but opens no menu, and neither Shift+right-click nor Shift+F10 gets past the list. The list is dark in the light theme and covers the value chip. **Major.** Fix: open the top candidate's menu with "Select other ▸" as its first item, or open the menu after a pick.

**I19 · The face menu has no face actions.** Under the heading "MOUNTING BRACKET · TOP FACE", every item acts on the body: Move / Rotate, Union, Subtract, Hide, Isolate, Fit. Sketch on face, view normal, push/pull and Hole are missing. Union and Subtract are disabled without a reason. Right-click on parameter rows and panel headers gets the browser's own menu (**code**). **Medium.**

**I20 · The command bar misses names the chrome itself uses.** "help", "shortcuts", "keyboard", "rename", "duplicate", "home", "new project", "assemble" and "build" all return "No matching command.", and the "/" list has no Assemble. Ctrl+K and ArrowDown on the empty field show nothing. The no-result row offers no next step. **Medium.** Fix: add aliases, and point the no-result row to `?` and `/`.

**I21 · The mode-cycle shortcut is described wrongly.** The help sheet says Ctrl/Cmd+Shift+M cycles View, Tweak and Build, but it cycles all five modes. Every mode button's tooltip shows it as that mode's own key, for example "Assemble Ctrl+Shift+M". **Medium.**

**I22 · Toasts read as commands and lead out of the workspace.** After Ctrl+Z the toast says "Undo Add box", an instruction rather than what happened. "Added box." offers no Undo. Ctrl+S toasts "Saved on this device.", the same as autosave, although it made a Manual save revision. The activity-log button replaces the whole workspace with Settings. **Medium.**

**I23 · Phone top bar text is clipped.** At 390 px the hint lane reads "↑↓ move · Tab completes · Enter runs · Es…" and disabled reasons read "Create a sketch f…" and "Selec…". File shows Ctrl+S hints on a touch device. **Medium.**

**I24 · Polish: chrome details.**

- A disabled Extrude can be the active top result and ghost-complete.
- File has no menu semantics (no `aria-haspopup`, no arrow keys); Panel layout does.
- Key spelling varies: "Ctrl/Cmd+S" against "Ctrl+S", "Shift + click" against "Shift+Click".
- "Import project" has an ellipsis in the command bar but not in the menu.
- Export diagnostics is grouped under "File", which no longer contains it.
- The command bar's ? icon shows the on-screen hint again; it isn't Help.
- Panel layout has redundant "PANEL LAYOUT" / "LAYOUT" headings, and "Model only" duplicates "Hide all panels".

**Polish.**

### Build

**I25 · An undefined name gets no Define offer outside `ExprInput`.** The keypad shows only 'Unknown identifier "foo" in expression.'. Box › Options shows "Width was not applied", without naming the unknown identifier. Done stays enabled while the field is red. **Major.** Fix: use DefineParameterPrompt in NumericKeypad and the Options rows, and block Done or say which value it will apply.

**I26 · Delete and Suppress describe the same dependents in opposite terms.** With Box → Fillet → Hole:

- Suppress says the later features "cannot rebuild without it".
- Delete says they "will rebuild without it", and its default focus is on Delete.

**Major.** Fix: one wording that states the real outcome, with focus on Cancel when there are dependents.

**I27 · A refused reorder gives the wrong reason.** ArrowUp on Hole's reorder handle says 'Cannot reorder: "Hole" would run before the body it uses exists.' Box 1 exists from step 1; the real dependency is presumably the fillet's output. The row itself gives no feedback. **Medium.**

**I28 · Hints promise fields that aren't there yet.** Fillet says "Options sets the radius", but Options has no radius until edges are picked. Chamfer has the same gap for distance, and Gear shows "Module 2 mm" with no field to change it. **Medium.** Fix: show the field at its default (disabled is fine), or change the hint.

**I29 · The Move card is built differently from every other command card.**

- It is titled "Move / Rotate", while the drawer says "Move".
- It has no Preview pill, and its Options button is an icon.
- Its instruction appears three times: coach card, toast and hint.
- Escape reports nothing.
- Move picks a lone body automatically, but Scale, Mirror, Split, Solid offset and the patterns still say "Click the body…".

**Medium.** Fix: build Move on InPlaceCommandBar, and auto-pick a lone body everywhere.

**I30 · Enter after typing doesn't apply, and a fast second Enter is lost.** B then `100 Tab 60 Tab 6 Enter` commits only Height. A second Enter right away is dropped; one pressed after 3 s applies. `InPlaceCommandBar` drops Enter silently while `!canFinish` (**code**). H1's digit routing itself holds. **Medium.** Fix: let Enter in the last field apply, or queue it and show "Applying…".

**I31 · A new primitive previews inside the existing body.** Cylinder, Sphere, Cone and Torus all preview at the origin, embedded in an existing box. Nothing says Done will make a separate, overlapping body. **Medium.**

**I32 · Thread and Gear teeth are offered on a box-only model.** Neither can succeed. **Medium.** Fix: an availability reason such as "Needs a cylindrical face".

**I33 · The Parameters status lane reports the wrong thing.** An invalid name `2bad` gives "Parameter 2bad was not changed.". A duplicate `width` shows an error in the field while the lane still reads "Added parameter h.". The expression column truncates `width / 2` to "width /". **Medium.**

**I34 · Polish: Build cards.**

- Position values are left-aligned and Size values right-aligned.
- "Base cen…" is truncated.
- Scale says "centre" where other cards say "center".
- The fillet field is labelled "R" while History writes "r".
- A Preview pill shows before anything is previewed.
- The bar's width, and so the position of Done, changes per tool.
- The rail's three suggested slots change after every tool use.
- Opening a fillet edit toasts "Full history resumed…" when nothing was suppressed.

**Polish.**

### Sketch

**I35 · A refused dimension still paints the sketch as conflicted, and Undo removes a good dimension.**

1. Lock a rectangle's corner.
2. Dimension the top edge to 50 and the right edge to 30. The toast says "Fully constrained."
3. Add a 70 mm diagonal. It is refused ("no change was applied"), yet three edges turn red, a "Constraints conflict" banner appears, and Review lists six valid constraints in red.
4. Ctrl+Z ("Undo Add distance dimension") removes the 30 mm dimension.

**Major.** Fix: keep a refused attempt's residuals out of the committed state, and report the refusal against the rejected value.

**I36 · Re-editing a sketch arms Line, so the first drag draws a stray line.** History › Edit sketch opens over-zoomed (see I6) with "Click to start a line". Dragging a corner adds a line. Double-clicking the History row does nothing, and the header truncates to "EDIT FEATURE · STEP 2 OF…". **Major.** Fix: open re-edits in Select, and let double-click enter editing.

**I37 · Tool-variant flyouts float over the canvas and swallow drawing clicks.** Pressing R shows "Corner · Center · 3 points · Polygon" mid-canvas for as long as the tool is armed. The first click lands on "3 points" and draws nothing. The same happens with Polygon. On a phone the strip covers the middle of the canvas. **Major.** Fix: attach the picker to the rail, and close it on the first canvas pointer-down.

**I38 · "Fully constrained" is announced but not shown.**

- The edges keep the same blue at 3 DOF and at 0 DOF, and turn green only after a manual Solve.
- Degrees of freedom appear only in toasts.
- The only lasting cue is an unexplained dot on the Solve icon, and there is no legend.

**Major.** Fix: classify after each commit (`DEFINED_COLOR` already exists), and add a persistent DOF chip with a legend.

**I39 · A selected line can't be dimensioned.** With an edge selected, Distance is greyed: "Does not apply to a line." The only path is to deselect, arm Distance and hit both exact endpoints, with no pick highlight or preview. A missed snap is ignored silently. There is no Dimension shortcut, and typed drawing sizes do not become driving dimensions. **Major.** Fix: accept a line or circle as a single pick, add a smart Dimension tool on D, and preview the dimension while placing.

**I40 · The entity editor and palette cover the geometry they edit.** At 1024×768, selecting an edge opens three stacked cards (260×580) that hide the whole rectangle. At 1440 they cover half of it, and Review constraints opens over the conflicting edges. The selection offers two commit buttons, Apply and Resize. **Major** at 1024, Medium at 1440. Fix: dock the editor in the left panel during sketch mode, or pan to keep the selection clear.

**I41 · On a phone the sketch canvas is about 205 px wide.** Drawing works, and the dimension keypad has units. But three rails stay on screen: 16 tools, 13 relations and the viewer rail. The flyout and the clipped size chip cover the rest. **Major.** Fix: below about 600 px, fold Relations into a bottom sheet and hide the viewer rail.

**I42 · E preselects every region, holes included, and Cancel leaves the sketch.** With nested and overlapping profiles, E selects all four regions, including the inner circle, and draws four overlapping arrows. Cancel goes to Build instead of back to the sketch. **Medium.**

**I43 · One Escape from Select leaves the sketch.** The reflex second Escape after placing a dimension exits to 3D, and the next click starts a new Extrude. Inside the Fillet, Offset and Distance value prompts, the hint says "Esc leaves the sketch". Geometry is kept. **Medium.** Fix: inside a sketch, Escape only disarms and deselects. Exit through Finish or a confirmed second Escape.

**I44 · Constraint icons are ambiguous or duplicated.**

- Parallel and Equal use the same icon.
- Coincident and Concentric are indistinguishable at 16 px.
- Perpendicular uses an angle icon.
- The canvas draws ∥ where the rail draws =.
- Arc uses a polyline glyph.
- Glyph clusters after a fillet or offset float unattached to any entity.

**Medium.**

**I45 · A face sketch can open rotated.** On a box's top face, sketch X pointed up and the cube's Top was rotated 90°. Seen once. **Medium.** Fix: align sketch +X with screen right.

**I46 · Polish: sketch hints and keys.**

- A rectangle in progress shows the line-chain hint.
- The Vertical refusal says "No change was applied" twice.
- Toasts end mid-word ("Likely culprit: Distan…").
- Ctrl+A selects page text instead of sketch entities.
- Trim, Offset, Construction and Finish have no keys.
- The sketch rail's Select is the 14th Tab stop.
- The light-theme grid competes with 1 px sketch strokes.

**Polish.**

### Viewport, panels and Tweak

**I47 · On a phone, Measure hides what it measures.**

- In Build at 360 and 390, the "More view tools" flyout stays open over the Measure panel and hides Angle and Ø/R.
- In View the panel covers the bracket and the cube, the scale rule draws over its text, and the search bar reads "Search comma…".

**Major.** Fix: collapse the flyout once a tool is chosen. Use a bottom sheet with the model framed above it.

**I48 · Two of three demos never get an exact section.** Mounting Bracket and Heat Sink stay on "Preview · This cut can only be shown approximately.", with DXF disabled, while Pipe Flange shows "Exact". The message is the generic fallback in `sectionRefusalDetail`, while Measure reports the same parts as EXACT. **Medium.** Fix: find the kernel refusal and say why.

**I49 · A section cut looks like real geometry, and Build doesn't say it is on.** The cut face is drawn in the body's own colour, so cut fins read as shorter fins. Escape leaves the cut on, with only a lit rail button in Build, while View and Tweak show a chip. Section can be turned on in an empty project. **Medium.** Fix: hatch or tint the cut face, show the chip in Build too, and disable Section when there is nothing to cut.

**I50 · Smart measure of a hole edge reports its circumference.** The edge of a Ø6 hole gives "Hole edge Ø6 — 18.85 mm", and the Ø/R toggle has no effect. **Medium.** Fix: lead with Ø or R for a circular edge, and give the arc length as detail.

**I51 · Still open from the 12 November list: the phone Tools drawer and the Tweak sheet.**

- At 360 and 390, the Tools drawer comes back open across the stage after a reload.
- At 360×640, a tap on Projection lands on "Close Tweak panel", and the cube sits under the sheet.

**Medium.**

**I52 · The instrument rail is ordered differently in each mode, and X-ray has no button.**

- Build orders the rail Measure, Fit, Grid, Projection, Section, Display, Views.
- View and Tweak order it differently and have no Section.
- X-ray (Shift+X) has no button anywhere (**code**).
- The Display icon is the same cube as Box, and Section's knife reads as a brush.

**Medium.**

**I53 · A face drag past its limit still draws the refused shape.** Dragging the top face to 16 mm shows "⚠ Not built · Keep 4 mm", but the stage still shows the 16 mm plate merged into the boss in solid colour. **Medium.** Fix: ghost the refused volume or snap back, and mark the limit on the handle.

**I54 · Polish: viewport details.**

- Saved views can't be named, and typing in the saved-views flyout armed Sketch.
- In orthographic view the X axis and the grid end mid-stage, despite #1395.
- After pressing W three times the toast says "Wireframe" while the model shows Shaded + edges.
- The section slider steps to values like 17.775 mm.
- Measure shows two identical "80.00 mm" chips.
- The cube's arrow keys follow DOM order (Right from Front goes to Top).
- A stray Tab stop at (0, 0) is named with the whole top bar's text.
- At 360×640 the cube sits on the model.

**Polish.**

### Assemble

**I55 · Motion opens already in an error on a fully joined assembly.** On Scissors, the header's Motion button opens Set up motion with both blades preselected. It then shows "These components are already joined by Revolute 1.", and Create is disabled. **Major.** Fix: default to an unjoined part, or disable Motion with a reason; leave already-joined parts out of Moves.

**I56 · Assembly lengths always say "mm".** The labels are hard-coded in `assemblyUi.ts` `unitSymbol`, the Set up motion Range field and the timeline key editor. The gear card on the same panel uses the document unit. In an inch project, a "5 mm" slide may move 5 inches. **Major** (**code**; check with an inch fixture).

**I57 · "Motion" names three things, and playback is set four ways.**

- **Three meanings:**
  - the header's Motion button (create a joint drive);
  - the Motion section (keyframe studies called "Motion 1");
  - each joint row's Play button.
- **Four playback controls:**
  - joint details: a mode select and a Sweep time select;
  - Set up motion: a Speed select;
  - the timeline: a cycling icon plus "1×";
  - the View player: a Loop toggle.

**Medium.** Fix: distinct names, and one playback control used everywhere.

**I58 · Save position sits in one joint but saves every joint.** It appears inside Revolute 1's details while its tooltip says "Save where every joint is now". Position chips can't be renamed. **Medium.**

**I59 · With a study open, moving a part silently records a keyframe.** A typed joint angle is keyed at the playhead instead of changing the rest pose (**code**, `registerStudyPoseSink`). A new study opens with the playhead at the end and a single key, so Play does nothing. **Medium.** Fix: a "Recording keys at 2.00 s" banner while a study is open.

**I60 · First-run card: unticking the fixed body leaves nothing fixed.** The excluded row's pin still reads "Fixed" (**code**). After Add parts, the toast says "press J to join" while the panel's primary button says "Set up motion". **Medium.**

**I61 · Polish: Assemble details.**

- Unfixed pins are at 45 % opacity, and fixed versus not is shown by colour alone.
- The joint-type tiles wrap their hints unevenly.
- The Play↔Pause swap shifts the playback select by 12 px.
- The demo's joint is named "Revolute 1" rather than "Pivot".

**Polish.**

### Draw (code only)

**I62 · Sheets can't be reordered, duplicated or renamed from their tab.** The tab strip only selects tabs. The name field is hidden behind a toggle at 1100 px or narrower. New sheets are named `Sheet ${sheets.length + 1}`, so deleting Sheet 1 and adding one gives two sheets called "Sheet 2". **Major.** Fix: a tab menu with Rename, Duplicate, Move left/right and Delete; drag to reorder; and the next unused name.

**I63 · The title block's SHEET cell prints the paper size.** It shows "A3", and the sheet's own name and "1 of N" appear nowhere. Export works one sheet at a time. **Medium.** Fix: "2 / 3", the sheet name, and an Export all sheets option.

**I64 · Changing paper or orientation doesn't refit the views.** Going from A3 to A4 pushes views off the page, and export is then refused. **Medium.** Fix: refit as part of the same undoable step.

**I65 · Add view defaults to a second Front, dropped mid-sheet.** There is no detail-view tool, and the section tool has no keyboard path. **Medium.**

**I66 · Draw zoom differs from Build.** A plain wheel does nothing on a fitted sheet; zooming needs Ctrl+wheel. BOM rows show a hover fill but are not interactive. **Polish.**

### Settings, import and export

**I67 · Import and export dialogs ignore Enter.** Units, Export, Image export and Shapr have no form and no Enter handling (**code**). In the Units dialog, Enter on the focused radio does nothing. **Medium.**

**I68 · The workspace accepts dropped files under a modal.** With the Units dialog open for an STL, a STEP dropped on the stage imported behind it, and the next Escape cancelled the STL. **Medium.**

**I69 · Out-of-range settings clamp silently.**

- Field of view 500 becomes 90, and −3 becomes 15.
- Autosave delay 9999 becomes 60.
- No ranges are shown.

**Polish.**

**I70 · Polish: Settings and export layout.**

- At 390 px Settings has no search, and its 11 sections are unlabelled icons.
- Controls cards are 1040 px wide where other sections are 760.
- Export mesh scrolls internally at 390 with Cancel and Export below the fold.
- Width and Height don't line up in Export image.
- The drop overlay leaves out DXF and Shapr pairs.

**Polish.**

### Assistant

**I71 · Escape in the prompt permanently rejects a proposal.** With focus in the empty prompt, Escape marks the proposal "Rejected · Nothing was changed", and it can't be restored. **Medium.** Fix: Escape hides the preview or leaves the field, and Reject stays an explicit action, or offer Undo reject.

**I72 · Polish: assistant thread.**

- The recipe chips stay under every conversation.
- "Analyze selected geometry" and question-card answers look like plain text.
- The user's own message is half-clipped under the header when a reply lands.
- A minimal `{configured:false}` status crashed the panel into a 60 %-height error (mock only).

**Polish.**

### Account, cloud, sharing and encryption

**I73 · A share-link recipient's first screen looks broken.** After a good loading card, the top bar shows "Local only" (whose tooltip, "Saved on this device", is false), "Signed out" and "Offline". Nobody is named as the sender. "Make a copy" is an unlabelled rail icon, and the toast mentioning it is cut off. View and tweak links look identical. **Major.** Fix: a share-session top bar ("Shared model · Tweak only", with the owner or link name) and a labelled primary Make a copy.

**I74 · The conflict dialog can't be decided from what it shows, and "Decide later" is a dead end.** Both rows read "2:34:27 PM · 2 edits · 1 save points", yet Cloud is marked "Newer". The two names differ, but only one is shown. After Decide later, the Conflict chip is a readout: `saveChipActs` excludes it, and the account conflict is cleared. **Major.** Fix: name, relative time and what differs on each row; a Conflict chip that reopens the dialog; correct plural.

**I75 · "Encryption is on" while new projects are still created unencrypted.** Right after setup, Settings says "Encryption is on — Chrome on Linux can open and sign your encrypted projects", but "Encrypt new projects" defaults to off. **Major.** Fix: end setup with "Encrypt new projects?" defaulting on, plus an offer to encrypt existing projects; otherwise, change the headline to "Keys ready · projects not encrypted yet".

**I76 · Three long numbers all mean "verify me".**

- "Your fingerprint — People compare it to verify you."
- "Your contact code — Read it to people who verify you."
- "Project state code" in the project indicator.

The first two are different 40-digit numbers on the same page. **Major.** Fix: one named code per purpose, shown only in the flow that uses it.

**I77 · Sync and role reasons live only in `title` tooltips.**

- Touch and keyboard users can't learn why the chip says Offline or Local only.
- After a room refusal, the reason exists only in a tooltip.
- A viewer at 1440 px sees only a people icon; "Read-only" appears nowhere.
- Refusal toasts use a green dot.

**Medium.** Fix: chips open a small popover with the reason and the next step; keep the role label visible; give refusals a warning tone.

**I78 · Masked identity fields hide typos.** The sign-in email, the Share invite email and the delete dialog's "Type your email address to confirm" all show dots. A mismatch in the delete dialog only leaves the button disabled. **Medium.** Fix: mask only while the field is unfocused, and add a "doesn't match" message.

**I79 · An encrypted project's Share dialog opens on a red error banner.** The banner text is the Worker's format-gate 409, which suggests the dialog still makes a plaintext sharing call for an encrypted project. **Medium.** Fix: skip the plaintext calls, and present confirm-sharing as one clear action.

**I80 · Setup never says plainly what losing your keys costs.** Step 1 says "Nobody, including OpenZCAD, can recover it", but not that encrypted projects become unreadable. The clear sentence ("encrypted cloud data cannot be recovered, by you or by us" plus "Back up first") appears only under Encrypt existing projects. "I saved my recovery key" is a toggle switch. **Medium.** Fix: reuse that sentence at step 1, and make the acknowledgement a checkbox.

**I81 · The email-code step has no Resend, and its placeholder looks typed.** The only way out is Use another email. The placeholder "000000" looks like entered digits, and a wrong code stays in the field. **Medium.**

**I82 · Restore and Branch are hidden.** The save dialog promises "a save point you can restore or branch from later". Clicking a revision row does nothing, and the actions are hover-only icons. **Medium.** Fix: a row menu with labelled Restore and Branch into new project.

**I83 · Polish: device approval.** The new device says "open Settings › Encryption and scan it", but the unlocked device has no scan control. A locked device shows Remove next to the only certified device. **Polish.**

**I84 · Polish: delete-account dialog.** There is no "Download your data first" link and nothing about encryption keys. After a 500 it doesn't say whether anything was deleted. **Polish.**

**I85 · Polish: Make a copy differs by link type.** A plaintext link copies to the device. An encrypted link asks where to put the copy. **Polish.**

**I86 · Polish: Settings sign-in actions disagree.** Account offers only Retry, AI Assistant › Personal token has a Sign in button, and the start screen has Sign in. **Polish.**

**I87 · Polish: Revisions copy.** "Initial document · not stored" is explained only in a `title`. **Polish.**

---

## Rechecks of the 12 November review

**Still holding:**

- H1: typed digits go to the first dimension.
- H4: the hint shows in full at 1440.
- H7: a pick now shows a labelled selection rail.
- H9: one Tab stop per rail, with arrow keys inside.
- H10: start-screen gutters, the Scissors link and a single primary button.
- H11: Panel layout.
- H13: the plane prompt.
- H14: tour step 3 advances when History opens.
- H15: Troubleshooting is out of File.
- H16: the Box card clears the cube at 1440.

**Items on its "open after the fix PRs" list:**

| Item                                        | Now                                                     |
| ------------------------------------------- | ------------------------------------------------------- |
| Phone Tools drawer returns across the stage | Still open (I51)                                        |
| 30 px View, Tweak and Assemble rail buttons | Still open in View and Tweak; Assemble not checked (I1) |
| Tweak sheet at 360×640 covers the rail      | Still open (I51)                                        |
| Box card against the cube at 768 px, docked | **Worse:** it now covers the cube completely (I7)       |
| Real phone, Safari, Firefox, desktop shell  | Still untried                                           |

## Not covered — candidates for the next review

- Draw by hand: placing views, dimensions, sections, export.
- Assemble in the light theme, at 1024 and 390, and by keyboard; creating a joint by picks; the gear card; the View player.
- Booleans, Extrude, Revolve, Loft and Sweep cards; the Inspector; the unapplied-card dialog; the outcome of confirming Delete on a feature with dependents.
- Right-click on History rows, parameter rows and panel headers.
- Encrypted invitations, contact verification, passkeys, a full device-approval handshake, an encrypted share-link visitor.
- A screen-reader pass.

## What is already good — protect these

- **Start and library:** one primary action on the empty start screen and a friendly pre-filled name. Drag-to-folder with the name field focused in place. The 30-day trash stated on each tile. Tile menus with arrow keys and focus return.
- **Escape and refusals:** Escape cancels each Build card with a clear "X canceled; nothing was added." Sketch conflicts are refused with "no change was applied" rather than corrupting the sketch. Refusals suggest a value that builds.
- **Sketch input:** typed values while drawing, with Tab between width and height. The phone keypad has units. Greyed relations explain why. Profile counts and open-endpoint diagnostics name the fix.
- **History and Measure:** History summaries such as "Fillet 12 edges · r 2 mm", and the rollback banner with Resume. Measure's EXACT badges and two-step Escape.
- **Keyboard and focus:** one Tab stop per rail, visible focus rings, and tooltips on keyboard focus.
- **Settings:** every value persists across reload, and theme and density apply live. Keymap refusals name the command holding the key.
- **Export:** the mesh dialog explains each format and unit. Image export disables SVG and says why.
- **Defaults and proposals:** the assistant and analytics are off by default. Proposal cards keep a clear preview → applied or rejected lifecycle, with "undo reverses it".
- **Sharing and account:** SharePage error states are distinct, and Try again appears only when retrying can work. CloudDataDeletionDialog has an inventory, typed confirmation and careful focus. Sign-out offers "Keep unlocked / Remove device keys". The migration notes have "Back up first".
- **Draw (code):** the explicit model fence with Update, export refusals that name their reasons, and "Delete all broken" with Undo.
