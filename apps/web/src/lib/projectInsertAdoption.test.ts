/**
 * PR #1418 review: a project insert into a device-only project records the
 * source's encryption requirement against the device id. An adoption that
 * had already checked that id, and was awaiting its local rekey, then moved
 * the document to the account's id under the same editor, and the insert
 * committed there with no requirement, so its autosave went out in
 * plaintext. This runs the real adoption and the real insert run, with the
 * insert landing inside the adoption's rekey.
 */
import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandManager, type AnyCommand } from '@openzcad/command-system';
import {
  createProjectDocument,
  reidentifyProjectDocument
} from '@openzcad/document-core';
import { toProjectId, toUserId, type ProjectDocument } from '@openzcad/shared';

import {
  api,
  encryptionRequired,
  isEncryptedProject,
  rememberEncryptedProject
} from './api';
import { errorMessage } from './errors';
import { createInFlightImportChecksums } from './importArchival';
import type { ImportRunOutcome } from './importProgress';
import { saveLocalProject } from './localProjectStore';
import {
  adoptLocalProject,
  type AdoptLocalProjectResult,
  type LocalProjectAdoptionState
} from './projectIdentityTransfer';
import { INSERT_DESTINATION_CHANGED } from './projectInsertEncryption';
import type { PreparedProjectInsert } from './projectInsertPrepare';
import { localStepImportSourceStore } from './stepImportRun';
import type {
  ValidatedFeatureOutcome,
  ValidatedFeatureRunOptions
} from '../hooks/useValidatedFeatureCommit';

const { prepare } = vi.hoisted(() => ({
  prepare: vi.fn<() => Promise<PreparedProjectInsert>>()
}));
vi.mock('./projectInsertWorkerClient', () => ({
  prepareProjectInsertInWorker: () => prepare()
}));
vi.mock('./e2ee/encryptedProjects', () => ({
  encryptedProjectStore: vi.fn(async () => ({
    saveProjectDocument: vi.fn(async () => {
      throw new Error('encrypted store unavailable in this test');
    })
  })),
  encryptedProjectShelf: vi.fn(async () => new Map())
}));

const { runProjectInsert } = await import('./projectInsertRun');

const ACCOUNT = toUserId('user_insert_adoption');

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

let accountDocument: ProjectDocument | null = null;
/** Every request that left the page. */
const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method === 'POST' && urlOf(input) === '/api/projects') {
    const document = accountDocument!;
    return Response.json({
      project: {
        projectId: document.projectId,
        name: document.name,
        revisionCount: 0,
        updatedAt: '2026-11-14T00:00:00.000Z',
        documentVersion: document.version
      },
      document
    });
  }
  return Response.json({ enabled: false });
});

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('fetch', network);
});

afterEach(() => {
  network.mockClear();
  vi.unstubAllGlobals();
});

function adoptionState(
  manager: () => CommandManager | null
): LocalProjectAdoptionState {
  return {
    localUserId: toUserId('device'),
    manager,
    setDoc: () => undefined,
    remoteVersions: new Map(),
    setProjects: () => undefined,
    setArtifacts: () => undefined,
    accountUserId: ACCOUNT,
    setCloudProjectIds: () => undefined,
    cloudProjectIds: new Set(),
    setStatus: () => undefined,
    summarize: (document) => ({
      projectId: document.projectId,
      name: document.name,
      revisionCount: 0,
      updatedAt: '2026-11-14T00:00:00.000Z'
    }),
    acceptAccountDocument: async (remote) => remote
  };
}

