# K02 cancellation audit (2026-10-02)

How exact rebuilds run today, where supersede/stale is guarded, and what is missing.

## Rebuild path

- UI posts a broadcast `{ type: 'sync', document }` per model version
  (`useGeometryWorker.postSync`, `apps/web/src/hooks/useGeometryWorker.ts`); one-off
  `syncOnce`/export/mass-property jobs carry a `requestId`.
- `apps/web/src/worker/geometryWorker.ts` `execute()` runs jobs serially through
  `GeometryWorkerQueue` (`geometryWorkerQueue.ts`), which keeps only the newest queued
  broadcast. A `cancel` message only marks still-queued `requestId` jobs as skipped.
- The sync rebuild is `ExactKernelAdapter.syncDocument`
  (`packages/kernel-adapter/src/exact.ts`) → `buildWithHistoryCache` (prefix restore +
  replay) → `buildDocumentHistory` (`exact-build-loop.ts`, one synchronous pass over
  `listFeaturesInOrder`, per-feature errors recorded as warnings) → measure pass.
  Progress is diagnostic-only (`rebuild-progress.ts`: observers cannot change acceptance
  or interrupt work).

## Supersede today

- A running WASM call cannot be interrupted: a `cancel` that races a running job leaves
  its entry behind (swept in `finally`), the job completes, and its result finds no
  pending request and is discarded. This matches the pinned kernel's contract
  (`remus_wasm.d.ts` on `OperationCancellationToken`: a single-threaded worker cannot
  process a new JS call while WASM runs).
- Broadcasts are dropped when stale at three points: `LatestBroadcastGate.isCurrent`
  before/after the cached rebuild in the worker (`exactRebuildCache.ts`), and the
  `projectId`/`version` match before `onDerived` on the main thread. Explicit
  `requestId` jobs resolve their own promise by design (demo seeding).
- There is no mid-rebuild abort: `buildDocumentHistory` takes no signal, and its
  per-feature `catch` records every throw as a `build-failed` warning and continues.
  A superseded rebuild therefore always burns the full remaining worker time, and any
  future kernel-reported `cancelled` refusal would be recorded as a feature warning
  instead of aborting the build.

## Stale overwrite

- No stale broadcast result can overwrite a newer model: the gate plus the
  `projectId`/`version` check drop it before `onDerived`. The remaining hole is
  inside the adapter: a cancelled build has no typed path, so nothing stops a partial
  `ExactBuildResult` (or a partially pushed checkpoint row) from being kept as if it
  were a successful prefix.

## Refusal mapping

- `KernelRefusalCategory` is extracted from the pin's `SolidOperationDetailedResult`
  (`kernel-refusal.ts`); `cancelled` is already a member, with a presenter sentence in
  `refusalLanguage.ts` (`CATEGORY_SENTENCES`), a boolean clause in
  `exact-boolean-refusal.ts` (`refusalReason`), and a documented slot in the shared
  `FeatureWarning.kernelRefusal` schema. Nothing constructs one yet: no caller passes
  `OperationCancellationToken` or reads `CancellableBooleanResult`.

## Slice taken

- `exact-cancellation.ts`: cooperative `BuildCancellationSignal`, generation guard,
  loop/boolean `cancelled` refusal constructors, cancellable detailed-path booleans via
  `booleanWithCancellation(exact_only=true)` with a `*Detailed` re-classification on
  the failure path (the cancellable entry throws where the twin returns data).
- `exact-build-loop.ts`: boundary check per feature, cancellation rethrown past the
  per-feature warning catch, one shared kernel token per build.
- `exact.ts`: `syncDocument` accepts an optional signal, checked after the pre-build
  awaits; cancelled builds preserve (never invalidate, never publish) the retained
  history/measure caches and rethrow typed.
- Worker passes `cancelledRequests` + broadcast-gate state as the signal; no UI change.
- Follow-ups (not this slice): stop button, cross-thread mid-WASM abort, measure-pass
  checks, budget propagation, cylinder/direct-edit/probe call-site tokens.
