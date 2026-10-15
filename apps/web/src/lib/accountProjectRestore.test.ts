import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  duplicateProjectDocument
} from '@openzcad/document-core';
import {
  documentNodesWithHistory,
  encodeImportedMeshPayload,
  toUserId
} from '@openzcad/shared';
import { api, ApiError } from './api';
import {
  archiveLocalOnlyImportSources,
  listLocalOnlyImportSources
} from './importArchival';
import {
  loadLocalProject,
  loadSourceBlob,
  putSourceBlobIfAbsent,
  saveLocalProject,
  summarizeProjectDocument
} from './localProjectStore';
import { restoreAccountProjectFromDevice as restoreConfirmedAccountProject } from './projectIdentityTransfer';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function restore(
  document: Parameters<typeof restoreConfirmedAccountProject>[0],
  expectedVersion: number,
  sources: Omit<
    Parameters<typeof restoreConfirmedAccountProject>[2],
    'remoteVersions'
  >
) {
  const remoteVersions = new Map<string, number>();
  try {
    const result = await restoreConfirmedAccountProject(
      document,
      {
        ...summarizeProjectDocument(document),
        documentVersion: expectedVersion
      },
      { ...sources, remoteVersions }
    );
    expect(result.project.documentVersion).toBe(result.document.version);
    expect(result.project.name).toBe(result.document.name);
    return result.document;
  } finally {
    expect(remoteVersions.get(document.projectId)).toBe(expectedVersion);
  }
}

async function imports() {
  const manager = new CommandManager(
    createProjectDocument('Account repair', toUserId('owner'))
  );
  const step = await putSourceBlobIfAbsent(new Uint8Array([1, 2, 3]));
  manager.execute(
    commandFactories.importStep({
      name: 'STEP in undo',
      sourceName: 'part.step',
      artifactId: 'artifact_local_step',
      stepSourceRef: step.ref
    })
  );
  manager.execute(
    commandFactories.deleteFeature({
      featureId: manager.document.featureOrder[0]!
    })
  );
  for (const [name, height] of [
    ['Current mesh', 0],
    ['Redo mesh', 1]
  ] as const) {
    const mesh = await putSourceBlobIfAbsent(
      encodeImportedMeshPayload({
        vertices: [0, 0, height, 1, 0, height, 0, 1, height],
        indices: [0, 1, 2]
      })
    );
    manager.execute(
      commandFactories.importMesh({
        name,
        sourceName: `${name}.stl`,
        artifactId: `artifact_local_${height}`,
        triangleCount: 1,
        meshPayloadRef: mesh.ref
      })
    );
  }
  manager.undo();
  await saveLocalProject(manager.document);
  return manager;
}

function archiver(
  manager: CommandManager,
  upload: Parameters<typeof archiveLocalOnlyImportSources>[0]['archive']
) {
  return () =>
    archiveLocalOnlyImportSources({
      document: manager.document,
      currentDocument: () => manager.document,
      loadSourceBytes: loadSourceBlob,
      archive: upload,
      applyArtifactId(featureId, artifactId, source) {
        manager.archiveSource(featureId, artifactId, source);
        return true;
      }
    });
}

it('archives mesh and STEP sources in current, undo and redo before restoring', async () => {
  const manager = await imports();
  const clicked = manager.document;
  const upload = vi.fn(
    async (input: { fileName: string }) => `artifact_owned_${input.fileName}`
  );
  const save = vi
    .spyOn(api, 'saveProjectDocument')
    .mockImplementation(async (input) => {
      expect(listLocalOnlyImportSources(input.document)).toEqual([]);
      expect(upload).toHaveBeenCalledTimes(3);
      expect(input.expectedVersion).toBe(1);
      return {
        projectId: input.projectId,
        version: input.document.version,
        updatedAt: '2026-10-15T00:00:00.000Z'
      };
    });
  const restored = await restore(clicked, 1, {
    archive: archiver(manager, upload),
    currentDocument: () => manager.document
  });
  expect(save).toHaveBeenCalledOnce();
  expect(listLocalOnlyImportSources(restored)).toEqual([]);
  expect(
    [...documentNodesWithHistory(restored)].filter(
      (node) => node.kind === 'feature'
    )
  ).not.toHaveLength(0);
  const redo = new CommandManager(restored);
  redo.redo();
  expect(redo.document.featureOrder).toHaveLength(2);
  expect(listLocalOnlyImportSources(redo.document)).toEqual([]);
  expect(
    listLocalOnlyImportSources((await loadLocalProject(clicked.projectId))!)
  ).toEqual([]);
});

