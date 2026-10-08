# Design-system review — 7 October 2026

A static review of the workspace's stylesheets and components at `dcfb517`.
It covers control sizes, selected/hover/focus states, motion, and theme-token
use. Unlike the [4 October polish pass](ui-polish-pass-2026-10-04.md), this one
was **not driven in a browser**. The environment could not install the pinned
Remus kernel, and it could not reach zcad.app. So every finding below comes
from reading the cascade (`styles/app.css` import order, with `quiet-stage.css`
and `target-size.css` last), and none of the sizes or contrast figures are
measured. Contrast figures are approximations computed from token hex values.
The PR's CI (`validate`, `e2e`) is the first execution of these changes.

The test at the end of each finding below says how the change is guarded.

## Landed

### Theme: chrome versus viewport tokens

| #   | Finding                                                                                                                                                                                                                                                          | Fix                                                                                              | Guard                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | The Move panel, the closed-profile Extrude card and the Move instruction drew a fixed dark `rgba(21–24, …)` background under themed headers, fields and buttons. In the light theme they rendered as dark cards with dark text in a lane of light cards.         | They now use the chrome surface, border and `--shadow-2`.                                        | `viewport-overlays.test.ts`: the dark-stage regex now covers any red channel under 40, and lane cards are pinned to a surface token. |
| T2  | The scale bar's canvas stroked with `--color-text`/`--color-accent` on the always-dark viewport, so in the light theme the rule went dark-on-dark under its light label.                                                                                         | It now uses the viewport text tokens and `--color-preselect`.                                    | `ViewportScaleIndicator.test.tsx` stubs the canvas and checks the stroke colours.                                                    |
| T3  | The Measure preview chip read `--color-text` and `--border-thin` on its dark stage.                                                                                                                                                                              | It now uses the viewport text and border tokens.                                                 | `view-mode.css` is added to the scanned overlay sheets.                                                                              |
| T4  | The validating pill, tool-card badge and assistant live states used `--color-preview` as text on chrome. It is the viewport's ghost green and is never re-themed, so on a light card it reads at about 1.9:1.                                                    | These now use `--color-success`.                                                                 | —                                                                                                                                    |
| T5  | Several fills and hovers on light cards were white washes (`rgba(255,255,255,…)`) that vanished in the light theme: tool-card phase, recovery, close and submode, keypad keys and field, the inspector's overflow menu, and the sketch rail's hover and keycaps. | These now use the surface tokens. The sketch keycaps also move from 10px text to the 11px floor. | —                                                                                                                                    |

### States

| #   | Finding                                                                                                                                                                                                                                     | Fix                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| S1  | On the Build, View, Tweak, sketch and instrument rails, the flyout tiles and the sketch relations, the `:hover:not(:disabled)` rule out-ranked `.active`. Pointing at the selected tool washed out its fill and looked like deselecting it. | Hover now skips `.active`, as the mode switch already did.                                                    |
| S2  | The Build rail's armed tool was drawn with an outline only. Every other rail's selected button is filled and outlined, and the outline alone was barely stronger than the primary-verb hint.                                                | The armed tool and its flyout tile now get the accent fill.                                                   |
| S3  | Hover and selected looked the same: Measure's mode tabs shared one rule, and the start screen's shelf tabs used neighbouring greys.                                                                                                         | Hover is now a neutral lift, and the accent marks the selection.                                              |
| S4  | Icon buttons (every panel close), the save and sharing chips, demo cards and revision actions set `outline: none` and showed focus with their hover style only. A focused part tile's ring was a 14%-alpha wash.                            | These now keep the base 2px accent outline. The topology pick rows on the dark stage use the viewport accent. |
| S5  | The instrument rail's hover was `--color-surface-2`, within a shade of the rail's own surface in the dark theme.                                                                                                                            | It now uses `--color-surface-hover` and `--radius-md` like the other rails.                                   |

