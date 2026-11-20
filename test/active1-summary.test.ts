import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FACE_DRAG_CASES,
  summarize
} from '../scripts/measure-active1-baselines.mjs';
import { ACTIVE1_BUDGETS } from '../scripts/active1-budgets.mjs';

/**
 * `measure-active1-baselines.mjs --summarize` over the H02 face-drag and
 * orbit probes' result files: medians across runs, the right distribution
 * per case, and the budgets in `active1-budgets.mjs`.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

const dist = (p50: number, p95: number) => ({
  n: 10,
  p50,
  p95,
  max: p95,
  mean: p50
});

function drag(
  label: string,
  exact: boolean,
  lag: [number, number],
  release: number
) {
  return {
    label,
    summary: {
      presentedFrames: exact ? 40 : 0,
      proxyPresentedFrames: exact ? 0 : 40,
      steadyPointerToPresentedMs: exact ? dist(...lag) : dist(0, 0),
      pointerToProxyFrameMs: exact ? dist(0, 0) : dist(...lag),
      firstGeometryMs: exact ? lag[0] * 2 : null,
      releaseToFrameMs: release
    },
    rendering: { motion: { intervalMs: dist(16.7, 20 + lag[0] / 10) } }
  };
}

function orbit(scene: string, throttle: number, p95: number, pct: number) {
  return {
    scene,
    throttle,
    orbit: {
      frame: { p50: 16.7, p95, p99: p95 * 2 },
      dropped: { missed: 3, refreshes: 360, pct }
    }
  };
}

describe('Active 1 summary: face drags and orbits', () => {
  it('takes medians across runs, per case, with budgets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'active1-summary-'));
    dirs.push(dir);
    const runs = [
      [drag('union', true, [40, 70], 300), drag('box cap', false, [8, 12], 90)],
      [drag('union', true, [44, 90], 310), drag('box cap', false, [9, 14], 95)],
      [drag('union', true, [42, 80], 900), drag('box cap', false, [7, 13], 85)]
    ];
    writeFileSync(
      join(dir, 'face-drag.jsonl'),
      runs
        .flat()
        .map((line) => JSON.stringify(line))
        .join('\n')
    );
    for (const [round, p95] of [
      [0, 18],
      [1, 22],
      [2, 20]
    ] as const) {
      mkdirSync(join(dir, `orbit-r${round}`));
      writeFileSync(
        join(dir, `orbit-r${round}`, 'summary.json'),
        JSON.stringify([
          orbit('torus', 1, p95, 1),
          orbit('torus', 4, p95 * 3, 20)
        ])
      );
    }
    const rows = summarize(dir);
    const row = (measurement: string) =>
      rows.find((entry) => entry.measurement === measurement);
    expect(row('Face drag pointer → exact frame p95 (union)')).toMatchObject({
      runs: 3,
      median: 80,
      min: 70,
      max: 90
    });
    expect(row('Face drag first exact geometry (union)')?.median).toBe(84);
    // A proxy-only case reports proxy frames and has no exact first frame.
    expect(row('Face drag pointer → proxy frame p50 (box cap)')?.median).toBe(
      8
    );
    expect(row('Face drag first exact geometry (box cap)')).toBeUndefined();
    // The median, not the mean, absorbs one slow release.
    expect(row('Face drag release → accepted frame (union)')?.median).toBe(310);
    expect(row('Orbit frame interval p95 (torus x1)')?.median).toBe(20);
    expect(row('Orbit frame interval p99 (torus x4)')?.median).toBe(120);
    expect(row('Orbit dropped refreshes (torus x4)')).toMatchObject({
      median: 20,
      unit: '%'
    });
    // Unbudgeted rows are recorded, never judged.
    for (const entry of rows)
      if (entry.budget == null) expect(entry.withinBudget).toBeNull();
  });

  it('summarizes sustained sessions against their budgets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'active1-sustained-'));
    dirs.push(dir);
    const row = (edit: number, heapMiB: number, ms: number) =>
      JSON.stringify({
        edit,
        ms,
        compactMs: null,
        replayed: 1,
        linearMemoryBytes: (edit < 50 ? 60 : 97) * 2 ** 20,
        retiredSlots: 1_000 * (edit % 60),
        heapUsed: heapMiB * 2 ** 20
      });
    const lines = Array.from({ length: 30 }, (_, i) =>
      row(i * 10, 72 + (i >= 20 ? 0.5 : 0), i >= 20 ? 46 : 44)
    );
    writeFileSync(
      join(dir, 'sustained-r0.jsonl'),
      [...lines, JSON.stringify({ idle: true, compactions: 5 })].join('\n')
    );
    const rows = summarize(dir);
    const find = (name: string) =>
      rows.find((entry) => entry.measurement.startsWith(name))!;
    expect(find('Sustained session: peak WASM').median).toBe(97);
    expect(find('Sustained session: peak retired').median).toBe(50_000);
    expect(find('Sustained session: post-GC heap').median).toBeCloseTo(0.5);
    expect(find('Sustained session: one-feature').median).toBeCloseTo(46 / 44);
    expect(rows.filter((entry) => entry.withinBudget === false)).toEqual([]);
    expect(ACTIVE1_BUDGETS.sustained.peakRetiredSlots).toBe(131_072);
  });

  it('runs only the public face-drag cases', () => {
    const cases = FACE_DRAG_CASES.split('|');
    expect(cases).toHaveLength(4);
    expect(FACE_DRAG_CASES).not.toMatch(/supplied|imported/);
    expect(ACTIVE1_BUDGETS.faceDragTargets.lagP95Ms).toBe(50);
  });
});
