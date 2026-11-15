import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyCommand } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toProjectId, toUserId } from '@openzcad/shared';

import {
  api,
  E2EE_PLAINTEXT_REFUSED_CODE,
  encryptionRequired,
  isEncryptedProject,
  rememberEncryptedProject
} from './api';
import { archiveArtifact } from './archiveArtifact';
import { localStorageEncryptedProjectPins } from './e2ee/encryptedProjectPins';
import { errorMessage } from './errors';
import { createInFlightImportChecksums } from './importArchival';
import type { ImportRunOutcome } from './importProgress';
import {
  INSERT_DESTINATION_CHANGED,
  INSERT_INTO_PLAINTEXT_REFUSED
} from './projectInsertEncryption';
import type { PreparedProjectInsert } from './projectInsertPrepare';
import {
  localStepImportSourceStore,
  type StepImportRunDeps
} from './stepImportRun';
import type {
  ValidatedFeatureOutcome,
  ValidatedFeatureRunOptions
} from '../hooks/useValidatedFeatureCommit';

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
    destinationId?: () => string;
    inspectSolids?: () => Promise<number[]>;
  } = {}
) {
  const finished: ImportRunOutcome[] = [];
  const statuses: string[] = [];
  const run = vi.fn(
    async (
      _command: AnyCommand,
      _options: ValidatedFeatureRunOptions
    ): Promise<ValidatedFeatureOutcome> => 'committed'
  );
  const archive = vi.fn<StepImportRunDeps['archive']>(
    async () => 'artifact_gearbox'
  );
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
      projectId: overrides.destinationId?.() ?? document.projectId,
      onAccount: overrides.onAccount ?? false
    }),
    stepImport: {
      store: {
        ...localStepImportSourceStore,
        putSourceBlobIfAbsent,
        ensureLocalProjectStorage: async () =>
          overrides.storage ?? 'unavailable'
      },
      inspectSolids: overrides.inspectSolids ?? (async () => [0]),
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

/**
 * The commit hook as `useValidatedFeatureCommit` runs it once validation
 * accepts: finalize (the upload), then `beforeCommit` synchronously with
 * the commit itself; a throw on the way is a rejection.
 */
function throughCommit(committed: { value: boolean }) {
  return async (
    _command: AnyCommand,
    options: ValidatedFeatureRunOptions
  ): Promise<ValidatedFeatureOutcome> => {
    try {
      if (options.finalize) await options.finalize();
      options.beforeCommit?.();
    } catch (error) {
      options.onFailure?.(errorMessage(error, 'Operation was not applied.'));
      return 'rejected';
    }
    committed.value = true;
    return 'committed';
  };
}

// PR #1418 review: the insert checked its source once, after preparing it.
// Another tab can pin the source later, while the STEP import prepares or
// validates, so the source travels with every upload (`sources`) and is
// settled again immediately before the commit.
describe('runProjectInsert, a source pinned in another tab mid-insert', () => {
  /** Every request that left the page; the account answers a session. */
  const network = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          session: {
            uploadSessionId: 'upload_insert',
            artifactId: 'artifact_insert',
            uploadUrl: '/api/uploads/upload_insert/content'
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  );
  beforeEach(() => vi.stubGlobal('fetch', network));
  afterEach(() => {
    network.mockClear();
    vi.unstubAllGlobals();
  });

  function plainSource(): string {
    const sourceProjectId = `project_source_${crypto.randomUUID()}`;
    prepare.mockResolvedValueOnce({ ...prepared, sourceProjectId });
    return sourceProjectId;
  }
  /** Another tab's store, on the same storage. */
  const pinElsewhere = (projectId: string) =>
    expect(localStorageEncryptedProjectPins().pin(projectId)).toBe(true);

  it('refuses the upload at the send, sending no bytes, and commits nothing', async () => {
    const source = plainSource();
    const committed = { value: false };
    const h = harness({
      onAccount: true,
      // While the STEP import prepares, after the insert's first check.
      inspectSolids: async () => {
        pinElsewhere(source);
        return [0];
      }
    });
    let uploadRefusal: unknown = null;
    h.archive.mockImplementation((input) =>
      archiveArtifact(api, toProjectId(h.document.projectId), input).catch(
        (error: unknown) => {
          uploadRefusal = error;
          throw error;
        }
      )
    );
    h.run.mockImplementation(throughCommit(committed));
    await runProjectInsert(h.deps);
    expect(h.archive).toHaveBeenCalledOnce();
    expect(h.archive.mock.calls[0]![0].sources).toEqual([source]);
    expect((uploadRefusal as { code?: string } | null)?.code).toBe(
      E2EE_PLAINTEXT_REFUSED_CODE
    );
    expect(network).not.toHaveBeenCalled();
    expect(committed.value).toBe(false);
    // The upload's refusal leaves it local only; the commit's own check
    // then refuses the insert.
    expect(h.finished.at(-1)).toEqual({
      tone: 'error',
      message: INSERT_INTO_PLAINTEXT_REFUSED
    });
  });

  it('refuses the commit of a plaintext account project once the source is pinned', async () => {
    const source = plainSource();
    const committed = { value: false };
    const h = harness({ onAccount: true });
    // Pinned during the upload, which the gate let through before it.
    h.archive.mockImplementation(async () => {
      pinElsewhere(source);
      return 'artifact_gearbox';
    });
    h.run.mockImplementation(throughCommit(committed));
    await runProjectInsert(h.deps);
    expect(committed.value).toBe(false);
    expect(h.finished.at(-1)?.message).toBe(INSERT_INTO_PLAINTEXT_REFUSED);
    expect(encryptionRequired(h.document.projectId)).toBe(false);
  });

  it('carries the requirement to a device-only project before the commit', async () => {
    const source = plainSource();
    const committed = { value: false };
    const h = harness({ onAccount: false });
    let requiredAtCommit = false;
    h.archive.mockImplementation(async () => {
      pinElsewhere(source);
      throw new Error('Cloud archival needs an account project.');
    });
    h.run.mockImplementation(async (command, options) => {
      const outcome = await throughCommit(committed)(command, options);
      requiredAtCommit = encryptionRequired(h.document.projectId);
      return outcome;
    });
    await runProjectInsert(h.deps);
    expect(committed.value).toBe(true);
    expect(requiredAtCommit).toBe(true);
    expect(
      localStorageEncryptedProjectPins().encryptionRequired(
        h.document.projectId
      )
    ).toBe(true);
  });
});

// PR #1418 review: an adoption keeps the editor's manager but moves its
// document to the account's id, so a manager fence alone let an insert
// commit under an id its requirement was never recorded for.
describe('runProjectInsert, the open project changing its id', () => {
  it('adds nothing when the id moves before the commit', async () => {
    let currentId = 'project_device_insert';
    const committed = { value: false };
    const h = harness({ destinationId: () => currentId });
    h.archive.mockImplementation(async () => {
      currentId = 'project_account_insert';
      return 'artifact_gearbox';
    });
    h.run.mockImplementation(throughCommit(committed));
    await runProjectInsert(h.deps);
    expect(committed.value).toBe(false);
    expect(h.finished.at(-1)).toEqual({
      tone: 'error',
      message: INSERT_DESTINATION_CHANGED
    });
  });

  it('uploads nothing once the id has moved', async () => {
    let currentId = 'project_device_insert_upload';
    const committed = { value: false };
    const h = harness({
      destinationId: () => currentId,
      inspectSolids: async () => {
        currentId = 'project_account_insert_upload';
        return [0];
      }
    });
    h.run.mockImplementation(throughCommit(committed));
    await runProjectInsert(h.deps);
    expect(h.archive).not.toHaveBeenCalled();
    expect(committed.value).toBe(false);
  });
});
