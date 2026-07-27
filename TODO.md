# OpenZCAD Roadmap

## Working now

- Schema-v2 canonical documents with migrations, checkpoints, asset references, command replay, transactions, undo/redo, and local-first autosave.
- OpenCascade browser-worker kernel with exact primitives, sweeps, transforms, booleans, validity checks, measurements, and exact STEP/STL export.
- Editable exact STEP import, deterministic face/edge selection, fillet/chamfer, and linear/circular patterns.
- Three-pane CAD workspace, feature editing, diagnostics, contextual topology actions, responsive compact layout, and AI command rail.
- Model browser with a selectable/visibility-toggleable bodies tree and a feature history list.
- Human-readable topology naming (directional faces, holes, edge ordinals) across the viewport callout, selection chip, and inspector — no raw fingerprints.
- Explicit command lifecycle states on the operation card (ready, dragging, exact entry, validating, failed).
- Edge-length measurements in the selection chip, including multi-edge totals.
- Sketch entity snapping to endpoints, midpoints, and centers with cursor glyphs, layered over grid snapping and axis inference.
- Configurable streamed AI proposals with compact topology-aware context, broad feature commands, strict structured output, dry-run preview, explicit approval, and undoable application.
- Cloudflare Access identity, owner-scoped beta APIs, and legacy-owner mapping.
- Live per-project Durable Object rooms with presence, version-aware synchronization, and conflict preservation.

## Next

- Invitations, viewer/editor roles, edit locks, and durable collaboration history.
- Face-attached sketches, shell/offset, mirror, and persistent topology naming.
- Multi-profile sketches, holes/pockets, partial revolve, and symmetric/two-sided extrude.
- AI-created sketches and symbolic references between newly generated operations in one proposal.
- Cache and loading UX improvements for the exact-kernel WASM module.

## Later

- Assemblies and mates.
- Drawings, dimensions, and inspection tools.
- Constraint solving, design tables, and variant management.
