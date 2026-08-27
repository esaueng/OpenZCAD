import { describe, expect, it, vi } from 'vitest';
import {
  coalesceImportProgress,
  importOverallFraction,
  type ImportPhase,
  type ImportRunProgress
} from './importProgress';

const ALL_PHASES: readonly ImportPhase[] = [
  'saving',
  'reading',
  'building',
  'archiving'
];

describe('importOverallFraction', () => {
  it('advances with the fraction inside a measurable phase', () => {
    const start = importOverallFraction(ALL_PHASES, {
      phase: 'saving',
      fraction: 0
    });
    const half = importOverallFraction(ALL_PHASES, {
      phase: 'saving',
      fraction: 0.5
    });
    const end = importOverallFraction(ALL_PHASES, {
      phase: 'saving',
      fraction: 1
    });
    expect(start).toBe(0);
    expect(half).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(half);
  });

  /**
   * The whole point of the null fraction. A phase that cannot report must not
   * borrow any of its own weight, or the bar creeps through a number nothing
   * measured — which is exactly the lie the card exists to avoid.
   */
  it('parks the bar at the phase boundary when a phase cannot report', () => {
    const parked = importOverallFraction(ALL_PHASES, {
      phase: 'building',
      fraction: null
    });
    const phaseBefore = importOverallFraction(ALL_PHASES, {
      phase: 'reading',
      fraction: 1
    });
    expect(parked).toBe(phaseBefore);
  });

  it('never goes backwards across a whole run', () => {
    const timeline: ImportRunProgress[] = [
      { phase: 'saving', fraction: 0 },
      { phase: 'saving', fraction: 0.4 },
      { phase: 'saving', fraction: 1 },
      { phase: 'reading', fraction: null },
      { phase: 'building', fraction: null },
      { phase: 'archiving', fraction: 0 },
      { phase: 'archiving', fraction: 0.5 },
      { phase: 'archiving', fraction: 1 }
    ];
    const widths = timeline.map((progress) =>
      importOverallFraction(ALL_PHASES, progress)
    );
    for (let index = 1; index < widths.length; index += 1) {
      expect(widths[index]).toBeGreaterThanOrEqual(widths[index - 1]!);
    }
    expect(widths.at(-1)).toBe(1);
  });

  /**
   * A storage-denied session embeds the file instead of writing a blob, so it
   * never has a `saving` phase. The bar has to divide over what will actually
   * happen, or it starts a third of the way along and finishes early.
   */
  it('divides over only the phases this run will pass through', () => {
    const withoutSaving: readonly ImportPhase[] = [
      'reading',
      'building',
      'archiving'
    ];
    expect(
      importOverallFraction(withoutSaving, { phase: 'reading', fraction: 0 })
    ).toBe(0);
    expect(
      importOverallFraction(withoutSaving, { phase: 'archiving', fraction: 1 })
    ).toBe(1);
  });

  it('clamps a fraction outside 0–1 rather than overrunning the bar', () => {
    expect(
      importOverallFraction(ALL_PHASES, { phase: 'archiving', fraction: 4 })
    ).toBe(1);
    expect(
      importOverallFraction(ALL_PHASES, { phase: 'saving', fraction: -2 })
    ).toBe(0);
  });

  it('reports nothing for a phase this run does not have', () => {
    expect(
      importOverallFraction(['building'], { phase: 'archiving', fraction: 0.5 })
    ).toBe(0);
  });
});

describe('coalesceImportProgress', () => {
  it('drops steps too small to see', () => {
    const publish = vi.fn();
    const update = coalesceImportProgress(publish, { minFractionStep: 0.05 });
    update({ phase: 'saving', fraction: 0 });
    update({ phase: 'saving', fraction: 0.01 });
    update({ phase: 'saving', fraction: 0.02 });
    update({ phase: 'saving', fraction: 0.2 });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith({
      phase: 'saving',
      fraction: 0.2
    });
  });

  /**
   * A 250 MB read arrives in roughly four thousand chunks. Each one reaching
   * React would re-render the workspace four thousand times mid-import, which
   * is the entire reason this filter exists.
   */
  it('collapses a chunked read to a bounded number of updates', () => {
    const publish = vi.fn();
    const update = coalesceImportProgress(publish, { minFractionStep: 0.05 });
    for (let chunk = 1; chunk <= 4000; chunk += 1) {
      update({ phase: 'saving', fraction: chunk / 4000 });
    }
    expect(publish.mock.calls.length).toBeLessThanOrEqual(21);
    expect(publish).toHaveBeenLastCalledWith({
      phase: 'saving',
      fraction: 1
    });
  });

  it('always passes a phase change, however small the step', () => {
    const publish = vi.fn();
    const update = coalesceImportProgress(publish, { minFractionStep: 0.5 });
    update({ phase: 'saving', fraction: 0.9 });
    update({ phase: 'archiving', fraction: 0.91 });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  /**
   * "Cannot report" is a different statement from "zero", and the card draws
   * it differently — a held, striped bar rather than a filling one. Dropping
   * the transition would leave the bar creeping when it should have stopped.
   */
  it('always passes a move to or from a phase that cannot report', () => {
    const publish = vi.fn();
    const update = coalesceImportProgress(publish, { minFractionStep: 0.9 });
    update({ phase: 'building', fraction: 0.1 });
    update({ phase: 'building', fraction: null });
    update({ phase: 'building', fraction: 0.11 });
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('always passes the end of a phase', () => {
    const publish = vi.fn();
    const update = coalesceImportProgress(publish, { minFractionStep: 0.5 });
    update({ phase: 'archiving', fraction: 0.6 });
    update({ phase: 'archiving', fraction: 1 });
    expect(publish).toHaveBeenLastCalledWith({
      phase: 'archiving',
      fraction: 1
    });
  });
});
