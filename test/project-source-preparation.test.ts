import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  toArtifactId,
  toAssetId
} from '@openzcad/shared';
import { prepareProjectSources } from '../apps/web/src/lib/projectSources';

it.each(['step', 'mesh'] as const)(
  'rebuilds the same %s geometry after externalizing legacy source data',
  async (kind) => {
    const manager = new CommandManager(
      createProjectDocument('Source preservation', toUserId('source_owner'))
    );
    const common = {
      name: 'Imported body',
      sourceName: `part.${kind}`,
      artifactId: 'artifact_legacy'
    };
    manager.execute(
      kind === 'step'
        ? commandFactories.importStep({
            ...common,
            stepText: readFileSync(
              new URL('./parity/corpus/b-unit-mm-cube.step', import.meta.url),
              'utf8'
            )
          })
        : commandFactories.importMesh({
            ...common,
            triangleCount: 4,
            vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
            indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]
          })
    );
    Object.assign(manager.document, {
      schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION - 1
    });
    const assetId = toAssetId('source_asset');
    manager.document.assets[assetId] = {
      assetId,
      artifactId: toArtifactId(common.artifactId),
      kind: kind === 'step' ? 'step-source' : 'stl-source',
      name: common.sourceName,
      contentType: 'application/octet-stream',
      storage: 'remote',
      createdAt: new Date().toISOString()
    };
    const sources = new Map<string, Uint8Array>();
    const prepared = await prepareProjectSources(
      manager.document,
      async (source) => {
        if (source.bytes) sources.set(source.ref.checksumSha256, source.bytes);
        return 'b'.repeat(32);
      }
    );
    expect(prepared.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(prepared.assets[assetId]!.artifactId).toBe('b'.repeat(32));
    expect(prepared.assets[assetId]!.checksum).toBe([...sources.keys()][0]);
    expect(prepared.assets[assetId]!.kind).toBe(
      kind === 'step' ? 'step-source' : 'mesh-cache'
    );
    expect(manager.document.assets[assetId].artifactId).toBe(common.artifactId);
    const before = await createExactKernelAdapter();
    const after = await createExactKernelAdapter({
      resolveSourceBytes: async (ref) => {
        const bytes = sources.get(ref.checksumSha256);
        if (!bytes) throw new Error('Missing restored source');
        return bytes;
      }
    });
    try {
      const original = await before.syncDocument(manager.document);
      const restored = await after.syncDocument(prepared);
      expect(original.exportableBodyIds).toHaveLength(1);
      expect(restored.exportableBodyIds).toEqual(original.exportableBodyIds);
      expect(restored.warnings).toEqual(original.warnings);
      const id = original.exportableBodyIds[0]!;
      expect(restored.bodyRepresentations[id]!.mesh).toEqual(
        original.bodyRepresentations[id]!.mesh
      );
      expect(restored.bodyRepresentations[id]!.topology).toEqual(
        original.bodyRepresentations[id]!.topology
      );
    } finally {
      before.dispose();
      after.dispose();
    }
  }
);

it('does not introduce dependencies from imports retained only in a pruned command log', async () => {
  const base = createProjectDocument(
    'Deleted import',
    toUserId('source_owner')
  );
  const manager = new CommandManager(base);
  manager.execute(
    commandFactories.importStep({
      name: 'Deleted source',
      sourceName: 'deleted.step',
      artifactId: 'artifact_unavailable',
      stepSourceRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: 'a'.repeat(64),
        logicalBytes: 5
      }
    })
  );
  const archive = vi
    .fn()
    .mockRejectedValue(new Error('An obsolete source must not be requested'));
  const document = { ...base, commandLog: manager.document.commandLog };
  const prepared = await prepareProjectSources(document, archive);
  expect(archive).not.toHaveBeenCalled();
  expect(prepared.commandLog).toEqual(document.commandLog);
});

it('refuses conflicting source forms before archiving or changing the input', async () => {
  const manager = new CommandManager(
    createProjectDocument('Invalid source', toUserId('source_owner'))
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Part',
      sourceName: 'part.step',
      artifactId: 'artifact_legacy',
      stepText: 'original bytes'
    })
  );
  const feature = Object.values(manager.document.nodes).find(
    (node) => node.kind === 'feature'
  )!;
  if (feature.kind !== 'feature') throw new Error('Missing import');
  Object.assign(feature.data, {
    stepSourceRef: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: 'a'.repeat(64),
      logicalBytes: 5
    }
  });
  const before = JSON.stringify(manager.document);
  const archive = vi.fn(async () => 'blob');
  await expect(
    prepareProjectSources(manager.document, archive)
  ).rejects.toThrow('Invalid rebuild data');
  expect(archive).not.toHaveBeenCalled();
  expect(JSON.stringify(manager.document)).toBe(before);
});
