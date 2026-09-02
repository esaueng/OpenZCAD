# Reference CAD interaction — frame analysis of the 2026-09-01 screen recording

An interaction-design reference for OpenZCAD, derived from a 10-minute recording of a commercial direct-modelling CAD application for
macOS. Every claim carries a timestamp and a frame number; every inferred mechanism is labelled
*inference*. Frame numbers `fN` refer to a constant-60 fps working copy (`t = N / 60 s`); one frame
is 16.7 ms. The source is variable-rate, so every count carries ±1 frame of inherent uncertainty.
Colours are described by function only.

Method: eleven independent frame-stepping passes (nine time segments, one camera pass, one
hover/motion pass), each reporting per-gesture frame numbers with evidence sheets, then
cross-checked against each other and spot-verified on the frames by hand. Where passes disagreed the
disagreement is stated, not averaged.

---

## 1. Recording facts

| Item | Value |
| --- | --- |
| Source | `Screen Recording 2026-09-01 at 7.40.49 PM.mov`, macOS screen recording, H.264 |
| Resolution | 4096 × 2304 |
| Frame rate | nominal 60 fps, variable; 36,017 frames in 625.48 s (mean 57.6 fps) |
| Working copy | resampled to constant 60 fps at 1280 × 720. A duplicated frame appears roughly every 25; two passes independently noticed a small (≤0.5 mean-abs-diff) encoder artefact on every 12th frame, which is not UI motion. |
| Length | 10 min 25 s |
| Software | A commercial direct-modelling CAD application for macOS (name withheld). Layout: adaptive tool rail left, Items list top-left, History panel right, hint card top-centre, status pill bottom-centre, view cube and Display Modes top-right. Version not shown. |
| Input | Not visible. Evidence in §E says all camera moves are trackpad gestures. Clicks are visible as a thin white ring that contracts at the pointer over 4–8 frames on pointer-down. |
| Project | title bar `Untitled Project`, renamed to `Test Handle v1` at 05:58.6 |

### What the user does

| Time | Task |
| --- | --- |
| 00:00–00:04 | Project browser; opens a new design (blur-dissolve 19 f, black loading 27 f, workspace at f258) |
| 00:08–00:10 | Sketch tool → plane picker (three datum quads) → picks XY; camera glides to Top in 20 f |
| 00:26–01:16 | Lines with live dimensions, integer-mm snap, Offset Edge for wall thickness, closing segments |
| 01:18–01:21 | Orbits inside the sketch (sketch stays active) |
| 01:31–01:38 | Clicks the L region: Extrude arms at `0 mm`; drags 7.2 mm in 11 f; retypes 5 via keypad |
| 01:42–02:13 | Face click arms Offset Face; Sketch on a face (733 ms glide to ortho); two rectangles; both regions extruded from one handle |
| 02:31–02:43 | Exits Sketch 03 (camera cut + 15 f settle); pushes two circle regions into the legs: `−4.1 mm` |
| 02:44–03:59 | Orbits; Chamfer 01/02 and Fillet 01/02 on the staple body |
| 04:18–04:21 | One 143-frame fillet drag that crosses zero and is refused: `Configuration of edges at vertex too complicated.` |
| 04:23–04:53 | Fillets set by keypad; long orbits and zooms |
| 05:06–05:25 | Sketch 04 on the top face: Text tool, `esau.co`, Transform Text gizmo, Done |
| 05:27–05:42 | Seven glyph regions picked one click each; one 7 s push to `−0.3 mm` (engrave) |
| 06:11–06:52 | History row expanded, Distance parameter typed `-.5` (no preview) and committed; Display Modes tour (11 single-frame switches) |
| 06:56–07:06 | Sketch 01 opened for edit from the Items list; dimension keypad opened and abandoned |
| 07:15–07:45 | Face → body double-click; Mirror (plane pick, green ghost, Done) twice → four bodies; gizmo drags typed to 25 mm |
| 08:10–08:12 | Offset Face on a leg wall, 6 → 8.4 mm total |
| 08:14–08:22 | Sketch on the ground plane (817 ms auto-orient), rectangle drag, extruded 7.9 mm |
| 08:24–08:38 | Seven edge clicks; one 7.3 s fillet drag rebuilding every frame |
| 08:58–09:12 | Face click, glide to face-on (567 ms), circle `⌀ 4 mm`, hole cut in one flick |
| 09:16–09:52 | `Copy` toggle in the gizmo HUD; copy-drags; `⌘U` Union twice |
| 10:07–10:16 | Fillet refused: `Operation failed because the resulting body wouldn't be valid.` (sticky 8.9 s) |
| 10:10–10:25 | Interior faces selected → owning body renders X-ray; final orbits |

---

## 2. Executive summary

1. **State changes never animate; only chrome does.** Hover, selection, deselection, gizmo appearance,
   geometry commit, tool-rail swaps, popovers and display-mode switches are all single-frame cuts
   (f4875 hover on, f5497 select + gizmo, f5862 keypad commit, f23459 shader switch, f26551 mirror
   commit). Panels, cards and the keypad animate over 83–420 ms. There is no in-between.
2. **The real B-rep is rebuilt on every drag frame; no proxy, no pop on release.** Extrude 01:32.80
   (f5568, walls shaded at 0.7 mm on the first frame), hole cut 02:39.50 (f9570), fillet on 7 edges
   08:30–08:38 (f30699→f30707 morphs smoothly), fillet 04:18 (radius changes on consecutive frames
   f15533–f15537). Release frames show no shading or silhouette change.
3. **Pointer-down to first geometry motion is one frame (17 ms)** for extrude (f5567→f5568), the
   rectangle (f29868→f29869), the extrude of a fresh sketch (f30029→f30030), and the move gizmo
   (f26675→f26676). Chamfer/Fillet adds a 7-frame (117 ms) drag dead-zone before engaging (f11825→f11832).
4. **Selection is the affordance.** Hover shows an outline (faces) or an orange fill (sketch regions)
   and never a handle. Clicking a sketch region arms Extrude and places a double-headed arrow **at the
   pick point** (5 px from the pointer, ~180 px from the centroid, f5497); clicking a solid face arms
   Offset Face (f6170); double-clicking promotes face → body and arms Move/Rotate (f26152→f26158, 100 ms).
5. **Cut versus add is decided only by drag direction.** The same `Extrude - One-Sided (E)` tool, the
   same arrow; the chip carries the sign (`−2.7 mm` at f9571, `−0.1 mm` at f20097) and the arrow
   becomes single-headed once the value is negative.
6. **Values are model-space projections, not pixel gains, and are unsnapped.** 17.5 px/mm at 01:33 versus
   9.9 px/mm at 02:10 for the same handle; chips run 0.7 → 4.1 → 6.9 → 7.2 mm and 1 → 2.9 → 6.9 → 11 →
   16.7 mm with 0.1 mm resolution and no detents. Sketch lines are the exception: they snap to whole mm
   with a magenta endpoint (f1647 `18 mm`).
7. **Refusals never touch the model.** Past zero at 04:19.53 (f15572) the fillet handle keeps tracking,
   the chip detaches onto a dashed leader and drops its `R`, the body stays sharp, and one plain
   sentence replaces the hint card (`Configuration of edges at vertex too complicated.`, f15575–f15660),
   clearing on the first buildable frame. At 10:07.67 a second refusal stays 8.9 s until replaced.
