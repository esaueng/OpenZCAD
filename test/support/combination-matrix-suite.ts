import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  reproduction,
  runCell,
  shrinkCell,
  summarize,
  type Cell,
  type CellOutcome,
  type CellState
} from './combination-matrix';

/** How a suite runs its cells; the generated matrix is the default. */
export interface LedgerRunner<C extends { id: string }> {
  run(adapter: ExactKernelAdapter, cell: C): Promise<CellOutcome>;
  reproduction(cell: C): string;
  /** Opt-in shrinking (`K10_SHRINK=1`); absent for hand-written families. */
  shrink?(adapter: ExactKernelAdapter, cell: C, state: CellState): Promise<C>;
}

const MATRIX_RUNNER: LedgerRunner<Cell> = {
  run: (adapter, cell) => runCell(adapter, cell),
  reproduction,
  shrink: shrinkCell
};

/**
 * One K10 ledger suite. Every cell must match its committed state.
 *
 * - `K10_RECORD=1` rewrites the ledger after an intended change (only when
 *   every cell ran, so a filtered run never truncates it); review the diff.
 * - `K10_CELL=<id>` runs a single cell and prints its outcome.
 * - `K10_FILTER=<regex>` runs the cells whose id matches.
 * - `K10_REPORT=<path>` writes each recorded cell's evidence there.
 * - `K10_SHRINK=1` shrinks each cell that leaves its ledger state and is
 *   not qualified to the smallest history in the same state.
 */
export function defineLedgerSuite<C extends { id: string } = Cell>(
  title: string,
  ledgerUrl: URL,
  cells: readonly C[],
  runner: LedgerRunner<C> = MATRIX_RUNNER as unknown as LedgerRunner<C>
): void {
  const ledger = JSON.parse(readFileSync(ledgerUrl, 'utf8')) as {
    cells: Record<string, CellState>;
  };
  const only = process.env.K10_CELL;
  const record = process.env.K10_RECORD === '1';
  const pattern = process.env.K10_FILTER
    ? new RegExp(process.env.K10_FILTER)
    : null;
  const selected = cells.filter(
    (cell) => (!only || cell.id === only) && (!pattern || pattern.test(cell.id))
  );
  const recorded: Record<string, CellState> = {};
  const outcomes: Record<string, CellOutcome> = {};

  describe(title, () => {
    let adapter: ExactKernelAdapter;
    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    }, 120_000);
    afterAll(() => {
      adapter.dispose();
      if (!record) return;
      const lines = Object.entries(outcomes).map(
        ([id, outcome]) =>
          `${outcome.state.padEnd(15)} ${id} — ${outcome.evidence}`
      );
      const report = `${title}\n${lines.join('\n')}\n${JSON.stringify(summarize(recorded))}\n`;
      if (process.env.K10_REPORT) writeFileSync(process.env.K10_REPORT, report);
      else console.info(report);
      if (Object.keys(recorded).length === cells.length) {
        writeFileSync(
          ledgerUrl,
          `${JSON.stringify({ summary: summarize(recorded), cells: recorded }, null, 2)}\n`
        );
      }
    });

    it('keeps every generated cell in the ledger and nothing else', () => {
      expect(Object.keys(ledger.cells).sort()).toEqual(
        cells.map((cell) => cell.id).sort()
      );
    });

    for (const cell of selected) {
      it(
        cell.id,
        async () => {
          const outcome = await runner.run(adapter, cell);
          recorded[cell.id] = outcome.state;
          outcomes[cell.id] = outcome;
          if (record || only) {
            console.info(`${cell.id}: ${outcome.state} — ${outcome.evidence}`);
            if (only) console.info(runner.reproduction(cell));
            if (record) return;
          }
          const committed = ledger.cells[cell.id];
          if (
            outcome.state !== committed &&
            process.env.K10_SHRINK === '1' &&
            outcome.state !== 'qualified' &&
            runner.shrink
          ) {
            const minimal = await runner.shrink(adapter, cell, outcome.state);
            console.info(
              `minimal history for ${cell.id}:\n${runner.reproduction(minimal)}`
            );
          }
          expect(
            outcome.state,
            `${outcome.evidence}\n${runner.reproduction(cell)}`
          ).toBe(committed);
        },
        120_000
      );
    }
  });
}
