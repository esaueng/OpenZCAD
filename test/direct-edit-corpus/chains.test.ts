import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

import { defineLedgerSuite } from '../support/combination-matrix-suite';
import {
  CHAIN_LEDGER_RUNNER,
  PR_SLICE_LENGTH,
  PR_SLICE_PARTS,
  PR_SLICE_SEEDS,
  chainReproduction,
  lastChainRun,
  prSliceChainCells,
  runChainDetailed,
  sameFailureSignature,
  shrinkChain,
  type ChainCell,
  type ChainStep,
  type FailureSignature
} from './chain-generator';
import { CHAIN_REFUSAL_PINS } from './pins';

/**
 * K10 CAD part QA Phase P2: fixed-seed direct-edit chains (3 seeds × 20 steps
 * per reference part A–D) with per-step strict solid/mesh, pinned typed
 * refusal, undo/redo, reopen, cold-replay and STEP round-trip verification,
 * plus chain shrinking (`K10_SHRINK=1`).
 */
const cells = prSliceChainCells();
defineLedgerSuite(
  'K10 CAD part QA P2: seeded direct-edit chains (PR slice)',
  new URL('./chains.ledger.json', import.meta.url),
  cells,
  CHAIN_LEDGER_RUNNER
);

describe('K10 direct-edit chain generator contracts', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 60_000);

  afterAll(() => {
    adapter.dispose();
  });

  it('covers reference parts A–D with 3 fixed seeds × 20 steps and unique ids', () => {
    expect(cells).toHaveLength(PR_SLICE_PARTS.length * PR_SLICE_SEEDS.length);
    expect(new Set(cells.map((c) => c.id)).size).toBe(cells.length);
    for (const part of PR_SLICE_PARTS) {
      const forPart = cells.filter((c) => c.part === part);
      expect(forPart.map((c) => c.seed)).toEqual([...PR_SLICE_SEEDS]);
      expect(forPart.every((c) => c.length === PR_SLICE_LENGTH)).toBe(true);
    }
  });

  // Runs after the ledger suite above; a filtered run cannot see every pin.
  it.skipIf(!!process.env.K10_CELL || !!process.env.K10_FILTER)(
    'reaches every chain refusal pin at exactly its pinned steps and sentences',
    () => {
      const runs = cells.map(
        (cell) => [cell.id, lastChainRun(cell.id)] as const
      );
      expect(runs.filter(([, run]) => !run).map(([id]) => id)).toEqual([]);
      const reached = new Map<string, string[]>();
      const sentences = new Set<string>();
      for (const [id, run] of runs) {
        for (const step of run!.executed) {
          if (!step.pin) continue;
          reached.set(step.pin, [
            ...(reached.get(step.pin) ?? []),
            `${id}#${step.index}`
          ]);
          sentences.add(step.refusalMessage!);
        }
      }
      expect(new Set(CHAIN_REFUSAL_PINS.map((pin) => pin.id)).size).toBe(
        CHAIN_REFUSAL_PINS.length
      );
      for (const pin of CHAIN_REFUSAL_PINS) {
        expect((reached.get(pin.id) ?? []).sort(), pin.id).toEqual(
          [...pin.at].sort()
        );
        expect(
          pin.messages.filter((message) => !sentences.has(message)),
          `${pin.id}: pinned sentences no chain reached`
        ).toEqual([]);
      }
    }
  );

  it('reproduces one full slice cell step for step, value for value', async () => {
    // B/seed-3 covers undo, redo, an earlier-value edit, a pinned refusal
    // and both reopens in about two seconds.
    const cell = cells.find((entry) => entry.id === 'B/seed-3/20')!;
    const first = await runChainDetailed(adapter, cell);
    const second = await runChainDetailed(adapter, cell);
    expect(first.outcome.state).toBe('qualified');
    expect(second.outcome.state).toBe('qualified');
    expect(second.recordedSteps).toEqual(first.recordedSteps);
    expect(second.executed).toEqual(first.executed);
    expect(second.finalVolume).toBe(first.finalVolume);
    expect(second.finalCensus).toEqual(first.finalCensus);
    const statuses = new Set(first.executed.map((step) => step.status));
    for (const status of [
      'committed',
      'refused',
      'undone',
      'undone-redone',
      'reopened'
    ] as const)
      expect(statuses, status).toContain(status);
    expect(first.summary.editsEarlier).toBeGreaterThan(0);
  }, 60_000);

  it('shrinks a failing chain to the smallest history with the same failure signature', async () => {
    // A real chain on part D, with a deterministic synthetic wrong-result
    // check on top: it fires on a committed cap offset of at least 2 mm,
    // while a 1 mm offset trips a different check. The shrinker must drop
    // the irrelevant steps and round 2.375 to 2 but not on to 1.
    const baseRun = await runChainDetailed(adapter, {
      id: 'D/shrink-source/4',
      part: 'D',
      seed: 1,
      length: 4
    });
    expect(baseRun.outcome.state).toBe('qualified');
    const offsetStep = baseRun.recordedSteps.find(
      (step): step is Extract<ChainStep, { kind: 'offset-face' }> =>
        step.kind === 'offset-face'
    );
    expect(offsetStep).toBeDefined();

    const steps: ChainStep[] = [
      { ...offsetStep!, stepId: 'step-0', offset: 0.75 },
      { ...offsetStep!, stepId: 'step-1', offset: 2.375 },
      { ...offsetStep!, stepId: 'step-2', offset: 0.5 },
      { kind: 'undo', stepId: 'step-3', redoAfter: true }
    ];

    const targetSignature: FailureSignature = {
      state: 'wrong',
      oracle: 'offset-shape-oracle',
      wrongCheck: 'synthetic-large-cap-offset'
    };
    const differentSignature: FailureSignature = {
      state: 'wrong',
      oracle: 'solid-validity',
      wrongCheck: 'different-oracle-check'
    };

    let probedOne = false;
    const extraStepOracle = ({
      step,
      status
    }: {
      step: ChainStep;
      status: string;
    }) => {
      if (step.kind !== 'offset-face' || status !== 'committed') return null;
      if (step.offset === 1) {
        probedOne = true;
        return {
          failure: differentSignature,
          evidence: 'switched to a different oracle at 1 mm'
        };
      }
      return step.offset >= 2
        ? {
            failure: targetSignature,
            evidence: `synthetic failure at offset ${step.offset}`
          }
        : null;
    };

    const failingCell: ChainCell = {
      id: 'D/shrink-test/4',
      part: 'D',
      seed: 99,
      length: steps.length,
      steps
    };

    const minimal = await shrinkChain(adapter, failingCell, 'wrong', {
      extraStepOracle
    });

    expect(minimal.steps).toHaveLength(1);
    const only = minimal.steps![0]!;
    expect(only).toMatchObject({ kind: 'offset-face', offset: 2 });
    // The shrinker did try 1 mm and rejected it for its different failure.
    expect(probedOne).toBe(true);

    const replayed = await runChainDetailed(adapter, minimal, {
      extraStepOracle
    });
    expect(sameFailureSignature(replayed.failure, targetSignature)).toBe(true);
    expect(chainReproduction(minimal)).toContain('offset-face');
    expect(chainReproduction(minimal)).toContain('by 2 mm');
  }, 60_000);
});