8. **Camera moves are direct and end within 200 ms.** No ease-in anywhere. Strokes either stop within
   one frame (f4782→f4783, f35822→f35823) or decay over 10–12 frames at ~0.8×/frame (f6115→f6126,
   f28266→f28278); nothing longer. Orbit and zoom are anchored on the point under the pointer.
9. **Animated view jumps are commands, not gestures**: plane pick → Top 20 f (333 ms, f616–f636);
   Sketch on a face 44 f (733 ms, f6200–f6243); Exit Sketching 15–28 f with the largest change in the
   first frame (f9070, f7551); face-on glide 34 f (567 ms, f32662–f32696). No view-cube click occurs.
10. **The chrome states the selection continuously.** The status pill reads `2 faces │ prj 0 mm │ min
    37.2173 mm ΔX… ` (02:38) or `8 edges ∿ 172 mm` (03:10) and morphs width over 10–22 frames about a
    fixed centre; the tool rail's second row echoes the count; History filters to `Related to Selection`.

---

## A. Gesture inventory

| Gesture | Input (inferred) | Target | Immediate feedback | During drag | On release | Cancel | Frequency |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hover | pointer move | face / edge / sketch region / rail row | same frame: face boundary strokes cyan with a faint fill (f12172, f14409); edge strokes cyan (f30314); closed sketch region fills orange (f4875); rail tile and label lighten (f513) | recomputed every rendered frame, also during camera motion (f4875/f4895 while orbiting) | — | move off: same frame, no fade (f4895); neighbour swap passes one blank frame (f9432) | constant |
| Click select | press + release, no modifier | face, edge, region, body (via double-click) | white ring contracts at pointer-down over 4–8 f (f199–f207); commit on pointer-up, styling 1–4 f later (f9449→f9453) | — | face fills cyan + arms Offset Face + gizmo + status pill + hint card in one frame (f6170); second click within 6–11 f promotes to body + Move/Rotate (f26158) | click empty canvas (f26903), `Deselect All ⇧⌘A`, or a tool commit | ~60 |
| Additive select | further plain clicks | same kind | each add is one frame (f14436, f14444, f14457) | — | count in pill and rail (`3 edges` → `7 edges`) | different-kind pick replaces (f15491, one sample) | ~30 |
| Extrude / push-pull drag | press on double-headed arrow at the pick point | selected region(s) or fresh extrusion faces | grab ring on the handle 7 f before press (f5560); geometry moves +1 f after press (f5568) | exact solid every frame; rotated chip on the dashed axis near the extent midpoint; sign by direction | geometry static; handle, chip and axis stay live until deselect (23 f later at f9828, 14 f at f5876) | Esc not observed | 6 |
| Offset Face drag | press on the face arrow | solid face | `Total ⌄` + `6 mm` chip at arm (f26152); rail collapses to 3 rows during the drag (f29443) | live rebuild (wedge faces crisp at f29441); chip `7.9 → 9.4 → 11 → 12 mm`, then back to `8.4` | tint returns, chip reverts to `Total ⌄ 8.4 mm` (f29517) | — | 2 |
| Chamfer/Fillet drag | press on the arrow placed on the edge | selected edges | press ring; 7-frame dead zone; geometry pops to a non-zero radius (f11832) | exact blend every frame; `Fillet ⌄` mode pill hides; chip `R1.9 mm`, `R0.5 mm` | commits and clears selection in ≤2 f (f12071); post-release gear + oval handle appear +2 f (f15673) | — | 5 |
| Move/Rotate gizmo drag | hover an axis arrow (turns blue, `0 mm` chip + `Copy` inline), press, drag | body / bodies | live body moves +1 f (f26676); dashed guide from an RGB origin triad | continuous 0.1 mm chip; overlap regions render translucent | body stays selected; gizmo, chip, guide persist for editing | click empty canvas | 6 |
| Copy toggle | click `Copy` pill in the gizmo HUD | — | 2-frame ripple; pill flips blue on pointer-up (+5 f, f33484); toast `Copy ON` 119 f (1.98 s) | copy-drag leaves the white original behind +5 f after press (f33509) | toggle resets silently after commit (no `Copy OFF`) | — | 2 |
| Mirror | rail `Mirror`, click a datum plane, `Done` | selected bodies | rail becomes `Keep Originals / On` + `Cancel` in one frame (f26356); three grey planes; body badges | plane tints purple, `Done` row inserted, green translucent evaluated ghost (f26450); survives orbit | preview → final in one frame, selection cleared (f26551) | `Cancel` | 2 |
| Union | `⌘U` on 2–3 selected bodies | bodies | card `Union (⌘ U) / Select intersecting bodies to unite` fades in 7 f | — | merged 39 f (650 ms) after the keypress (f34494); selection consumed | — | 2 |
| Value chip tap → keypad | click the chip | any live value | keypad scales out of the chip over 7–15 f (117–250 ms), value pre-selected | typing replaces; preview on keystroke seen for fillet (f17531), not for extrude (kp2 at 01:37.35) nor History fields | commit 1 f: keypad gone and geometry at the new value in the same frame (f5862, f26883) | dismiss 1 f (f25336) | 7 |
| Sketch Line | click, click (chained) | plane | commit on pointer-up; rubber band + live dimension +3 f (f1585) | 4-dp chip every frame; whole-mm snap (`18 mm`, magenta dot) | segment committed, dimension removed in 1 f (f2240); next segment starts | Return / Esc / Delete per banner | ~10 |
| Sketch Rectangle / Circle | press-drag | plane | shape at +1 f (f29869); circle chip +1 f, arc +3 f (f32808, f32810) | two live chips (rectangle) / `⌀ 4 mm` (circle); corner lags pointer ~2 f on fast moves | orange → blue committed curve in 1 f (f32827) | Return | 4 |
| Camera orbit / pan / zoom | trackpad gesture (pointer stays within ~30 px) | canvas | first frame carries full motion (f4714, f31164) | 1:1 tracking; green ring at the pointer for the gesture's duration | stop in 1 f or decay ≤12 f | — | ~120 |
| Animated view jump | plane pick / Sketch on face / Exit Sketching / face-on command | camera | starts +1 f after the click (f614→f616) | 15–60 frames, see §E | exact landing, no wobble | — | 8 |

---

## B. Direct manipulation, in depth

### B1. Extrude / push-pull of a sketch region

- **Affordance.** Hover over a closed region fills it orange (f4875). Clicking it (f5497, 01:31.617)
  changes the fill to a brighter selected orange and, in the same frame, draws the whole gizmo: a
  blue double-headed arrow **at the pick point** (pointer at proxy (673,471) → arrow at (673,466);
  the region's centroid is ~180 px away), a smaller horizontal double-arrow 15 px outboard (draft
  angle), a round boolean-mode badge 13 px further when the extrusion meets an existing body
  (f7776), a dashed axis through the anchor in both directions, and the value chip `0 mm`. The gizmo
  is a screen-space billboard at constant size. The sketch plane and grid drop 6 frames later
  (f5503); the hint card `Extrude - One-Sided (E) / Drag arrows to extrude and add draft angle`
  fades in at +13 to +17 frames.
- **Latency.** A grab ring appears on the handle 7 frames before the press (f5560). Press f5567 →
  first geometry f5568: **1 frame**. The drag ran 11 frames (183 ms) to 7.2 mm; motion magnitudes
  11.4 / 16.6 / 5.8 / 2.3 / 2.1 / 0.8 / 1.5 are a decelerating hand, not an animation (verified: the
  cursor ring moves with the arrow on every frame of `seq/B_drag`). Settle: geometry constant from
  f5579; release is not distinguishable from a held pointer.
