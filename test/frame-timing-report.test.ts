import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareMarkdown,
  droppedFrames,
  readRun,
  spread,
  stats,
  VSYNC_MS,
  writeRunSummary
} from '../scripts/frame-timing-report.mjs';

function result(scene: string, throttle: number, p95: number) {
  return {
    kind: 'frame-timing',
    scene,
    title: scene,
    throttle,
    environment: {
      browser: 'HeadlessChrome/1',
      gpu: 'Test GPU',
      viewport: { width: 1366, height: 1024 },
      deviceScaleFactor: 2,
      timerQuery: true
    },
    load: {
      bodiesMs: 120,
      silhouettes: [{ ms: 40, triangles: 1000, candidates: 900 }]
    },
    orbit: {
      triangles: 1000,
      frame: { p50: 16.7, p95, p99: p95 + 1 },
      dropped: { missed: 1, refreshes: 10, pct: 10 },
      viewerCpu: { p50: 4, p95: 8 },
      gpu: { p50: 2, p95: 3 },
      samples: { intervals: [16.7] }
    }
  };
}

describe('frame-timing report', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('takes nearest-rank percentiles', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(stats(values)).toMatchObject({
      count: 100,
      p50: 50,
      p95: 95,
      p99: 99,
      max: 100,
      mean: 50.5
    });
    expect(stats([])).toMatchObject({ count: 0, p50: null, max: null });
  });

  it('counts the refreshes a long frame spanned as dropped', () => {
    // Two on-time frames, one that took three refreshes, one that took two.
    expect(
      droppedFrames([VSYNC_MS, VSYNC_MS, 3 * VSYNC_MS, 2 * VSYNC_MS + 1])
    ).toEqual({ missed: 3, refreshes: 7, pct: (100 * 3) / 7 });
    // Timer jitter just over one refresh is not a drop.
    expect(droppedFrames([VSYNC_MS * 1.2]).missed).toBe(0);
    expect(droppedFrames([]).pct).toBeNull();
  });

  it('reports the median of repeated runs with its spread', () => {
    expect(spread([3, 1, 2])).toEqual({ median: 2, min: 1, max: 3, runs: 3 });
    expect(spread([4, 2])).toEqual({ median: 3, min: 2, max: 4, runs: 2 });
    expect(spread([null, undefined])).toBeNull();
  });

  it('writes a run summary from the per-test files only', () => {
    root = mkdtempSync(join(tmpdir(), 'frame-timing-'));
    writeFileSync(
      join(root, 'torus--x4.json'),
      JSON.stringify(result('torus', 4, 30))
    );
    writeFileSync(
      join(root, 'torus--x1.json'),
      JSON.stringify(result('torus', 1, 20))
    );
    writeFileSync(join(root, 'other.json'), JSON.stringify({ kind: 'other' }));
    writeRunSummary(root);
    expect(
      readRun(root).map((run) => (run as { throttle: number }).throttle)
    ).toEqual([1, 4]);
    const markdown = readFileSync(join(root, 'summary.md'), 'utf8');
    expect(markdown).toContain('not a device measurement');
    expect(markdown).toContain(
      '| torus | 1 | 1000 | 16.7 / 20.0 / 21.0 | 10.0 |'
    );
    const summary = JSON.parse(
      readFileSync(join(root, 'summary.json'), 'utf8')
    ) as { orbit: { samples?: unknown } }[];
    expect(summary).toHaveLength(2);
    // Raw samples stay in the per-test files.
    expect(summary[0]!.orbit.samples).toBeUndefined();
  });

  it('compares two builds scene by scene over runs', () => {
    const page = compareMarkdown({
      before: [[result('torus', 1, 20)], [result('torus', 1, 24)]],
      after: [[result('torus', 1, 30)]],
      beforeLabel: 'pre-U10',
      afterLabel: 'main'
    });
    expect(page).toContain('| torus | 1 | pre-U10 | 16.7 | 22.0 (20.0–24.0) |');
    expect(page).toContain('| torus | 1 | main | 16.7 | 30.0 |');
  });
});
