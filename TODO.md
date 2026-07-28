# OpenZCAD Roadmap

## Working now

- Schema-v2 canonical documents with migrations, checkpoints, asset references, command replay, transactions, undo/redo, and local-first autosave.
- OpenCascade browser-worker kernel with exact primitives, sweeps, transforms, booleans, validity checks, measurements, and exact STEP/STL export.
- Editable exact STEP import, deterministic face/edge selection, fillet/chamfer, and linear/circular patterns.
- CAD workspace with feature editing, diagnostics, contextual topology actions, responsive compact layout, collapsible browser sections, a collapsible tool palette, and a docked assistant panel — all removable by one setting.
- Configurable streamed AI proposals with compact topology-aware context, broad feature commands, strict structured output, dry-run preview, explicit approval, and undoable application.
- Conversational assistant: it returns a patch, clarifying questions with tappable suggested answers, or a plain refusal, and carries the conversation forward as bounded history.
- Modeling from formal 2D drawings: PNG/JPEG/WebP and PDF attachments (rasterized client-side), a drawing-interpretation protocol covering projection convention, units, and scale, and a dimension audit table showing every value read and the view it came from.
- Cloudflare Access identity, owner-scoped beta APIs, and legacy-owner mapping.
- Live per-project Durable Object rooms with presence, version-aware synchronization, and conflict preservation.

## Next

- Invitations, viewer/editor roles, edit locks, and durable collaboration history.
- Face-attached sketches, shell/offset, mirror, and persistent topology naming.
- Multi-profile sketches, holes/pockets, partial revolve, and symmetric/two-sided extrude.
- AI-created sketches and symbolic references between newly generated operations in one proposal.
- Cache and loading UX improvements for the exact-kernel WASM module.
- Region-of-interest cropping for a drawing sheet, so a detail view can be sent at full resolution.
- Turning a drawing's dimension audit into editable parameter overrides applied without a new proposal.

## Later

- Assemblies and mates.
- Drawings, dimensions, and inspection tools.
- Constraint solving, design tables, and variant management.