- **Continuity.** At 0.7 mm (f5568) the walls are already shaded with a crisp silhouette; the sketch
  curves stay drawn on the moving top face; the L's inner corner is mitred correctly at every
  intermediate height. No wireframe, no ghost, no shading change at settle. *Inference: exact
  kernel rebuild per pointer event* — evidence above, repeated for the hole cut (f9570: pocket with
  shaded cylindrical wall and bottom on the first frame) and the engrave (f20097: seven glyph
  regions gain recess walls in one frame).
- **Value display.** Chip text is **rotated to run along the extrusion axis**. At 0 mm the chip
  stands ~51 px outboard of the arrow; during and after a drag it sits on the dashed axis within
  ~8 px of the extent's midpoint (base (605,620), handle (613,453), chip (608,550) at 01:33.0).
  One decimal, mm, explicit sign. Values 0.7 / 4.1 / 6.9 / 7.2; later 3.6, 8.1, −2.7 → −4.4 → −4.1.
  **No snap detents.** Same handle: 126 px for 7.2 mm at 01:33 (17.5 px/mm), ~80 px for 8.1 mm at
  02:10.6 (9.9 px/mm) → *inference: the pointer ray is projected onto the axis in model space, so
  mm-per-pixel scales with zoom and view angle.* The hole cut starts at `−2.7 mm` on its first
  preview frame after a 15–18 px dead zone (f9570): the value is the pointer's absolute projection
  measured from the region's plane, not a delta from the press.
- **Typing mid-operation.** Click the chip (pointer over it thickens its blue border, 01:36.00) →
  keypad panel anchored at the chip, screen-aligned, pre-filled `3.6` fully selected; rows `( ) mm cm
  m deg`, `7 8 9 ÷ ⌫`, `4 5 6 ×`, `1 2 3 −`, `± 0 . +`, tall blue `✓`, a variable button and a
  keyboard-toggle button. Opens over 12–15 frames (200–250 ms) by unfolding from the chip's corner;
  typing does **not** preview (field `5`, model still 3.6 mm, 01:37.35); commit is one frame with
  keypad gone and geometry at the new height together (f5862); close is 1–2 frames, never the open
  reversed.
- **Direction and sign.** Double-headed arrow at zero; a negative drag reads `−x mm` and the arrow
  becomes single-headed pointing into the body (compare 05:34.80 vs 05:35.05). Cutting is the same
  tool: the banner still reads `Extrude - One-Sided (E)` at 09:10.4 while a hole is being cut. A
  through-cut never occurs (the deepest cut is −4.1 mm into a much deeper leg).
- **Two regions, one handle.** With two regions selected each carries its own arrow (f7776); dragging
  one grows both in the same frame by the same value (f7796); only the grabbed handle keeps a chip.
- **Adjacent geometry.** New side walls appear in the neutral material; only the moving face carries
  the cyan tint; neighbouring faces do not flash or re-tessellate visibly (02:10.6). Post-release the
  operation stays open — handle, chip and axis persist until a click on empty canvas (f5876 14 f
  later; f9828 23 f later).

### B2. Offset Face (solid face push/pull)

- A single click on a solid face arms it in one frame (f6170, f26152): translucent cyan fill, a
  dashed axis with teardrop end markers, a mode pill `Total ⌄` and the chip `6 mm` (the current
  wall dimension — the value is absolute, not a delta). Banner `Offset Face / Drag the arrow to
  offset the faces inward or outward` (no hotkey shown).
- Drag 08:10.57–08:10.88 (f29434–f29453): chip `7.9 → 9.4 → 11 → 12 mm`; the `Total ⌄` prefix
  collapses out ~100 ms into the drag and the pill fills blue; the face tint drops so the real
  result is visible; the rail collapses to `Search / Deselect All (1 face) / Offset Face`. Rebuild
  is live every frame (crisp new wedge faces at f29441 and f29444). Release: tint returns, chip
  `Total ⌄ 8.4 mm`. The gizmo hides while the camera moves and returns when it stops (gone by f6199).

### B3. Chamfer / Fillet

- Selecting an edge alone does **not** create a handle (edge cyan for 20 frames, f15491–f15510).
  Arming the tool (`F` or the rail entry `Chamfer/Fillet F / Auto`) draws, in one frame (f15511), a
  blue double-headed arrow on the edge near its midpoint pointing perpendicular to it in screen
  space, a `Fillet ⌄` mode pill, and a blue-outlined `0 mm` chip, laid out along the edge and offset
  into free space; the rail collapses to three rows; the banner fades in 2 frames later over 7
  frames. Once armed, further edge picks keep the handle (edge click f30317 → handle +2 f, f30319).
- Drag: press ring (dashed inside the dead zone, solid once engaged); dead zone 7 frames / 15–18 px
  (f11825→f11832); on engage the geometry pops to a non-zero radius in one frame. Then radius
  changes on **consecutive frames** (R0.3 → 0.4 → 0.5 → 0.6 at f15533–f15537; band-crop diff
  non-zero on every frame f15637–f15662) for 7 edges at once as well as 1 (08:30–08:38, 436-frame
  drag, f30699→f30707 morphs without a jump). Chip `R1.9 mm` in fillet mode, `1 mm` in chamfer mode
  (03:20.4), rotated to lie along the edge, trailing the handle by a large fixed offset (~250 px at
  08:31). The chip is display-rounded to 0.1 mm and every 0.1 step is visible in the geometry, so
  0.1 is resolution, not a snap. Value = pointer travel in model space (~21.5 px/mm at 04:19).
- Release commits and clears in ≤2 frames (f12071 pill gone) — unlike extrude, which stays open. Two
  frames after release a small gear icon and an oval handle appear beside the arrow (f15673); neither
  is used. Zero handling: dragging past zero is what triggers the refusal in §D; a fillet on the
  same edge at R0.6 had built 40 frames earlier, so magnitude was not the cause.
- Fillet vs chamfer: one tool in mode `Auto` plus the on-canvas `Fillet ⌄` pill; the banner names both
  (`Drag arrows to chamfer or fillet edges`). A chamfered result appears at 03:20.4 (`1 mm`, flat
  facet) after a mid-operation mode switch that was not captured. *Inference (moderate): `Auto`
  means fillet one way and chamfer the other; unproven.*
- Keypad: opened from the chip (10 f / 167 ms), fillet **rebuilt at R1 while the keypad was still
  open** (f17531, keypad fade-out began f17540). This is the one tool where typing appeared to preview;
  whether a Return had already been pressed is not recoverable.

### B4. Move / Rotate gizmo, copy, mirror

- Gizmo: at the selection's bounds centre projected to screen (in empty space for a U-body), ~41 px
  constant screen size: centre dot, four straight axis arrows, four diagonal double-arrows, three
  plane plates, and a `Copy` pill. Hovering an arrow fills it blue, drops the others to outlines and
  shows `0 mm` + `Copy` inline beside that arrow — the axis is chosen by which handle is pressed.
- Drag f26676–f26692 (17 f): the live shaded body translates (embossed text stays crisp; *inference:
  rigid transform on the scene graph, no rebuild*); a white dashed guide runs from an RGB origin
  triad to the gizmo; chip `1 → 2.9 → 6.9 → 11 → 16.7 → 21.7 → 24.5 → 28.4 mm`, unsnapped, no snap
  to other bodies, no alignment lines. After release everything stays for editing; keypad → `25` →
  `✓` snaps the body to exactly 25 mm in one frame (f26883).
