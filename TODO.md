# OpenZCAD Roadmap

The sequencing, ownership, and acceptance gates for everything under "Next"
live in [PLAN.md](PLAN.md).

## Working now

- Schema-v4 canonical documents with migrations, checkpoints, asset references,
  command replay, transactions, undo/redo, and local-first autosave.
  Face-attached sketch plane references are stored as frame snapshots.
- BrepKit browser-worker exact kernel as the primary path, with OpenCascade
  rebuilding documents that contain STEP imports: exact primitives, sweeps,
  multi-profile extrusion, transforms, booleans, validity checks,
  measurements, and exact STEP/STL export.
- ADR-011 unified cross-kernel topology fingerprints with fail-closed
  resolution — references survive kernel reroutes or fail visibly, never
  landing silently on different geometry.
- Editable exact STEP import, deterministic face/edge selection,
  fillet/chamfer, linear/circular patterns, planar face offsets, cylindrical
  hole/boss radius edits (BrepKit documents), and imported complete
  through-hole recognition, resize, and removal (STEP documents).
- Debounced local-first cloud settings autosave: coalesced edits, serialized
  requests, revision-safe 409 retry, flush before logout, and dirty-state
  preservation through reload.
- Orientation cube with face snapping, pointer-drag orbiting, and a drag
  threshold separating click-snap from orbit.
- CAD workspace with feature editing, diagnostics, contextual topology
  actions, responsive compact layout, a collapsible tool palette, and a
  docked assistant panel that one setting removes entirely.
- Model browser with a selectable/visibility-toggleable bodies tree and a
  feature history list, in collapsible sections that remember their state per
  device.
- Human-readable topology naming (directional faces, holes, edge ordinals)
  across the viewport callout, selection chip, and inspector — no raw
  fingerprints.
- Explicit command lifecycle states on the operation card (ready, dragging,
  exact entry, validating, failed).
- Edge-length measurements in the selection chip, including multi-edge totals.
- Sketch entity snapping to endpoints, midpoints, and centers with cursor
  glyphs, layered over grid snapping and axis inference.
- Configurable streamed AI proposals with compact topology-aware context,
  broad feature commands, strict structured output, dry-run preview, explicit
  approval, and undoable application.
- Conversational assistant: it returns a patch, clarifying questions with
  tappable suggested answers, or a plain refusal, and carries the
  conversation forward as bounded history.
- Modeling from formal 2D drawings: PNG/JPEG/WebP and PDF attachments
  (rasterized client-side), a drawing-interpretation protocol covering
  projection convention, units, and scale, and a dimension audit table
  showing every value read and the view it came from.
- Single-use email-code identity, opaque sessions, owner-scoped beta APIs,
  and legacy-owner mapping.
- Live per-project Durable Object rooms with presence, version-aware
  synchronization, three-way merge, conflict detection, and persisted
  snapshots.

## Next

Ordered per the PLAN.md waves; topology lineage is the critical path for
modeling, face attachment, and AI.

- Reliability hardening: cloud-settings offline pause/resume and a
  session-epoch guard; orientation-cube pointer-lifecycle edges (lost
  capture, blur, unmount); component-test infrastructure; e2e suite split by
  domain.
- Viewport edge-overlay consolidation: one idle-edge batch per visible body
  and selection changes that no longer rebuild geometry, recreate materials,
  or invalidate the shadow map.
- Persistent topology lineage (schema v5): additive lineage references with
  hash fallback and visible failure — never nearest-geometry matching — after
  a kernel-evolution spike settles fillet provenance, the missing
  chamfer/pattern/direct-edit coverage, and deletion detection. Includes an
  explicit fail-closed guard for closed B-spline/NURBS topology.
- Collaboration: invitations (hashed single-use tokens, seven-day,
  email-matched), immutable owner/editor/viewer roles enforced server-side
  and inside the Durable Object per message, one project-wide edit lease
  persisted in Durable Object storage, and conflict recovery UX that always
  writes a local recovery copy before any destructive resolution.
- Modeling operations: mirror (original plus copy, no automatic fusion),
  shell (positive thickness), uniform solid offset (positive is outward),
  and generalized imported-feature recognition beyond through-holes — blind
  holes, counterbores/countersinks, bosses, prismatic pockets, and conical
  tapers with an angle-authoritative invariant; unsupported features are
  labeled, never inferred.
- True face-attached sketches: the evolved source face becomes authoritative
  while resolvable; the stored frame snapshot remains as
  migration/diagnostic data.
- AI operations gated per deterministic contract, in order: direct edits,
  face-attached sketches, multi-profile extrudes, mirror, shell/offset, then
  recognized imported features — each behind its own flag, with preview and
  Apply unified onto one preflight path.
- Kernel loading and caching: lazy BrepKit load, OpenCascade only for STEP
  work, bounded content-keyed result caching, and a production chunk report.

## Later

- Assemblies and mates.
- Drawings, dimensions, and inspection tools.
- Constraint solving, design tables, and variant management.
- Partial revolve and symmetric/two-sided extrude.
- Region-of-interest cropping for a drawing sheet, so a detail view can be
  sent at full resolution.
- Turning a drawing's dimension audit into editable parameter overrides
  applied without a new proposal.
