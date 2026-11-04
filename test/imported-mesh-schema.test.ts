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
  isImportedMeshSourceData,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  decodeProjectStorageBody,
  hydrateProjectStorageSnapshot,
  prepareProjectStorageSnapshot
} from '@openzcad/persistence';

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

    expect(document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
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

describe('assumed units on a unitless mesh import (v52)', () => {
  function importWith(assumedUnits?: 'mm' | 'inch') {
    const manager = new CommandManager(
      createProjectDocument('Unitless mesh', toUserId('user_mesh_units'))
    );
    manager.execute(
      commandFactories.importMesh({
        name: 'Bracket',
        sourceName: 'bracket.stl',
        artifactId: 'artifact_bracket',
        triangleCount: 1,
        meshPayloadRef: reference,
        ...(assumedUnits ? { assumedUnits } : {})
      })
    );
    return manager.document;
  }
  const meshData = (document: ProjectDocument) =>
    Object.values(document.nodes).flatMap((node) =>
      node.kind === 'feature' && node.data.featureKind === 'imported-mesh'
        ? [node.data]
        : []
    )[0]!;

  it('records the reading on the feature, and it survives save and replay', () => {
    const document = importWith('inch');
    expect(meshData(document).assumedUnits).toBe('inch');
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(52);
    const saved = JSON.parse(JSON.stringify(document)) as ProjectDocument;
    expect(meshData(normalizeDocument(saved)).assumedUnits).toBe('inch');
    const manager = new CommandManager(normalizeDocument(saved));
    manager.undo();
    manager.redo();
    expect(meshData(manager.document).assumedUnits).toBe('inch');
  });

  it('leaves the field out when no reading was assumed', () => {
    expect('assumedUnits' in meshData(importWith())).toBe(false);
  });

  it('accepts only a known unit', () => {
    const data = meshData(importWith('mm'));
    expect(isImportedMeshSourceData(data)).toBe(true);
    expect(isImportedMeshSourceData({ ...data, assumedUnits: 'furlong' })).toBe(
      false
    );
    expect(isImportedMeshSourceData({ ...data, assumedUnits: 25.4 })).toBe(
      false
    );
  });
});