- Copy: the `Copy` pill in the HUD, not a modifier. Press f33479, state flips on pointer-up f33484,
  toast `Copy ON` for 1.98 s; the copy-drag leaves the original behind in white 5 frames after
  press (f33509); the toggle resets silently. Bodies left overlapping never merge; `⌘U` merges 2–3
  selected bodies 650 ms after the keypress with no prompt (f34494), and the Items list collapses.
- Mirror: rail becomes `⚙ Keep Originals / On` + `✕ Cancel` in one frame (f26356); only the three
  datum planes are pickable; each selected body gets a badge. Plane pick (f26450, one frame): plane
  tints purple and enlarges, `✓ Done` is inserted at the top of the rail, and a **green translucent
  ghost of the evaluated result** (holes and text included, interior edges visible) appears and
  survives orbits (f26471–f26486). `Done` → final geometry in one frame, selection cleared (f26551).

### B5. Sketch dimensions and the Transform Text gizmo

- Rectangle drag: two live chips (width in a blue focus box, height), continuous to 0.1 mm, the drawn
  corner lags the pointer ~2 frames during fast motion (f29875). Line: 4-dp chip every frame,
  whole-mm snap with a magenta endpoint. Typed sketch dimensions use the same keypad plus a padlock
  (driving constraint) key (01:54.45).
- Transform Text: pivot ring, white free-move square, X arrow with a `0 mm` chip, Y arrow, scale
  arrow; rail replaced by `Done` / `Cancel`; press ripple 5 f; motion starts +6 f after press
  (f19292); the chip never left `0 mm` during a free move (not a live readout).

---

## C. Selection and hover

- **Hover response is instantaneous and binary.** Face: boundary edges stroke cyan with a faint fill
  (f12172, f14409, f30067); edge: one edge cyan (f30314); closed sketch region: solid orange fill
  (f4875). On and off in one frame (f4875 / f4895, ten instances 01:21–01:31; f9353→f9354 orange
  pixel count 0 → 48,921). Measured brightness is flat to ±0.02 between — no ramp, no pulse.
- **No dwell, no hysteresis.** A neighbour swap is remove-then-add with exactly one blank frame
  (f9432). Highlight hops between faces are isolated single-frame spikes 12–26 frames apart with the
  camera static (f12312, f12324, f12348). Hover flickers off/on within 2 frames when the pointer skims
  an edge (f5410/f5412). Hover is re-picked every rendered frame, including during orbits.
- **Hover never shows a handle, a pill or a banner.** Status pill and banner read empty at 03:22.9 and
  01:21.3 with a face and a region hovered.
- **Selection = fill.** Face fills translucent cyan (f33393: interior R 169 → 45 in one frame); body
  fills flat cyan (f26158); selected sketch region is a brighter orange than hovered (f5496 vs f5497;
  one pass at 05:33 could not distinguish them). Selection lands in the same frame as the gizmo, the
  status pill, and the hint card. Latency from pointer-up: 1–4 frames (f9449→f9453).
- **Ladder.** Click = face; second click within 6–11 frames (100–183 ms) = owning body with
  Move/Rotate armed (f26152→f26158, f33393→f33398). Additive by default for same-kind picks
  (1→2 faces f14457; 3→5→8 edges; 2→5 bodies) and mixed kinds (`1 face & Body 01`, f27291);
  one different-kind pick replaced a face set (f15491, single sample). No marquee anywhere. Clear:
  click on empty canvas (f26903, rail updates one frame before the viewport), `Deselect All ⇧⌘A`,
  or a committing tool (Mirror `Done`, `⌘U`, fillet release). Clearing 1–5 items is one frame.
- **Occluded selection.** When the selection resolves to interior faces, the owning body switches to
  an X-ray render in one frame with the selected faces tinted through it (f36644); neighbouring
  bodies stay opaque; it reverts when the selection drops. Overlapping selected bodies render
  translucent where they overlap (09:18.55).
- **Contextual actions.** Selection-filtered tool rail: nothing → 6 rows; 1 face → 26; 1 body → 19;
  2 bodies → 16; 1 face & 1 body → 12 (intersection of valid sets); unavailable tools are dimmed, not
  hidden (`Plane - Midplane`, `Union`, `Subtract`). Its second row is `Deselect All ⇧⌘A / <count or
  name>`. Status pill: one body → its name; otherwise a count plus live measurements (`8 edges ∿ 172
  mm`, `2 faces │ prl 0 mm │ min 37.2173 mm ΔX: 12.337 ΔY: 35.1131 ΔZ: 0`, `2 bodies │ min 19 mm …
  │ cntr 31.9458 mm …`). History filters to `● Related to Selection  Clear` one frame after the
  viewport (f5876→f5877). Hovering a History row tints that feature's faces olive-green in the
  viewport with zero latency (f23090 on, f23100 off).
- **Cursor.** macOS arrow, plus app-drawn rings: a white ring contracting over 4–8 frames marks
  pointer-down (f199–f207, f520–f522, f1574–f1577; the app commits on pointer-up 7–10 frames after
  ring onset across four calibrated targets); a dashed ring inside a drag dead zone becomes solid on
  engage (f9552→f9570); a green ring is drawn at the pointer for the duration of every camera gesture
  (f1610–f1636, f4714–f4782, f30326–f30348). The green ring was also seen at rest over a fresh fillet
  face (f15686–f15690) and appearing in the same frame as a face outline during an orbit (f12172);
  its exact trigger is an open question (§6).

---

## D. Failure and refusal handling

Two refusals occur; both are worth reproducing exactly.

### D1. Fillet dragged past zero (04:19.53–04:21.00, f15572–f15660)

| Frame | Time | Chip | Geometry | Top-centre slot |
| --- | --- | --- | --- | --- |
| f15570 | 04:19.500 | `R0.2mm`, rotated on the edge | small fillet | hint card `Chamfer/Fillet (F)` |
| f15572 | 04:19.533 | `0 mm` | sharp again, edge re-drawn cyan | hint card |
| f15575 | 04:19.583 | `0.6 mm`, **horizontal, detached, no `R`**, tethered to the edge by a dashed leader with an arrowhead | unchanged | cross-fade begins |
| f15591 | 04:19.850 | `~1 mm` | unchanged | `Configuration of edges at vertex too complicated.` at full opacity |
| f15630 | 04:20.500 | `2.1 mm` | unchanged | message |
| f15637 | 04:20.617 | — | fillet returns, radius climbing | message starts fading |
| f15642 | 04:20.700 | `R0.2mm`, rotated, re-attached | fillet | hint card fading back |
| f15680 | 04:21.333 | `R0.8mm` | fillet | hint card, collapsed to its title line |

- Where: exactly the hint card's slot, top-centre (proxy x 553–700, y 26–51). Plain white sentence,
  no icon, no card chrome, no dismiss control, no colour. Cross-fade in 17 f (283 ms), out 19 f
  (316 ms). **State-driven, not timed**: it clears on the first frame the fillet becomes buildable.
- The message names a cause in kernel terms and offers no action. It does not open a feature, suggest
  a value, or offer undo.
