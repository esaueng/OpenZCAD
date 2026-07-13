# OpenZCAD Architecture

OpenZCAD is a browser-based parametric CAD design tool — nothing more. The browser owns modeling, the Cloudflare Worker owns orchestration and persistence, and derived geometry artifacts are disposable projections of the parametric document.

## Core layers

- `geometry`: the solid kernel. Solids are polyhedral B-Reps (shared vertices + planar, convex, outward-wound polygon faces). Generators cover box/cylinder/sphere/cone/torus, profile extrude, and full revolve; booleans run BSP CSG with post-pass T-junction healing; `validateSolid` checks the every-edge-used-twice watertightness contract; `solidVolume`/`solidBounds` feed measurements.
- `document-core`: canonical project state — feature tree, sketches, and the **parameter table**. Feature inputs are `ParamValue`s: literal numbers or expression strings evaluated against the parameters at rebuild time (sandboxed recursive-descent parser; never `eval`). Documents are immutable values: every mutating operation clones and returns a new document. Features can be updated, renamed, and deleted after creation (deletion cascades to bodies/sketches; dependents degrade to warnings).
- `command-system`: deterministic mutations, transactions, undo/redo, replay. Command factories pre-assign created IDs and serialize them with the payload, so replaying a command log rebuilds the exact same entity graph. Undo history is capped (100 entries).
- `kernel-adapter`: rebuilds every body from its parametric definition on each sync — evaluate parameters, build solids in feature order, run booleans (inputs become *consumed*), bake transforms into world-space vertices — then derives per-body triangle meshes, face counts, volumes, and bounds. The same `buildSolids` path feeds STEP/STL export, so the viewport and the exported file always agree.
- `io-step`: ISO 10303-21 writer (AP214 `AUTOMOTIVE_DESIGN`). Emits a full product structure and one faceted `MANIFOLD_SOLID_BREP` per body with exact shared topology: one `VERTEX_POINT` per vertex, one `EDGE_CURVE` per undirected edge, two `ORIENTED_EDGE`s per curve with opposite senses. Geometry is scaled to millimetres. Also provides metadata-level STEP reading (product names) for imports.
- `io-stl`: full STL parsing (binary + ASCII, real triangles, 200k-triangle import cap) and ASCII STL writing with computed facet normals.
- `viewport`: render projection only. Bodies arrive as world-space meshes (transforms are baked by the kernel) and render flat-shaded with feature-edge overlays.
- `persistence` / `cloudflare-adapters`: save/load semantics, artifact manifests, upload sessions (15-minute TTL, single use), D1/R2/Queues/DO/Workflow implementations.

## Workspace UI

`apps/web` is a direct-modeling workspace: GlobalTopBar (project identity + save state, Model/Visualize workspace tabs, undo/redo, command search, import/export) over [ToolPalette+ModelBrowser | Viewport | PropertiesInspector] over StatusBar.

- **Command registry** (`src/lib/commands.ts`): every user-facing command is declared once — label, icon name, category, shortcut, availability predicate, contextual-relevance score. The tool palette, command search (S / Ctrl+K), context menus, keyboard map, and shortcut sheet (?) all render from it.
- **Tool sessions** (`src/lib/session.ts`): the live state of one in-progress command (armed → adjust via HUD or on-canvas manipulator → commit as one undoable command / cancel with zero document change). Pure data + pure functions; previews reuse the kernel's `PLANE_BASES`/profile builders so ghost geometry always matches what commit produces.
- **ToolPalette**: vertical grouped tools (Sketch / Create / Modify / Combine) with labels + shortcuts, collapsible groups, and a contextual "For selection" group that reprioritizes (sketch → Extrude/Revolve; one body → Move; 2+ bodies → Booleans). Collapses to an icon rail under 1280px.
- **ModelBrowser**: parameter table plus the feature tree with inline rename (double-click), hover visibility eyes, consumed/failed/hidden badges, and a right-click context menu.
- **Viewport**: dominant region. Hover preselect, click select, shift-click multi-select, pickable sketch-profile outlines, live ghost previews, extrude arrow + move triad manipulators (drag writes back into the HUD value), CommandHUD floating top-center, orientation widget + standard views/projection/fit cluster upper-right, right-click context menu.
- **PropertiesInspector**: collapsible right panel for full parameters of the selected feature (expression fields with live evaluation), measurements, and per-body appearance (Visualize workspace; persisted as node metadata, undoable).

## Geometry sync pipeline

The app posts the document to a browser worker whenever `document.version` changes. The worker rebuilds all solids from the parametric definitions and replies with derived state tagged by `projectId`/`version`; the app discards stale replies and commits matching ones via `commitDerivedState`, which intentionally does not bump `version` (this breaks the re-derive feedback loop and distinguishes model edits from re-derivation). Parameter edits bump `version` like any other command, which is what makes the model parametric end-to-end.

## Cloudflare mapping

- Worker routes expose the project API and upload/export orchestration.
- D1 stores metadata and revision pointers, never large blobs.
- R2 stores uploads, exports, thumbnails, and large snapshots.
- Durable Objects host collaboration room, lock, and presence scaffolding.
- Queues handle background validation and thumbnail requests.
- Workflows orchestrate multi-step import and export pipelines.

## API behavior

- All POST bodies are validated; malformed input returns `400` with `{ "error": string }`. Bodies over 25MB return `413`. Unknown routes/resources return `404`; unexpected failures return `500` without internals.
- `POST /api/projects/:id/revisions` requires the path ID, payload `projectId`, and `document.projectId` to agree, and returns `404` for unknown projects.
- `POST /api/imports/finalize` returns `404` when the upload session is unknown, expired, or already consumed (sessions are single-use).
- Export workflow kick-off is best-effort: the browser performs the actual STEP/STL writing and download; the Worker records the artifact and job.

## CAD rules

- Viewport meshes are never the source of truth; the parametric document is.
- Feature outputs are referenced through stable entity IDs; replay rebuilds identical graphs.
- STEP export writes only real, validated B-Rep topology. Shells that fail the closed-shell check still export but carry an explicit warning instead of silently lying.
- Transforms are baked into geometry by the kernel; representations carry no placement of their own, so every consumer (viewport, CSG, exporters) sees identical coordinates.

## Local development

- `pnpm dev:web` runs the Vite dev server with the Cloudflare Vite plugin.
- Browser workers execute geometry derivation.
- Worker bindings fall back to in-memory development repositories when D1/R2 bindings are absent (state resets per isolate).

## Security posture and known limitations

- **No authentication yet.** Every API request acts as a fixed development user (`user_beta_dev`); project access is not scoped per user beyond the listing query. Real auth must land before any non-beta exposure.
- Parameter expressions are evaluated with a sandboxed recursive-descent parser (never `eval`/`Function`); unknown identifiers and cycles surface as per-parameter errors.
- Upload file names are sanitized before being embedded in R2 object keys; upload sessions expire and are single-use.
- `listProjects` on D1 parses each project's full document JSON to compute revision metadata; acceptable at beta scale, but revision metadata should move to columns before documents grow large.
- The D1 `database_id` in wrangler config is a placeholder; deploys fall back to in-memory persistence until a real beta database is provisioned.
- The kernel is polyhedral: STEP output is faceted B-Rep (planar faces). Curved faces are tessellated at fixed densities; analytic STEP surfaces and STEP B-Rep *import* require the staged OpenCascade.js adapter.
- BSP booleans are robust for typical part modeling but coplanar-face overlaps can produce imperfect shells; such results are flagged by the closed-shell warning rather than hidden.