it.each(['missing', 'failed'] as const)(
  'keeps partial archives for retry and refuses restore when a source is %s',
  async (outcome) => {
    const manager = await imports();
    const save = vi.spyOn(api, 'saveProjectDocument');
    const upload = vi.fn(async (input: { kind: string; fileName: string }) => {
      if (input.kind === 'mesh-payload') throw new Error('Upload unavailable');
      return `artifact_owned_${input.fileName}`;
    });
    const archive = () =>
      archiveLocalOnlyImportSources({
        document: manager.document,
        loadSourceBytes: async (checksum) => {
          const source = listLocalOnlyImportSources(manager.document).find(
            (entry) => entry.checksumSha256 === checksum
          );
          return outcome === 'missing' && source?.kind === 'mesh-payload'
            ? null
            : loadSourceBlob(checksum);
        },
        archive: upload,
        applyArtifactId(featureId, artifactId, source) {
          manager.archiveSource(featureId, artifactId, source);
          return true;
        }
      });
    await expect(
      restore(manager.document, 1, {
        archive,
        currentDocument: () => manager.document
      })
    ).rejects.toThrow('The account copy was not restored');
    expect(save).not.toHaveBeenCalled();
    const cached = (await loadLocalProject(manager.document.projectId))!;
    expect(listLocalOnlyImportSources(cached)).toHaveLength(2);
    expect(
      listLocalOnlyImportSources(cached).every(
        (source) => source.kind === 'mesh-payload'
      )
    ).toBe(true);
    const retry = vi.fn(
      async (input: { fileName: string }) => `artifact_owned_${input.fileName}`
    );
    save.mockImplementation(async (input) => ({
      projectId: input.projectId,
      version: input.document.version,
      updatedAt: '2026-10-15T00:00:00.000Z'
    }));
    const restored = await restore(cached, 1, {
      archive: archiver(manager, retry),
      currentDocument: () => manager.document
    });
    expect(retry).toHaveBeenCalledTimes(2);
    expect(
      retry.mock.calls.every(([input]) => input.fileName.endsWith('.ozmesh'))
    ).toBe(true);
    expect(listLocalOnlyImportSources(restored)).toEqual([]);
  }
);

it('retains newer device edits and owned sources when the fenced restore fails', async () => {
  const manager = await imports();
  manager.redo();
  await saveLocalProject(manager.document);
  const clicked = manager.document;
  const refused = new ApiError(409, 'Account changed');
  const save = vi.spyOn(api, 'saveProjectDocument').mockRejectedValue(refused);
  let edited = false;
  const upload = vi.fn(async (input: { fileName: string }) => {
    if (!edited) {
      edited = true;
      manager.execute(
        commandFactories.renameNode({
          nodeId: manager.document.rootNodeId,
          name: 'Edited during recovery'
        })
      );
    }
    return `artifact_owned_${input.fileName}`;
  });
  await expect(
    restore(clicked, 1, {
      archive: archiver(manager, upload),
      currentDocument: () => manager.document
    })
  ).rejects.toBe(refused);
  expect(save.mock.calls[0]![0].document.name).toBe('Account repair');
  const cached = (await loadLocalProject(clicked.projectId))!;
  expect(cached.name).toBe('Edited during recovery');
  expect(cached.version).toBe(manager.document.version);
  expect(listLocalOnlyImportSources(cached)).toEqual([]);
  const retryArchive = vi.fn();
  save.mockImplementation(async (input) => ({
    projectId: input.projectId,
    version: input.document.version,
    updatedAt: '2026-10-15T00:00:00.000Z'
  }));
  const restored = await restore(cached, 2, {
    archive: retryArchive,
    currentDocument: () => manager.document
  });
  expect(retryArchive).not.toHaveBeenCalled();
  expect(restored.name).toBe('Edited during recovery');
  expect(save.mock.calls[1]![0].expectedVersion).toBe(2);
});

it('does not replace a reopened project with the departed upload manager', async () => {
  const departed = await imports();
  const clicked = departed.document;
  const reopened = new CommandManager(clicked);
  reopened.execute(
    commandFactories.renameNode({
      nodeId: reopened.document.rootNodeId,
      name: 'Reopened and edited'
    })
  );
  await saveLocalProject(reopened.document);
  const upload = vi.fn(
    async (input: { fileName: string }) => `artifact_owned_${input.fileName}`
  );
  const save = vi.spyOn(api, 'saveProjectDocument');
  await expect(
    restore(clicked, 1, {
      archive: archiver(departed, upload),
      // App supplies no originating document after its manager is replaced.
      currentDocument: () => null
    })
  ).rejects.toThrow('The account copy was not restored');
  expect(save).not.toHaveBeenCalled();
  expect((await loadLocalProject(clicked.projectId))!.name).toBe(
    'Reopened and edited'
  );
  expect((await loadLocalProject(clicked.projectId))!.version).toBe(
    reopened.document.version
  );
});

it('does not start the old project archive against a replacement editor after the lazy import', async () => {
  const original = await imports();
  const clicked = original.document;
  const replacement = new CommandManager(
    duplicateProjectDocument(clicked, 'Other account copy', toUserId('owner'))
  );
  const before = structuredClone(replacement.document);
  expect(replacement.document.projectId).not.toBe(clicked.projectId);
  expect(replacement.document.featureOrder[0]).toBe(clicked.featureOrder[0]);
  const upload = vi.fn(async () => 'artifact_archived_under_original_project');
  // This is the App closure's actual shape: document/upload owner come from
  // the old render; the archival run reads managerRef only when it starts.
  const archive = vi.fn(() =>
    archiveLocalOnlyImportSources({
      document: clicked,
      currentDocument: () => replacement.document,
      loadSourceBytes: loadSourceBlob,
      archive: upload,
      applyArtifactId(featureId, artifactId, source) {
        replacement.archiveSource(featureId, artifactId, source);
        return [...documentNodesWithHistory(replacement.document)].some(
          (node) =>
            node.kind === 'feature' &&
            'artifactId' in node.data &&
            node.data.artifactId === artifactId
        );
      }
    })
  );
  const save = vi.spyOn(api, 'saveProjectDocument');
  await expect(
    restore(clicked, 1, {
      archive,
      currentDocument: () => null
    })
  ).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
  expect(replacement.document).toEqual(before);
  expect(archive).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
});
