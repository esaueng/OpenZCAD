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
 * `measure-active1-baselines.mjs --summarize` over the H02 face-drag, orbit
 * and sustained-session probes' result files: medians across runs, the
 * right distribution per run, and the budgets in `active1-budgets.mjs`.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

type Dist = {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
};
const dist = (p50: number, p95: number): Dist => ({
  n: 10,
  p50,
  p95,
  max: p95,
  mean: p50
});
const none = (): Dist => ({
  n: 0,
  p50: null,
  p95: null,
  max: null,
  mean: null
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
      requests: exact ? 40 : 0,
      presentedFrames: exact ? 40 : 0,
      proxyPresentedFrames: exact ? 0 : 40,
      steadyPointerToPresentedMs: exact ? dist(...lag) : none(),
      pointerToProxyFrameMs: exact ? none() : dist(...lag),
      firstGeometryMs: exact ? lag[0] * 2 : null,
      releaseToFrameMs: release,
      stages: { roundTripMs: dist(lag[0], lag[1]) }
    },
    rendering: { motion: { intervalMs: dist(16.7, 20 + lag[0] / 10) } }
  };
}

function orbit(scene: string, throttle: number, p95: number, fps: number) {
  return {
    scene,
    throttle,
    orbit: {
      // The page's requestAnimationFrame cadence: never judged.
      frame: { p50: 16.7, p95: 16.7, p99: 16.7 },
      dropped: { missed: 0, refreshes: 360, pct: 0 },
      viewerInterval: { p50: 16.7, p95, p99: p95 * 2 },
      viewerFps: fps
    }
  };
}

function writeDrags(dir: string, runs: ReturnType<typeof drag>[][]) {
  writeFileSync(
    join(dir, 'face-drag.jsonl'),
    runs
      .flat()
      .map((line) => JSON.stringify(line))
      .join('\n')
  );
}

const HOLDER = 'native holder +Z face (plate, cut, two arms)';

describe('Active 1 summary: face drags and orbits', () => {
  it('takes medians across runs, per case, with budgets', () => {
    const dir = tempDir('active1-summary-');
    writeDrags(dir, [
      [drag('union', true, [40, 70], 300), drag('box cap', false, [8, 12], 90)],
      [drag('union', true, [44, 90], 310), drag('box cap', false, [9, 14], 95)],
      [drag('union', true, [42, 80], 900), drag('box cap', false, [7, 13], 85)]
    ]);
    for (const [round, p95] of [
      [0, 18],
      [1, 22],
      [2, 20]
    ] as const) {
      mkdirSync(join(dir, `orbit-r${round}`));
      writeFileSync(
        join(dir, `orbit-r${round}`, 'summary.json'),
        JSON.stringify([
          orbit('torus', 1, p95, 59),
          orbit('torus', 4, p95 * 3, 30)
        ])
      );
    }
    const rows = summarize(dir);
    const row = (measurement: string) =>
      rows.find((entry) => entry.measurement === measurement);
    expect(row('Face drag pointer → frame p95 (union)')).toMatchObject({
      runs: 3,
      median: 80,
      min: 70,
      max: 90
    });
    expect(row('Face drag first exact geometry (union)')?.median).toBe(84);
    // A proxy-only case reports its proxy lag and has no exact first frame.
    expect(row('Face drag pointer → frame p50 (box cap)')?.median).toBe(8);
    expect(row('Face drag first exact geometry (box cap)')).toBeUndefined();
    // The median, not the mean, absorbs one slow release.
    expect(row('Face drag release → accepted frame (union)')?.median).toBe(310);
    // Orbit rows read the viewer's own frames.
    expect(row('Orbit viewer frame interval p95 (torus x1)')?.median).toBe(20);
    expect(row('Orbit viewer frame interval p99 (torus x4)')?.median).toBe(120);
    expect(row('Orbit viewer frames per second (torus x4)')).toMatchObject({
      median: 30,
      unit: 'fps',
      budget: ACTIVE1_BUDGETS.orbit['* x4']!.minViewerFps,
      withinBudget: false
    });
    expect(row('Orbit viewer frames per second (torus x1)')?.withinBudget).toBe(
      true
    );
    // Unbudgeted rows are recorded, never judged.
    for (const entry of rows)
      if (entry.budget == null) expect(entry.withinBudget).toBeNull();
  });

  it('judges each drag run by what followed its pointer', () => {
    // One run followed by proxy frames, two by slow exact frames: the exact
    // runs' lag counts rather than dropping out behind the proxy run.
    const dir = tempDir('active1-drag-mixed-');
    writeDrags(dir, [
      [drag(HOLDER, false, [15, 16], 70)],
      [drag(HOLDER, true, [60, 80], 70)],
      [drag(HOLDER, true, [62, 85], 70)]
    ]);
    const p95 = summarize(dir).find(
      (entry) =>
        entry.measurement === `Face drag pointer → frame p95 (${HOLDER})`
    )!;
    expect(p95.median).toBe(80);
    expect(p95.withinBudget).toBe(false);
  });

  it('fails a budgeted row a run did not record', () => {
    const dir = tempDir('active1-drag-missing-');
    const empty = drag(HOLDER, false, [15, 16], 70);
    empty.summary.pointerToProxyFrameMs = none();
    writeDrags(dir, [
      [drag(HOLDER, false, [15, 16], 70)],
      [empty],
      [drag(HOLDER, false, [15, 16], 70)]
    ]);
    const p95 = summarize(dir).find(
      (entry) =>
        entry.measurement === `Face drag pointer → frame p95 (${HOLDER})`
    )!;
    expect(p95.median).toBe(16);
    expect(p95.withinBudget).toBe(false);
  });
});

