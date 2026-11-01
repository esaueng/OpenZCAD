import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  importMeshBody,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { parseStl } from '@openzcad/io-stl';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { importedMeshStl } from '../packages/kernel-adapter/src/imported-mesh';
import { sharedDocumentReferencesImport } from '@openzcad/persistence';
import {
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES,
  decodeImportedMeshPayload,
  documentNodesWithHistory,
  documentStructureError,
  encodeImportedMeshPayload,
  hasValidImportedMeshSources,
  importedSourceReferenceOf,
  isImportedMeshSourceData,
  persistedDocumentBytes,
  toArtifactId,
  toUserId,
  type ImportedSourceReference,
  type ProjectDocument
} from '@openzcad/shared';
import {
  parseSaveProjectDocumentRequest,
  type HttpError
} from '../apps/web/worker/validation';

/**
 * IO-2 / PERF-1 (14 October 2026 review): an imported mesh was embedded in the
 * document as JSON numbers in the feature node AND in its `import.mesh`
 * command, and again in the import's undo entry — about 24 values per
 * triangle. From ~21k triangles the account refused the project; from ~100k
 * the import's own undo entry outgrew the 8 MB history budget and took every
 * undo step with it.
 *
 * Reference-form imports carry a SHA-256 of one canonical payload instead.
 */

const user = toUserId('user_mesh_payload');

/** A binary STL of facets on a 0.1 mm grid, like any scanned part. */
function binaryStl(triangles: number): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles, true);
  for (let i = 0; i < triangles; i += 1) {
    const base = 84 + i * 50 + 12;
    const x = (i % 1000) * 0.1 + 0.0123;
    const y = Math.floor(i / 1000) * 0.1 + 0.0456;
    [x, y, 1.7, x + 0.1, y, 1.7, x, y + 0.1, 1.9].forEach((value, k) =>
      view.setFloat32(base + k * 4, value, true)
    );
  }
  return buffer;
}

/** What `holdImportedMeshPayload` stores, without the blob store. */
function payloadReference(mesh: { vertices: number[]; indices: number[] }): {
  ref: ImportedSourceReference;
  bytes: Uint8Array;
} {
  const bytes = encodeImportedMeshPayload(mesh);
  return {
    bytes,
    ref: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
      logicalBytes: bytes.byteLength
    }
  };
}

/** A closed 10 × 20 × 30 box as a triangle soup, three vertices per facet. */
function boxSoup(): { vertices: number[]; indices: number[] } {
  const [w, d, h] = [10, 20, 30];
  const corner = (index: number) => [
    index & 1 ? w : 0,
    index & 2 ? d : 0,
    index & 4 ? h : 0
  ];
  const quads = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5]
  ];
  const vertices: number[] = [];
  for (const [a, b, c, e] of quads) {
    for (const index of [a, b, c, a, c, e]) vertices.push(...corner(index!));
  }
  return { vertices, indices: vertices.map((_, index) => index).slice(0, 36) };
}

function referencedMeshDocument(
  ref: ImportedSourceReference,
  triangleCount: number,
  artifactId = 'artifact_local_mesh'
): CommandManager {
  const manager = new CommandManager(createProjectDocument('Mesh', user));
  manager.execute(
    commandFactories.importMesh({
      name: 'scan.stl',
      artifactId,
      sourceName: 'scan.stl',
      triangleCount,
      meshPayloadRef: ref
    })
  );
  return manager;
}

function meshFeature(document: ProjectDocument) {
  const feature = Object.values(document.nodes).find(
    (node) => node.kind === 'feature' && node.featureKind === 'imported-mesh'
  );
  if (!feature || feature.kind !== 'feature') throw new Error('No mesh.');
  return feature;
}

function saveEdgeRefusal(document: ProjectDocument): string | null {
  try {
    parseSaveProjectDocumentRequest(
      { projectId: document.projectId, expectedVersion: 1, document },
      document.projectId
    );
    return null;
  } catch (error) {
    return `${(error as HttpError).status} ${(error as Error).message}`;
  }
}