- The gesture continues: the handle keeps tracking, the number keeps counting (0.6 → 2.1 mm) for
  1.1 s, and the body is untouched. No clamp, no snap-back, no greyed handle, no colour change; the
  status pill still reads `1 edge ∿ 4 mm`. The chip's change of form (horizontal, detached, dashed
  leader, prefix dropped) is the only in-canvas failure signal — legible as "this is a pointer
  measurement, not a model dimension".
- Prevention: none for this case. The tool always opens at `0 mm` and the arrow is constrained to one
  screen axis, so the only route to the failure is overshooting through zero.

### D2. Fillet refused at 10:07.67 (f36460–f36993)

- `Chamfer/Fillet (F)` card fades out over f36451–f36458 (117 ms); after a 2-frame gap the message
  `Operation failed because the resulting body wouldn't be valid.` fades in over f36460–f36468
  (133 ms), same slot, same plain-text style.
- Geometry unchanged; no partial fillet; no dialog. The message is **sticky**: displaced by other
  cards at ≈10:11.6 and ≈10:12.5 and returning on each failed retry, final fade-out f36986–f36993,
  total on-screen span ≈8.9 s. The user retries several times and never gets the fillet; the segment
  ends unresolved. Context: `1 edge ⌒ 4.2786 mm`, chip `0 mm` next to a `Fillet ⌄` pill; interior
  faces of a unioned cluster (§C X-ray). Cause not recoverable from pixels.

### D3. Nothing-happens moments

- History parameter field: `-.5` typed and left uncommitted for 5.0 s (f22446–f22747) with zero
  canvas change and no dirty indicator beyond the focus ring; on Return it normalises to `-0.5 mm`
  and the rebuild lands 4 frames (67 ms) later over a 4-frame swap. No live preview from panel fields.
- Dimension keypad opened on `3` and dismissed with nothing typed (f25247–f25336); open animates
  117 ms, dismiss is one frame; nothing snaps back because nothing moved.
- Preventive design observed: `Continue` disabled until the text field is non-empty; constraint
  buttons pre-dimmed rather than failing on click; Mirror offers only the three datum planes and
  `Done` exists only once a plane is picked; keypad pre-selects the value so a stray key replaces
  rather than appends; the live count and total edge length in the pill let a mis-pick be seen before
  any operation; Sketch refuses to guess a plane (`Exit Sketching / No active plane`, f527–f613).

---

## E. Camera and viewport

- **Input.** Across 626 green-ring samples the pointer moves under ~30 px while the camera does
  hundreds (C13: pointer parked at (772,195) ±25 px for 1.5 s during a full orbit). *Inference:
  trackpad gestures, not mouse drags.* Which gesture maps to orbit versus pan is not readable.
- **Pivot and anchor.** Orbit pivots about the point under the pointer: the same surface feature stays
  inside the stationary green ring while the body swings ~90° and roughly doubles in size
  (01:40.68–01:42.13, f6074/f6104/f6122/f6134). Zoom is anchored on the pointer (green ring pinned to
  the same model point during the 04:03.9 zoom, f14636–f14661). Behaviour over empty space was not
  exercised.
- **Response.** No ease-in anywhere: the first frame of every gesture carries full magnitude (f4714
  0.027 → 3.224; f31164 −17.4 px). Tracking is 1:1; mid-orbit there are exact-zero frames when the
  fingers pause (f10328–f10331), and slow orbits step at a ~6-frame cadence (f15313–f15330) —
  input batching or recorder drops, unresolved.
- **Stops.** Measured on a geometry-only crop, per-frame mean-abs diff:
  - dead stops: f4782 2.13 → f4783 0.28; f35822 1.58 → f35823 0.07; f11637 0.65 → f11638 0.02; f12207 1.67 → f12208 0.04
  - decays: f6115 6.83 → 3.44, 2.05, 2.23, 1.48, 1.37, 1.10, 0.82, 0.80, 0.74, 0.92 → f6126 0.09 (10 f, 167 ms, ≈0.85×/frame); f28266 5.44 → 4.81, 4.09, 3.45, 2.95, 2.51, 2.61, 2.00, 1.60, 1.16, 0.90 → f28278 0.41 (12 f); pan f31168 8.3 → 6.3, 4.7, 4.8, 3.8, 3.7, 3.1, 3.1, 2.6, 2.6, 1.35 → f31180 0.30 (11 f).
  - Reading: no coast longer than 200 ms exists; the 10–12-frame tails are monotone with no overshoot
    and cannot be separated from finger deceleration on a trackpad. Either implement no inertia or a
    glide capped near 150 ms with τ ≈ 75 ms.
- **Zoom.** Discrete notches land in one frame with no tween (f36262 19.8, f36264 24.3, then 18 frozen
  frames) or as 4–8-frame eased steps (f1597–f1600, f9107–f9111 constant-rate then hard stop);
  continuous pinch strokes have the same ≤12-frame tail (f19604–f19615). A grid-spacing readout under
  the view cube (`0.5 mm`, `1 mm`) tracks zoom.
- **Animated jumps** (all triggered by commands, never by the view cube, which is never clicked):

  | Jump | Frames | Duration | Profile (per-frame diff) |
  | --- | --- | --- | --- |
  | Plane pick → Top (f616–f636) | 20 | 333 ms | 2.3, 3.1, 3.3, 3.4, 3.5, 3.2 … 2.0, 1.7, 0.8 — ~3 f ease-in, long monotone ease-out, no overshoot |
  | Sketch on a face → face-normal ortho (f6199–f6243) | 44 | 733 ms | 6.5 first frame, plateau 3.7–4.9, dip at f6221–f6224, second rise 4.9 → 4.0 → 2.2, 0.4 — two phases (rotate, then dolly/fit), no ease-in |
  | Sketch on the ground plane → Top (f29693–f29742) | 49 | 817 ms | two eased phases (27 f + 22 f); cursor stationary |
  | Snap to sketch plane at 05:06 (f18367–f18427) | 60 | 1000 ms | hard start, ~15 f decay |
  | Exit Sketching (f7551–f7578) | 28 | 467 ms | 11.5 in the first frame, then 6.7, 5.1, 4.0, 3.3 … 1.4, second bump 1.5–3.0, 0.2 — a near-cut followed by an eased settle |
  | Exit Sketch 03 (f9070–f9084) | 15 | 250 ms | 7.2 first frame, 4.7, 3.7, 3.1, 2.7, 2.2, 1.8, then 2.8–3.5 bump, 1.9, 0.07 |
  | Face-on + fit inside a sketch (f32662–f32696) | 34 | 567 ms | ease-in-out, single arc, then 78 frames dead still |

  Landings are exact (an off-centre solid shows no side faces in the sketch view: orthographic, while
  the 3D view is perspective with converging grid lines). The projection change is folded into the
  animation with no visible pop. Tool state (rail, banner, `Sketch 01`) is applied at the start of
  the glide (f618), not the end. The return pose after Exit Sketching is a fresh 3/4 view, not a restore.
- **Orientation widget.** A 3D view cube top-right with labelled faces and an XYZ triad; when the view
  is face-on, two 90° rotate buttons appear flanking it (01:44.5). It moves ~110 px when the History
  panel opens (the panel pushes the toolbar). Never used as a control in this recording.
- **Sketch and camera.** Orbiting inside a sketch is free (01:18.57, sketch mode intact); a white pill
  `Normal to Sketch` appears under the banner while the view is off-normal (f9092, 22 f after the
  exit cut) and hides when the view is normal again. During a pending line placement, a camera
  gesture freezes the pending endpoint and its dimension in model space (`16.4924 mm` held 33
  frames, f1611–f1643) while the green ring is up.