describe('an insert that lands while an adoption rekeys its project', () => {
  it('commits nothing under the account id, which keeps the requirement, and sends no plaintext of it', async () => {
    const deviceId = `proj_device_${crypto.randomUUID()}`;
    const accountId = `proj_account_${crypto.randomUUID()}`;
    const source = `proj_source_${crypto.randomUUID()}`;
    expect(rememberEncryptedProject(source)).toBe(true);
    const local = reidentifyProjectDocument(
      createProjectDocument('Bracket', toUserId('device')),
      toProjectId(deviceId)
    );
    await saveLocalProject(local);
    accountDocument = {
      ...reidentifyProjectDocument(local, toProjectId(accountId)),
      ownerUserId: ACCOUNT
    };
    const manager = new CommandManager(local);
    expect(encryptionRequired(deviceId)).toBe(false);

    // The adoption checks the device id (nothing to carry yet), then
    // reads the editor once before its rekey and once after it.
    let rekeyStarted!: () => void;
    const rekeying = new Promise<void>((resolve) => {
      rekeyStarted = resolve;
    });
    let managerReads = 0;
    let requiredDuringRekey = false;
    const adoption: Promise<AdoptLocalProjectResult> = adoptLocalProject(
      deviceId,
      adoptionState(() => {
        managerReads += 1;
        if (managerReads === 1) rekeyStarted();
        if (managerReads === 2) {
          requiredDuringRekey = encryptionRequired(deviceId);
        }
        return manager;
      })
    );

    // The insert: prepared while the rekey runs, so it records the
    // source's requirement against the device id, then reaches its
    // commit once the adoption has moved the document.
    prepare.mockImplementationOnce(async () => {
      await rekeying;
      return {
        projectName: 'Gearbox',
        sourceProjectId: source,
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
        bodies: [
          { name: 'Plate Body', solidCount: 1, color: null, opacity: null }
        ],
        skipped: []
      };
    });
    let committed = false;
    const finished: ImportRunOutcome[] = [];
    const insert = runProjectInsert({
      file: new File(['{}'], 'gearbox.openzcad'),
      ownerUserId: ACCOUNT,
      signal: new AbortController().signal,
      progress: {
        start() {},
        update() {},
        finish: (outcome) => finished.push(outcome)
      },
      setStatus: () => undefined,
      // The adoption keeps the same editor.
      stillCurrent: () => true,
      destination: () => ({
        projectId: manager.document.projectId,
        onAccount: manager.document.projectId === accountId
      }),
      stepImport: {
        store: {
          ...localStepImportSourceStore,
          ensureLocalProjectStorage: async () => 'unavailable'
        },
        inspectSolids: async () => [0],
        archive: async () => {
          throw new Error('Cloud archival needs an account project.');
        },
        validatedFeature: {
          reserve: () => ({ release() {} }),
          run: async (
            _command: AnyCommand,
            options: ValidatedFeatureRunOptions
          ): Promise<ValidatedFeatureOutcome> => {
            await adoption;
            try {
              if (options.finalize) await options.finalize();
              options.beforeCommit?.();
            } catch (error) {
              options.onFailure?.(errorMessage(error, 'Not applied.'));
              return 'rejected';
            }
            committed = true;
            return 'committed';
          }
        },
        status: { setStatus: () => undefined, setFeatureFormError() {} },
        marks: {
          inFlight: createInFlightImportChecksums(),
          abandoned: new Set<string>()
        },
        currentDocument: () => manager.document,
        editDisabledReason: () => null,
        newId: () => crypto.randomUUID()
      }
    });

    expect((await adoption).state).toBe('adopted');
    await insert;
    expect(requiredDuringRekey).toBe(true);
    expect(manager.document.projectId).toBe(accountId);

    // Fenced on the id it started in: nothing landed under the new one.
    expect(committed).toBe(false);
    expect(finished.at(-1)).toEqual({
      tone: 'error',
      message: INSERT_DESTINATION_CHANGED
    });
    // The adoption carried the requirement it found just before publishing.
    expect(encryptionRequired(accountId)).toBe(true);
    expect(isEncryptedProject(accountId)).toBe(true);

    // The editor's next autosave of the account project is not plaintext.
    network.mockClear();
    await api
      .saveProjectDocument({
        projectId: toProjectId(accountId),
        expectedVersion: manager.document.version,
        document: manager.document
      })
      .catch(() => undefined);
    expect(
      network.mock.calls.filter(([input]) =>
        urlOf(input).startsWith(`/api/projects/${accountId}`)
      )
    ).toEqual([]);
  });
});
