# OpenZCAD

OpenZCAD is a Cloudflare-deployed browser CAD application with a parametric document model, replayable command system, browser-side geometry execution, and Worker-based orchestration.

## Monorepo
- `apps/web`: React + Vite SPA plus Cloudflare Worker API.
- `packages/*`: document model, commands, kernel seam, IO adapters, persistence, jobs, plugins, and Cloudflare adapters.

See `architecture.md` for the layer map, API behavior, and current security posture.

## Commands
- `pnpm install` — install workspace dependencies.
- `pnpm dev:web` — Vite dev server with the Cloudflare plugin (Worker API included).
- `pnpm build` — production build of the web app and worker.
- `pnpm test` — vitest unit/integration suite (`test/`).
- `pnpm lint` / `pnpm typecheck` — ESLint (type-checked rules) and tsc.
- `pnpm exec playwright test` — e2e smoke test (builds and serves a preview automatically; requires Playwright browsers).
- `pnpm deploy:beta` — deploy the beta Worker via wrangler.

## Status
- MVP document, command, API, and UI foundations are implemented.
- Command logs replay deterministically (IDs are assigned at command creation and serialized with the payload).
- The Worker API validates request bodies and returns structured JSON errors (400/404/413/500).
- Native OpenCascade.js execution, full STEP fidelity, authentication, and collaboration conflict resolution remain staged follow-up work.
