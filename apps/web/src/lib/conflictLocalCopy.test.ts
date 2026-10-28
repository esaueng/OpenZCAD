import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addReferenceImage,
  createProjectDocument
} from '@openzcad/document-core';
import {
  documentNodesWithHistory,
  encodeImportedMeshPayload,
  importedSourceReferenceOf,
  toUserId,
  type ArtifactId,
  type ReferenceImage,
  type ReferenceImageId
} from '@openzcad/shared';
import {
  loadSourceBlob,
  saveLocalProject,
  sha256Hex
} from './localProjectStore';
import { resolveExactSourceBytes } from './exactSourceResolver';
import { localConflictCopy } from './conflictLocalCopy';

const sourceOwner = toUserId('user_shared_source_owner');
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function sourceFixture(kind: 'step' | 'mesh') {
  const bytes =
    kind === 'step'
      ? new TextEncoder().encode('ISO-10303-21;\nEND-ISO-10303-21;')
      : encodeImportedMeshPayload({
          vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 2]
        });
  return {
    bytes,
    ref: {
      marker: 'openzcad-source-ref' as const,
      version: 1 as const,
      hashAlgorithm: 'sha256' as const,
      checksumSha256: await sha256Hex(bytes),
      logicalBytes: bytes.byteLength
    }
  };
}

describe('Keep both creates an ordinary owned project', () => {
  it.each([
    ['signed-in viewer', toUserId('user_current_viewer')],
    ['signed-in editor', toUserId('user_current_editor')],
    ['device-only visitor', toUserId('user_local_browser')]
  ] as const)(
    'assigns the copy and its undo history to the %s',
    async (_role, creator) => {
      const original = new CommandManager(
        createProjectDocument('Shared part', sourceOwner)
      );
      original.execute(
        commandFactories.renameNode({
          nodeId: original.document.rootNodeId,
          name: 'My local changes'
        })
      );
      const source = structuredClone(original.document);
      const copy = await localConflictCopy(
        source,
        ['My local changes (copy)'],
        creator
      );
      expect(copy.ownerUserId).toBe(creator);
      expect(copy.editHistory?.actorUserId).toBe(creator);
      expect(copy.projectId).not.toBe(source.projectId);
      expect(copy.name).toBe('My local changes (copy 2)');
      expect(copy.checkpoints).toHaveLength(1);
      expect(copy.revisions).toHaveLength(1);
      expect(copy.checkpoints[0]?.revisionId).toBe(
        copy.revisions[0]?.revisionId
      );
      for (const node of documentNodesWithHistory(copy)) {
        if (node.kind === 'project')
          expect(node.projectId).toBe(copy.projectId);
      }
      const reopened = new CommandManager(copy, creator);
      expect(reopened.canUndo).toBe(true);
      reopened.undo();
      expect(reopened.document.name).toBe('Shared part');
      expect(reopened.document.ownerUserId).toBe(creator);
      expect(reopened.document.projectId).toBe(copy.projectId);
      reopened.redo();
      expect(reopened.document.name).toBe('My local changes (copy 2)');
      expect(reopened.document.ownerUserId).toBe(creator);
      reopened.execute(
        commandFactories.renameNode({
          nodeId: copy.rootNodeId,
          name: 'My independent part'
        })
      );
      expect(reopened.document.name).toBe('My independent part');
      expect(original.document).toEqual(source);
      expect(source.ownerUserId).toBe(sourceOwner);
    }
  );

  it('also assigns ownership when a legacy source has no undo history', async () => {
    const source = createProjectDocument('Legacy shared part', sourceOwner);
    const creator = toUserId('user_current_owner');
    const copy = await localConflictCopy(source, [], creator);
    expect(copy.ownerUserId).toBe(creator);
    expect(copy.name).toBe('Legacy shared part (copy)');
    expect(new CommandManager(copy, creator).document.ownerUserId).toBe(
      creator
    );
    expect(source.ownerUserId).toBe(sourceOwner);
  });
});

it.each(['step', 'mesh'] as const)(
  'caches and detaches a current %s source before copying',
  async (kind) => {
    const { bytes, ref } = await sourceFixture(kind);
    const manager = new CommandManager(
      createProjectDocument('Shared import', sourceOwner)
    );
    manager.execute(
      kind === 'step'
        ? commandFactories.importStep({
            name: 'Source',
            sourceName: 'part.step',
            artifactId: 'artifact_cloud_source',
            stepSourceRef: ref
          })
        : commandFactories.importMesh({
            name: 'Source',
            sourceName: 'part.stl',
            artifactId: 'artifact_cloud_source',
            triangleCount: 1,
            meshPayloadRef: ref
          })
    );
    const source = structuredClone(manager.document);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(bytes));
    vi.stubGlobal('fetch', fetch);
    const copy = await localConflictCopy(
      source,
      [],
      toUserId('user_copy_owner')
    );
    await saveLocalProject(copy);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(copy)).not.toContain('artifact_cloud_source');
    expect(await loadSourceBlob(ref.checksumSha256)).toEqual(bytes);
    fetch.mockReset().mockRejectedValue(new Error('Source access revoked'));
    for (const node of documentNodesWithHistory(copy)) {
      if (node.kind !== 'feature') continue;
      const imported = importedSourceReferenceOf(node.data);
      if (imported)
        await expect(
          resolveExactSourceBytes(
            imported,
            node.data as Parameters<typeof resolveExactSourceBytes>[1]
          )
        ).resolves.toEqual(bytes);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(manager.document).toEqual(source);
  }
);

