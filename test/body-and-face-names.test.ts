import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  type AnyCommand
} from '@openzcad/command-system';
import {
  attachDerivedState,
  createBodyFeatureIds,
  createProjectDocument,
  numberedBodyName
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';
import {
  buildModelingOperationSubmission,
  modelingFaceOptions
} from '../apps/web/src/lib/modelingOperations';
import { faceNamerFor } from '../apps/web/src/lib/faceProducerName';

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

async function synced(document: ProjectDocument) {
  return attachDerivedState(document, await adapter.syncDocument(document));
}

const along = (edge: EdgeTopology, offset: number) =>
  edge.points.filter((_, index) => index % 3 === offset);

function bodyName(document: ProjectDocument, bodyId: BodyId) {
  return Object.values(document.nodes).find(
    (node) => node.kind === 'body' && node.bodyId === bodyId
  )?.name;
}

function faceLabels(document: ProjectDocument, bodyId: BodyId) {
  const body = document.derived.bodyRepresentations[bodyId]!;
  return modelingFaceOptions(body.topology, body, faceNamerFor(document)).map(
    (face) => face.label
  );
}

/**
 * Two boxes named "Box", touching, and a union — the bracket of the
 * 1 October 2026 design review (F18). `numbered` creates them the way the
 * app does now; without it, the way every stored document did.
 */
function bracket(numbered: boolean) {
  const manager = new CommandManager(
    createProjectDocument('Bracket', toUserId('user_names'), 'mm')
  );
  const run = (label: string, commands: AnyCommand[]) =>
    manager.runTransaction(label, commands);
  const plate = createBodyFeatureIds();
  const flange = createBodyFeatureIds();
  const union = createBodyFeatureIds();
  const box = (
    ids: ReturnType<typeof createBodyFeatureIds>,
    dimensions: Record<string, number>
  ) =>
    commandFactories.addPrimitive({
      name: 'Box',
      ...(numbered
        ? { bodyName: numberedBodyName(manager.document, 'Box') }
        : {}),
      primitiveKind: 'box',
      dimensions,
      ids
    });
  run('Plate', [box(plate, { width: 80, height: 40, depth: 5 })]);
  run('Flange', [box(flange, { width: 80, height: 5, depth: 40 })]);
  run('Union', [
    commandFactories.booleanBodies({
      name: 'Union',
      operation: 'union',
      targetBodyIds: [plate.bodyId, flange.bodyId],
      ids: union
    })
  ]);
  return { manager, run, plate, flange, union };
}

describe('bodies numbered at creation, faces named by their feature', () => {
  it('numbers two boxes and keeps the base name through a union', async () => {
    const { manager, plate, flange, union } = bracket(true);
    const document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    expect(bodyName(document, plate.bodyId)).toBe('Box 1');
    expect(bodyName(document, flange.bodyId)).toBe('Box 2');
    // The union is still the plate with the flange joined on.
    expect(bodyName(document, union.bodyId)).toBe('Box 1');

    const labels = faceLabels(document, union.bodyId);
    // Each top names the box it came from, instead of "Top face (1)/(2)".
    expect(labels).toContain('Box 1 · top');
    expect(labels).toContain('Box 2 · top');
    expect(labels.filter((label) => /^Top face/.test(label))).toEqual([]);
    expect(new Set(labels).size).toBe(labels.length);
    // Grouped by the feature that made them, in history order.
    const firstBox2 = labels.findIndex((label) => label.startsWith('Box 2'));
    expect(
      labels.slice(firstBox2).some((label) => label.startsWith('Box 1'))
    ).toBe(false);
  });

  it('names a drilled bore after the hole, and keeps the rest', async () => {
    const { manager, run, union } = bracket(true);
    let document = await synced(manager.document);
    const body = document.derived.bodyRepresentations[union.bodyId]!;
    const top = body.topology!.faces.find(
      (face) =>
        face.geometry?.normal?.z === 1 &&
        Math.abs((face.geometry.centroid ?? face.geometry.center).z - 5) < 1e-6
    )!;
    const hole = createBodyFeatureIds();
    const submission = buildModelingOperationSubmission(
      {
        operation: 'hole',
        value: {
          name: 'Hole',
          targetBodyId: union.bodyId,
          faceHash: top.hash,
          style: 'simple',
          diameter: '6',
          depthMode: 'through',
          depth: '5',
          counterboreDiameter: '10',
          counterboreDepth: '2',
          countersinkDiameter: '10',
          countersinkAngleDeg: '90',
          position: { u: '-10', v: '20' }
        }
      },
      modelingFaceOptions(body.topology, body, faceNamerFor(document))
    );
    if (submission.operation !== 'hole') throw new Error('Not a hole.');
    run('Hole', [
      commandFactories.holeBody({ ...submission.input, ids: hole })
    ]);
    document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    expect(bodyName(document, hole.bodyId)).toBe('Box 1');
    const labels = faceLabels(document, hole.bodyId);
    expect(labels).toContain('Hole · through hole Ø6');
    expect(labels).toContain('Box 1 · top');
    expect(labels).toContain('Box 2 · top');
  });

  it('carries the box names through a fillet on the union', async () => {
    const { manager, run, union } = bracket(true);
    let document = await synced(manager.document);
    const corner = document.derived.bodyRepresentations[
      union.bodyId
    ]!.topology!.edges.find((edge) => {
      const xs = along(edge, 0);
      return (
        along(edge, 1).every((y) => Math.abs(y - 5) < 1e-6) &&
        along(edge, 2).every((z) => Math.abs(z - 5) < 1e-6) &&
        Math.max(...xs) - Math.min(...xs) > 60
      );
    })!;
    const fillet = createBodyFeatureIds();
    run('Fillet', [
      commandFactories.filletEdges({
        name: 'Fillet',
        targetBodyId: union.bodyId,
        edgeHashes: [corner.hash],
        edgeReferences: [corner.reference!],
        size: 3,
        ids: fillet
      })
    ]);
    document = await synced(manager.document);
    expect(document.derived.warnings).toEqual([]);
    expect(bodyName(document, fillet.bodyId)).toBe('Box 1');
    // The fillet republishes the operands' faces; its own blend reads as the
    // fillet's, and faces the union merged keep their direction names.
    expect(faceLabels(document, fillet.bodyId)).toEqual([
      'Box 1 · top',
      'Box 1 · back',
      'Box 2 · top',
      'Box 2 · back',
      'Fillet · blend face R3',
      'Bottom face',
      'Front face',
      'Left face',
      'Right face'
    ]);
  });

  it('leaves the names of a document made before numbering alone', async () => {
    const { manager, plate, flange, union } = bracket(false);
    const document = await synced(manager.document);
    expect(bodyName(document, plate.bodyId)).toBe('Box Body');
    expect(bodyName(document, flange.bodyId)).toBe('Box Body');
    expect(bodyName(document, union.bodyId)).toBe('Box Body');
    // Display-only names: the feature still tells the tops apart by place.
    const labels = faceLabels(document, union.bodyId);
    expect(labels).toContain('Box · top (1)');
    expect(labels).toContain('Box · top (2)');
  });
});
