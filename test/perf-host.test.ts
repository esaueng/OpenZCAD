import { describe, expect, it } from 'vitest';
import { busyRows } from '../scripts/perf-host.mjs';

type Row = { pid: number; ppid: number; args: string };
const busy = (rows: Row[], root = 1) =>
  busyRows(rows, root).map((row) => row.pid);

/**
 * F06 slice 5: the quiet-host check behind the W01 and row-switch probes.
 * A job queued behind the shared heavy-job lock loads nothing; counting it
 * made a probe holding that lock wait on its own queue until it timed out.
 */
describe('which processes make the host noisy', () => {
  it('counts a Playwright run that is running', () => {
    const rows: Row[] = [
      { pid: 10, ppid: 2, args: 'bash -c pnpm exec playwright test a.spec.ts' },
      { pid: 11, ppid: 10, args: 'node playwright/cli.js test a.spec.ts' },
      { pid: 12, ppid: 11, args: 'chrome-headless-shell --type=renderer' }
    ];
    expect(busy(rows)).toEqual([10, 11]);
  });

  it('skips a job waiting for the heavy-job lock, and its shells', () => {
    const rows: Row[] = [
      {
        pid: 20,
        ppid: 2,
        args: 'bash -c flock ~/.cache/openzcad-heavy.lock pnpm exec playwright test'
      },
      {
        pid: 21,
        ppid: 20,
        args: 'flock /home/u/.cache/openzcad-heavy.lock pnpm exec playwright test'
      }
    ];
    expect(busy(rows)).toEqual([]);
  });

  it('counts the same job once it holds the lock and has started', () => {
    const rows: Row[] = [
      {
        pid: 30,
        ppid: 2,
        args: 'flock /home/u/.cache/openzcad-heavy.lock pnpm exec playwright test'
      },
      { pid: 31, ppid: 30, args: 'pnpm exec playwright test' }
    ];
    expect(busy(rows)).toEqual([30, 31]);
  });

  it('never counts the probe’s own process tree, nor cargo-free idle work', () => {
    const rows: Row[] = [
      { pid: 40, ppid: 1, args: 'node scripts/measure-active1-baselines.mjs' },
      { pid: 41, ppid: 40, args: 'pnpm exec playwright test perf.spec.ts' },
      { pid: 50, ppid: 2, args: 'cargo build --release' },
      { pid: 60, ppid: 2, args: 'vim notes.md' }
    ];
    expect(busy(rows, 40)).toEqual([50]);
  });
});
