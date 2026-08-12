# Direct sketch and extrusion design QA

## Comparison setup

- Source visuals: three reference screenshots — a focused sketch interaction reference, an arrow extrusion reference, and the existing OpenZCAD visual-language baseline (not stored in the repository).
- Implementation evidence: sketch, extrude, and confirmed-solid screenshots of the implementation, reviewed side by side against the references.
- Primary viewport: 1440 × 900 at device pixel ratio 2.
- Responsive checks: 1024 × 768 and 768 × 650.

The implementation intentionally preserves the OpenZCAD application chrome and visual tokens while adopting the reference interaction hierarchy: full-canvas sketching, a compact left tool palette, centered task guidance, plane controls on the right, selected closed profiles, and signed direct-manipulation extrusion.

## Fidelity and behavior review

- Layout and spacing: the sketch canvas owns the central workspace, with the tool palette and setup panel clear of the drawing origin at desktop and tablet widths. The compact-width check keeps all primary sketch controls usable; secondary top-bar text truncates before modeling controls are lost.
- Typography and color: existing OpenZCAD monospace/status typography and dark surfaces remain consistent. Amber marks active sketch geometry, red and blue identify axes, green communicates profile readiness, and blue identifies extrusion actions.
- Icons and surfaces: controls use the existing Lucide icon family, matching stroke weight and avoiding custom SVG/CSS artwork. Borders, radii, and elevation follow the current OpenZCAD panels rather than copying the reference application's unrelated chrome.
- Copy and hierarchy: the active tool, current gesture, plane, profile readiness, signed distance, side, and confirmation action are visible without opening the feature inspector.
- Interaction states: rectangle, circle, and polygon modes have one active state; plane buttons and profile selection expose pressed/selected state; finish/create actions disable until valid; Escape and Enter are supported; profile deselection and cancel paths are present.
- Accessibility: primary controls are semantic buttons/forms/toolbars with accessible names, pressed states, labels, and visible focus styles. Keyboard shortcuts remain available for profile tools and completion/cancellation.
- Image fidelity: no product imagery was required or substituted. The functional Canvas and Three.js renderers draw the CAD grid, geometry, preview, and handles.

## Comparison history and fixes

1. P2 interaction-state mismatch: the first sketch pass visually marked both Select and Circle as active. The static Select styling was removed; the post-fix DOM and screenshot show exactly one active tool (`Circle`).
2. P2 handle visibility: the extrusion arrow head initially ended flush with the translucent preview cap. The handle now renders without depth testing and extends 7 mm beyond the preview, keeping the drag target and signed value visible at non-zero distances.
3. Post-fix evidence: the final desktop comparison shows the closed circle at Ø32 mm, an opposite-side preview at -34.5 mm, a visible outboard arrow head/value, and the exact confirmed solid. No P0, P1, or remaining P2 findings were observed.

## Functional verification

- Drew a snapped closed circle on the Top (XY) plane and finished it into canonical document history.
- Selected the filled profile directly and launched Extrude from the contextual action.
- Dragged to -34.5 mm on the opposite side, crossed through the sketch plane, and reached +3 mm on the positive side.
- Confirmed `Extrude 1`; the exact kernel returned one live body, 2412.743 mm³ volume, three faces, and zero workspace warnings.
- Console warning/error log after confirmation: empty.

## Remaining P3 scope differences

- Advanced sketch entities and constraints from the reference product (line, arc, spline, trim, tangent, concentric, and dimensional constraints) are not part of this delivery.
- The current document model stores one closed profile object per sketch. Multi-loop and multi-region sketches need a document-schema milestone rather than a UI-only change.
- Extrusion creates a standalone body; automatic add/cut/intersect semantics against an existing body remain a future modeling-mode milestone.

## Final result

Passed. The requested sketch-to-bidirectional-extrusion journey is implemented, visually verified against the supplied references, and functional in the real application flow.

## E3 assistant-created sketch acceptance addendum

- The assistant review card describes the sketch and extrusion as separate proposed operations; Apply commits both in one undoable transaction.
- Same-proposal sketch aliases resolve to preassigned canonical sketch IDs before command serialization, so replay never depends on a local alias.
- Open endpoints, near-closure gaps, and invalid profile diagnostics stop the proposal before document mutation or worker geometry.
- The assistant digest now includes each sketch's canonical or face attachment plane plus its full object data, so later requests can inspect the geometry the assistant created.
- Playwright verifies a rectangular `add_sketch` followed by an aliased `add_extrude`, including the final exact body, applied review state, zero warnings, and an empty console-error log.

## E1 mirror, shell, and solid-offset acceptance addendum

- Mirror, Shell, and Solid offset share the existing feature-tool rail and inspector hierarchy; all require an exact preflight before their create action is available.
- Shell face choices use human-readable exact-face labels and pressed states. The browser acceptance path selected the box `z max` face, passed preflight, and produced a visibly open 2 mm shell with one live body and zero warnings.
- A kernel regression builds a filleted solid, requests an impossible 100 mm shell, and verifies that the feature warning path receives the refusal while the source remains live and no result body is published.
- The implementation now runs on the pinned BrepKit browser kernel rather than the brief's older `occt-wasm` API. BrepKit does not expose the proposed `*WithHistory` calls, so these operations retain their documented hash-only lineage instead of claiming unverified topology evolution.
- Press-pull remains explicitly out of scope; Solid offset is whole-body only.

## Feature suppression and rollback addendum

- Each history row exposes semantic pause/resume and rollback controls on
  hover or keyboard focus; an active pause remains visible without hover.