- **Renderer.** Fully idle between gestures (runs of exact duplicate frames); no LOD or degradation
  during motion; a ~12-frame progressive shading refinement follows each stop (R 163.8 → 169.2,
  f33378–f33390) — invisible in motion, but a still grabbed <200 ms after a stop is not the settled image.

---

## F. Motion and timing vocabulary

| Transition | Frames | ms | Shape |
| --- | --- | --- | --- |
| Hover on / off / hop; selection tint on; deselect; gizmo appear; tool-rail swap; Display Modes popover open/close; every display-mode switch (×11); History list reflow; keypad dismiss; mirror preview → final; geometry commit | 1 | 17 | hard cut |
| Hint card fade in | 5–10 | 83–167 | opacity only |
| Hint card fade out | 3–8 | 50–133 | opacity, asymmetric (faster than in) |
| Hint card ↔ error message cross-fade | 17–19 | 283–316 | cross-fade in the same slot |
| Hint card swap between tools | 19–24 | 316–400 | cross-fade |
| `Normal to Sketch` pill in / out | 8 / 7–10 | 133 / 117–167 | opacity |
| Pill stack reflow to make room for `Undo` | 9 | 150 | symmetric ease-in-out |
| `Copy ON` toast | 119 | 1980 | 117 ms in, hold, ~133 ms out |
| Keypad open (unfold/scale from the chip corner) | 7–15 | 117–250 | ease-out, no overshoot; value pinned at the anchor |
| Keypad close | 1–2 (once ~12) | 17–33 | cut |
| Text panel open / close | 21–22 / 5–7 | 350–367 / 83–117 | opacity, ease-out / ease-out |
| History disclosure expand | 15 | 250 | height + opacity, rise 12 f, fall 5 f |
| History panel slide out / in | 25 / 20 | 417 / 333 | ease-out / ease-in-out; toolbar translates with it |
| Status pill first appearance | 4–16 | 67–267 | opacity |
| Status pill content morph | 10–22 | 167–367 | width 36 → 288 → 130 px about a fixed centre, single overshoot lobe (2.2× final), label blank for the first ~60 %, then fades in |
| Status pill disappear | 1 | 17 | cut |
| Sketch-tool rail swap on entry | 2 | 33 | icons, then labels one frame later |
| Home → document | 19 + 27 | 317 + 450 | blur/scale dissolve, hard cut to a loading screen, one-step paint-in |
| Click ring | 4–8 | 67–133 | contracting ring, monotone |
| Camera jumps | 15–60 | 250–1000 | see §E |
| Post-stop shading refinement (render) | ~12 | ~200 | exponential convergence |

Grouping: roughly 90 % of transitions are 0 ms. Chrome uses a small set — ~117 ms (banner
fades, keypad-from-dimension), ~200–250 ms (keypad unfold, disclosure), ~350–367 ms (Text panel,
pill morph), ~400 ms (panel slide). Closes are never the reverse of opens (roughly 3:1 in:out, or a
cut). Nothing is linear; nothing rings — one overshoot lobe on the pill, none elsewhere. Rule:
**containers animate, content does not.**

---

## G. Sketching

- **Entry and plane choice.** Rail `Sketch` with nothing selected → three translucent datum quads at
  the origin appear at f527, 4 frames before the rail swaps to the sketch rail headed `Exit Sketching
  / No active plane`. Hovered quad fills light grey, pointer becomes an arrow. Click → quads vanish
  in one frame (f614), camera glides to Top over 20 f, `Line` auto-arms, the banner and a
  right-hand `Constraint Settings` panel fade in during the glide, a green `Tip` card slides in top
  centre. Sketch on a selected face: rail `Sketch` → 733 ms glide to face-normal ortho; the face's
  cyan tint drops one frame after the camera stops (f6244). Sketch Text was entered from inside a
  sketch, not from a face.
- **Line.** Click-click, chained; banner `Line (L) / Place endpoints to draw a line. Press Return to
  finish, or Escape or Delete to finish without placing temporary segments.` First point commits on
  pointer-up (f1581 magenta donut, f1582 green dot); rubber band and live dimension appear +3 f
  (f1585). Dimension: offset leader with arrowheads and witness lines, chip rotated along the leader,
  black fill, blue rounded border (its resting style), 4 decimals updated every frame. **Whole-mm
  snap**: chip shortens to `18 mm` / `23 mm` / `12 mm` and the live endpoint turns magenta (f1647,
  f1664, f1904–f2044). No typed dimension entry occurs in 00:00–01:20; values are reached by moving
  the cursor until the integer snap engages.
- **Inference indicators.** Cursor captured by a named entity: crosshair swallowed by a violet disc,
  then a dark label above it ~5 frames later (`Origin` f1573, `Y Axis` f1794). Live endpoint: blue
  dot = free, magenta ring = snapped. Violet full-width guide for horizontal/extension alignment
  (f1980). Axis capture toggles on/off every 1–4 frames near the axis (f1739–f1757): **no
  hysteresis** — a reproduction that adds any will feel steadier than the original. A 4-frame ring
  blinks at the plane centre before a circle is started (f32800–f32803).
- **Navigation while placing.** Green ring → pending point and dimension frozen in model space; camera
  motion starts 3 f after the ring and ends 2 f after it clears (f1610–f1638, f1665–f1676).
- **Rectangle / Circle.** Rectangle: press-drag, shape +1 f, two live chips (width in a blue focus box),
  corner lags ~2 f on fast moves, blue square vertex handles. Circle: press at centre, chip `⌀ 4 mm`
  +1 f, orange arc +3 f, dashed radius line; release recolours orange → blue in one frame and adds a
  centre marker and reference axes. Orange = live, blue = committed.
- **Offset Edge (O).** Source edges tint orange, offset preview blue, a blue double-headed arrow at the
  profile corner; the pointer over the handle is an arrow. Used twice to give the L its wall thickness.
- **Constraints.** Twelve entries (`Parallel A` … `Make Construction`) in a right panel; entries valid
  for the current selection at full opacity, the rest dimmed (07:01: only `Parallel` and
  `Horizontal/Vertical` enabled). No constraint glyph was placed in the first sketch; in Sketch 01's
  edit at 06:57 small white glyphs (perpendicular tick, tangency mark) float beside geometry and a
  `−3 mm` dimension carries a leader.
- **Dimension editing.** Click a dimension chip → text pre-selected with an `fx` variable button, then
  the keypad scales in over 7 f (117 ms) with an extra padlock key; dismiss is one frame.
- **Text.** `Add Text` floating dialog (fade-in 350 ms): `Type here…`, `Font Arial, Bold ⌄`, `Capital
  Height 8 mm`, three Alignment buttons, `Continue` (disabled while empty). Each keystroke redraws
  an orange outline preview on the same frame (f18651 …), but at ~1.9× the committed size and
  partly covered by the dialog. `Continue` → `Transform Text` gizmo with `Done` / `Cancel` replacing
  the rail; `Done` converts to blue sketch curves in one frame (f19498).
- **Exit.** Return/Escape or `Exit Sketching`; the camera cuts most of the way to a 3D pose in the
  first frame and settles over 14–27 more (§E). After exit, an active sketch's outer region is
  drawn as a persistent translucent lavender fill on the face (easy to mistake for a selection; the
  pill is empty at 05:26.3). Closed regions become extrudable by a click; the extrude consumes the
  sketch fill on commit (f20514).

