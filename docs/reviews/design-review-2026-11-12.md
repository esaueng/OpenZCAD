# OpenZCAD design review — 12 November 2026

**Build reviewed:** a local production build of `main` at `da376162`, signed out, local projects only. The deployed site was not reviewed.

**How it was tested:** headless Chromium (SwiftShader) driven by Playwright, at 1440×900 in the dark and light themes, at 1024×768, and at 390×844 with touch. Covered: the start screen, the first-run tour, Box creation, face and edge selection, all five modes, the panels, the File menu, Settings and the command bar. Each finding was reproduced hands-on unless marked **code**.

**Harness caveats:** pointer input was synthetic, so orbit and drag latency were not judged. Frame times under SwiftShader are not feel. Not covered: signed-in, cloud and sharing flows, the assistant, drawing inside a sketch, drawing sheets, and the desktop shell.

**Follows up:** [the 11 October review](design-review-2026-10-11.md) (findings G1–G16). Two of its fixes were rechecked and hold: bodies keep a neutral colour with the preview hue reserved for previews (G2), and the command bar finds "fil" without a slash (G4). The findings below are numbered H1–H16.

---

## Findings — one per root cause

Format: **Where** · **What** · **Severity** · **Fix**.

**H1 · Typing a size into Box moves the camera.** `B` arms Box with a 30×18×24 preview, but focus sits on the command card, so digits fire the view shortcuts (`1` Front, `5` Back). `100 Tab 60 Tab 6 Enter`, the recipe the October review recorded as working, ended in "Box canceled; nothing was added." Through the Width chip, Tab went to the `mm` unit button rather than Depth. With a face selected, typing `5` goes straight into the distance field. **Major.** Fix: send digits to the first dimension while a create tool is armed; Tab cycles the dimensions.

**H2 · A creation preview outgrows the stage.** At width 100 the preview ran under the instrument rail and the Parameters panel, and the Depth and Width chips collided. **Major.** Fix: reframe when a creation preview leaves the visible stage; edits keep the camera.

**H3 · On a phone the workspace opens with the model mostly covered.** At 390×844 two double-column rails and a floating Parameters panel sat over the part, and the "Tools" label was clipped. **Major.** Fix: no panel open by default at phone width, single-column rails, the instrument rail collapsed.

**H4 · Hint and title text is truncated or stale.** The command bar doubles as the hint lane and cut its hint at 1440 px ("Click a body, face, or edge · Shift+Cli…"). Draw showed "Drag a view to place it…" before any sheet existed. The selection title truncated to "Mounting Bracket · Front fa…" with free space beside it. **Medium.**

**H5 · A temporary panel displaces a pinned one.** Opening History from the rail replaced Parameters, whose pin was lit, and its rail button went inactive. The "Temporary panel…" notice and its Pin button duplicated the header pin. **Medium.**

**H6 · The Tools drawer looks like a popover but does not dismiss like one.** It stayed open through outside clicks, Escape closed it only with focus inside, and it sat over the command bar's results. **Medium.** Fix: light-dismiss it, or dock it visibly.

**H7 · The left rail changes identity on selection.** The Build tools were swapped, in the same slot, for up to ten unlabelled "Selection: …" icons, while the tour said "Its tools stay in place whatever you pick." **Medium.**

**H8 · An empty project gives no invitation on the canvas.** Two panels showed empty lists and the stage was blank. **Medium.**

**H9 · Keyboard order reaches the Build tools late.** Tab passed 14 instrument-rail buttons and 7 view-cube buttons before Sketch. **Medium.** Fix: one tab stop per rail with arrow keys inside.

**H10 · Start screen.** The Projects block and "Learn by example" used different gutters; the Scissors card's link floated mid-card; two primary buttons showed in the empty state; the pre-filled name field read like search. **Polish.**

**H11 · "View options" holds panel layout presets,** not view options, and opened down to the screen edge. **Polish.**

**H12 · The parameter type selector renders as a bare "–",** and two were amber with no explanation. **Polish.**

**H13 · Sketch plane prompt.** A toast repeated the card's instruction, and the XY plane label read badly from the default view. **Polish.**

**H14 · Tour step 3 did not advance** when History was opened, although steps 1–2 advance on action. **Polish.**

**H15 · File menu "Troubleshooting"** put support exports in a primary menu. **Polish.**

**H16 · The Box card touched the view cube** at 1440 px. **Polish.**

## Where these findings are tracked

This document is historical evidence. Priority and delivery status live in [ROADMAP.md](../../ROADMAP.md), and each fix PR recorded its own evidence there.

| Findings               | Fix PR |
| ---------------------- | ------ |
| H8, H10, H14, H15      | #1374  |
| H1, H2, H16            | #1375  |
| H5, H11, H12           | #1376  |
| H4, H13                | #1377  |
| H6, H7, H9             | #1378  |
| H3                     | #1382  |
| Leftovers from the six | #1383  |

Three things the fixes changed that an owner may want to revisit:

- A temporary panel now shares the column with pinned panels. The earlier cover behaviour was deliberate and had its own smoke test, which #1376 rewrote.
- The Tools drawer stayed persistent and became a docked drawer; Escape on an idle workspace now closes it, and it stays closed (#1378).
- Tour step 3 leaves the moment History opens, taking its tips on reordering and rollback with it (#1374).

Two findings turned out differently from how the review described them:

- H13: the plane labels were not mirrored; they lay flat in the plane and were sheared by the view angle. They now face the camera. The prompt card was not moved, since its position was the October review's F10 fix.
- H12: amber means the parameter is unitless while every use of it expects one quantity.

Open after the fix PRs, as their authors reported:

- On a phone, a Tools drawer left open comes back across the stage.
- View, Tweak and Assemble rail buttons are 30 px on touch; making them 44 px needs a layout decision for Tweak.
- In Tweak at 360×640 the sheet covers the last button of the right rail.
- The Box card still overlaps the view cube in a 768 px window with a panel docked.
- Nothing was tried on a real phone, Safari, Firefox or the desktop shell.

## Failing tests the work surfaced

Three specs outside the CI smoke set were failing on `main` unnoticed:

- `command-action-contrast.spec.ts` (light theme): the test measured a transparent button fill as black. Fixed in #1377 with the threshold unchanged.
- `panel-dock.spec.ts` ("… Fit frames what is left"): a product bug. A retired highlight never finished fading, so the viewport kept redrawing a still scene. Fixed in #1382.
- `overlay-reach.spec.ts` ("UI-06"): open at the time of writing.

## What is already good — protect these

- **Text contrast.** A scan of visible text on the demo workspace found nothing under 5.5:1 in the dark theme and nothing under 5.2:1 in the light theme.
- **Tokens.** Nearly all of the roughly 650 font-size declarations use the seven type tokens, and raw hex colours appear 67 times across six stylesheets.
- **Surfaces that read well:** the light theme, Settings, the Assemble and Draw empty states, the File menu's grouping, the "Box 100 × 18 × 24 mm" history row, and the top bar collapsing at 1024 px.