describe('imported mesh payload encoding', () => {
  it('round-trips document-unit triangles exactly, -0 included', () => {
    const vertices = [0.1 / 25.4, -0, 1e-300, 123456.789, -2.5, 7 / 3];
    const indices = [0, 1, 0, 1, 0, 1];
    const decoded = decodeImportedMeshPayload(
      encodeImportedMeshPayload({ vertices, indices })
    );
    expect(Array.from(decoded.vertices)).toEqual(vertices);
    expect(Object.is(decoded.vertices[1], -0)).toBe(true);
    expect(Array.from(decoded.indices)).toEqual(indices);
  });

  it('encodes one content one way, so the checksum is stable', () => {
    const mesh = boxSoup();
    expect(payloadReference(mesh).ref).toEqual(payloadReference(mesh).ref);
    expect(payloadReference(mesh).ref.checksumSha256).not.toBe(
      payloadReference({ ...mesh, vertices: [...mesh.vertices].reverse() }).ref
        .checksumSha256
    );
  });

  it('refuses payloads it cannot vouch for', () => {
    const bytes = encodeImportedMeshPayload(boxSoup());
    for (const damaged of [
      bytes.subarray(0, 7),
      bytes.subarray(0, 10),
      bytes.subarray(0, bytes.length - 4),
      Uint8Array.from(bytes, (value, index) => (index === 0 ? 0 : value)),
      Uint8Array.from(bytes, (value, index) => (index === 6 ? 2 : value))
    ]) {
      expect(() => decodeImportedMeshPayload(damaged)).toThrow(
        'Imported mesh payload is unreadable.'
      );
    }
    for (const malformed of [
      { vertices: [0, 0], indices: [] },
      { vertices: [0, 0, Infinity], indices: [] },
      { vertices: [0, 0, 0], indices: [0, 0, -1] },
      { vertices: [0, 0, 0], indices: [0, 0, 0.5] }
    ]) {
      expect(() => encodeImportedMeshPayload(malformed)).toThrow(
        'Imported mesh data is malformed.'
      );
    }
  });

  it('leaves the triangles to the kernel handoff, which refuses what no kernel could build', () => {
    // A well-formed payload can still carry nonsense from a damaged store; the
    // one check every mesh passes on its way into a kernel catches it.
    const bytes = encodeImportedMeshPayload(boxSoup());
    new DataView(bytes.buffer).setFloat64(16, Number.NaN, true);
    expect(() =>
      importedMeshStl({
        sourceName: 'nan.stl',
        triangleCount: 12,
        ...decodeImportedMeshPayload(bytes)
      })
    ).toThrow(/malformed/);
    expect(() =>
      importedMeshStl({
        sourceName: 'index.stl',
        triangleCount: 1,
        ...decodeImportedMeshPayload(
          encodeImportedMeshPayload({
            vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 7]
          })
        )
      })
    ).toThrow(/invalid triangle index/);
  });

  it.each([
    ['Uint8Array', (length: number) => new Uint8Array(length)],
    ['Buffer', (length: number) => Buffer.alloc(length)]
  ] as const)(
    'owns the decoded data from an unaligned %s view',
    (_kind, allocate) => {
      const mesh = boxSoup();
      const bytes = encodeImportedMeshPayload(mesh);
      const padded = allocate(bytes.length + 3);
      padded.set(bytes, 3);
      const decoded = decodeImportedMeshPayload(padded.subarray(3));
      padded.fill(0);
      expect(Array.from(decoded.vertices)).toEqual(mesh.vertices);
      expect(Array.from(decoded.indices)).toEqual(mesh.indices);
    }
  );
});

