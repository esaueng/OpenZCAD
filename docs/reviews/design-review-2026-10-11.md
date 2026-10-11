# OpenZCAD design review — 11 October 2026

**Site reviewed:** https://zcad.app, signed out, local projects only, nothing shared.

**Deployed commit:** `a90f51ad` (PR #624) with Remus 2026.1.45 (kernel commit `a04b5c86`), read from `/build-meta.json` at the start and the end of the session. It is also `main`'s head. Nothing was deployed during the session.

**Goal judged against:** "An easy to use, simple yet powerful, intuitive, web-based CAD program."

**How it was tested:** the Claude Browser pane at an emulated 1280×800 in the dark theme. Layout was rechecked at 1024×768 and the chrome in the light theme (OS scheme emulated, Theme = System). Three local projects were used: _Plate_ (§1), _Bracket_ (§2 and the sketch, View, Tweak and export checks), and the _Mounting Bracket_ demo (§4). Each finding is marked **hands-on** (reproduced) or **code** (read in source). Where a finding names a cause, the source line is given.

**Harness caveats:** at 1440×900 the pane cropped its screenshots, so 1280×800 was the primary size. Synthetic drags carry no intermediate pointer moves, so orbit was not exercised by dragging. The view was turned with the rotate-view buttons instead. The `type` action inserts a literal tab character, so Tab was always sent as its own key. The Tweak rail's "Export STEP" button exports on one click, so one STEP file was downloaded inside the pane by accident. Wall-clock times were not measured, so interaction counts stand in for them.

**Follows up:** [the 1 October review](design-review-2026-10-01.md) (findings F1–F30). §3 records which of those findings now hold. The new findings below are numbered G1–G16, so the two sets never collide.

---

## 1. First five minutes — a 100×60×6 mm plate, two holes, one rounded edge

| Step           | What happened                                                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create "Plate" | The workspace opened with a four-step tour, which was read and finished. The tour opens only for the first project.                                                                                                                                                                                                                         |
| Box            | `B` armed Box. The lane said "Enter creates · Esc cancels", but **the card took 2–4 s to appear** on this first open (G16). Typed 100 Tab 60 Tab 6 Enter. The plate appeared and was auto-framed, and the toast said "Added box." **No ghost of the box was shown while typing** (G6).                                                      |
| Hole 1         | Hole tool, then a click on the top face. A ghost hole appeared **at the face centre, not where I clicked** (G7). The fields are now named "U · along −Y" and "V · along +X". Typed V = −40 and pressed Enter: the hole was drilled with one Enter.                                                                                          |
| Hole 2         | The same steps with V = 40. Clicking near the +X end again placed the ghost at the centre.                                                                                                                                                                                                                                                  |
| Fillet         | Fillet tool, then a click on the front top edge. The card listed "Front · Top edge" and the handle read "R 2 mm". Typed 7 (more than the 6 mm plate) and pressed Enter. The card answered "Fillet could not be created on 1 selected edge with radius 7. Try a smaller radius: radius 5.5 builds here." Typed 3 and the fillet was applied. |
| **Result**     | A finished part in about 14 interactions. Its one refusal was provoked on purpose, and its wording told me what to do.                                                                                                                                                                                                                      |

**Words that still made me stop:** "adjust the hole and check the exact result" (lane), "1 exact edge selected", "Radius change: Linear" with "End radius (blank = constant)", and "Sketch closed · sketch edits preserved." (shown after a sketch with no edits).

## 2. A real part, counted — the parametric bracket (F1's recipe)

What was built: parameter `width = 80` → Box `width`×40×5 → Box `width`×5×40 → Union → a 3 mm fillet on the inside corner → two through holes at V = `width/2-15` and `-(width/2-15)` → set `width = 120`, then 60 from Tweak mode.

| Tally                          | Count  | Notes                                                                                                                                                                                                                 |
| ------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clicks                         | ~18    | plus typed fields and 7 Enters                                                                                                                                                                                        |
| Fields retyped                 | 1      | `width` typed into the first Box before the parameter existed was refused: "Unknown identifier "width" in expression." with Create disabled. I had to cancel, define it in the Parameters panel, and start over (G5). |
| Camera moves I did not ask for | 0      | The second box stayed in frame.                                                                                                                                                                                       |
| Camera moves I had to make     | 2      | Two "rotate view" clicks to reach the inside edge. None of the presets is a back iso.                                                                                                                                 |
| Refusals or errors             | 0      |                                                                                                                                                                                                                       |
| Dead ends                      | 0      | Enter after picking both Union rows created the union.                                                                                                                                                                |
| **`width` 80 → 120 → 60**      | **ok** | Both boxes, the fillet and both holes follow, from the Parameters panel and from Tweak mode. **This was the 1 October blocker (F1). It now holds for a part built from primitives.**                                  |

A sketch on the flange face (a rectangle and Finish) followed by a −5 mm Extrude cut a window through the flange. The cut showed a live preview and a sentence under the disabled Create ("Enter a distance other than 0, or drag the arrow…"). After Create, **the whole part turned the same mint as the preview** (G2), and a "Box 1 · 120 × 40 × 40 mm · Move · Mirror" callout and a "Total −5 mm" handle stayed up (G15).

## 3. Status of the 1 October findings (checked on `a90f51ad`)

| ID  | Status                   | Evidence this session                                                                                                     |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| F1  | **fixed**                | §2: width 80 → 120 → 60 on Box+Box+Union+Fillet+Hole+Hole.                                                                |
| F2  | **fixed**                | Del on Box with dependents opens "Delete "Box"? 4 later features build on it… Undo brings everything back." Cancel works. |
| F3  | mostly fixed             | Ghost hole and axis names are present. The click position is ignored, and U maps to −Y (G7).                              |
| F4  | **fixed**                | Enter after two Union row clicks created the union.                                                                       |
| F5  | fixed                    | No stale chip or lane text in the new Bracket project after the Plate fillet.                                             |
| F7  | hint fixed               | Radius 7 on a 6 mm plate → "radius 5.5 builds here". The preview handle still reads "R 7 mm" untinted before Create.      |
| F8  | fixed (per decision)     | Picked face: light tint and an accent outline; the rest dims.                                                             |
| F9  | **fixed**                | The Hole card scrolls inside the column and keeps Create/Cancel pinned at 800 px.                                         |
| F10 | **fixed**                | "Pick a sketch plane" renders in the command slot under the top bar.                                                      |
| F11 | improved                 | A face pick in Hole shows one tag. After an Extrude Create, a callout, a handle and the lane still appear together (G15). |
| F12 | unchanged (by decision)  | Orbit is Shift+left-drag, listed in the shortcut overlay.                                                                 |
| F13 | **fixed**                | Measure sits on the Build rail.                                                                                           |
| F14 | **fixed**                | A single "Create hole".                                                                                                   |
| F17 | **fixed**                | Zero-distance Extrude explains itself under the field.                                                                    |
| F18 | partly                   | Bodies are numbered and faces are named by feature ("Box 1 · top"). The surfaces still disagree (G9).                     |
| F20 | **changed, new problem** | Suppress is no longer silent; it is now refused, with an unreadable message (G1).                                         |
| F22 | partly                   | "+11" counters are gone; "exact" jargon remains (G11).                                                                    |
| F23 | improved                 | Demo workspace: 0 of 154 visible controls unnamed, 10 under 24 px (was 36) (G14).                                         |
| F25 | **fixed**                | With Theme = System and a light OS scheme, the workspace chrome is light.                                                 |
| F26 | fixed                    | Escape closes the File menu.                                                                                              |
| F29 | fixed                    | The second bracket box stayed in frame.                                                                                   |
| F30 | **fixed**                | The Fillet card lists the picked edges by name, each with a remove button.                                                |

Not re-tested: F6 (needs a deploy mid-session), F15, F16, F19, F21, F24 (a real `?` keypress did not reach the app from the harness; a dispatched `?` opened the overlay), F27, F28.

## 4. The demo — Mounting Bracket, 17 features, 9 parameters

The demo opens to a view where the wall hides the boss and its bore. Suppressing **Boss** with the row's eye icon is now **refused**: a lane line appears for about five seconds and is cut off at "Transfor…". The full text, read from the DOM, is one 640-character sentence:

> Cannot suppress "Boss". Dependent features cannot rebuild: "Place boss on wall": Transform target is unavailable.; "Union boss": Boolean target body_fcbbf6c2-0b07-4ba9-b17f-d08f7cee134a is unavailable.; … "Wall top edge break": Edge modifier target is unavailable.

A failure record is also filed under the wrong feature: "Edit not saved · Place boss on wall … Edit Place boss on wall". The history row's right-click menu offers only "Edit properties" and "Delete". Suppress and roll-back exist only as hover icons.

---

## Findings — one per root cause

Format: **Where** · **What** (in the user's words) · **Severity** · **Fix** · **Evidence**.

**G1 · Suppressing a used feature is refused in a sentence nobody can read.** This was hit on the demo's Boss, and it applies to any primitive that later features consume. "I clicked the eye and a grey line flashed something about body_fcbbf6c2." **Major.** Fix: treat suppress like delete. Open a dialog: "Boss is used by 6 later features. Suppress them too · Cancel". Keep raw body ids out of user text (they come from `packages/kernel-adapter/src/exact-feature-builders.ts:1329` through `apps/web/src/lib/featureSuppression.ts:41`). File the failure under the feature the user acted on, not the first dependent. Hands-on and code.

**G2 · The body colour changes with the last operation and matches the preview.** The Plate went gold → orange after Hole. The Bracket went orange → mint after the Extrude cut, the same hue as the Extrude preview a moment earlier (`featureColor`, `packages/shared/src/index.ts:3311`). "Did it apply, or is it still previewing?" **Major.** Fix: give bodies one neutral colour (or a user-set colour per body), keep the feature-kind colour for history icons, and reserve the preview hue for previews only. Hands-on.

**G3 · Fit (F) resets the view direction and ignores the drawer.** At 1024×768 with the drawer open, F turned the camera back to the front iso and framed the part against the full canvas, so half of it sat under the drawer. `computeFitPose` is called with no direction (`apps/web/src/components/ModelViewer.tsx:11272`), and its comment says Fit "lands on the home orientation". "I pressed fit and lost the side I was working on." **Major.** Fix: keep the current direction (`4` and the iso preset already give home), and frame to the stage rectangle that the column and drawer leave clear. Hands-on and code.

**G4 · The command bar swallows plain words when the assistant is unavailable.** Signed out, typing "fil" and pressing Enter does nothing. Only "/fil" finds Fillet (`apps/web/src/components/CommandBar.tsx:268`). "The search box doesn't search." **Major** for first-time users, who type words, not slashes. Fix: with no assistant, treat plain text as a command search. Hands-on and code.

**G5 · A parameter cannot be defined where it is first used.** Typing `width` into the Box card gives "Unknown identifier "width" in expression." and disables Create (`packages/document-core/src/index.ts:4180`). **Minor.** Fix: offer "Define width = 80 ↵" inline, and create the parameter with the feature. Hands-on.

**G6 · Box and Cylinder show nothing until Create.** Hole, Fillet and Extrude all preview; the primitive cards do not. "I typed 100, 60, 6 and had to trust it." **Minor.** Fix: ghost the primitive at its corner/centre while the card is open. Hands-on (Box).

**G7 · A Hole face click does not place the hole.** The ghost always starts at the face centre. On a top face the first field (U) runs along −Y, so the 100 mm direction is the second field. **Minor.** Fix: let the pick point set U/V, and order the fields X then Y wherever the face allows. Hands-on.

**G8 · Two command-card designs.** Extrude has an icon, a "Ready" badge, a subtitle and a small ×. Box, Hole, Fillet and Union use a "NEW FEATURE" eyebrow and a boxed ×. Extrude also offers three ways to flip direction: a "Reverse direction" button, a negative distance, and a "Distance…" button whose purpose is unclear. **Minor.** Fix: one header component, and a signed distance with one flip control. Hands-on.

**G9 · Names disagree across surfaces.** The Hole face list says "Box 1 · top", while the viewport tag on the same face says "Box 1 · Top face". After a Union the list mixes "Box 2 · back" with unattributed "Bottom face" and "Front face". History rows and the delete dialog read "Hole, Hole". The merged bracket is "Box 1" in Parts and in the callout. **Minor.** Fix: one formatter for face names, number repeated feature names at creation ("Hole 2"), and name a union result after the union. Hands-on.

**G10 · The history right-click menu is thinner than the row.** It offers Edit properties and Delete only. Suppress and roll-back are hover icons, although the tour says "right-click a row for actions". **Minor.** Fix: put Suppress, Roll back to here and Rename in the menu. Hands-on.

**G11 · Copy that is wrong or redundant.** "Parameter width updated." appears when a parameter is created. "Sketch closed · sketch edits preserved." appears after an empty sketch. The Fillet lane says "Click edges with Shift…" although a plain click picks. The Union card says "numbered in the viewport" before any number is shown. Tweak mode says "the design stays locked" three times. "check the exact result" and "1 exact edge selected" remain. **Polish.** Hands-on.

**G12 · The scale bar changes with no camera move.** It went from 50 mm to 20 mm on a face pick. It is measured at the orbit pivot (`ModelViewer.tsx:8507`), and a pick appears to move the pivot. **Polish.** The cause is suspected. Fix: measure at the view centre's depth on the model, or keep the pivot fixed on a pick.

**G13 · The command palette lists Fillet twice** ("Edges & faces" and "Feature"). **Polish.** Hands-on.

**G14 · The remaining small targets:** drawer section headers are 14 px tall, the cube's corner buttons are 17×21, and parameter-name buttons are 19 px tall. **Polish.** Hands-on (measured).

**G15 · Create leaves three surfaces up.** After an Extrude cut: the body callout (with Move and Mirror), a "Total −5 mm" face handle, and a lane line cut off at "Esc clea…" at 1280 px. **Minor.** Fix: after Create, select the new feature's result quietly; show the handle only on a pick. Hands-on.

**G16 · The first tool open after load shows its lane prompt 2–4 s before its card.** "Enter creates" appeared with nothing to create. **Polish.** Fix: prefetch the ToolCard chunk when idle, or show a skeleton card. Hands-on (a single observation; it did not recur).

## Where these findings are tracked

This document is historical evidence. Priority and delivery status for the findings live in [ROADMAP.md](../../ROADMAP.md), and each fix PR records its evidence under a master row there. The ranked list and the top five below show how the review saw priorities on 11 October; they are not a work queue.

| Findings     | Fix PR | ROADMAP row         |
| ------------ | ------ | ------------------- |
| G1, G10      | #630   | U02                 |
| G2, G15      | #633   | U04                 |
| G3, G12      | #631   | recorded by that PR |
| G4, G13      | #628   | U04                 |
| G5           | #635   | recorded by that PR |
| G6, G7       | #629   | U01                 |
| G8, G14, G16 | #634   | U03                 |
| G9, G11      | #632   | U02                 |

## Ranked list with rough sizes (as of the review)

1. G1 suppress refusal: hours (dialog with "suppress dependents too", plain text, correct attribution)
2. G2 body colour equals preview colour: hours, plus a palette decision
3. G4 command bar dead end when signed out: hours
4. G3 Fit resets direction and ignores the drawer: hours
5. G5 inline parameter definition: about a day
6. G7, G6 hole placement by click, primitive ghosts: about a day
7. G15, G8, G9, G10: hours each
8. G11–G14, G16 polish: under an hour each

## Top five changes to make next (as of the review)

1. Make suppress behave like delete: one dialog, the dependents named, an option to suppress them too, and no internal ids in the text (G1).
2. Stop recolouring the part per operation, so the preview hue only ever means "preview" (G2).
3. Make the command bar search commands when the assistant is unavailable (G4).
4. Fit keeps the current direction and frames the visible stage (G3).
5. Let `width` be defined from the field that first uses it (G5).

## What is already good — protect these

- **The parametric promise now holds** on a part built from primitives: one number drives boxes, the fillet and both holes, from Build and from Tweak.
- **Refusals that teach:** the fillet hint now names a radius that builds, and the zero-distance Extrude explains itself.
- **Delete is safe and honest:** it names the dependents and offers Undo.
- **Cards fit:** tall cards scroll with their actions pinned, and the sketch-plane chooser sits in the command slot.
- **Accessible names:** every visible control in the demo workspace has a name.

## Does it read as a simple, powerful, intuitive CAD tool today?

Closer than on 1 October. The two blockers from then (F1 parametrics, F2 silent delete) are fixed. A first-time user can now build, parameterise, cut and export a bracket without a dead end. What remains is mostly the app not telling the truth clearly enough. The part changes colour like a preview, Fit forgets where you were looking, the search box ignores words, and the one hard refusal left (suppress) speaks in body ids. Each of these is hours of work, and none needs the kernel.
