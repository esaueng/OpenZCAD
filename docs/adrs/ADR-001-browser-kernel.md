# ADR-001: Geometry Kernel Runs In Browser

## Decision
The CAD kernel runtime executes inside browser Web Workers, not in Cloudflare Workers.

## Rationale
This preserves Cloudflare Workers for orchestration, keeps geometry compute close to the interactive client, and allows future remote compute to plug in without changing document semantics.

