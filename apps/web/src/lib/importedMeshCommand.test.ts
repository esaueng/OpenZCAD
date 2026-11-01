import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { parseStl } from '@openzcad/io-stl';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type UnitSystem } from '@openzcad/shared';
import {
  importedMeshCommand,
  meshInDocumentUnits
} from './importedMeshCommand';

/** A 25.4 mm cube as an ASCII STL: one inch on every side. */
function inchCubeStl(): ArrayBuffer {
  const s = 25.4;
  const corners = [
    [0, 0, 0],
    [s, 0, 0],
    [s, s, 0],
    [0, s, 0],
    [0, 0, s],
    [s, 0, s],
    [s, s, s],
    [0, s, s]
  ];
  const triangles = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7]
  ];
  const lines = ['solid cube'];
  for (const triangle of triangles) {
    lines.push('  facet normal 0 0 0', '    outer loop');
    for (const corner of triangle) {
      lines.push(`      vertex ${corners[corner]!.join(' ')}`);
    }
    lines.push('    endloop', '  endfacet');
  }
  lines.push('endsolid cube', '');
  return new TextEncoder().encode(lines.join('\n')).buffer;
}

/**
 * Every mesh import — the STL preview, the STL commit and the kernel-read
 * formats — adopts its triangles through `meshInDocumentUnits` and builds its
 * `imported-mesh` command through `importedMeshCommand`.
 * The STL arm once built its own and skipped the unit scaling, so a 25.4 mm
 * cube STL landed in an inch project as a 25.4 in cube, while the same cube
 * as an OBJ read 1 in.
 */
describe('importedMeshCommand', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  async function importedCube(units: UnitSystem) {
    const parsed = parseStl(inchCubeStl(), 'cube.stl');
    const manager = new CommandManager({
      ...createProjectDocument(`Cube ${units}`, toUserId('user_mesh_units')),
      units
    });
    manager.execute(
      importedMeshCommand(
        parsed,
        meshInDocumentUnits(parsed, units),
        'artifact_local_cube'
      )
    );
    const bodyId = manager.document.bodyOrder[0]!;
    const derived = await adapter.syncDocument(manager.document);
    return { parsed, body: derived.bodyRepresentations[bodyId] };
  }

  it('lands a 25.4 mm STL cube in an inch project as a 1 in cube', async () => {
    const { body } = await importedCube('inch');
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(body?.bbox?.min[axis]).toBeCloseTo(0, 6);
      expect(body?.bbox?.max[axis]).toBeCloseTo(1, 6);
    }
    expect(body?.volume).toBeCloseTo(1, 6);
  });

  it('adopts the millimetre triangles at 1/UNIT_TO_MM in every unit', async () => {
    const parsed = parseStl(inchCubeStl(), 'cube.stl');
    for (const [units, edge] of [
      ['mm', 25.4],
      ['cm', 2.54],
      ['m', 0.0254],
      ['inch', 1]
    ] as const) {
      const command = importedMeshCommand(
        parsed,
        meshInDocumentUnits(parsed, units),
        'artifact_cube'
      );
      expect(Math.max(...command.payload.vertices!)).toBeCloseTo(edge, 9);
      expect(command.payload).toMatchObject({
        name: 'cube.stl',
        sourceName: 'cube.stl',
        artifactId: 'artifact_cube',
        triangleCount: 12,
        indices: parsed.indices
      });
    }
  });

  it('leaves a millimetre project with the vertices exactly as read', async () => {
    const { parsed, body } = await importedCube('mm');
    expect(meshInDocumentUnits(parsed, 'mm').vertices).toBe(parsed.vertices);
    expect(body?.bbox?.max.z).toBeCloseTo(25.4, 6);
  });

  it('records the unit a unitless file was read in on the command', () => {
    const mesh = { name: 'part.stl', triangleCount: 1 };
    const payload = {
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2]
    };
    expect(
      importedMeshCommand(
        { ...mesh, assumedUnits: 'inch' },
        payload,
        'artifact_part'
      ).payload.assumedUnits
    ).toBe('inch');
    expect(
      'assumedUnits' in
        importedMeshCommand(mesh, payload, 'artifact_part').payload
    ).toBe(false);
  });
});
