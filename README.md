# OpenZCAD

OpenZCAD is a simple, open-source, browser-based **parametric CAD design tool**. You model parts with primitives, sketches, extrudes, revolves, and real boolean operations; drive every dimension from a named parameter table; and export true STEP (ISO 10303-21, AP214) and STL files. That is the whole product — OpenZCAD is purely a CAD design tool.

## What it does

- **Parametric modeling** — a parameter table (`w = 30`, `slot = w / 2 - 4`) feeds every feature input. Any numeric field accepts an expression (`+ - * / ^`, `pi`, `sqrt`, `min/max`, degree-based `sin/cos/tan`, …). Edit a parameter and the whole model rebuilds.
- **Features** — box / cylinder / sphere / cone / torus primitives; sketches (rectangle, circle, N-gon on the XY/XZ/YZ planes with offsets) that you extrude or revolve; union / subtract / intersect booleans (real CSG — inputs are consumed, results are watertight); move/rotate transforms. Every feature is editable, renameable, and deletable after creation, with full undo/redo and deterministic replay.
- **True STEP export** — a built-in ISO 10303-21 writer emits AP214 files with a full product structure and exact faceted B-Rep topology (shared vertices, every edge referenced exactly twice with opposite orientation), so FreeCAD / SolidWorks / Fusion read closed solids. Curved surfaces are tessellated by the kernel; all faces are planar. ASCII STL export and STL import (real triangle geometry) are included; STEP import is metadata-only until a native kernel lands.
- **Browser kernel** — geometry rebuilds run in a Web Worker from a small built-in polyhedral B-Rep kernel (`packages/geometry`): exact prisms, tessellated curved solids, BSP-based CSG with T-junction healing, watertightness validation, volume/bounds measurement.

## Monorepo

- `apps/web`: React + Vite SPA plus Cloudflare Worker API.
- `packages/geometry`: polyhedral solid kernel (primitives, sweeps, CSG, validation).
- `packages/document-core`: parametric document model, parameter table, expression engine.
- `packages/command-system`: deterministic replayable commands, undo/redo, transactions.
- `packages/kernel-adapter`: turns documents into solids, meshes, and export payloads.
- `packages/io-step` / `packages/io-stl`: STEP writer + metadata reader, STL reader/writer.
- `packages/viewport`, `packages/persistence`, `packages/cloudflare-adapters`, `packages/jobs`, `packages/plugin-api`: rendering, save/load, and platform plumbing.

See `architecture.md` for the layer map, API behavior, and current security posture.

## Commands

- `pnpm install` — install workspace dependencies.
- `pnpm dev:web` — Vite dev server with the Cloudflare plugin (Worker API included).
- `pnpm build` — production build of the web app and worker.
- `pnpm test` — vitest unit/integration suite (`test/`), including geometry and STEP-validity tests.
- `pnpm lint` / `pnpm typecheck` — ESLint (type-checked rules) and tsc.
- `pnpm exec playwright test` — e2e modeling smoke test (builds and serves a preview automatically; requires Playwright browsers).
- `pnpm deploy:beta` — deploy the beta Worker via wrangler.

## Status

- Modeling, parameters, feature editing, booleans, undo/redo, replay, save/load, STEP/STL export are implemented and tested (watertightness, exact CSG volumes, STEP topology pairing).
- STEP files are faceted B-Rep: valid and watertight, with planar faces only. Analytic surfaces (true cylinders/spheres in STEP) and full STEP import arrive with a native OpenCascade.js kernel (see `TODO.md`).
- No authentication yet; the beta API acts as a fixed development user.
