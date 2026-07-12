# OpenZCAD Roadmap

## Working now

- Schema-v2 canonical documents with migrations, checkpoints, asset references, command replay, transactions, undo/redo, and local-first autosave.
- OpenCascade browser-worker kernel with exact primitives, sweeps, transforms, booleans, validity checks, measurements, and exact STEP/STL export.
- Three-pane CAD workspace, feature editing, diagnostics, selection, responsive compact layout, and AI command rail.
- Configurable streamed AI proposals with strict structured output, dry-run preview, explicit approval, and undoable application.
- Beta Cloudflare project, revision, upload, export, artifact, and AI routes.

## Next

- Authentication and per-project authorization.
- Editable exact STEP import represented in the canonical feature/document model.
- Face/edge selection and face-attached sketches.
- Fillet, chamfer, shell/offset, mirror, and linear/circular patterns.
- Multi-profile sketches, holes/pockets, partial revolve, and symmetric/two-sided extrude.
- Broader deterministic AI patch operations for those features.
- Cache and loading UX improvements for the exact-kernel WASM module.

## Later

- Assemblies and mates.
- Drawings, dimensions, and inspection tools.
- Collaboration presence, locks, and conflict resolution on the existing Durable Object scaffold.
