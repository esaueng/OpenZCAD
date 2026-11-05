import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  cylinderSphereOverlap,
  runCell,
  sphereCylinderCells,
  type CellState
} from './support/combination-matrix';

/**
 * K10 first slice. Every cell must match its committed ledger state; set
 * `K10_RECORD=1` to rewrite the ledger after an intended change and review
 * the diff. See docs/plans/kernel-robustness-plan-2026-11-05.md.
 */
const LEDGER_URL = new URL('./combination-matrix.ledger.json', import.meta.url);
const ledger = JSON.parse(readFileSync(LEDGER_URL, 'utf8')) as {
  cells: Record<string, CellState>;
};
const recorded: Record<string, CellState> = {};

describe('K10 combination matrix: sphere × cylinder', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => {
    adapter.dispose();
    // A filtered run records a subset; never let it truncate the ledger.
    const complete =
      Object.keys(recorded).length === sphereCylinderCells().length;
    if (process.env.K10_RECORD === '1' && complete) {
      writeFileSync(
        LEDGER_URL,
        `${JSON.stringify({ cells: recorded }, null, 2)}\n`
      );
    }
  });

  it('integrates the overlap oracle against the closed-form protrusion', () => {
    // The upright boss: the volume outside the sphere is a separately
    // derived constant (test/sphere-cylinder-union.test.ts).
    const frame = {
      base: { x: 0, y: 0, z: 58 },
      axis: { x: 0, y: 0, z: 1 },
      height: 64.10000000000001
    };
    const protrusion =
      Math.PI * 36 * frame.height - cylinderSphereOverlap(frame, 6);
    expect(Math.abs(protrusion - 6030.504746075203)).toBeLessThan(0.05);
  });

  it('keeps every committed cell in the ledger and nothing else', () => {
    expect(Object.keys(ledger.cells).sort()).toEqual(
      sphereCylinderCells()
        .map((cell) => cell.id)
        .sort()
    );
  });

  for (const cell of sphereCylinderCells()) {
    it(
      cell.id,
      async () => {
        const outcome = await runCell(adapter, cell);
        recorded[cell.id] = outcome.state;
        if (process.env.K10_RECORD === '1') {
          console.info(`${cell.id}: ${outcome.state} — ${outcome.evidence}`);
          return;
        }
        expect(outcome.state, outcome.evidence).toBe(ledger.cells[cell.id]);
      },
      120_000
    );
  }
});
