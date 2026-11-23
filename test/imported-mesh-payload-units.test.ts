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
  type BodyRepresentation,
  type ImportedSourceReference,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';
import { coincidentBoxSoup } from './support/mesh-import-fixtures';

/**
 * I03 (schema v153): an imported mesh's payload may be stored in another unit
 * than the document's (`payloadUnits`), and the kernel scales it on load.
 * Nothing writes the field yet (the stored-unit conversion will), so these
 * documents set it directly on the feature.
 */

/** A closed 10 × 20 × 30 box as a triangle soup, three vertices per facet. */
function boxSoup(): { vertices: number[]; indices: number[] } {
  const corner = (index: number) => [
    index & 1 ? 10 : 0,
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

function meshDocument(
  ref: ImportedSourceReference,
  units: UnitSystem,
  triangleCount: number,
  payloadUnits?: UnitSystem
): ProjectDocument {
  const manager = new CommandManager(
    createProjectDocument('Mesh units', toUserId('user_mesh_units'), units)
  );
  manager.execute(
    commandFactories.importMesh({
      name: 'scan.stl',
      artifactId: 'artifact_mesh_units',
      sourceName: 'scan.stl',
      triangleCount,
      meshPayloadRef: ref
    })
  );
  const document = structuredClone(manager.document);
  if (payloadUnits) {
    for (const node of Object.values(document.nodes)) {
      if (node.kind === 'feature' && node.data.featureKind === 'imported-mesh')
        node.data.payloadUnits = payloadUnits;
    }
  }
  return document;
}

/** The same document with a box moved ahead of the mesh, so it replays. */
function replayed(document: ProjectDocument): ProjectDocument {
  const manager = new CommandManager(document);
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
  return manager.document;
}

function meshBody(
  document: ProjectDocument,
  representations: Partial<Record<string, BodyRepresentation>>
): BodyRepresentation {
  const bodyId = document.bodyOrder[0];
  const body = bodyId === undefined ? undefined : representations[bodyId];
  if (!body) throw new Error('No mesh body.');
  return body;
}

function extent(box: BodyRepresentation['bbox']): number[] {
  return [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
}

function displayExtent(vertices: Float32Array): number[] {
  const size: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    let min = Infinity;
    let max = -Infinity;
    for (let index = axis; index < vertices.length; index += 3) {
      min = Math.min(min, vertices[index]!);
      max = Math.max(max, vertices[index]!);
    }
    size.push(max - min);
  }
  return size;
}

function stlExtent(stl: string): number[] {
  const points = [...stl.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map(
    (match) => [Number(match[1]), Number(match[2]), Number(match[3])]
  );
  return [0, 1, 2].map(
    (axis) =>
      Math.max(...points.map((point) => point[axis]!)) -
      Math.min(...points.map((point) => point[axis]!))
  );
}

function expectExtent(actual: number[], expected: number[], digits = 6) {
  actual.forEach((value, axis) =>
    expect(value).toBeCloseTo(expected[axis]!, digits)
  );
}

describe('imported mesh payload units', { timeout: 180_000 }, () => {
  const { ref, bytes } = payloadReference(boxSoup());
  const options = { resolveSourceBytes: async () => bytes };

  it('reads a payload with no payloadUnits in document units, as before v153', async () => {
    // Characterization: the payload's numbers are the document's, whatever
    // unit that is — the 10 × 20 × 30 soup is a 10 × 20 × 30 inch box here.
    const adapter = await createExactKernelAdapter(options);
    try {
      const document = meshDocument(ref, 'inch', 12);
      const result = await adapter.syncDocument(document);
      const body = meshBody(document, result.bodyRepresentations);
      expect(body.meshReference).toBeUndefined();
      expect(body.volume).toBeCloseTo(6000, 6);
      expectExtent(extent(body.bbox), [10, 20, 30]);
      expectExtent(displayExtent(body.mesh.vertices), [10, 20, 30], 4);
      // Export is millimetres: inches times 25.4.
      expectExtent(
        stlExtent(
          await adapter.exportStl(document, [body.bodyId], undefined, {
            units: 'mm'
          })
        ),
        [254, 508, 762],
        3
      );
    } finally {
      adapter.dispose();
    }
  });

  it.each([
    ['mm', 1 / 25.4],
    ['cm', 10 / 25.4]
  ] as const)(
    'scales a %s payload into an inch document on load',
    async (payloadUnits, k) => {
      const adapter = await createExactKernelAdapter(options);
      const unscaledAdapter = await createExactKernelAdapter(options);
      try {
        const document = meshDocument(ref, 'inch', 12, payloadUnits);
        const result = await adapter.syncDocument(document);
        const body = meshBody(document, result.bodyRepresentations);
        const plain = meshDocument(ref, 'inch', 12);
        const unscaled = meshBody(
          plain,
          (await unscaledAdapter.syncDocument(plain)).bodyRepresentations
        );
        // Geometry: bounds by k, volume (analysis) by k³, the same faces.
        expect(body.meshReference).toBeUndefined();
        expectExtent(extent(body.bbox), [10 * k, 20 * k, 30 * k]);
        expect(body.volume).toBeCloseTo(6000 * k ** 3, 6);
        expect(body.faceCount).toBe(unscaled.faceCount);
        expect(body.faceCount).toBeGreaterThan(0);
        // Display: the tessellation is in the scaled document units.
        expectExtent(
          displayExtent(body.mesh.vertices),
          [10 * k, 20 * k, 30 * k],
          4
        );
        // Export: millimetres again, so the payload's own numbers times
        // its unit's millimetres.
        const mm = 25.4 * k;
        expectExtent(
          stlExtent(
            await adapter.exportStl(document, [body.bodyId], undefined, {
              units: 'mm'
            })
          ),
          [10 * mm, 20 * mm, 30 * mm],
          3
        );
      } finally {
        adapter.dispose();
        unscaledAdapter.dispose();
      }
    }
  );

  it('scales the reference-mesh fallback when the facets make no solid', async () => {
    // Non-manifold facets (a 2 × 3 × 4 extent): the translator refuses them
    // as a solid, so the body is a display-only reference mesh — scaled all
    // the same.
    const soup = coincidentBoxSoup();
    const open = payloadReference({
      vertices: [...soup.vertices],
      indices: [...soup.indices]
    });
    const adapter = await createExactKernelAdapter({
      resolveSourceBytes: async () => open.bytes
    });
    try {
      const document = meshDocument(open.ref, 'inch', soup.triangleCount, 'mm');
      const result = await adapter.syncDocument(document);
      const body = meshBody(document, result.bodyRepresentations);
      expect(body.meshReference).toBe(true);
      expectExtent(displayExtent(body.mesh.vertices), [
        2 / 25.4,
        3 / 25.4,
        4 / 25.4
      ]);
      expectExtent(extent(body.bbox), [2 / 25.4, 3 / 25.4, 4 / 25.4]);
    } finally {
      adapter.dispose();
    }
  });

  it('never shares a cached conversion between two reads of one blob', async () => {
    // One adapter, one blob: unscaled, then as millimetres, then each again
    // through a replay that restores from the conversion cache.
    const adapter = await createExactKernelAdapter(options);
    try {
      const plain = meshDocument(ref, 'inch', 12);
      const fromMm = meshDocument(ref, 'inch', 12, 'mm');
      const volume = async (document: ProjectDocument) =>
        meshBody(
          document,
          (await adapter.syncDocument(document)).bodyRepresentations
        ).volume;
      expect(await volume(plain)).toBeCloseTo(6000, 6);
      expect(await volume(fromMm)).toBeCloseTo(6000 / 25.4 ** 3, 6);
      expect(await volume(replayed(plain))).toBeCloseTo(6000, 6);
      expect(await volume(replayed(fromMm))).toBeCloseTo(6000 / 25.4 ** 3, 6);
      // A millimetre payload in a millimetre document reads as-is.
      expect(await volume(meshDocument(ref, 'mm', 12, 'mm'))).toBeCloseTo(
        6000,
        6
      );
    } finally {
      adapter.dispose();
    }
  });
});