it('retains independent STEP undo and mesh redo after original access is revoked', async () => {
  const step = await sourceFixture('step');
  const mesh = await sourceFixture('mesh');
  const manager = new CommandManager(
    createProjectDocument('Shared history', sourceOwner)
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Undo source',
      sourceName: 'undo.step',
      artifactId: 'artifact_cloud_undo',
      stepSourceRef: step.ref
    })
  );
  manager.execute(
    commandFactories.deleteFeature({
      featureId: manager.document.featureOrder[0]!
    })
  );
  manager.execute(
    commandFactories.importMesh({
      name: 'Redo source',
      sourceName: 'redo.stl',
      artifactId: 'artifact_cloud_redo',
      triangleCount: 1,
      meshPayloadRef: mesh.ref
    })
  );
  manager.undo();
  const source = structuredClone(manager.document);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (url) => {
      const address =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      return new Response(address.includes('undo') ? step.bytes : mesh.bytes);
    });
  vi.stubGlobal('fetch', fetch);
  const creator = toUserId('user_copy_owner');
  const copy = await localConflictCopy(source, [], creator);
  await saveLocalProject(copy);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(copy)).not.toMatch(/artifact_cloud_(undo|redo)/);
  fetch.mockReset().mockRejectedValue(new Error('Source access revoked'));
  const reopened = new CommandManager(copy, creator);
  reopened.undo();
  expect(reopened.document.featureOrder).toHaveLength(1);
  reopened.redo();
  reopened.redo();
  expect(reopened.document.featureOrder).toHaveLength(1);
  for (const node of documentNodesWithHistory(copy)) {
    if (node.kind !== 'feature') continue;
    const ref = importedSourceReferenceOf(node.data);
    if (ref) {
      const expected =
        ref.checksumSha256 === step.ref.checksumSha256
          ? step.bytes
          : mesh.bytes;
      await expect(
        resolveExactSourceBytes(
          ref,
          node.data as Parameters<typeof resolveExactSourceBytes>[1]
        )
      ).resolves.toEqual(expected);
    }
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(manager.document).toEqual(source);
});

it.each([404, 'corrupt'] as const)(
  'refuses the copy if a required source is %s, without mutating the original',
  async (failure) => {
    const { bytes, ref } = await sourceFixture('step');
    const manager = new CommandManager(
      createProjectDocument('Shared source', sourceOwner)
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Required source',
        sourceName: 'required.step',
        artifactId: 'artifact_cloud_required',
        stepSourceRef: ref
      })
    );
    const source = structuredClone(manager.document);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          failure === 'corrupt'
            ? new Response(new Uint8Array(bytes.length).fill(9))
            : new Response(null, { status: failure })
        )
    );
    await expect(
      localConflictCopy(source, [], toUserId('user_copy_owner'))
    ).rejects.toThrow();
    expect(manager.document).toEqual(source);
    expect(source.ownerUserId).toBe(sourceOwner);
  }
);

it('caches and detaches reference pictures retained only in redo history', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const ref = {
    marker: 'openzcad-source-ref' as const,
    version: 1 as const,
    hashAlgorithm: 'sha256' as const,
    checksumSha256: await sha256Hex(bytes),
    logicalBytes: bytes.length
  };
  const image: ReferenceImage = {
    imageId: 'rimg_history' as ReferenceImageId,
    name: 'History picture',
    contentType: 'image/png',
    source: ref,
    artifactId: 'artifact_cloud_picture' as ArtifactId,
    pixelWidth: 2,
    pixelHeight: 2,
    plane: { type: 'canonical', plane: 'XY', offset: 0 },
    center: { u: 0, v: 0 },
    rotationDeg: 0,
    width: 10,
    opacity: 1
  };
  const manager = new CommandManager(
    createProjectDocument('Shared picture', sourceOwner)
  );
  manager.applyDocumentEdit(
    addReferenceImage(manager.document, { image }),
    'Added picture'
  );
  manager.undo();
  const source = structuredClone(manager.document);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(bytes));
  vi.stubGlobal('fetch', fetch);
  const creator = toUserId('user_copy_owner');
  const copy = await localConflictCopy(source, [], creator);
  await saveLocalProject(copy);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(copy)).not.toContain('artifact_cloud_picture');
  fetch.mockReset().mockRejectedValue(new Error('Source access revoked'));
  const reopened = new CommandManager(copy, creator);
  reopened.redo();
  const restored = reopened.document.referenceImages!.images[0]!;
  await expect(
    resolveExactSourceBytes(restored.source, {
      artifactId: restored.artifactId,
      sourceName: restored.name
    })
  ).resolves.toEqual(bytes);
  expect(fetch).not.toHaveBeenCalled();
  expect(manager.document).toEqual(source);
});
