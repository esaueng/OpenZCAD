# ADR-004: MVP Ships With Honest Mock Kernel Boundary

## Status
Superseded by ADR-005: the mock kernel has been replaced by the built-in polyhedral kernel (`packages/geometry`). The adapter boundary this ADR introduced is retained.

## Decision
The MVP implements a browser-side kernel adapter boundary plus a mock local kernel so the application remains runnable before full OpenCascade.js integration lands.

## Rationale
This keeps the architecture correct now while avoiding fake Worker-side geometry and avoiding misleading STEP export behavior.
