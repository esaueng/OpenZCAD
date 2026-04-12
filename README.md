# OpenZCAD

OpenZCAD is a Cloudflare-deployed browser CAD application with a parametric document model, replayable command system, browser-side geometry execution, and Worker-based orchestration.

## Monorepo
- `apps/web`: React + Vite SPA plus Cloudflare Worker API.
- `packages/*`: document model, commands, kernel seam, IO adapters, persistence, jobs, plugins, and Cloudflare adapters.

## Commands
- `pnpm install`
- `pnpm dev:web`
- `pnpm build`
- `pnpm test`
- `pnpm deploy:beta`

## Status
- MVP document, command, API, and UI foundations are implemented.
- Native OpenCascade.js execution, full STEP fidelity, and collaboration conflict resolution remain staged follow-up work.

