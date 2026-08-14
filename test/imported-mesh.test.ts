import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  importMeshBody,
  mirrorBody,
  offsetSolidBody,
  shellBody
} from '@openzcad/document-core';
import { solidFromTriangles, solidVolume } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  toArtifactId,
  type BodyId,
  type BodyNode,
  type ProjectDocument
} from '@openzcad/shared';
import { importedMeshStl } from '../packages/kernel-adapter/src/imported-mesh';

/**
 * Imported meshes on the one exact kernel.
 *
 * A document containing an imported mesh used to be rerouted, whole, to a
 * separate polyhedral kernel that had no case for `mirror`, `shell` or
 * `solid-offset`. Those features produced no geometry and only a generic
 * "no geometry produced" warning, so a user lost operations without being told
 * what happened or why. Every one of them must now rebuild through the kernel,
 * and the one thing an imported mesh still cannot do — boolean against an exact
 * body — must refuse by name instead of disappearing.
 */

const user = toUserId('user_mesh_import');

/** A closed 12-triangle box, the shape a real STL export of a block has. */
function boxMesh(
  width: number,
  height: number,
  depth: number
): { vertices: number[]; indices: number[]; triangleCount: number } {
  const corners: [number, number, number][] = [
    [0, 0, 0],
    [width, 0, 0],
    [width, height, 0],
    [0, height, 0],
    [0, 0, depth],
    [width, 0, depth],
    [width, height, depth],
    [0, height, depth]
  ];
  // Outward-facing quads: -Z, +Z, -Y, +Y, -X, +X.
  const quads = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [3, 7, 6, 2],
    [0, 4, 7, 3],
    [1, 2, 6, 5]
  ];
  const vertices: number[] = [];
  const indices: number[] = [];
  for (const quad of quads) {
    const base = vertices.length / 3;
    for (const corner of quad) {
      vertices.push(...corners[corner]!);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { vertices, indices, triangleCount: indices.length / 3 };
}

const MESH = boxMesh(10, 20, 30);

function meshDocument(): { document: ProjectDocument; bodyId: BodyId } {
  return importMeshBody(createProjectDocument('Mesh part', user), {
    name: 'Imported block',
    artifactId: 'artifact_block',
    sourceName: 'block.stl',
    ...MESH
  });
}

function asciiStlVolume(text: string): number {
  const points = [...text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap(
    (match) => [Number(match[1]), Number(match[2]), Number(match[3])]
  );
  const indices = [...Array(points.length / 3).keys()];
  return Math.abs(solidVolume(solidFromTriangles(points, indices)));
}

// Real-kernel suite: WASM startup plus solid modeling runs well past the 5 s
// default when the whole test pool is contending for CPU.
describe('imported meshes on the exact kernel', { timeout: 30_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  it('rebuilds a mesh-import document with mirror, shell and solid-offset', async () => {
    const { document, bodyId } = meshDocument();
    const base = await adapter.syncDocument(document);
    expect(base.warnings).toEqual([]);
    // Sewing recovers whole planar faces, so the top of the block is one face
    // a user can select rather than two loose triangles.
    const top = base.bodyRepresentations[bodyId]!.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs(face.geometry.center.z - 30) < 1e-7
    );
    expect(top).toBeTruthy();

    const mirrored = mirrorBody(document, {
      name: 'Mirrored block',
      targetBodyId: bodyId,
      plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
    });
    const shelled = shellBody(document, {
      name: 'Shelled block',
      targetBodyId: bodyId,
      openingFaceHashes: [top!.hash],
      ...(top!.reference ? { openingFaceReferences: [top!.reference] } : {}),
      thickness: 1
    });
    const offset = offsetSolidBody(document, {
      name: 'Offset block',
      targetBodyId: bodyId,
      distance: 1
    });

    // Mirror: an independent copy on the far side of the plane, same size.
    const mirrorState = await adapter.syncDocument(mirrored.document);
    expect(mirrorState.warnings).toEqual([]);
    const mirroredBody = mirrorState.bodyRepresentations[mirrored.bodyId]!;
    expect(mirroredBody.volume).toBeCloseTo(6000, 6);
    expect(mirroredBody.bbox.min.x).toBeCloseTo(-10, 6);
    expect(mirroredBody.bbox.max.x).toBeCloseTo(0, 6);
    // Mirror does not consume its source, so both bodies survive.
    expect(mirrorState.bodyRepresentations[bodyId]!.consumed).toBe(false);

    // Shell: 1 mm walls, open on the selected top face, so the cavity runs the
    // full 29 mm above the floor.
    const shellState = await adapter.syncDocument(shelled.document);
    expect(shellState.warnings).toEqual([]);
    const shelledBody = shellState.bodyRepresentations[shelled.bodyId]!;
    expect(shelledBody.volume).toBeCloseTo(6000 - 8 * 18 * 29, 6);
    expect(shelledBody.bbox.max).toEqual({ x: 10, y: 20, z: 30 });

    // Solid offset: every face pushed out 1 mm, so 12 x 22 x 32.
    const offsetState = await adapter.syncDocument(offset.document);
    expect(offsetState.warnings).toEqual([]);
    const offsetBody = offsetState.bodyRepresentations[offset.bodyId]!;
    expect(offsetBody.volume).toBeCloseTo(12 * 22 * 32, 6);
    expect(offsetBody.bbox.min).toEqual({ x: -1, y: -1, z: -1 });
    expect(offsetBody.bbox.max).toEqual({ x: 11, y: 21, z: 31 });
  });

  it('keeps mesh-reference body semantics and hash-only lineage', async () => {
    const { document, bodyId } = meshDocument();
    const body = Object.values(document.nodes).find(
      (node): node is BodyNode => node.kind === 'body'
    )!;
    expect(body.bodyType).toBe('mesh-reference');
    expect(body.representationSource).toBe('mesh-import');

    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const representation = derived.bodyRepresentations[bodyId]!;
    expect(representation.source).toBe('imported-mesh');
    expect(representation.volume).toBeCloseTo(6000, 6);
    expect(representation.bbox).toEqual({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 20, z: 30 }
    });

    // Nothing about a mesh is traceable to a modeling operation, so no face or
    // edge may claim a verified lineage reference and the body must say so.
    const topology = representation.topology!;
    expect(topology.faces.every((face) => face.reference === undefined)).toBe(
      true
    );
    expect(topology.edges.every((edge) => edge.reference === undefined)).toBe(
      true
    );
    expect(topology.lineageDiagnostics).toEqual([
      expect.objectContaining({ kind: 'body', status: 'hash-only' })
    ]);
  });

  it('round-trips the mesh through STL export without losing volume', async () => {
    const { document, bodyId } = meshDocument();
    const sourceVolume = Math.abs(
      solidVolume(solidFromTriangles(MESH.vertices, MESH.indices))
    );
    const stl = await adapter.exportStl(document, [bodyId]);
    // Tessellating planar faces is exact, so the tolerance here is numerical,
    // not geometric: the exported solid must be the mesh that was imported.
    expect(asciiStlVolume(stl)).toBeCloseTo(sourceVolume, 6);
    expect(sourceVolume).toBeCloseTo(6000, 6);
  });

  it('scales a mesh STL export to millimetres for an inch document', async () => {
    const { document, bodyId } = importMeshBody(
      createProjectDocument('Inch mesh', user, 'inch'),
      {
        name: 'Imported block',
        artifactId: 'artifact_block',
        sourceName: 'block.stl',
        ...boxMesh(1, 2, 3)
      }
    );
    const stl = await adapter.exportStl(document, [bodyId]);
    expect(asciiStlVolume(stl)).toBeCloseTo(6 * 25.4 ** 3, 3);
  });

  it('refuses a boolean against an imported mesh by name', async () => {
    const { document, bodyId } = meshDocument();
    const withTool = addPrimitiveFeature(document, {
      name: 'Tool',
      primitiveKind: 'box',
      dimensions: { width: 5, height: 5, depth: 40 }
    });
    const toolId = withTool.bodyOrder.at(-1)!;
    const cut = booleanBodies(withTool, {
      name: 'Cut mesh',
      operation: 'subtract',
      targetBodyIds: [bodyId, toolId]
    }).document;

    const derived = await adapter.syncDocument(cut);
    // Named body, named reason, named remedy — not a silent drop.
    expect(derived.warnings).toEqual([
      'Feature "Cut mesh": Body "Imported block" is an imported mesh, which ' +
        'has no exact surfaces to boolean against. Convert the mesh to a ' +
        'solid, or build the cut from exact bodies instead.'
    ]);
    // The operands still rebuild; only the boolean result is missing.
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(6000, 6);
    expect(derived.bodyRepresentations[toolId]!.volume).toBeCloseTo(1000, 6);
  });

  it('refuses a boolean against a body derived from an imported mesh', async () => {
    const { document, bodyId } = meshDocument();
    const mirrored = mirrorBody(document, {
      name: 'Mirrored block',
      targetBodyId: bodyId,
      plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
    });
    const withTool = addPrimitiveFeature(mirrored.document, {
      name: 'Tool',
      primitiveKind: 'box',
      dimensions: { width: 5, height: 5, depth: 40 }
    });
    const toolId = withTool.bodyOrder.at(-1)!;
    const cut = booleanBodies(withTool, {
      name: 'Cut mirror',
      operation: 'union',
      targetBodyIds: [mirrored.bodyId, toolId]
    }).document;

    const derived = await adapter.syncDocument(cut);
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain('Cut mirror');
    expect(derived.warnings[0]).toContain('is an imported mesh');
  });

  it('names a mesh it cannot turn into a body instead of failing blankly', async () => {
    const { document } = importMeshBody(
      createProjectDocument('Broken mesh', user),
      {
        name: 'Single facet',
        artifactId: 'artifact_facet',
        sourceName: 'facet.stl',
        triangleCount: 1,
        vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2]
      }
    );
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([
      'Feature "Single facet": An imported mesh needs at least two triangles to form a body.'
    ]);
    expect(Object.keys(derived.bodyRepresentations)).toHaveLength(0);
  });
});

describe('imported mesh document validation', () => {
  it('rejects malformed persisted triangle indices before serialization', () => {
    expect(() =>
      importedMeshStl({
        featureKind: 'imported-mesh',
        artifactId: toArtifactId('artifact_bad'),
        sourceName: 'bad.stl',
        triangleCount: 1,
        vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 99]
      })
    ).toThrow(/invalid triangle index/);
  });
});
