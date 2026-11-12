/**
 * Reopen timing harness for persisted history sessions
 * (`exact-session-snapshot.ts`). Not a regression test: it is skipped unless
 * SESSION_PERF_PROJECT names a native `.openzcad` file (kept outside the
 * repository), so CI never runs it.
 *
 * It times what a reload costs today (a cold replay of the whole history in
 * a fresh adapter) against a reopen from the session the first adapter
 * captured, after a structured clone (what IndexedDB stores), and checks the
 * two projections are equal. Reported: wall time of each, the session's
 * kernel bytes, accounted bytes, capture and clone time, and both syncs'
 * cache events.
 *
 *   pnpm exec vitest run --config test/perf/session-restore-perf.config.ts
 *
 * Environment: SESSION_PERF_PROJECT, SESSION_PERF_SAMPLES (default 3),
 * REMUS_WASM_PKG / REMUS_WASM_IO_PKG for a local kernel build.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import {
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  estimateStructuredBytes,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import type { BodyId, DerivedState, ProjectDocument } from '@openzcad/shared';

const projectPath = process.env.SESSION_PERF_PROJECT;
const samples = Number(process.env.SESSION_PERF_SAMPLES ?? 3);
const IDLE = { lineageDemand: [] as BodyId[] };

function comparable(derived: DerivedState) {
  const { updatedAt: _updatedAt, ...rest } = derived;
  return {
    ...rest,
    bodyRepresentations: Object.fromEntries(
      Object.entries(derived.bodyRepresentations).map(([id, body]) => {
        const { projectionRevision: _revision, ...kept } = body;
        return [id, kept];
      })
    )
  };
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[values.length >> 1]!;

it.skipIf(!projectPath)('reopen from a persisted session', async () => {
  const document = withoutDerivedProjection(
    normalizeDocument(
      (
        JSON.parse(readFileSync(projectPath!, 'utf8')) as {
          document: ProjectDocument;
        }
      ).document
    )
  );
  const replay: number[] = [];
  const restore: number[] = [];
  const capture: number[] = [];
  const clone: number[] = [];
  let report: Record<string, unknown> = {};
  for (let sample = 0; sample < samples; sample += 1) {
    const events: RebuildCacheEvent[] = [];
    const source = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    let started = performance.now();
    const replayed = await source.syncDocument(
      document,
      undefined,
      undefined,
      undefined,
      IDLE
    );
    replay.push(performance.now() - started);
    started = performance.now();
    const session = await source.captureHistorySession!(document);
    capture.push(performance.now() - started);
    expect(session).not.toBeNull();
    source.dispose();
    started = performance.now();
    const stored = structuredClone(session!);
    clone.push(performance.now() - started);

    const reopened = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    started = performance.now();
    const restored = await reopened.syncDocument(
      document,
      undefined,
      undefined,
      undefined,
      { ...IDLE, persistedSession: stored }
    );
    restore.push(performance.now() - started);
    reopened.dispose();
    expect(events[1]!.sessionRestore).toBe('restored');
    expect(comparable(restored)).toEqual(comparable(replayed));
    report = {
      features: document.featureOrder.length,
      kernelBytes: session!.kernelBytes.byteLength,
      accountedBytes: estimateStructuredBytes(session),
      events
    };
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ...report,
        replayMs: replay.map(Math.round),
        restoreMs: restore.map(Math.round),
        captureMs: capture.map(Math.round),
        cloneMs: clone.map(Math.round),
        medians: {
          replayMs: Math.round(median(replay)),
          restoreMs: Math.round(median(restore)),
          captureMs: Math.round(median(capture)),
          cloneMs: Math.round(median(clone))
        }
      },
      null,
      1
    )}\n`
  );
});
