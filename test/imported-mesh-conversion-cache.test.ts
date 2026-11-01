import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  encodeImportedMeshPayload,
  toUserId,
  type ImportedSourceReference,
  type ProjectDocument
} from '@openzcad/shared';

/** A closed 10 × 20 × 30 box as a triangle soup, three vertices per facet. */
function boxSoup(offset: number): { vertices: number[]; indices: number[] } {
  const corner = (index: number) => [
    (index & 1 ? 10 : 0) + offset,
    index & 2 ? 20 : 0,
    index & 4 ? 30 : 0
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

/** A referenced mesh, then a box moved ahead of it so the mesh replays. */
function replayedMeshDocuments(ref: ImportedSourceReference): {
  built: ProjectDocument;
  replayed: ProjectDocument;
} {
  const manager = new CommandManager(
    createProjectDocument('Mesh cache', toUserId('user_mesh_cache'))
  );
  manager.execute(
    commandFactories.importMesh({
      name: 'scan.stl',
      artifactId: 'artifact_mesh_cache',
      sourceName: 'scan.stl',
      triangleCount: 12,
      meshPayloadRef: ref
    })
  );
  const built = manager.document;
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Ahead',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    })
  );
  const ahead = listFeaturesInOrder(manager.document).find(
    (feature) => feature.name === 'Ahead'
  )!;
  manager.execute(
    commandFactories.moveFeature({ featureId: ahead.featureId, toIndex: 0 })
  );
  return { built, replayed: manager.document };
}

describe('imported mesh conversion cache', { timeout: 120_000 }, () => {
  it('restores a replayed mesh exactly as a fresh conversion builds it', async () => {
    const { ref, bytes } = payloadReference(boxSoup(-50));
    const { built, replayed } = replayedMeshDocuments(ref);
    const bodyId = built.bodyOrder[0]!;
    const options = { resolveSourceBytes: async () => bytes };
    const cached = await createExactKernelAdapter(options);
    const fresh = await createExactKernelAdapter({
      ...options,
      importedMeshCacheBytes: 0
    });
    try {
      // The first build converts and stores; the replay restores from it.
      await cached.syncDocument(built);
      const restored = await cached.syncDocument(replayed);
      const converted = await fresh.syncDocument(replayed);
      const a = converted.bodyRepresentations[bodyId];
      const b = restored.bodyRepresentations[bodyId];
      expect(a?.volume).toBeCloseTo(6000, 6);
      expect(b?.volume).toBe(a?.volume);
      expect(b?.bbox).toEqual(a?.bbox);
      expect(b?.topology?.faces.map((face) => face.hash).sort()).toEqual(
        a?.topology?.faces.map((face) => face.hash).sort()
      );
      expect(b?.topology?.edges.map((edge) => edge.hash).sort()).toEqual(
        a?.topology?.edges.map((edge) => edge.hash).sort()
      );
      expect(restored.warnings).toEqual(converted.warnings);
    } finally {
      cached.dispose();
      fresh.dispose();
    }
  });
});
