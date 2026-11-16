/**
 * Large grid-pattern preview timing (ROADMAP Active 1, H02/W01; production QA
 * 2026-11-14 finding #16). Not part of CI's suites: run deliberately, on a
 * quiet machine, through `scripts/measure-active1-baselines.mjs` or directly:
 *
 *   PATTERN_PERF_RUN=1 pnpm exec vitest run \
 *     --config test/perf/pattern-preview.config.ts
 *
 * Each sample builds the ×50 bar (`test/support/large-pattern-bar.ts`) in a
 * fresh exact adapter, then times what the in-place Grid pattern card's frame
 * costs: the candidate document built as the app builds it (a proposing sync
 * with the live, empty lineage demand). Done then commits that frame, so the
 * live sync after it is timed too and must restore, not replay.
 *
 * Environment:
 * - PATTERN_PERF_GRIDS: `XxY` list, default `3x3,3x10,10x10`.
 * - PATTERN_PERF_SAMPLES: rounds, default 3 (grids interleave per round).
 * - PATTERN_PERF_OUT: JSONL file to append each sample to.
 * - PATTERN_PERF_BUDGET=1: assert the budgets recorded in
 *   docs/performance/2026-11-15-active1-baselines.md.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import type { RebuildProgress } from '../../packages/kernel-adapter/src/rebuild-progress';
import { RemusKernel } from '../../packages/kernel-adapter/src/remus-runtime';
import { barGrid, largePatternBar } from '../support/large-pattern-bar';
import { hostSnapshot } from '../../scripts/perf-host.mjs';
import { ACTIVE1_BUDGETS } from '../../scripts/active1-budgets.mjs';

const run = process.env.PATTERN_PERF_RUN === '1';
const grids = (process.env.PATTERN_PERF_GRIDS ?? '3x3,3x10,10x10')
  .split(',')
  .map((grid) => grid.trim().split('x').map(Number) as [number, number]);
const samples = Math.max(1, Number(process.env.PATTERN_PERF_SAMPLES ?? 3));
const out = process.env.PATTERN_PERF_OUT;

interface Tally {
  ms: number;
  calls: number;
}
const kernelCalls = new Map<string, Tally>();

/** Times every synchronous `RemusKernel` method. Returns the undo. */
function instrumentKernel(): () => void {
  const proto = RemusKernel.prototype as unknown as Record<string, unknown>;
  const originals = new Map<string, PropertyDescriptor>();
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor' || name === 'free') continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || typeof descriptor.value !== 'function') continue;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    originals.set(name, descriptor);
    Object.defineProperty(proto, name, {
      ...descriptor,
      value(this: unknown, ...args: unknown[]) {
        const start = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          const tally = kernelCalls.get(name) ?? { ms: 0, calls: 0 };
          tally.ms += performance.now() - start;
          tally.calls += 1;
          kernelCalls.set(name, tally);
        }
      }
    });
  }
  return () => {
    for (const [name, descriptor] of originals)
      Object.defineProperty(proto, name, descriptor);
  };
}

function topKernelCalls(limit = 8) {
  return [...kernelCalls.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, limit)
    .map(([method, { ms, calls }]) => ({
      method,
      ms: Number(ms.toFixed(1)),
      calls
    }));
}

it.skipIf(!run)(
  'times large grid-pattern previews on the ×50 bar',
  { timeout: 3_600_000 },
  async () => {
    const restore = instrumentKernel();
    const results: { grid: string; previewMs: number }[] = [];
    try {
      for (let round = 0; round < samples; round += 1) {
        for (const [count, count2] of grids) {
          const grid = `${count}x${count2}`;
          const hostBefore = hostSnapshot();
          const events: RebuildCacheEvent[] = [];
          const adapter = await createExactKernelAdapter({
            onRebuildCacheEvent: (event) => events.push(event)
          });
          try {
            const { document: base, bar } = largePatternBar();
            let started = performance.now();
            await adapter.syncDocument(base, undefined, undefined, undefined, {
              lineageDemand: []
            });
            const barMs = performance.now() - started;

            const command = commandFactories.patternBody(
              barGrid(bar, count, count2)
            );
            const candidate = command.apply(base);
            const stages: RebuildProgress[] = [];
            kernelCalls.clear();
            events.length = 0;
            started = performance.now();
            const frame = await adapter.syncDocument(
              candidate,
              (progress) => {
                if (progress.status === 'completed') stages.push(progress);
              },
              undefined,
              undefined,
              { proposeCarry: true, lineageDemand: [] }
            );
            const previewMs = performance.now() - started;
            const previewKernel = topKernelCalls();
            const previewKernelMs = [...kernelCalls.values()].reduce(
              (sum, tally) => sum + tally.ms,
              0
            );
            const previewEvents = [...events];

            const manager = new CommandManager(base);
            manager.execute(command);
            events.length = 0;
            started = performance.now();
            await adapter.syncDocument(
              manager.document,
              undefined,
              undefined,
              undefined,
              { lineageDemand: [] }
            );
            const commitMs = performance.now() - started;
            const commitEvent = events.at(-1);

            const patternBody = candidate.bodyOrder.at(-1)!;
            const body = frame.bodyRepresentations[patternBody];
            const sample = {
              probe: 'pattern-preview',
              recordedAt: new Date().toISOString(),
              round,
              grid,
              copies: count * count2,
              barMs,
              previewMs,
              previewKernelMs,
              commitAfterPreviewMs: commitMs,
              commitCache: commitEvent,
              previewCache: previewEvents.at(-1),
              stages: stages.map(({ stage, name, durationMs, outcome }) => ({
                stage,
                name,
                durationMs,
                outcome
              })),
              kernelTop: previewKernel,
              result: {
                warnings: frame.warnings.length,
                faces: body?.topology?.faces?.length ?? null,
                bbox: body?.bbox ?? null
              },
              host: { before: hostBefore, after: hostSnapshot() },
              node: process.version
            };
            if (out) {
              mkdirSync(dirname(out), { recursive: true });
              appendFileSync(out, `${JSON.stringify(sample)}\n`);
            }
            console.log(
              `[pattern-preview] ${grid} round ${round}: bar ${barMs.toFixed(0)} ms, ` +
                `preview ${previewMs.toFixed(0)} ms (kernel ${previewKernelMs.toFixed(0)}), ` +
                `commit ${commitMs.toFixed(0)} ms, ${sample.result.faces} faces, ` +
                `load ${hostBefore.loadAverage1m.toFixed(2)}`
            );
            expect(body, `${grid} preview built the grid`).toBeDefined();
            expect(frame.warnings).toEqual([]);
            expect(commitEvent).toMatchObject({ replayed: 0 });
            results.push({ grid, previewMs });
          } finally {
            adapter.dispose();
          }
        }
      }
    } finally {
      restore();
    }
    const budget = ACTIVE1_BUDGETS.patternPreview10x10.nodeMedianMs;
    if (process.env.PATTERN_PERF_BUDGET === '1' && budget !== null) {
      const tenByTen = results
        .filter((result) => result.grid === '10x10')
        .map((result) => result.previewMs)
        .sort((a, b) => a - b);
      expect(tenByTen.length).toBeGreaterThan(0);
      const median = tenByTen[Math.floor((tenByTen.length - 1) / 2)]!;
      expect(median).toBeLessThanOrEqual(budget);
    }
  }
);