---

## 4. Contrasts with OpenZCAD

Citations are to the repository at `main` `349763c0`, read for this comparison.

| Behaviour | Reference CAD (recording) | OpenZCAD today | Gap | Notes |
| --- | --- | --- | --- | --- |
| Hover feedback | outline (face) / orange fill (region), 1-frame on/off, no fade, no dwell | face film + x-ray pass and edge width/colour, all eased through `easeToward` τ = 60 ms with face-to-face cross-fade (`packages/viewport/src/selection/SelectionManager.ts:153-181, 270-284`; `packages/viewport/src/motion.ts:43-53`) | small | Opposite choice: OpenZCAD eases, the reference cuts. Plan item 3.2 (hover dwell) would move further from the reference. |
| Hover shows a handle | never; handles only after selection | same: rigs arm on selection (`apps/web/src/lib/interaction/machine.ts:261-332`) | none | |
| Handle placement | at the pick point on the region plane | double-headed arrow centred on the pick point (`packages/viewport/src/gizmo/rigs.ts:98-101`) | none | |
| Preview during drag | exact solid every frame, no proxy, no pop | `transform-proxy` for offset/extrude/cylinder, `exact-worker` at 150 ms cadence for blends, preview stops after a 400 ms slow frame (`apps/web/src/lib/interaction/capabilities.ts:25`; `apps/web/src/components/ModelViewer.tsx:5115-5124, 5190-5196`; `apps/web/src/lib/livePreview.ts:14-15, 124-128`) | large | Kernel-in-a-worker makes 1-frame exact rebuild hard; the reference shows what the target feels like. |
| Drag → first motion | 1 frame | first move after a frame applies immediately (`ModelViewer.tsx:5270-5277`); exact previews land at ≥150 ms | small (proxy) / large (exact) | |
| Value snapping | none on drags (0.1 mm resolution); whole-mm snap only for sketch lines | zoom-adaptive 1-2-5 ladder, Shift to escape, on move/offset/radius (`packages/viewport/src/gizmo/move.ts:49-52, 85-101`; `ModelViewer.tsx:5183-5187`) | large | Deliberate divergence; keep or drop consciously. |
| Value ↔ pixel mapping | model-space projection, scales with zoom | pointer projected onto the axis (rigs) | none | |
| Sign / cut | one tool; drag direction decides; explicit `−` in chip | offset signed with explicit `+` (`ModelViewer.tsx:4152`); in-sketch extrude infers add/cut from direction (`docs/plans/sketch-flow-camera-plan-2026-08-26.md:32-33`) | none | |
| Chip orientation | rotated along the drag axis, on the dashed axis near the extent midpoint | DOM chip floating 1.3 units past the handle, screen-aligned (`packages/viewport/src/gizmo/DragRig.ts:37, 67`) | small | |
| Typing mid-drag | chip tap → keypad from the chip, prefilled/selected, units + operators, no preview while typing (extrude), 1-frame commit | chip click → keypad with expressions (`apps/web/src/lib/keypad.ts:69-90, 164-173`) | small | Match: open ~200 ms from the anchor, close instantly. |
| Refusal presentation | plain sentence in the hint slot, handle live, chip detaches, body untouched, clears when valid | `role="alert"` in the ToolCard with cause / detail / `Edit <Feature>` button; handle re-armed at last good value (`apps/web/src/components/ToolCard.tsx:64-86`; `apps/web/src/hooks/useDirectEditCommit.ts:49-61`) | small | OpenZCAD's message design is richer; the reference's live-handle-during-refusal is the piece to adopt. |
| Pre-computed limits | none; failure after the fact | none; warning reactive from the rebuild (`apps/web/src/App.tsx:12941-12945`) | none | Both reactive. |
| Blend on release | fillet commits and clears selection ≤2 f; extrude stays open until deselect | one edit at a time, validated before apply (`useDirectEditCommit.ts:58-60`) | small | Decide per tool whether the operation stays open. |
| Selection additive | plain click adds (same kind) | Shift+click toggles (`ModelViewer.tsx:3721, 5777`) | small | Convention choice. |
| Face → body | double-click promotes to the body and arms Move | double-click promotes to owning body (`ModelViewer.tsx:6160-6191`) | none | |
| Box select | none observed | direction-typed window/crossing (`packages/viewport/src/selection/boxSelect.ts:38-46`) | — | OpenZCAD has more. |
| Occluded selection | owning body switches to X-ray in one frame | x-ray pass with brighter rim (`packages/viewport/src/render/semantics.ts:38-54`) | none | |
| Orbit / zoom anchor | point under the pointer for both | pivot = picked point projected onto the view axis; zoom-to-cursor default on (`packages/viewport/src/camera/CameraController.ts:367, 606-625`) | none | |
| Camera inertia | none, or ≤12-frame decay; no ease-in | drag damping 0.35, glide damping 0.15 bounded 800 ms (`CameraController.ts:48-55, 588-597`) | small–medium | OpenZCAD coasts up to 800 ms; the reference never exceeds ~200 ms. |
| Discrete zoom | one-frame steps or 4–8-frame steps, hard stop | velocity-adaptive wheel zoom, τ 180 ms (`packages/viewport/src/camera/zoomDynamics.ts:16-28`) | small | |
| View jumps | 250–1000 ms, no ease-in, exact landing; exit is a near-cut + settle | 170–520 ms travel-scaled `1-(1-t)³`; sketch glide fixed 800 ms trapezoid (`packages/viewport/src/camera/views.ts:309, 342-383`) | small | Durations comparable; the reference's exit profile (big first frame) is unusual. |
| View cube | present, never used; 90° buttons appear when face-on | faces + corners + rotate arrows (`apps/web/src/components/OrientationWidget.tsx`) | none | |
| Sketch axis snap | no hysteresis (toggles every 1–4 frames) | sticky 1.5× hysteresis, Tab cycling (`apps/web/src/lib/sketch/session.ts:788-820`) | — | OpenZCAD steadier by design. |
| Navigation during placement | pending point frozen, green ring at the pointer | not read in this survey | unknown | Worth checking. |
| Motion tokens | 0 ms for state; ~117 / 200–250 / 350–367 / 400 ms for chrome; closes 3:1 faster | 100 / 200 / 350 ms + one bezier, ~90 of ~110 declarations (`apps/web/src/theme/tokens.css:98-101`; `docs/interaction-design.md:9-17`) | small | Tokens already align; the difference is *what* animates (OpenZCAD eases scene state). |
| Status readout | pill with count + live measurements, width morph 10–22 f | status bar `aria-live` region (`apps/web/src/components/StatusBar.tsx:83`); ToolCard phase pill | medium | |
| Booleans | never automatic; `⌘U` explicit, 650 ms | boolean commits change on the next frame (`docs/interaction-design.md:42-47`) | none | |
| Display-mode switch | 1-frame cut | not read | unknown | |

---

## 5. Reproducible specifications

### S1. Selection-first push/pull with exact rebuild

- Trigger: pointer-up on a closed sketch region or a solid face (commit on release, ring on press).
- Response, same frame: fill the target (region: saturated fill; face: translucent fill), draw a
  double-headed arrow at the pick point projected onto the target plane, a dashed axis through it in
  both directions, and a value chip reading `0 mm` (or the current total for a face) rotated along
  the axis and standing ~50 px outboard. Show the tool banner within 100 ms (fade 80–120 ms). Drop
  sketch chrome ≤100 ms later in one frame.
