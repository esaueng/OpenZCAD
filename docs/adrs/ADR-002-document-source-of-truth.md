# ADR-002: Document Model Is Source Of Truth

## Decision
Project documents and feature history are canonical. Meshes and thumbnails are cached projections only.

## Rationale
This keeps undo/redo, replay, persistence, collaboration, and future analysis features deterministic.

