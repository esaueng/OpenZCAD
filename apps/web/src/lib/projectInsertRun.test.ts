import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

import {
  encryptionRequired,
  isEncryptedProject,
  rememberEncryptedProject
} from './api';
import { localStorageEncryptedProjectPins } from './e2ee/encryptedProjectPins';
import { createInFlightImportChecksums } from './importArchival';
import type { ImportRunOutcome } from './importProgress';
import type { PreparedProjectInsert } from './projectInsertPrepare';
import { localStepImportSourceStore } from './stepImportRun';

const prepared: PreparedProjectInsert = {
  projectName: 'Gearbox',
  sourceProjectId: 'project_gearbox_source',
  stepText: [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('gearbox'),'2;1');",
    "FILE_NAME('gearbox.step','2026-11-14T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
    'ENDSEC;',
    'DATA;',
    "#24=PRODUCT('Plate Body','Plate Body','',(#1));",
    'ENDSEC;',
    'END-ISO-10303-21;'
  ].join('\n'),
  bodies: [{ name: 'Plate Body', solidCount: 1, color: null, opacity: null }],
  skipped: []
};

const prepare = vi.fn(async (): Promise<PreparedProjectInsert> => prepared);
vi.mock('./projectInsertWorkerClient', () => ({
  prepareProjectInsertInWorker: () => prepare()
}));

const { runProjectInsert } = await import('./projectInsertRun');

function harness(
  overrides: {
    reserve?: () => { release(): void } | null;
    storage?: 'ready' | 'unavailable' | 'blocked';
    stillCurrent?: () => boolean;
    onAccount?: boolean;
  } = {}
) {
  const finished: ImportRunOutcome[] = [];
  const statuses: string[] = [];
  const run = vi.fn(async () => 'committed' as const);
  const archive = vi.fn(async () => 'artifact_gearbox');
  const putSourceBlobIfAbsent = vi.fn(
    localStepImportSourceStore.putSourceBlobIfAbsent
  );
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
    destination: () => ({
      projectId: document.projectId,
      onAccount: overrides.onAccount ?? false
    }),
    stepImport: {
      store: {
        ...localStepImportSourceStore,
        putSourceBlobIfAbsent,
        ensureLocalProjectStorage: async () =>
          overrides.storage ?? 'unavailable'
      },
      inspectSolids: async () => [0],
      archive,
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
  return {
    deps,
    document,
    finished,
    statuses,
    run,
    archive,
    putSourceBlobIfAbsent
  };
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

// PR #1418 review: inserting a backup of a project this device keeps
// encrypted moved its content under the open project's id, which the send
// gate then judged alone.
describe('runProjectInsert encryption requirement', () => {
  function encryptedSource(): string {
    const sourceProjectId = `project_source_${crypto.randomUUID()}`;
    expect(rememberEncryptedProject(sourceProjectId)).toBe(true);
    prepare.mockResolvedValueOnce({ ...prepared, sourceProjectId });
    return sourceProjectId;
  }

  it('refuses an account project that is not encrypted, storing, uploading and committing nothing', async () => {
    encryptedSource();
    const h = harness({ onAccount: true });
    await runProjectInsert(h.deps);
    expect(h.putSourceBlobIfAbsent).not.toHaveBeenCalled();
    expect(h.archive).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.finished).toEqual([
      { tone: 'error', message: 'nothing was added' }
    ]);
    expect(h.statuses.at(-1)).toMatch(
      /Encrypt this project first, or insert into an encrypted project/
    );
    expect(encryptionRequired(h.document.projectId)).toBe(false);
  });

  it('refuses a source whose encryption switch did not finish here', async () => {
    const sourceProjectId = `project_source_${crypto.randomUUID()}`;
    expect(
      localStorageEncryptedProjectPins().markCutoverUnresolved(sourceProjectId)
    ).toBe(true);
    prepare.mockResolvedValueOnce({ ...prepared, sourceProjectId });
    const h = harness({ onAccount: true });
    await runProjectInsert(h.deps);
    expect(h.archive).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('carries the requirement to a device-only project before inserting', async () => {
    encryptedSource();
    const h = harness({ onAccount: false });
    let requiredAtCommit = false;
    h.run.mockImplementationOnce(async () => {
      requiredAtCommit = encryptionRequired(h.document.projectId);
      return 'committed' as const;
    });
    await runProjectInsert(h.deps);
    expect(h.run).toHaveBeenCalledOnce();
    expect(requiredAtCommit).toBe(true);
    // Recorded durably: a fresh store (a reload) still requires it.
    expect(
      localStorageEncryptedProjectPins().encryptionRequired(
        h.document.projectId
      )
    ).toBe(true);
    expect(isEncryptedProject(h.document.projectId)).toBe(false);
  });

  it('inserts into an encrypted account project as before', async () => {
    encryptedSource();
    const h = harness({ onAccount: true });
    expect(rememberEncryptedProject(h.document.projectId)).toBe(true);
    await runProjectInsert(h.deps);
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.finished.at(-1)?.tone).not.toBe('error');
  });

  it('inserts a source this device holds nothing about without recording anything', async () => {
    const h = harness({ onAccount: true });
    await runProjectInsert(h.deps);
    expect(h.run).toHaveBeenCalledOnce();
    expect(encryptionRequired(h.document.projectId)).toBe(false);
  });
});