- Drag: value = pointer ray projected onto the axis in model space, absolute from the target plane;
  0.1 mm display resolution, no detents; sign from direction; arrow becomes single-headed when
  non-zero. Geometry: rebuild the exact solid on every pointer event; if a rebuild cannot finish in a
  frame, hold the last exact result rather than substituting a proxy (the reference never shows one).
  Chip rides the axis near the extent midpoint. Multiple selected regions move together from any one
  handle.
- Release: nothing changes visually. The operation stays open (handle, chip, axis) until a click on
  empty canvas, a chip edit, or a new selection.
- Failure: see S2. Cancel: Esc (not observed; the reference relies on empty-canvas click).

### S2. Refusal without touching the model

- Trigger: kernel rejects the value under the pointer during a drag.
- Response within 3 frames: keep the handle tracking the pointer; leave the model at the last valid
  result; change the chip from "attached, rotated, prefixed" to "detached, horizontal, no prefix,
  tethered by a dashed leader with an arrowhead" so the number reads as a pointer measurement; replace
  the tool banner in place with one plain sentence naming the cause (cross-fade 280–320 ms); leave the
  status pill alone.
- Recovery: the moment a frame is buildable again, rebuild, re-attach the chip, and cross-fade the
  banner back (no timer, no dismiss control). A refusal at commit stays until another card replaces it.
- OpenZCAD addition worth keeping: the `Edit <Feature>` action and `<details>` kernel text; the
  reference offers neither.

### S3. Hover and selection grammar

- Hover: recompute the pick every rendered frame (including during camera motion); apply the
  highlight in the same frame with no fade, no dwell, no hysteresis; neighbour swap = remove then
  add with at most one blank frame. Face: boundary stroke plus a faint fill; edge: single edge
  stroke; closed region: solid fill. Never show a handle, a status readout or a banner on hover.
- Selection: filled tint; gizmo, status pill (count + live measurement), hint card and rail filter
  land in the same frame. Plain click adds a same-kind item; double-click within ~180 ms promotes a
  face to its body and arms Move; click on empty canvas clears everything in one frame; the rail may
  update one frame before the viewport.
- Occluded selection: when selected faces are interior, render the owning body X-ray in one frame.

### S4. Camera

- Orbit and zoom anchored on the point under the pointer. No ease-in: first frame at full magnitude.
  1:1 tracking. On input end, stop within one frame, or glide with τ ≈ 75 ms capped at 150 ms; never
  overshoot. Discrete wheel notches apply in one frame (or a 4–8-frame constant-rate step), never a
  long tween. No axis snapping on release.
- Command jumps: land exactly; total 250–750 ms; entering a plane uses an ease-out with ≤50 ms
  ease-in (20–44 frames, two phases if a dolly is needed); leaving a sketch puts most of the motion in
  the first frame and settles over 15–27 frames. Apply tool state at the start of the jump. Offer a
  `Normal to <plane>` pill while the view is off-normal inside a sketch; hide it when normal.
- Draw a distinct ring at the pointer for the whole duration of a camera gesture, and freeze any
  pending sketch placement in model space while it is up.

### S5. Keypad from a chip

- Trigger: click the value chip (chip border thickens on hover).
- Response: a panel unfolds from the chip's corner over 120–250 ms (ease-out, no overshoot), value
  pre-filled and fully selected, with `( ) mm cm m deg`, digits, `÷ × − +`, `±`, `⌫`, a tall confirm
  key, a variable button and a keyboard toggle; sketch dimensions add a padlock. Typing replaces.
  Preview policy: none while typing for extrude/offset/parameters; live preview was seen once for
  fillet — pick one and state it.
- Commit: one frame, keypad gone and geometry at the new value together; the operation stays open.
  Dismiss: one frame; never play the open in reverse.

### S6. Status pill

- Bottom-centre pill. One body selected → its name; otherwise `<n> faces/edges/bodies` plus live
  measurements: total edge length for edges; parallel and minimum distance with ΔX/ΔY/ΔZ for two
  faces; min and centre distance for two bodies; a collapse chevron. Content change: blank the label,
  morph width about a fixed centre over 10–22 frames with one overshoot lobe (~2.2× final width),
  fade the new label in over the last third. Appear: 4–16-frame fade; disappear: one frame.

### S7. Modal operations with an evaluated ghost

- Trigger: a tool that needs a second pick (Mirror, Transform Text).
- Response: replace the rail in one frame with the tool's options and `Cancel`; draw only valid pick
  targets; badge the operands. On the pick: tint the picked datum, show the **evaluated** result as a
  translucent ghost with interior edges (holes, text included), and insert `Done` at the top of the
  rail. The ghost persists through camera moves and pointer departure. `Done`: ghost → final in one
  frame, selection cleared, rail restored, banner fades out over ~120 ms. Booleans stay explicit;
  overlapping bodies are never merged silently.

### S8. Sketch inference at the cursor

- Capture feedback lives at the pointer: the crosshair is replaced by a filled disc when captured
  and a name label appears above it ~80 ms later; the live endpoint shows free (dot) versus snapped
  (ring); full-width guide lines mark alignments. Committed curves recolour in one frame. Provide
  whole-unit value snapping with a visible endpoint change. Keep OpenZCAD's hysteresis — the
  reference's absence of it is visibly jittery.

---

## 6. Open questions (need a second recording)

1. Push/pull across a fillet or chamfer, and a through-cut: how blends and the far face respond, and
   whether the chip changes label or clamps. Never exercised.
2. Negative extrude of a fresh region and crossing zero on Offset Face: does the arrow flip, is there a
   hard stop at zero.
3. What `Total ⌄` (Offset Face), `Fillet ⌄` / `Auto`, `Diameter ‹`, and the round boolean badge switch
   between; none was opened.
4. The green ring's trigger: camera gesture in progress (dominant evidence) versus a pickable target
   under the pointer (two sightings at rest, f15686–f15690 and f12172). A recording with a visible
   input overlay would settle it, as would the orbit binding itself.
5. Orbit pivot over empty space; zoom fixed point measured with the pointer far from centre.
6. Whether the fillet keypad truly previews per keystroke (one instance) while extrude does not.
7. The ~100 ms stepping during slow orbits: input batching or recorder frame drops.
8. The single-frame zoom-out at 07:05.650 (f25539) and what armed the `Undo` pill ~15 frames later.
9. Whether the Copy toggle resets on commit, deselect, or tool change; what the chain-link pill does.
10. Face-drag with the camera moving: the user never orbited during a value drag, and the app hid the
    Offset Face gizmo while the camera moved — whether a drag survives a mid-drag camera gesture is untested.
11. Whether the ~1.9× oversize text preview and the dialog covering the word are zoom-dependent.

---

## Evidence

The eleven pass reports (`passes/seg_A.md` … `seg_I.md`, `camera.md`, `hover_motion.md`), the
method brief, the OpenZCAD-side survey, the per-gesture 60 fps sheets and 4K crops
(`evidence/seq/*`, `evidence/hi/*`, `evidence/sheets/*`) and the extraction scripts are archived
outside the repository in `~/claude/cad-reference-analysis-2026-09-01/`. Each pass report lists the sheet
files behind every frame number quoted here. The recording copy used is
`~/claude/cad-reference-2026-09-01.mov`.