describe('imported mesh feature forms', () => {
  const { ref } = payloadReference(boxSoup());

  it('stores exactly one of the embedded triangles and the reference', () => {
    const base = createProjectDocument('Forms', user);
    const input = {
      name: 'Box',
      artifactId: 'artifact_a',
      sourceName: 'box.stl',
      triangleCount: 12
    };
    const { vertices, indices } = boxSoup();
    expect(() =>
      importMeshBody(base, { ...input, vertices, indices, meshPayloadRef: ref })
    ).toThrow(/exactly one/);
    expect(() => importMeshBody(base, input)).toThrow(/exactly one/);
    expect(() =>
      importMeshBody(base, { ...input, vertices, meshPayloadRef: ref })
    ).toThrow(/exactly one/);
    expect(() => importMeshBody(base, { ...input, vertices })).toThrow(
      /exactly one/
    );

    const data = meshFeature(
      importMeshBody(base, { ...input, meshPayloadRef: ref }).document
    ).data;
    expect(data).toEqual({
      featureKind: 'imported-mesh',
      artifactId: 'artifact_a',
      sourceName: 'box.stl',
      triangleCount: 12,
      meshPayloadRef: ref
    });
    expect(importedSourceReferenceOf(data)).toEqual(ref);
  });

  it('accepts legacy embedded documents and refuses mixed or missing forms', () => {
    const { vertices, indices } = boxSoup();
    const embedded = {
      featureKind: 'imported-mesh',
      artifactId: toArtifactId('artifact_a'),
      sourceName: 'box.stl',
      triangleCount: 12,
      vertices,
      indices
    } as const;
    const referenced = {
      featureKind: 'imported-mesh',
      artifactId: toArtifactId('artifact_a'),
      sourceName: 'box.stl',
      triangleCount: 12,
      meshPayloadRef: ref
    } as const;
    expect(isImportedMeshSourceData(embedded)).toBe(true);
    expect(isImportedMeshSourceData(referenced)).toBe(true);
    expect(importedSourceReferenceOf(embedded)).toBeUndefined();
    expect(isImportedMeshSourceData({ ...embedded, meshPayloadRef: ref })).toBe(
      false
    );
    expect(isImportedMeshSourceData({ ...referenced, indices })).toBe(false);
    expect(isImportedMeshSourceData({ ...embedded, indices: undefined })).toBe(
      false
    );
    expect(
      isImportedMeshSourceData({
        ...referenced,
        meshPayloadRef: { ...ref, checksumSha256: 'nope' }
      })
    ).toBe(false);

    // The account and the room refuse what no rebuild could even look for.
    const document = referencedMeshDocument(ref, 12).document;
    expect(hasValidImportedMeshSources(document)).toBe(true);
    expect(saveEdgeRefusal(document)).toBeNull();
    const mixed = structuredClone(document);
    Object.assign(meshFeature(mixed).data, { vertices, indices });
    expect(hasValidImportedMeshSources(mixed)).toBe(false);
    expect(saveEdgeRefusal(mixed)).toBe(
      '400 "document" has invalid imported mesh data.'
    );
  });

  it('keeps the command log and undo entry by reference', () => {
    const manager = referencedMeshDocument(ref, 12);
    const entry = manager.document.commandLog.at(-1)!;
    expect(entry.kind).toBe('import.mesh');
    expect(entry.payload).toMatchObject({ meshPayloadRef: ref });
    expect(JSON.stringify(entry.payload)).not.toMatch(/vertices|indices/);
    expect(JSON.stringify(manager.document.editHistory)).not.toMatch(
      /"vertices"|"indices"/
    );
  });

  it('authorizes a share link to serve a referenced mesh payload, not an embedded mesh', () => {
    const referenced = referencedMeshDocument(
      ref,
      12,
      'artifact_payload'
    ).document;
    expect(sharedDocumentReferencesImport(referenced, 'artifact_payload')).toBe(
      true
    );
    expect(sharedDocumentReferencesImport(referenced, 'artifact_other')).toBe(
      false
    );
    const embedded = importMeshBody(createProjectDocument('Embedded', user), {
      name: 'Box',
      artifactId: 'artifact_original',
      sourceName: 'box.stl',
      triangleCount: 12,
      ...boxSoup()
    }).document;
    expect(sharedDocumentReferencesImport(embedded, 'artifact_original')).toBe(
      false
    );
  });

  it('rewires an archived payload id through the model, the command log and undo history', () => {
    const manager = referencedMeshDocument(ref, 12, 'artifact_local_payload');
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    manager.undo();
    manager.undo();
    // Only the undo history still names the import now.
    expect(manager.document.featureOrder).toHaveLength(0);
    const featureId = [...documentNodesWithHistory(manager.document)].find(
      (node) => node.kind === 'feature' && node.featureKind === 'imported-mesh'
    )!;
    const archived = manager.archiveSource(
      (featureId as { featureId: string }).featureId,
      'artifact_payload_archived'
    );
    const text = JSON.stringify(archived);
    expect(text).not.toContain('artifact_local_payload');
    expect(text).toContain('artifact_payload_archived');
    manager.redo();
    expect(meshFeature(manager.document).data).toMatchObject({
      artifactId: 'artifact_payload_archived',
      meshPayloadRef: ref
    });
  });

  it.each(['distinct ids', 'reused local id'] as const)(
    'archives only the uploaded source identity across restored history with %s',
    (ids) => {
      const manager = referencedMeshDocument(ref, 12, 'artifact_local_old');
      const featureId = manager.document.featureOrder[0]!;
      const newer = {
        ...ref,
        checksumSha256: 'b'.repeat(64),
        logicalBytes: ref.logicalBytes + 16
      };
      const localNew =
        ids === 'reused local id' ? 'artifact_local_old' : 'artifact_local_new';
      manager.execute(
        commandFactories.updateFeature({
          featureId,
          data: {
            artifactId: toArtifactId(localNew),
            meshPayloadRef: newer
          }
        })
      );
      const archived = manager.archiveSource(featureId, 'artifact_cloud_old', {
        kind: 'mesh-payload',
        checksumSha256: ref.checksumSha256,
        logicalBytes: ref.logicalBytes
      });
      expect(meshFeature(archived).data).toMatchObject({
        artifactId: localNew,
        meshPayloadRef: newer
      });
      const text = JSON.stringify(archived.commandLog);
      expect(text).toContain('artifact_cloud_old');
      expect(text).toContain(localNew);
      manager.undo();
      expect(meshFeature(manager.document).data).toMatchObject({
        artifactId: 'artifact_cloud_old',
        meshPayloadRef: ref
      });
      manager.redo();
      expect(meshFeature(manager.document).data).toMatchObject({
        artifactId: localNew,
        meshPayloadRef: newer
      });
    }
  );
});

