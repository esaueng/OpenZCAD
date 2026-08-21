# OpenZCAD Roadmap

Status snapshot: 2026-08-19, schema v6. “Working” below means implemented on
the current branch; production enablement is a separate rollout decision.

## Working now

- Schema-v6 canonical documents with v1–v5 normalization, checkpoints, asset
  references, command replay, transactions, undo/redo, and local-first autosave.
- A browser-worker Remus exact adapter with primitives, multi-profile
  sweeps, transforms, booleans, finishing, patterns, mirror-copy, shell, solid
  offset, validity checks, measurements, and exact STEP/STL export.
- Exact schema-v5 topology witnesses plus semantic lineage for the proved
  primitive, sweep, and supported rigid-transform subset. Unsupported evolution
  remains explicitly hash-only and every ambiguous resolution fails closed.
- True face-attached sketches on both exact adapters: a lineage reference is
  resolved at the sketch’s history position and its deterministic planar frame
  is rebuilt from the evolved face. Deleted, ambiguous, non-planar, or
  unsupported faces stop the rebuild; legacy attachments use their stored
  migration frame with a warning.
- Modeling UI and command preflight for mirror, shell opening-face selection,
  and positive-outward solid offset. Remus mirror refuses dense
  blended/boolean bodies when the pinned kernel does not preserve measured
  solid volume. (The OpenCascade convex-planar solid-offset refusal is gone
  with the kernel — Z5.)
- A bounded, kernel-neutral imported-feature recognizer for blind holes,
  counterbores, countersinks, bosses, prismatic pockets, and conical tapers.
  This is a tested read-only proof module, not live product editing yet.
- Owner/editor/viewer sharing APIs and UI, one persisted project-wide edit
  lease, per-message authorization, and recovery-copy-first conflict actions.
  Unresolved local divergence survives dialog close/reload. The checked-in
  beta configuration enables the sharing and lease-enforcement flags for
  authenticated accounts; the development configuration keeps them off.
- Strict AI contracts and digest-bound preflight for the existing operations
  plus face sketches, multi-profile extrusion, mirror, shell, solid offset, and
  validated direct edits. The six newer families are independently dark behind
  rollout flags; recognized imported-feature operations remain explicitly
  disabled.
- Lazy exact-adapter/Remus loading in the geometry worker,
  tagged loading/rebuild lifecycle, coalesced broadcasts, and a canonical
  rebuild LRU bounded to 8 entries, 32 MiB, and 4 in-flight loads.
- CAD workspace, selection/topology labels, on-model direct manipulation,
  command palette, orientation widget, assistant panel, and the existing
  measured viewport edge batching.
- Debounced cloud-settings autosave with serialized requests, revision-safe
  retry, flush-before-logout, offline pause/resume, and dirty-state recovery.
- Project cloud sync between a user's own devices ([ADR-016](docs/adrs/ADR-016-project-cloud-sync.md)):
  adoption of device-only projects into the account keeping their id; debounced
  cloud document autosave on a separate endpoint from revision checkpoints;
  freshness polling on focus, reconnect, and interval; a recorded per-device
  sync baseline that makes both-moved divergence detectable and recoverable
  outside a live room; bounded revision retention with per-account byte
  accounting; and a switchable, visible sync state. `PROJECT_PERSONAL_SYNC_ENABLED`
  is enabled in the checked-in beta configuration, unset (off) in the
  development configuration, and independent of sharing.
- Signed-off orientation cube with face and corner snapping, an origin-corner
  XYZ triad, drag orbiting, and pointer-lifecycle cleanup.
- Start-screen archive, recycle bin, pinning, and manual project ordering.
- Model browser visibility/selection controls, human-readable topology labels,
  explicit command lifecycle states, edge measurements, and sketch snapping.
- Drawing-assisted proposals from raster images and PDFs with projection,
  units, scale, and dimension-audit metadata.

## Release gates / next

- `PROJECT_PERSONAL_SYNC_ENABLED` is now on in the checked-in beta
  configuration (it remains deliberately separate from
  `PROJECT_SHARING_ENABLED`): exercise cross-device sync against a real beta
  session and confirm migration 0010 is applied remotely.
- Run the collaboration recovery-copy reload E2E against a real beta session
  and verify revocation/lease expiry for the sharing rollout now enabled in
  the checked-in beta configuration.
- Connect the imported-feature proof query to live kernel face adjacency and add
  deterministic coordinated edit commands before enabling those UI or AI paths.
- Extend verified lineage through production boolean post-processing, blends,
  patterns, direct edits, and STEP provenance. Do not substitute nearest-face
  or traversal-order rebinding.
- Benchmark cold first rebuild, warm cache hits, eviction, retained worker
  memory, and large-document cloning on target hardware. Current cache limits
  are safety bounds, not a measured performance promise.
- Measure the consolidated viewport edge overlays on target hardware and retain
  the Heat Sink interaction probe as the acceptance signal.
- Add multi-profile editing refinements and richer sketch constraints only
  through deterministic commands. (Partial revolve shipped: the revolve form
  exposes `angleDeg` and `test/partial-revolve.test.ts` pins it. Two-sided
  extrude shipped the same way: `backDistance` on the extrude command and
  form, mutually exclusive with `symmetric`, `test/two-sided-extrude.test.ts`
  pins volume, placement, and legacy byte-compatibility.)
- Enable AI imported-feature operations only after the equivalent manual
  command and exact preflight are shipping and tested.

## Later

- Assemblies and mates.
- Drawings, dimensions, and inspection tools.
- Constraint solving, design tables, and variant management.
- Region-of-interest cropping for a drawing sheet, so a detail view can be
  sent at full resolution.
- Turning a drawing's dimension audit into editable parameter overrides
  applied without a new proposal.
