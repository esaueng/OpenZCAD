import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  MESH_PAYLOAD_UNITS_SCHEMA_VERSION,
  assertStorableDocument,
  createProjectDocument,
  normalizeDocument,
  updateFeature
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  documentNodesWithHistory,
  importedSourceReferenceOf,
  isImportedMeshSourceData,
  toUserId,
  type FeatureId,
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
  const meshDataOrUndefined = (document: ProjectDocument) =>
    Object.values(document.nodes).flatMap((node) =>
      node.kind === 'feature' && node.data.featureKind === 'imported-mesh'
        ? [node.data]
        : []
    )[0];
  const meshData = (document: ProjectDocument) =>
    meshDataOrUndefined(document)!;

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

describe('mesh payload units (v153)', () => {
  function withPayloadUnits(
    document: ProjectDocument,
    payloadUnits: unknown
  ): ProjectDocument {
    const next = structuredClone(document);
    for (const node of Object.values(next.nodes))
      if (node.kind === 'feature' && node.data.featureKind === 'imported-mesh')
        (node.data as Record<string, unknown>).payloadUnits = payloadUnits;
    return next;
  }
  const meshDataOrUndefined = (document: ProjectDocument) =>
    Object.values(document.nodes).flatMap((node) =>
      node.kind === 'feature' && node.data.featureKind === 'imported-mesh'
        ? [node.data]
        : []
    )[0];
  const meshData = (document: ProjectDocument) =>
    meshDataOrUndefined(document)!;

  it('is part of the current schema', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(
      MESH_PAYLOAD_UNITS_SCHEMA_VERSION
    );
  });

  function featureIdOf(document: ProjectDocument): FeatureId {
    const feature = Object.values(document.nodes).find(
      (node) => node.kind === 'feature'
    );
    if (feature?.kind !== 'feature') throw new Error('No mesh feature.');
    return feature.featureId;
  }
  function olderSchema(document: ProjectDocument): ProjectDocument {
    return {
      ...structuredClone(document),
      schemaVersion: MESH_PAYLOAD_UNITS_SCHEMA_VERSION - 1
    } as never;
  }
  const importInput = (
    form: 'embedded' | 'reference',
    payloadUnits?: 'mm' | 'inch'
  ) => ({
    name: 'Triangle',
    sourceName: 'triangle.stl',
    artifactId: 'artifact_triangle',
    triangleCount: 1,
    ...(form === 'reference'
      ? { meshPayloadRef: reference }
      : { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }),
    ...(payloadUnits ? { payloadUnits } : {})
  });

  it('round-trips a feature.update and an import.mesh through save, normalization and replay', () => {
    const base = createProjectDocument(
      'Converted mesh',
      toUserId('user_mesh_schema')
    );
    const manager = new CommandManager(base);
    manager.execute(commandFactories.importMesh(importInput('reference')));
    const patchedId = featureIdOf(manager.document);
    manager.execute(
      commandFactories.updateFeature({
        featureId: patchedId,
        data: { payloadUnits: 'mm' }
      })
    );
    manager.execute(
      commandFactories.importMesh(importInput('reference', 'inch'))
    );
    const meshes = (document: ProjectDocument) =>
      Object.fromEntries(
        Object.values(document.nodes).flatMap((node) =>
          node.kind === 'feature' && node.data.featureKind === 'imported-mesh'
            ? [[node.featureId, node.data.payloadUnits]]
            : []
        )
      );
    const written = meshes(manager.document);
    expect(Object.keys(written)).toHaveLength(2);
    expect(written[patchedId]).toBe('mm');
    expect(Object.values(written).filter((unit) => unit === 'inch')).toEqual([
      'inch'
    ]);

    // The command log carries both, and replaying it rebuilds both.
    expect(manager.document.commandLog.map((command) => command.kind)).toEqual(
      expect.arrayContaining(['import.mesh', 'feature.update'])
    );
    const replayed = replayCommands(base, manager.document.commandLog);
    expect(meshes(replayed)).toEqual(written);

    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    const reopened = normalizeDocument(saved);
    expect(meshes(reopened)).toEqual(written);
    expect(meshes(assertStorableDocument(saved))).toEqual(written);
    expect(meshes(replayCommands(base, reopened.commandLog))).toEqual(written);
    const reopenedManager = new CommandManager(reopened);
    reopenedManager.undo();
    expect(meshes(reopenedManager.document)[patchedId]).toBe('mm');
    reopenedManager.undo();
    expect(meshes(reopenedManager.document)[patchedId]).toBeUndefined();
    reopenedManager.redo();
    reopenedManager.redo();
    expect(meshes(reopenedManager.document)).toEqual(written);

    // Absent stays absent: an import that states none writes none.
    expect('payloadUnits' in meshData(meshDocument('reference'))).toBe(false);
  });

  it('refuses it beside inline vertices, on update and on import', () => {
    const embedded = meshDocument('embedded');
    expect(() =>
      updateFeature(embedded, {
        featureId: featureIdOf(embedded),
        data: { payloadUnits: 'mm' }
      } as never)
    ).toThrow(/payload/i);
    const manager = new CommandManager(embedded);
    const before = manager.document;
    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId: featureIdOf(embedded),
          data: { payloadUnits: 'mm' }
        })
      )
    ).toThrow(/payload/i);
    expect(manager.document).toBe(before);
    expect(() =>
      manager.execute(
        commandFactories.importMesh({
          ...importInput('embedded'),
          payloadUnits: 'mm'
        })
      )
    ).toThrow(/payload/i);
    expect(manager.document).toBe(before);
    // Nor an unknown unit beside a reference.
    const referenced = meshDocument('reference');
    expect(() =>
      updateFeature(referenced, {
        featureId: featureIdOf(referenced),
        data: { payloadUnits: 'furlong' }
      } as never)
    ).toThrow(/payload/i);
  });

  it('refuses inline triangles patched in beside it, before anything changes', () => {
    // A referenced mesh that states its payload's units, then a patch that
    // adds embedded triangles: the merged data would carry the field beside
    // triangles the kernel reads in document units, which storage refuses.
    const base = createProjectDocument(
      'Patched mesh',
      toUserId('user_mesh_schema')
    );
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.importMesh(importInput('reference', 'mm'))
    );
    const featureId = featureIdOf(manager.document);
    const inline = {
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2]
    };
    const before = manager.document;
    const beforeLog = structuredClone(before.commandLog);
    expect(() =>
      manager.execute(
        commandFactories.updateFeature({
          featureId,
          data: inline
        })
      )
    ).toThrow(/payload units/i);
    expect(manager.document).toBe(before);
    expect(manager.document.commandLog).toEqual(beforeLog);
    expect(manager.canRedo).toBe(false);
    // Undo still returns to the empty document, and what remains stores.
    expect(() =>
      assertStorableDocument(JSON.parse(JSON.stringify(manager.document)))
    ).not.toThrow();
    manager.undo();
    expect(meshDataOrUndefined(manager.document)).toBeUndefined();
    manager.redo();
    expect(meshData(manager.document).payloadUnits).toBe('mm');
    expect(() =>
      assertStorableDocument(JSON.parse(JSON.stringify(manager.document)))
    ).not.toThrow();
    // Either array alone is refused as well.
    for (const partial of [
      { vertices: inline.vertices },
      { indices: inline.indices }
    ])
      expect(() =>
        updateFeature(manager.document, {
          featureId,
          data: partial
        })
      ).toThrow(/payload units/i);
    // Replay applies the same rule: a log carrying the patch is refused.
    const forged = [
      ...manager.document.commandLog,
      {
        ...manager.document.commandLog.at(-1)!,
        kind: 'feature.update',
        payload: { featureId, data: inline }
      }
    ];
    expect(() => replayCommands(base, forged as never)).toThrow(
      /payload units/i
    );
  });

  it('refuses an import.mesh carrying it on an older-schema manager', () => {
    const older = olderSchema(
      createProjectDocument('Older', toUserId('user_mesh_schema'))
    );
    const manager = new CommandManager(older);
    expect(() =>
      manager.execute(
        commandFactories.importMesh(importInput('reference', 'mm'))
      )
    ).toThrow(/Mesh payload units require project schema v153/);
    expect(manager.document).toBe(older);
    expect(manager.document.commandLog).toEqual(older.commandLog);
    // The same import without the field still runs there.
    manager.execute(commandFactories.importMesh(importInput('reference')));
    expect(() => normalizeDocument(manager.document)).not.toThrow();
  });

  it('refuses a document that declares an older schema', () => {
    const document = withPayloadUnits(meshDocument('reference'), 'inch');
    expect(() =>
      normalizeDocument({
        ...document,
        schemaVersion: MESH_PAYLOAD_UNITS_SCHEMA_VERSION - 1
      } as never)
    ).toThrow(/Mesh payload units require project schema v153/);
    // A command log that patched it in is refused too, node or not.
    const plain = meshDocument('reference');
    const feature = Object.values(plain.nodes).find(
      (node) => node.kind === 'feature'
    )!;
    const patched = {
      ...plain,
      schemaVersion: MESH_PAYLOAD_UNITS_SCHEMA_VERSION - 1,
      commandLog: [
        ...plain.commandLog,
        {
          ...plain.commandLog.at(-1)!,
          kind: 'feature.update',
          payload: {
            featureId: feature.kind === 'feature' ? feature.featureId : '',
            data: { payloadUnits: 'mm' }
          }
        }
      ]
    };
    expect(() => normalizeDocument(patched as never)).toThrow(/v153/);
    // The same document without the field still opens at that schema.
    expect(() =>
      normalizeDocument({
        ...meshDocument('reference'),
        schemaVersion: MESH_PAYLOAD_UNITS_SCHEMA_VERSION - 1
      } as never)
    ).not.toThrow();
  });

  it('refuses a patch that writes it into an older document', () => {
    const document = {
      ...meshDocument('reference'),
      schemaVersion: MESH_PAYLOAD_UNITS_SCHEMA_VERSION - 1
    } as never as ProjectDocument;
    const feature = Object.values(document.nodes).find(
      (node) => node.kind === 'feature'
    )!;
    if (feature.kind !== 'feature') throw new Error('No mesh feature.');
    expect(() =>
      updateFeature(document, {
        featureId: feature.featureId,
        data: { payloadUnits: 'mm' }
      } as never)
    ).toThrow(/v153/);
  });

  it('accepts any known unit, only beside a payload reference', () => {
    const reference = meshData(meshDocument('reference'));
    for (const unit of ['mm', 'cm', 'm', 'inch'])
      expect(
        isImportedMeshSourceData({ ...reference, payloadUnits: unit })
      ).toBe(true);
    for (const bad of ['furlong', 'Inch', 25.4, null, {}])
      expect(
        isImportedMeshSourceData({ ...reference, payloadUnits: bad })
      ).toBe(false);
    // Embedded triangles are always in document units.
    const embedded = meshData(meshDocument('embedded'));
    expect(isImportedMeshSourceData(embedded)).toBe(true);
    expect(isImportedMeshSourceData({ ...embedded, payloadUnits: 'mm' })).toBe(
      false
    );
    expect(() =>
      assertStorableDocument(
        JSON.parse(
          JSON.stringify(withPayloadUnits(meshDocument('embedded'), 'mm'))
        )
      )
    ).toThrow();
    expect(() =>
      assertStorableDocument(
        JSON.parse(
          JSON.stringify(withPayloadUnits(meshDocument('reference'), 'ft'))
        )
      )
    ).toThrow();
  });
});