describe('Active 1 summary: sustained sessions', () => {
  const sampleRow = (edit: number, heapMiB: number, ms: number) =>
    JSON.stringify({
      edit,
      ms,
      compactMs: null,
      replayed: 1,
      linearMemoryBytes: 60 * 2 ** 20,
      retiredSlots: 1_000 * (edit % 60),
      heapUsed: heapMiB * 2 ** 20
    });
  const sampled = Array.from({ length: 30 }, (_, i) =>
    sampleRow(i * 10, 72 + (i >= 20 ? 0.5 : 0), i >= 20 ? 46 : 44)
  );

  it('takes peaks over every sync, not only the sampled rows', () => {
    const dir = tempDir('active1-sustained-');
    writeFileSync(
      join(dir, 'sustained-r0.jsonl'),
      [
        ...sampled,
        JSON.stringify({
          idle: true,
          compactions: 5,
          syncs: 303,
          peakRetiredSlots: 66_194,
          peakLinearMemoryBytes: 97 * 2 ** 20
        })
      ].join('\n')
    );
    const rows = summarize(dir);
    const find = (name: string) =>
      rows.find((entry) => entry.measurement.startsWith(name))!;
    expect(find('Sustained session: peak WASM').median).toBe(97);
    expect(find('Sustained session: peak retired').median).toBe(66_194);
    expect(find('Sustained session: post-GC heap').median).toBeCloseTo(0.5);
    expect(find('Sustained session: one-feature').median).toBeCloseTo(46 / 44);
    expect(rows.filter((entry) => entry.withinBudget === false)).toEqual([]);
  });

  it('fails a spike between samples, and a run with no peaks recorded', () => {
    const dir = tempDir('active1-sustained-spike-');
    // The sampled rows never pass 59,000 retired slots; the run's peak did.
    writeFileSync(
      join(dir, 'sustained-r0.jsonl'),
      [
        ...sampled,
        JSON.stringify({
          syncs: 303,
          peakRetiredSlots: 150_000,
          peakLinearMemoryBytes: 97 * 2 ** 20
        })
      ].join('\n')
    );
    writeFileSync(join(dir, 'sustained-r1.jsonl'), sampled.join('\n'));
    const retired = summarize(dir).find((entry) =>
      entry.measurement.startsWith('Sustained session: peak retired')
    )!;
    expect(retired.max).toBe(150_000);
    expect(retired.withinBudget).toBe(false);
    expect(ACTIVE1_BUDGETS.sustained.peakRetiredSlots).toBe(131_072);
  });

  it('runs only the public face-drag cases', () => {
    const cases = FACE_DRAG_CASES.split('|');
    expect(cases).toHaveLength(4);
    expect(FACE_DRAG_CASES).not.toMatch(/supplied|imported/);
    expect(ACTIVE1_BUDGETS.faceDragTargets.lagP95Ms).toBe(50);
  });
});
