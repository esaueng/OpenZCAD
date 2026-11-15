import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

import { createInFlightImportChecksums } from './importArchival';
import type { ImportRunOutcome } from './importProgress';
import type { PreparedProjectInsert } from './projectInsertPrepare';
import { localStepImportSourceStore } from './stepImportRun';

const prepared: PreparedProjectInsert = {
  projectName: 'Gearbox',
  stepText: 'ISO-10303-21;\nEND-ISO-10303-21;\n',
  bodies: [{ name: 'Plate Body', solidCount: 1, color: null, opacity: null }],
  skipped: []
};

const prepare = vi.fn(async () => prepared);
vi.mock('./projectInsertWorkerClient', () => ({
  prepareProjectInsertInWorker: () => prepare()
}));

const { runProjectInsert } = await import('./projectInsertRun');

function harness(
  overrides: {
    reserve?: () => { release(): void } | null;
    storage?: 'ready' | 'unavailable' | 'blocked';
    stillCurrent?: () => boolean;
  } = {}
) {
  const finished: ImportRunOutcome[] = [];
  const statuses: string[] = [];
  const run = vi.fn(async () => 'committed' as const);
  const document = createProjectDocument('Target', toUserId('user_insert'));
  const deps = {
    file: new File(['{}'], 'gearbox.openzcad'),
    ownerUserId: toUserId('user_insert'),
    signal: new AbortController().signal,
    progress: {
      start() {},
      update() {},
      finish: (outcome: ImportRunOutcome) => finished.push(outcome)
    },
    setStatus: (message: string) => statuses.push(message),
    stillCurrent: overrides.stillCurrent ?? (() => true),
    stepImport: {
      store: {
        ...localStepImportSourceStore,
        ensureLocalProjectStorage: async () =>
          overrides.storage ?? 'unavailable'
      },
      inspectSolids: async () => [0],
      archive: async () => 'artifact_gearbox',
      validatedFeature: {
        reserve: overrides.reserve ?? (() => ({ release() {} })),
        run
      },
      status: {
        setStatus: (message: string) => statuses.push(message),
        setFeatureFormError() {}
      },
      marks: {
        inFlight: createInFlightImportChecksums(),
        abandoned: new Set<string>()
      },
      currentDocument: () => document,
      editDisabledReason: () => null,
      newId: () => crypto.randomUUID()
    }
  };
  return { deps, finished, statuses, run };
}

beforeEach(() => prepare.mockClear());

// Review P2 (#1506): Insert starts its card before the STEP import's run,
// and a run that declined early left that card running with nothing behind
// its Cancel button.
describe('runProjectInsert card', () => {
  it('settles the card when the commit lock is busy', async () => {
    const { deps, finished, statuses, run } = harness({ reserve: () => null });
    await runProjectInsert(deps);
    expect(run).not.toHaveBeenCalled();
    expect(finished).toEqual([
      { tone: 'warning', message: 'nothing was added' }
    ]);
    expect(statuses.at(-1)).toMatch(/still finishing|another/i);
  });

  it('settles the card when browser storage is blocked', async () => {
    const { deps, finished, run } = harness({ storage: 'blocked' });
    await runProjectInsert(deps);
    expect(run).not.toHaveBeenCalled();
    expect(finished).toEqual([
      { tone: 'warning', message: 'nothing was added' }
    ]);
  });

  it('adds nothing when the project changes while the other one is read', async () => {
    const { deps, finished, run } = harness({ stillCurrent: () => false });
    await runProjectInsert(deps);
    expect(prepare).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(finished).toEqual([
      {
        tone: 'warning',
        message: 'The project changed while the other one was read.'
      }
    ]);
  });
});