- Suppressed rows use muted italic text, a warning-colored strike, and an
  explicit `suppressed` label. They are not styled as failed geometry.
- The active rollback boundary is a persistent accent rule after the selected
  row, while every later row shows its suppressed state.
- Pause and rollback buttons expose accessible names and `aria-pressed` state.
  Undo/redo moves the rendered boundary and exact body count with the canonical
  document rather than keeping local UI state.
- Compact-width acceptance must confirm the two new 20 px controls do not hide
  the feature name, visibility control, or delete action.

## Durable collaboration and roles addendum

- A real browser fixture opens a cloud-backed project as a room `viewer`; the
  collaboration control reports `read-only` after the room state arrives.
- Modeling controls such as **Box** are disabled by the central edit gate. A
  direct parameter submission is also refused and leaves canonical history
  unchanged, covering a mutation path outside the tool palette.
- The sharing dialog states `Your role: viewer`, marks the edit lease as not
  available, and replaces member/invitation management with owner-only copy.
- Server-focused coverage independently verifies that viewer/editor/owner
  rules cannot be bypassed through REST writes, WebSocket frames, the oversized
  HTTP snapshot fallback, or lease acquisition/renewal after membership
  revocation.
- Collaboration and lease rollout flags stay off; this acceptance validates
  the dark implementation and does not claim beta or production enablement.

## E6 artifact-flow addendum

- The export remains a normal browser download generated by the exact geometry
  worker; archival does not move geometry work into the Cloudflare Worker.
- A successful archive increments the existing File count and adds one
  downloadable row under **Stored files** without adding new top-bar controls.
- Playwright exercises generate, upload, finalize, metadata refresh, and stored
  row visibility through the production UI. Failure remains deliberately
  local-first: the download succeeds and the status omits the archive suffix.

## Face attachment failure-state addendum

- Face-sketch entry remains limited to a current exact planar selection with a
  schema-v5 lineage reference; a nearby or hash-only face is not substituted.
- Browser acceptance draws a real face-attached rectangle, then suppresses its
  source box. The model browser retains both canonical features while
  **Diagnostics** names the source-body/history-position failure.
- Resuming the source clears the diagnostic and rebuilds the sketch without a
  replacement-face choice or manual reattachment.
- Kernel acceptance separately proves that benign upstream dimension changes
  move the attached extrusion to the evolved exact face before the stale-state
  case is exercised.

## Extrude inference addendum

- The direct extrude controller keeps Operation visible throughout the drag.
  It reads `Inferring…` while the worker measures and then `New Body`, `Add`,
  or `Cut` with a short explanation naming the target where applicable.
- Apply stays disabled until the exact preview matches the current document
  version, distance, and profile selection.
- Operation is feedback rather than an editable guess. The feature inspector
  shows the stored value and explains that later distance edits preserve it.
- Tangency, multiple overlaps, coincident material, and refused measurements
  use explicit New Body explanations instead of silently consuming a target.
- Desktop and compact-width acceptance must verify the operation detail wraps
  inside the controller without covering Distance or Apply Extrude.

## Top-bar and quick-actions rail QA addendum

- Reference sources: `/var/folders/t_/tvn84c292rzdfcbj06vltnsw0000gn/T/codex-clipboard-e36a0c60-efae-4f19-8224-63cf3e172bf1.png` (812 x 136) and `/var/folders/t_/tvn84c292rzdfcbj06vltnsw0000gn/T/codex-clipboard-f9d574c0-ddcd-4803-afee-44e5702c3b8b.png` (300 x 548).
- Implementation evidence: `/private/tmp/openzcad-topbar-desktop.png` (1280 x 720 at DPR 1), `/private/tmp/openzcad-topbar-mobile.png` (390 x 844 at DPR 1), and the focused side-by-side comparison `/private/tmp/openzcad-topbar-comparison.png` (880 x 970).
- Captured state: local `Topbar QA` project, signed-in development account state, unavailable cloud-project storage, offline collaboration, and one exact box body after exercising undo and redo.
- Layout and spacing: desktop action tracks measure 128, 104, 126, 90, and 28 px for save, account, collaboration, File, and Settings. Their x positions remained 744, 884, 1000, 1138, and 1240 through repeated save samples. At 390 px, all five tracks collapse to 28 px icons at x positions 228, 260, 292, 324, and 356 with no horizontal overflow.
- Typography and color: the existing compact monospace status typography, dark chrome, green authenticated state, muted local/collaboration states, and blue active grid control remain consistent with the product and supplied references.
- Icons and surfaces: existing Lucide icons are reused. No image, custom SVG, or placeholder substitution was introduced.
- Copy and hierarchy: the top bar contains state-only account copy (`Signed in`) and does not render the development user's name or email. The DOM and rendered order is save, account, collaboration, File, Settings, which produces the requested right-to-left order of Settings, File, collaboration, account, and save.
- Interaction states: File remains a menu immediately left of Settings; undo and redo are absent from the banner and are the first two controls in the semantic `Quick actions` toolbar. Creating a box enabled Undo, Undo returned the project to zero bodies and enabled Redo, and Redo restored one body.
- Accessibility: the action cluster is named `Workspace actions`; the account status exposes `Cloud account: signed in`; the rail is named `Quick actions`; and disabled undo/redo states are conveyed semantically.
- Comparison history: the first implementation capture passed the focused source-to-implementation review. No P0, P1, or P2 fidelity defect was observed, so no post-capture correction was required.
- Console and responsive health: the in-app browser reported no warning or error logs. Document scroll width equaled viewport width at both 1280 and 390 px.

final result: passed