describe(
  'imported mesh documents and the account',
  { timeout: 120_000 },
  () => {
    it('a 25k-triangle STL import saves to the account', () => {
      const parsed = parseStl(binaryStl(25_000), 'download.stl');
      const { ref } = payloadReference(parsed);
      const document = referencedMeshDocument(
        ref,
        parsed.triangleCount
      ).document;

      expect(documentStructureError(document)).toBeNull();
      expect(saveEdgeRefusal(document)).toBeNull();
      // A few kilobytes, not megabytes: the mesh lives once, outside.
      expect(persistedDocumentBytes(document)).toBeLessThan(64 * 1024);

      // The embedded form of the same import is what the account refused, and
      // still refuses: the cap did not move, the mesh did.
      const embedded = new CommandManager(createProjectDocument('Mesh', user));
      embedded.execute(
        commandFactories.importMesh({
          name: 'download.stl',
          artifactId: 'artifact_local_mesh',
          sourceName: 'download.stl',
          triangleCount: parsed.triangleCount,
          vertices: parsed.vertices,
          indices: parsed.indices
        })
      );
      expect(saveEdgeRefusal(embedded.document)).toMatch(
        /^400 Project document holds more than 500000 values\.$/
      );
    });

    it('a 200k-triangle import, the importer cap, stays far inside the cloud ceiling', () => {
      const parsed = parseStl(binaryStl(200_000), 'scan.stl');
      const { ref, bytes } = payloadReference(parsed);
      const document = referencedMeshDocument(
        ref,
        parsed.triangleCount
      ).document;
      expect(persistedDocumentBytes(document)).toBeLessThan(
        MAX_CLOUD_PROJECT_DOCUMENT_BYTES / 100
      );
      expect(saveEdgeRefusal(document)).toBeNull();
      // The payload itself: 16 header bytes, 8 per coordinate, 4 per index.
      expect(bytes.byteLength).toBe(16 + 200_000 * 9 * 8 + 200_000 * 3 * 4);
    });

    it('undo survives a 100k-triangle import', () => {
      const manager = new CommandManager(createProjectDocument('Undo', user));
      for (let box = 0; box < 5; box += 1) {
        manager.execute(
          commandFactories.addPrimitive({
            name: `Box ${box}`,
            primitiveKind: 'box',
            dimensions: { width: 10, height: 10, depth: 10 }
          })
        );
      }
      const parsed = parseStl(binaryStl(100_000), 'scan.stl');
      const { ref } = payloadReference(parsed);
      manager.execute(
        commandFactories.importMesh({
          name: 'Scan',
          artifactId: 'artifact_local_probe',
          sourceName: 'scan.stl',
          triangleCount: parsed.triangleCount,
          meshPayloadRef: ref
        })
      );
      // Before: undoLabel null, no entries, 6 trimmed.
      expect(manager.undoLabel).toBe('Import STL mesh');
      expect(manager.document.editHistory?.entries).toHaveLength(6);
      expect(manager.document.editHistory?.trimmed).toBe(0);

      manager.undo();
      expect(manager.document.featureOrder).toHaveLength(5);
      expect(manager.undoLabel).toBe('Add box');
      manager.redo();
      expect(meshFeature(manager.document).data).toMatchObject({
        meshPayloadRef: ref
      });
    });
  }
);