### Motion

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                              | Fix                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| M1  | The entrance keyframes animated `transform`, which replaced the element's own transform. The View and Build rails are centred with `translateY(-50%)`, so on every mode switch they started half their height low and drifted up. `oz-pop` forced `translateX(-50%)` onto the section and views panels that the column layout re-anchors, so those panels opened half their width to the left and then snapped back. | The keyframes now use the independent `translate` and `scale` properties, which compose with the element's own transform. |
| M2  | The camera glides, view tweens, orbit and wheel smoothing, sketch inference and the sketch-recede fade checked only the in-app Reduce motion setting, which defaults off. The OS preference was ignored, even though the CSS honours it.                                                                                                                                                                             | Added `lib/reducedMotion.ts`, which checks both. `reducedMotion.test.ts` covers it.                                       |
| M3  | Dialogs opened with a 320ms overshooting spring from 90%, over a backdrop that fades in 100ms. The tool card used a raw `140ms ease-out`.                                                                                                                                                                                                                                                                            | Both now use the token duration and curve.                                                                                |
| M4  | Popovers didn't move the way they open. The views panel rose upward although it opens leftward, and the context menu rose although it hangs from the pointer. The overflow menu, part-tile menu and keypad had no entrance. The View bar entered from the right and left upward.                                                                                                                                     | Each now animates in a direction that matches its placement.                                                              |
| M5  | The sketch entry and exit glide took 800ms, longer than any view move.                                                                                                                                                                                                                                                                                                                                               | It now takes 520ms, the longest view glide.                                                                               |

### Sizes

| #   | Finding                                                                                                                                                                                                                                                                                            | Fix                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Z1  | The three top-bar islands were 40, 34 and 32px tall (the last was 36 below 1120px).                                                                                                                                                                                                                | All three now use `--topbar-island-h` (36px). The actions are 28px at every width. The count badges move from 9.5px to the 11px floor. |
| Z2  | Controls under the 24px floor: row visibility (20), edge-pick remove (22), search clear, account and update actions (20), assistant pending remove (16), toast action, section export, consumed toggle, callout recovery, and History's resume. Resume was also the app's only pill-shaped button. | These are now at least 24px.                                                                                                           |
| Z3  | The closed-profile action mixed 25px and 30px controls. The lane cards each hand-wrote the same 14/34px shadow.                                                                                                                                                                                    | Extrude now matches `.primary` and dismiss matches the panel close. The cards use `--shadow-2`.                                        |

Cleanup: about 300 lines of rules for the retired focused-sketch screen and the
old extrude controller fields were removed. No markup referenced them.

## Open after pass 1 (superseded by pass 2 below)

**Sizes**

- **The control scale.** The app uses heights of 16–36px in about ten steps. The proposal is 24 for compact controls, 28 by default and 32 for forms, with 30 reserved for rail buttons. Inputs are 30px with `--radius-sm` while buttons are 32px with `--radius-md`. That gap needs a lane-fit Playwright run before changing, so it is not changed here.
- **Rail widths.** The sketch-relations rail is 44px wide with 34px buttons and 15px icons. The instrument rail beside it is 40px, with 30px buttons and 16px icons (`quiet-stage.css` around 2091–2171, which also hard-codes `44px`/`78px` offsets). This needs `stage-reach.spec.ts` at 1024×600 and 844×390.
- **Same-group mixes.** Each of these groups mixes heights: the measurement dock (28/30/26/24/≈18), sharing dialog rows (20–28), the parameter add row (26/28), menu and flyout rows (≈26–32), and close buttons in one lane slot (24/25/26/28).
- **Icon sizes.** 224 `size=` props use 9 sizes. For close X icons alone, 11/12/13/14/18 are in use. The proposal is 12 in 24px controls, 14 in 28–32px controls, and 16 in rails.

**Theme**

- **Menus.** The context, overflow, start-tile and rail menus each have their own background, border, shadow, item height and danger colour.
- **Disabled opacity** takes 0.4, 0.45, 0.5 and 0.55. The rails also double-dim, and `.is-dim` (0.55) reads as disabled.
- **Destructive confirms.** The delete and cloud-deletion confirm buttons are `white` on `--color-error`, about 3.8:1 in the dark theme. Fixing this needs a new `--color-on-error` token or reuse of `.secondary.danger`.
- **Scroll shades** use `rgba(0,0,0,.35)`, which makes a grey band on light surfaces.
- **Eyebrow headings** use three styles beside `.panel-eyebrow`.

**Motion**

- **Selection callouts and measurement pills re-fade** each time their overlay group is rebuilt (an edge added, a highlight changed). Only the first appearance should animate (`ModelViewer.tsx` `clearGroup(context.overlayGroup)`).
- **Dialogs unmount in one frame.** They need the `useDelayedUnmount` exit the context menu and toasts have.
- **Layout properties are animated in four places:**
  - the history handle (`top`, 350ms)
  - the history spine fill (`height`)
  - progress bars (`width`)
  - the assistant panel (`max-height`)

  These should move to `transform`.

## Pass 2 (same day, after #612 merged)

