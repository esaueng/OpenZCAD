/**
 * H02 whole-worker retention: a long editing session must not grow the
 * history kernel's arena without bound.
 *
 * A checkpoint restore retires every later arena slot as a tombstone that
 * keeps its value, and slots are never reused. Before the arena-wear bound,
 * 300 alternating offset and fillet-radius edits of the filleted union left
 * 343k retired slots, grew WASM linear memory from 32 to 270 MB and the
 * accounted checkpoint estimate from 1.2 to 157 MB (past the 128 MiB
 * admission budget, so checkpoints started to drop), and slowed a one-feature
 * edit from about 47 to 58 ms, while the replay-work recycle never fired.
 *
 * Here small thresholds wear the arena out within a few edits. The idle
 * warm-up the worker schedules (`warmHistory`) must then compact it into a
 * fresh kernel with the same published geometry, and a session that never
 * idles must be recycled before its next build.
 *
 * `SUSTAINED_EDITS=300 SUSTAINED_OUT=<file>` also runs the production
 * thresholds over a long session and writes one JSON line per ten edits and
 * per compaction (sync time, arena slots, linear memory, post-GC Node heap);
 * `SUSTAINED_IDLE=0` leaves out the idle compactions.
 */
import { writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import {
  HISTORY_ARENA_COMPACT_RETIRED_SLOTS,
  HISTORY_ARENA_RECYCLE_RETIRED_SLOTS,
  historyArenaWear,
  type HistoryArenaRetentionLimits
} from '../packages/kernel-adapter/src/exact-history-cache';
import type { BodyId, DerivedState, ProjectDocument } from '@openzcad/shared';
import { deleteFeature, patternBody } from '@openzcad/document-core';
import { filletedUnion } from './support/filleted-union';

const OFFSETS = [-6.28, -5.5, -4.75, -4, -3.25, -2.5];
const RADII = [5, 4.5, 4, 3.5];

function featureNamed(document: ProjectDocument, name: string) {
  const node = Object.values(document.nodes).find(
    (candidate) => candidate.kind === 'feature' && candidate.name === name
  );
  if (!node || node.kind !== 'feature') throw new Error(`No feature ${name}`);
  return node;
}

/** Edit `n`: two of every three move the top face, the third the fillet. */
function nextEdit(document: ProjectDocument, n: number): ProjectDocument {
  const next = structuredClone(document);
  next.version += 1;
  if (n % 3 === 2) {
    const fillet = featureNamed(next, 'Junction fillet').data as unknown as {
      size: number;
    };
    fillet.size = RADII[n % RADII.length]!;
  } else {
    const top = featureNamed(next, 'Offset top').data as unknown as {
      operation: { offset: number };
    };
    top.operation.offset = OFFSETS[n % OFFSETS.length]!;
  }
  return next;
}

/** What a sync publishes about a body, for exact comparison across kernels. */
function published(derived: DerivedState, bodyId: BodyId) {
  const body = derived.bodyRepresentations[bodyId]!;
  return {
    volume: body.volume,
    faceCount: body.faceCount,
    bbox: body.bbox,
    faces: body.topology?.faces.map((face) => ({
      reference: face.reference?.lineageName,
      area: face.geometry?.area
    })),
    edges: body.topology?.edges.length,
    triangles: body.mesh.indices.length / 3,
    warnings: derived.warnings
  };
}

async function session(limits?: HistoryArenaRetentionLimits) {
  const events: RebuildCacheEvent[] = [];
  const adapter = await createExactKernelAdapter({
    measurementCacheDiagnostics: true,
    ...(limits ? { historyArenaRetention: limits } : {}),
    onRebuildCacheEvent: (event) => events.push(event)
  });
  const { document, bodyId } = await filletedUnion(adapter);
  return { adapter, events, document, bodyId };
}

const retired = (event: RebuildCacheEvent | undefined) =>
  event?.checkpointMemory?.retiredSlots ?? NaN;

async function freshBuild(document: ProjectDocument, bodyId: BodyId) {
  const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
  try {
    return published(await fresh.syncDocument(document), bodyId);
  } finally {
    fresh.dispose();
  }
}

describe('history arena wear', () => {
  it('classifies retired slots against the live ones', () => {
    const live = 10_000;
    const wear = (retiredSlots: number) =>
      historyArenaWear({ allocatedSlots: live + retiredSlots, retiredSlots });
    expect(wear(0)).toBe('fresh');
    expect(wear(HISTORY_ARENA_COMPACT_RETIRED_SLOTS - 1)).toBe('fresh');
    expect(wear(HISTORY_ARENA_COMPACT_RETIRED_SLOTS)).toBe('worn');
    expect(wear(HISTORY_ARENA_RECYCLE_RETIRED_SLOTS)).toBe('exhausted');
    // A large model's own live entities never count as wear: its retired
    // slots must also outnumber the live ones four times over.
    expect(
      historyArenaWear({
        allocatedSlots: 400_000 + 300_000,
        retiredSlots: 300_000
      })
    ).toBe('fresh');
    expect(
      historyArenaWear(
        { allocatedSlots: 1_000 + 5_000, retiredSlots: 5_000 },
        { compactRetiredSlots: 4_096, recycleRetiredSlots: 8_192 }
      )
    ).toBe('worn');
  });
});

describe('sustained session retention', () => {
  it(
    'compacts a worn arena at idle with the same published geometry',
    {
      timeout: 180_000
    },
    async () => {
      const limits = { compactRetiredSlots: 8_192, recycleRetiredSlots: 1e9 };
      const { adapter, events, document, bodyId } = await session(limits);
      let current = document;
      let compactions = 0;
      let maxRetired = 0;
      let capturedWhileWorn = 0;
      for (let n = 0; n < 45; n += 1) {
        current = nextEdit(current, n);
        current.derived = await adapter.syncDocument(current);
        maxRetired = Math.max(maxRetired, retired(events.at(-1)));
        if (!adapter.needsHistoryWarmup!(current.projectId)) continue;
        // A worn kernel is never persisted: it would carry its tombstones
        // into every reopened session.
        if (await adapter.captureHistorySession!(current))
          capturedWhileWorn += 1;
        const before = published(current.derived, bodyId);
        expect(await adapter.warmHistory!(current)).toBe(true);
        compactions += 1;
        expect(adapter.needsHistoryWarmup!(current.projectId)).toBe(false);
        // The swapped-in kernel publishes exactly what the worn one did.
        const again = structuredClone(current);
        again.version += 1;
        const after = await adapter.syncDocument(again);
        expect(published(after, bodyId)).toEqual(before);
        expect(retired(events.at(-1))).toBeLessThan(limits.compactRetiredSlots);
        current = again;
        current.derived = after;
      }
      expect(compactions).toBeGreaterThanOrEqual(2);
      expect(capturedWhileWorn).toBe(0);
      expect(events.some((event) => event.recycleReason)).toBe(false);
      // Bounded by the threshold plus the edits before the next idle moment.
      expect(maxRetired).toBeLessThan(4 * limits.compactRetiredSlots);
      // And the compacted session still builds what a fresh kernel builds.
      expect(published(current.derived, bodyId)).toEqual(
        await freshBuild(current, bodyId)
      );
      expect(await adapter.captureHistorySession!(current)).not.toBeNull();
    }
  );

  it(
    'recycles a session that never idles before its next build',
    {
      timeout: 180_000
    },
    async () => {
      const limits = {
        compactRetiredSlots: 8_192,
        recycleRetiredSlots: 16_384
      };
      const { adapter, events, document, bodyId } = await session(limits);
      let current = document;
      let maxRetired = 0;
      for (let n = 0; n < 45; n += 1) {
        current = nextEdit(current, n);
        current.derived = await adapter.syncDocument(current);
        maxRetired = Math.max(maxRetired, retired(events.at(-1)));
      }
      const recycles = events.filter(
        (event) => event.recycleReason === 'arena-retention'
      );
      expect(recycles.length).toBeGreaterThanOrEqual(1);
      for (const event of recycles) {
        expect(event.kind).toBe('full-rebuild');
        expect(retired(event)).toBeLessThan(limits.compactRetiredSlots);
      }
      // One build past the threshold at most: the recycle runs before the next.
      expect(maxRetired).toBeLessThan(2 * limits.recycleRetiredSlots);
      expect(published(current.derived, bodyId)).toEqual(
        await freshBuild(current, bodyId)
      );
    }
  );

  it(
    'sees slots retired by restores that replay nothing',
    {
      timeout: 180_000
    },
    async () => {
      // Unit-scaled STEP exports of an unchanged model allocate scaled copies
      // that the export's own checkpoint restore retires, with no feature
      // replayed: before the fix neither the wear nor the replay budget saw
      // them, so the arena grew past both thresholds unnoticed.
      const limits = { compactRetiredSlots: 8_192, recycleRetiredSlots: 1e9 };
      const { adapter, events, document, bodyId } = await session(limits);
      const kernel = () =>
        (adapter as unknown as { historyKernel: unknown }).historyKernel;
      const before = kernel();
      let exports = 0;
      while (
        !adapter.needsHistoryWarmup!(document.projectId) &&
        exports < 150
      ) {
        await adapter.exportStep(document, [bodyId], { units: 'inch' });
        exports += 1;
      }
      // About 194 retired slots per export against about 4,850 live: worn
      // once retired slots pass four times the live ones, near export 90.
      expect(adapter.needsHistoryWarmup!(document.projectId)).toBe(true);
      expect(exports).toBeGreaterThan(50);
      expect(kernel()).toBe(before);
      // The live result the worker would schedule the idle work for: a sync
      // of the unchanged document, which replays nothing and stays worn.
      await adapter.syncDocument(document);
      expect(events.at(-1)?.replayed).toBe(0);
      expect(adapter.needsHistoryWarmup!(document.projectId)).toBe(true);
      // Worn, so not persisted; after the idle compaction it is.
      expect(await adapter.captureHistorySession!(document)).toBeNull();
      expect(await adapter.warmHistory!(document)).toBe(true);
      expect(await adapter.captureHistorySession!(document)).not.toBeNull();

      expect(events.length).toBeGreaterThan(0);
    }
  );

  it(
    'sees an undo that alone wears the arena out, and refuses to persist it',
    {
      timeout: 180_000
    },
    async () => {
      // Undoing a terminal feature restores the checkpoint before it and
      // replays nothing; that restore alone retires the feature's slots.
      // Before the fix no checkpoint admission re-read the arena then, so a
      // worn kernel still reported fresh and could be persisted.
      //
      // Retired slots must also outnumber live ones four to one. Unit-scaled
      // exports (each retires a few hundred slots) build that up with the
      // threshold out of reach; then the threshold is set just above the
      // retired count (the limits are read on every call), so the undo is
      // what crosses it.
      const limits = { compactRetiredSlots: 1e9, recycleRetiredSlots: 1e9 };
      const { adapter, events, document, bodyId } = await session(limits);
      const patterned = patternBody(document, {
        name: 'Row',
        targetBodyId: bodyId,
        patternKind: 'linear',
        count: 8,
        axis: 'x',
        spacing: 80
      });
      const { exportableBodyIds: exportable } = await adapter.syncDocument(
        patterned.document
      );
      expect(exportable.length).toBeGreaterThan(0);
      const stats = () => events.at(-1)!.checkpointMemory!;
      for (let n = 0; ; n += 1) {
        await adapter.exportStep(patterned.document, exportable, {
          units: 'inch'
        });
        await adapter.syncDocument(patterned.document);
        const { allocatedSlots, retiredSlots } = stats();
        if (retiredSlots >= 4 * (allocatedSlots - retiredSlots) + 4_000) break;
        if (n > 300) throw new Error('The arena never wore out.');
      }
      limits.compactRetiredSlots = stats().retiredSlots + 500;
      await adapter.syncDocument(patterned.document);
      expect(adapter.needsHistoryWarmup!(document.projectId)).toBe(false);

      const row = featureNamed(patterned.document, 'Row');
      const undone = deleteFeature(patterned.document, {
        featureId: row.featureId
      });
      await adapter.syncDocument(undone);
      expect(events.at(-1)?.replayed).toBe(0);
      expect(stats().retiredSlots).toBeGreaterThanOrEqual(
        limits.compactRetiredSlots
      );
      expect(adapter.needsHistoryWarmup!(undone.projectId)).toBe(true);
      expect(await adapter.captureHistorySession!(undone)).toBeNull();
      expect(await adapter.warmHistory!(undone)).toBe(true);
      expect(await adapter.captureHistorySession!(undone)).not.toBeNull();
    }
  );

  const longEdits = Number(process.env.SUSTAINED_EDITS ?? 0);
  it.runIf(longEdits > 0)(
    'records a long session at the production thresholds',
    { timeout: 3_600_000 },
    async () => {
      setFlagsFromString('--expose-gc');
      const gc = runInNewContext('gc') as () => void;
      const idle = process.env.SUSTAINED_IDLE !== '0';
      const { adapter, events, document } = await session();
      let current = document;
      const rows: string[] = [];
      let compactions = 0;
      for (let n = 0; n < longEdits; n += 1) {
        current = nextEdit(current, n);
        const started = performance.now();
        current.derived = await adapter.syncDocument(current);
        const ms = performance.now() - started;
        let compactMs: number | null = null;
        if (idle && adapter.needsHistoryWarmup!(current.projectId)) {
          const compactStart = performance.now();
          if (await adapter.warmHistory!(current)) compactions += 1;
          compactMs = performance.now() - compactStart;
        }
        if (n % 10 === 0 || n === longEdits - 1 || compactMs !== null) {
          gc();
          const usage = process.memoryUsage();
          const event = events.at(-1)!;
          rows.push(
            JSON.stringify({
              edit: n,
              ms: Math.round(ms),
              compactMs: compactMs === null ? null : Math.round(compactMs),
              kind: event.kind,
              replayed: event.replayed,
              recycle: event.recycleReason ?? null,
              linearMemoryBytes: event.checkpointMemory?.linearMemoryBytes,
              allocatedSlots: event.checkpointMemory?.allocatedSlots,
              retiredSlots: event.checkpointMemory?.retiredSlots,
              checkpoints: event.checkpointMemory?.checkpoints,
              estimatedBytes: event.checkpointMemory?.estimatedBytes,
              heapUsed: usage.heapUsed,
              rss: usage.rss
            })
          );
        }
      }
      const summary = {
        idle,
        compactions,
        recycles: events.filter((event) => event.recycleReason).length,
        syncs: events.length
      };
      if (process.env.SUSTAINED_OUT)
        writeFileSync(
          process.env.SUSTAINED_OUT,
          `${rows.join('\n')}\n${JSON.stringify(summary)}\n`
        );
      expect(
        Math.max(...events.map(retired).filter(Number.isFinite))
      ).toBeLessThan(2 * HISTORY_ARENA_RECYCLE_RETIRED_SLOTS);
    }
  );
});