describe('referenced mesh rebuilds', { timeout: 120_000 }, () => {
  it('retries a transient payload miss instead of restoring the missing mesh', async () => {
    const { ref, bytes } = payloadReference(boxSoup());
    const manager = referencedMeshDocument(ref, 12, 'artifact_mesh_retry');
    let resolverCalls = 0;
    const retrying = await createExactKernelAdapter({
      resolveSourceBytes: async () => {
        resolverCalls += 1;
        if (resolverCalls === 1)
          throw new Error('Network temporarily unavailable.');
        return bytes;
      }
    });
    try {
      const missed = await retrying.syncDocument(manager.document);
      expect(Object.keys(missed.bodyRepresentations)).toHaveLength(0);
      expect(missed.warnings.join('\n')).toContain(
        'not available on this device'
      );
      const retried = await retrying.syncDocument(manager.document);
      expect(retrying.hasTransientFailures(missed)).toBe(true);
      expect(Object.keys(retried.bodyRepresentations)).toHaveLength(1);
      expect(
        retried.bodyRepresentations[manager.document.bodyOrder[0]!]!.volume
      ).toBeCloseTo(6000, 6);
      expect(retried.warnings).toEqual([]);
      expect(retrying.hasTransientFailures(retried)).toBe(false);
      expect(resolverCalls).toBe(2);
    } finally {
      retrying.dispose();
    }
  });

  let adapter: ExactKernelAdapter;
  const payloads = new Map<string, Uint8Array>();
  const requests: {
    checksum: string;
    artifactId: string;
    sourceName: string;
  }[] = [];

  beforeAll(async () => {
    adapter = await createExactKernelAdapter({
      async resolveSourceBytes(ref, { artifactId, sourceName }) {
        requests.push({ checksum: ref.checksumSha256, artifactId, sourceName });
        const bytes = payloads.get(ref.checksumSha256);
        if (!bytes) throw new Error('not here');
        return bytes;
      }
    });
  });

  afterAll(() => {
    adapter.dispose();
  });

  it('builds the same body from the reference as from the embedded triangles', async () => {
    const mesh = boxSoup();
    const { ref, bytes } = payloadReference(mesh);
    payloads.set(ref.checksumSha256, bytes);

    const embedded = importMeshBody(createProjectDocument('Embedded', user), {
      name: 'Box',
      artifactId: 'artifact_box',
      sourceName: 'box.stl',
      triangleCount: 12,
      ...mesh
    });
    const referenced = importMeshBody(
      createProjectDocument('Referenced', user),
      {
        name: 'Box',
        artifactId: 'artifact_box',
        sourceName: 'box.stl',
        triangleCount: 12,
        meshPayloadRef: ref
      }
    );
    const fromEmbedded = await adapter.syncDocument(embedded.document);
    const fromReference = await adapter.syncDocument(referenced.document);
    const a = fromEmbedded.bodyRepresentations[embedded.bodyId];
    const b = fromReference.bodyRepresentations[referenced.bodyId];
    expect(fromReference.warnings).toEqual([]);
    expect(b?.volume).toBeCloseTo(6000, 6);
    expect(b?.volume).toBe(a?.volume);
    expect(b?.bbox).toEqual(a?.bbox);
    expect(b?.topology?.faces.map((face) => face.hash).sort()).toEqual(
      a?.topology?.faces.map((face) => face.hash).sort()
    );
    expect(requests).toContainEqual({
      checksum: ref.checksumSha256,
      artifactId: 'artifact_box',
      sourceName: 'box.stl'
    });
  });

  it('reads a referenced payload once, not on every edit', async () => {
    const mesh = {
      vertices: boxSoup().vertices.map((value) => value + 100),
      indices: boxSoup().indices
    };
    const { ref, bytes } = payloadReference(mesh);
    payloads.set(ref.checksumSha256, bytes);
    const manager = referencedMeshDocument(ref, 12, 'artifact_edits');
    await adapter.syncDocument(manager.document);
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    await adapter.syncDocument(manager.document);
    manager.undo();
    const derived = await adapter.syncDocument(manager.document);
    expect(Object.keys(derived.bodyRepresentations)).toHaveLength(1);
    expect(
      requests.filter((request) => request.checksum === ref.checksumSha256)
    ).toHaveLength(1);
  });

  it('restores a replayed mesh from its conversion exactly as built', async () => {
    const mesh = {
      vertices: boxSoup().vertices.map((value) => value - 50),
      indices: boxSoup().indices
    };
    const { ref, bytes } = payloadReference(mesh);
    payloads.set(ref.checksumSha256, bytes);
    const manager = referencedMeshDocument(ref, 12, 'artifact_replayed');
    const first = await adapter.syncDocument(manager.document);
    const bodyId = manager.document.bodyOrder[0]!;
    // A step moved ahead of the mesh replays it, which now restores the
    // cached conversion instead of translating and sewing the STL again.
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Ahead',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    const added = listFeaturesInOrder(manager.document).find(
      (feature) => feature.name === 'Ahead'
    )!;
    manager.execute(
      commandFactories.moveFeature({ featureId: added.featureId, toIndex: 0 })
    );
    const replayed = await adapter.syncDocument(manager.document);
    const a = first.bodyRepresentations[bodyId];
    const b = replayed.bodyRepresentations[bodyId];
    expect(b?.volume).toBe(a?.volume);
    expect(b?.bbox).toEqual(a?.bbox);
    expect(b?.topology?.faces.map((face) => face.hash).sort()).toEqual(
      a?.topology?.faces.map((face) => face.hash).sort()
    );
    expect(replayed.warnings).toEqual(first.warnings);
  });

  it('names the import whose payload this device cannot find', async () => {
    const { ref } = payloadReference({
      vertices: boxSoup().vertices.map((value) => value * 2),
      indices: boxSoup().indices
    });
    const { document, bodyId } = importMeshBody(
      createProjectDocument('Missing', user),
      {
        name: 'Lost',
        artifactId: 'artifact_lost',
        sourceName: 'lost.stl',
        triangleCount: 12,
        meshPayloadRef: ref
      }
    );
    const derived = await adapter.syncDocument(document);
    expect(derived.bodyRepresentations[bodyId]).toBeUndefined();
    expect(derived.warnings.join('\n')).toContain(
      'Mesh data for "lost.stl" is not available on this device.'
    );
  });
});
