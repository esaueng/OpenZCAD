import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  normalizeDocument
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  documentNodesWithHistory,
  importedSourceReferenceOf,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  decodeProjectStorageBody,
  hydrateProjectStorageSnapshot,
  prepareProjectStorageSnapshot
} from '../packages/cloudflare-adapters/src/project-object-storage';

const reference = {
  marker: 'openzcad-source-ref' as const,
  version: 1 as const,
  hashAlgorithm: 'sha256' as const,
  checksumSha256: 'a'.repeat(64),
  logicalBytes: 128
};

function meshDocument(form: 'embedded' | 'reference'): ProjectDocument {
  const manager = new CommandManager(
    createProjectDocument('Portable mesh', toUserId('user_mesh_schema'))
  );
  manager.execute(
    commandFactories.importMesh({
      name: 'Triangle',
      sourceName: 'triangle.stl',
      artifactId: 'artifact_triangle',
      triangleCount: 1,
      ...(form === 'reference'
        ? { meshPayloadRef: reference }
        : { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] })
    })
  );
  return manager.document;
}

describe('reference mesh schema boundary', () => {
  it('saves reference-only meshes beyond the v16 client boundary', () => {
    const document = meshDocument('reference');
    const saved = JSON.parse(JSON.stringify(document)) as ProjectDocument;

    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(23);
    expect(saved.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(saved.schemaVersion).toBeGreaterThan(16);
    expect(normalizeDocument(saved)).toEqual(document);
    for (const node of documentNodesWithHistory(saved)) {
      if (node.kind !== 'feature' || node.data.featureKind !== 'imported-mesh')
        continue;
      expect(node.data.meshPayloadRef).toEqual(reference);
      expect(node.data.vertices).toBeUndefined();
      expect(node.data.indices).toBeUndefined();
    }
  });

  it.each(['embedded', 'reference'] as const)(
    'hydrates v16 %s meshes without rewriting their sources or history',
    async (form) => {
      const legacy = structuredClone(meshDocument(form));
      legacy.schemaVersion = 16 as typeof legacy.schemaVersion;
      const before = structuredClone(legacy);
      const prepared = await prepareProjectStorageSnapshot(legacy);
      const hydrated = await hydrateProjectStorageSnapshot(
        prepared.snapshot,
        legacy.projectId,
        async (ref) => {
          const asset = prepared.assets.find(
            (candidate) => candidate.objectKey === ref.objectKey
          );
          if (!asset) throw new Error('Missing projected mesh asset.');
          return decodeProjectStorageBody(
            Uint8Array.from(asset.storedBody).buffer,
            asset.contentEncoding,
            asset.logicalBytes
          );
        }
      );
      const normalized = normalizeDocument(hydrated);

      expect(normalized.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
      expect({ ...normalized, schemaVersion: 16 }).toEqual(before);
      expect(legacy).toEqual(before);
      expect(normalizeDocument(normalized)).toEqual(normalized);
      const manager = new CommandManager(normalized);
      manager.undo();
      manager.redo();
      expect(manager.document.nodes).toEqual(normalized.nodes);
      const references = [...documentNodesWithHistory(normalized)].flatMap(
        (node) =>
          node.kind === 'feature' && importedSourceReferenceOf(node.data)
            ? [importedSourceReferenceOf(node.data)]
            : []
      );
      if (form === 'reference') {
        expect(references.length).toBeGreaterThan(0);
        expect(
          references.every(
            (ref) => ref?.checksumSha256 === reference.checksumSha256
          )
        ).toBe(true);
      } else {
        expect(references).toEqual([]);
      }
    }
  );
});