The second pass was still static. This time a root-only `pnpm install` gave
local ESLint, TypeScript, Vitest and Prettier, so the stylesheet and theme
contract tests ran locally. The web package's own suites and Playwright
still ran only in CI.

The pass took on the first pass's open items and two new audits: one of
interaction flow (keyboard, focus and dismissal) and one of copy, icons and
type.

**Landed in pass 2**

- **Menus.** The context, inspector overflow and part-tile menus and the
  rail popovers now share one style:
  - surface background, strong border, `radius-md`, 4px padding and
    `--shadow-popover`
  - 28px items, muted until hovered
  - destructive items in `--color-error-text`
- **State tokens.**
  - `--opacity-disabled` (0.45) replaces the 0.4, 0.45, 0.5 and 0.55
    variants, and disabled rail controls no longer double-dim. `.is-dim`
    moves to 0.7 so it no longer reads as disabled.
  - `--color-danger-fill` and `--color-on-danger` give the destructive
    confirm buttons 4.8:1 contrast, pinned in `contrast.test.ts`.
  - `--color-scroll-shade` is now defined per theme.
- **Control groups.** The measurement dock, the sharing rows and the
  parameter add row each use one 28px height.
- **Rails.** The relations rail now uses `--rail-w`, with 30px buttons and
  16px icons. The instrument rail and View bar icons are 16px.
- **Icons.** Icon-only controls are 12px in 24px controls, 14px in 28px
  controls and 16px in rails. The X icon replaces the text "×" in three
  controls. The account dismiss button is now 24px.
- **Type.** The workspace eyebrows (flyout headings, sketch palette legends
  and sketch card labels) now share `.panel-eyebrow`'s type.
- **Copy.** "Export mesh…" and the circle modes are now sentence case.
  "Trash" replaces "recycle bin", and "Feature tools list" replaces the
  unshown "command card".
- **Motion.** The history knob moves by `transform` over 200ms, together
  with the fill. The assistant thread's `max-height` uses the base
  duration.
- **Flow.**
  - _Move entry._ Typing `-5` into Move produced +5, because a lone "-" was
    committed as 0. Covered by `DirectModelingOverlays.test.tsx`.
  - _Escape in dialogs._ Escape did nothing in a dialog once a disabled
    button had dropped focus to `<body>`. `useModalFocus` now hands that
    Escape to the dialog. Covered by `useModalFocus.test.tsx`.
  - _Escape in rename._ Escape in a measurement rename switched Measure off
    and lost the name. Covered by `MeasurementDock.test.tsx`.
  - _Project rename._ The project rename now stops its own Escape.
  - _Enter on a select._ Enter on a select now submits the Hole, Shell,
    Loft and Sweep cards. Covered by `ModelingOperationsForm.test.tsx`.
  - _Keypad._ Enter on a focused keypad chip now presses the chip.
  - _Project properties._ The dialog no longer closes when a text
    selection is dragged out of it.
  - _Sharing._ The sharing invite field has a focus mark again.

**Still open after pass 2**

- **Flow**
  - Create project, duplicate, delete-forever and empty-trash can each be
    submitted twice; StartScreen never receives the busy flag.
  - Inspector Create/Apply stays enabled during the exact rebuild. Only
    Extrude edit is guarded.
  - Sharing's Revoke and Remove happen on one click, and the dialog closes
    mid-request.
  - Seven confirms use `window.confirm()`, which embedded browsers answer
    with Cancel. They need a shared in-page confirm dialog.
  - Cloud deletion's type-to-confirm field never takes focus.
  - The part-tile menu has `role="menu"` but no arrow keys, and loses focus
    after an action.
  - The History find field drops focus on Escape.
  - Apply move is disabled with no stated reason.
  - Card footers put the primary button first; sketch cards and dialogs
    put it last. That needs a design decision.
  - Escape in the body colour picker commits instead of reverting.
- **Copy**
  - The direct-edit verbs are Title Case ("Edit Fillet", "Offset Face",
    "Resize Hole"). Changing them touches e2e selectors throughout.
  - Lengths in live HUDs and chips use 1-, 2- and 3-decimal precision, and
    angles 1 and 3.
  - The diameter glyph appears as both "⌀ " and "Ø".
  - File sizes have three formatters.
  - Shortcut hints sit in some aria-labels and not others.
  - The View bar uses native `title` tooltips instead of `<Tooltip>`.
- **Carried over from pass 1:**
  - the control-height scale (30px inputs beside 32px buttons)
  - the callout re-fade on overlay rebuilds
  - the dialog exit animation
  - progress bars animating `width`
