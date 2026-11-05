import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  filletEdges,
  findSketch,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type BooleanOperation,
  type FaceTopology,
  type PrimitiveKind,
  type ProjectDocument
} from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { selectionFeature } from '../apps/web/src/lib/selectionFeature';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import { sphereCylinderUnionInputs } from './support/sphere-cylinder-union';

/**
 * Kernel robustness plan WS4: a drag on a face that survived a union or
 * subtract edits the consumed operand's stored value and replays, instead of
 * moving the boolean's face. Each case builds the history on the real kernel,
 * routes the drag through the production planner, rebuilds, and checks the
 * result against a closed-form oracle — volume, the moved face's position,
 * a closed consistently oriented mesh, STEP exportability, and the picked
 * face keeping its operand role.
 */
const user = toUserId('user_source_first_routing');

describe('source-first routing across a boolean', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => {
    adapter.dispose();
  });

  async function rebuild(document: ProjectDocument, bodyId: BodyId) {
    const derived = await adapter.syncDocument(
      document,
      undefined,
      undefined,
      undefined,
      { lineageDemand: [bodyId] }
    );
    expect(derived.warnings).toEqual([]);
    expect(derived.featureWarnings ?? []).toEqual([]);
    const body = derived.bodyRepresentations[bodyId]!;
    expect(body).toBeDefined();
    return { document: { ...document, derived }, body };
  }

  function expectSound(body: BodyRepresentation) {
    expect(body.exportableStep).toBe(true);
    expect(
      isClosedConsistentlyOrientedMesh(
        inspectTriangleMeshClosure(body.mesh.vertices, body.mesh.indices)
      )
    ).toBe(true);
  }

  function faceNamed(body: BodyRepresentation, lineage: string): FaceTopology {
    const faces = (body.topology?.faces ?? []).filter((face) =>
      face.reference?.lineageName.startsWith(lineage)
    );
    expect(faces, lineage).toHaveLength(1);
    return faces[0]!;
  }

  /** A 40 × 40 × 10 plate and one placed second primitive. */
  function plateAnd(
    primitiveKind: PrimitiveKind,
    dimensions: Record<string, number>,
    at: { x: number; y: number; z: number }
  ) {
    let document = addPrimitiveFeature(
      createProjectDocument('Source-first routing', user),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 40, depth: 10 }
      }
    );
    document = addPrimitiveFeature(document, {
      name: 'Tool',
      primitiveKind,
      dimensions
    });
    const [plate, tool] = document.bodyOrder as [BodyId, BodyId];
    document = transformBody(document, {
      name: 'Place tool',
      targetBodyId: tool,
      translation: at
    }).document;
    return { document, plate, tool };
  }

  function combine(
    document: ProjectDocument,
    operation: BooleanOperation,
    targetBodyIds: BodyId[]
  ) {
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Combine',
        operation,
        targetBodyIds
      })
    );
    return { manager, bodyId: manager.document.bodyOrder.at(-1)! };
  }

  /** Plans the drag, asserts it edits `feature`, applies it and rebuilds. */
  async function drag(
    manager: CommandManager,
    bodyId: BodyId,
    lineage: string,
    offset: number,
    expected: { kind: string; feature: string }
  ) {
    const before = await rebuild(manager.document, bodyId);
    const face = faceNamed(before.body, lineage);
    const plan = planFaceOffset({
      document: before.document,
      bodyId,
      face,
      faceHash: face.hash,
      offset
    });
    expect(plan?.kind).toBe(expected.kind);
    expect(
      plan && 'feature' in plan
        ? plan.feature.name
        : plan && 'primitive' in plan
          ? plan.primitive.name
          : undefined
    ).toBe(expected.feature);
    expect(
      plan && 'preflightRejection' in plan ? plan.preflightRejection : undefined
    ).toBeUndefined();
    // Selecting the face opens the feature the drag edits.
    expect(
      selectionFeature(before.document, before.body, {
        bodyId,
        kind: 'face',
        topologyId: face.topologyId,
        hash: face.hash,
        ...(face.reference ? { reference: face.reference } : {})
      })?.name
    ).toBe(expected.feature);
    manager.execute(plan!.command);
    const after = await rebuild(manager.document, bodyId);
    expectSound(after.body);
    const moved = faceNamed(after.body, lineage);
    return { before: before.body, after: after.body, face, moved };
  }

  it.each([
    ['union', 'cap.end', 5],
    ['union', 'cap.end', -5]
  ] as const)(
    'drags a boss cap on a sphere through its source Cylinder (%s, %s, %d)',
    async (operation, cap, offset) => {
      const { document, sphere, cylinder } = sphereCylinderUnionInputs();
      const { manager, bodyId } = combine(document, operation, [
        sphere,
        cylinder
      ]);
      const lineage = `boolean.face.operand.1.primitive.cylinder.face.${cap}`;
      const { before, after, face, moved } = await drag(
        manager,
        bodyId,
        lineage,
        offset,
        { kind: 'primitive-dimension', feature: 'Cylinder' }
      );
      expect(moved.geometry?.center.z).toBeCloseTo(
        face.geometry!.center.z + offset,
        6
      );
      // Only the boss above the sphere changes length: π r² · offset. The
      // sphere's volume is integrated to a relative tolerance.
      const expected = Math.PI * 36 * offset;
      expect(
        Math.abs(after.volume - before.volume - expected) / Math.abs(expected)
      ).toBeLessThan(1e-4);
    }
  );

  it('makes a blind bore shallower when its floor is pulled out (subtract tool cap)', async () => {
    // Box minus a Cylinder from z 4 to 24: the bore is 6 deep and its floor
    // is the tool's start cap, facing back up the bore.
    const { document, plate, tool } = plateAnd(
      'cylinder',
      { radius: 5, height: 20 },
      { x: 20, y: 20, z: 4 }
    );
    const { manager, bodyId } = combine(document, 'subtract', [plate, tool]);
    const { after, moved } = await drag(
      manager,
      bodyId,
      'boolean.face.operand.1.primitive.cylinder.face.cap.start',
      2,
      { kind: 'primitive-dimension', feature: 'Tool' }
    );
    expect(moved.geometry?.center.z).toBeCloseTo(6, 9);
    expect(after.volume).toBeCloseTo(16000 - Math.PI * 25 * 4, 6);
  });

  it.each(['union', 'subtract'] as const)(
    'drags a Cone cap across a %s by its stored height',
    async (operation) => {
      // Frustum r 6 → 3 over z 4 → 24; the drag moves its far cap to 27.
      // In a subtract the plate keeps only the cut below z 10.
      const { document, plate, tool } = plateAnd(
        'cone',
        { bottomRadius: 6, topRadius: 3, height: 20 },
        { x: 20, y: 20, z: 4 }
      );
      const { manager, bodyId } = combine(document, operation, [plate, tool]);
      const lineage =
        operation === 'union'
          ? 'boolean.face.operand.1.primitive.cone.face.cap.end'
          : 'boolean.face.operand.1.primitive.cone.face.cap.start';
      const offset = operation === 'union' ? 3 : -2;
      const { after, moved, face } = await drag(
        manager,
        bodyId,
        lineage,
        offset,
        { kind: 'primitive-dimension', feature: 'Tool' }
      );
      const height = operation === 'union' ? 23 : 22;
      // Pushing the subtract's floor 2 into the plate lengthens the tool
      // downward: its base shifts 4 → 2 and its far cap stays at 24.
      const base = operation === 'union' ? 4 : 2;
      const radius = (z: number) => 6 - (3 * (z - base)) / height;
      const frustum = (from: number, to: number) => {
        const [a, b] = [radius(from), radius(to)];
        return ((Math.PI * (to - from)) / 3) * (a * a + a * b + b * b);
      };
      if (operation === 'union') {
        expect(moved.geometry?.center.z).toBeCloseTo(27, 9);
        expect(after.volume).toBeCloseTo(16000 + frustum(10, 27), 6);
      } else {
        expect(moved.geometry?.center.z).toBeCloseTo(
          face.geometry!.center.z - 2,
          9
        );
        expect(after.volume).toBeCloseTo(16000 - frustum(base, 10), 6);
      }
    }
  );

  async function filletedPlateMinusPocket(at: { x: number; y: number }) {
    const { document, plate, tool } = plateAnd(
      'cylinder',
      { radius: 5, height: 20 },
      { ...at, z: 4 }
    );
    const { manager, bodyId } = combine(document, 'subtract', [plate, tool]);
    const joined = await rebuild(manager.document, bodyId);
    const corner = joined.body.topology!.edges.find(
      (edge) =>
        edge.reference?.lineageName ===
        'boolean.edge.operand.0.primitive.box.edge.z.x-min.y-min'
    )!;
    expect(corner).toBeDefined();
    const rounded = filletEdges(joined.document, {
      name: 'Fillet edges',
      targetBodyId: bodyId,
      edgeHashes: [corner.hash],
      edgeReferences: [corner.reference!],
      size: 2
    });
    return {
      manager: new CommandManager(rounded.document),
      bodyId: rounded.bodyId
    };
  }

  it('resizes a filleted plate side through its Box across a subtract', async () => {
    const { manager, bodyId } = await filletedPlateMinusPocket({
      x: 20,
      y: 20
    });
    const { before, after } = await drag(
      manager,
      bodyId,
      'boolean.face.operand.0.primitive.box.face.x-max',
      5,
      { kind: 'primitive-dimension', feature: 'Box' }
    );
    expect(after.bbox.max.x).toBeCloseTo(45, 9);
    expect(after.volume - before.volume).toBeCloseTo(5 * 40 * 10, 6);
  });

  it('keeps a plate side the subtract tool bites into on the local offset', async () => {
    // The pocket at x 37 opens through the x-max side, which a longer box
    // would close over: the source edit would change what the cut means.
    const { manager, bodyId } = await filletedPlateMinusPocket({
      x: 37,
      y: 20
    });
    const { document, body } = await rebuild(manager.document, bodyId);
    const side = (body.topology?.faces ?? []).find(
      (face) =>
        face.reference?.lineageName ===
        'boolean.face.operand.0.primitive.box.face.x-max'
    );
    // The bitten side keeps its role, but its neighbours include the
    // tool's wall, so the drag stays the exact local face offset.
    expect(side).toBeDefined();
    const plan = planFaceOffset({
      document,
      bodyId,
      face: side!,
      faceHash: side!.hash,
      offset: 5
    });
    expect(plan?.kind).toBe('direct-edit');
  });

  async function extrudedBoss(z: number, distance: number) {
    const base = addPrimitiveFeature(
      createProjectDocument('Extrude across a boolean', user),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 40, depth: 10 }
      }
    );
    const { document: sketched, sketchId } = addSketchFeature(base, {
      name: 'Boss sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: z },
      objects: [{ objectKind: 'circle', radius: 5, centerX: 20, centerY: 20 }]
    });
    const objectIds = [...(findSketch(sketched, sketchId)?.objectIds ?? [])];
    const extruded = extrudeSketch(sketched, {
      name: 'Boss',
      sketchId,
      distance,
      profiles: [{ all: true, sourceEntityIds: objectIds }]
    });
    return {
      document: extruded.document,
      plate: base.bodyOrder[0]!,
      boss: extruded.bodyId
    };
  }

  it('lengthens a free extrude through its distance across a union', async () => {
    const { document, plate, boss } = await extrudedBoss(4, 16);
    const { manager, bodyId } = combine(document, 'union', [plate, boss]);
    const { after, moved } = await drag(
      manager,
      bodyId,
      'boolean.face.operand.1.sweep.face.cap.end',
      4,
      { kind: 'extrude-distance', feature: 'Boss' }
    );
    expect(moved.geometry?.center.z).toBeCloseTo(24, 9);
    expect(after.volume).toBeCloseTo(16000 + Math.PI * 25 * 14, 6);
  });

  it('makes an extruded pocket shallower when its floor is pulled out (subtract tool)', async () => {
    // Sketch above the plate, extruded down to z 4: the far cap is the floor.
    const { document, plate, boss } = await extrudedBoss(12, -8);
    const { manager, bodyId } = combine(document, 'subtract', [plate, boss]);
    const { after, moved } = await drag(
      manager,
      bodyId,
      'boolean.face.operand.1.sweep.face.cap.end',
      2,
      { kind: 'extrude-distance', feature: 'Boss' }
    );
    expect(moved.geometry?.center.z).toBeCloseTo(6, 9);
    expect(after.volume).toBeCloseTo(16000 - Math.PI * 25 * 4, 6);
  });

  it('opens the Sphere from a patch that survived a union, and its radius rebuilds', async () => {
    const { document, sphere, cylinder } = sphereCylinderUnionInputs();
    const { manager, bodyId } = combine(document, 'union', [sphere, cylinder]);
    const before = await rebuild(manager.document, bodyId);
    for (const role of ['z-max', 'z-min']) {
      const patch = faceNamed(
        before.body,
        `boolean.face.operand.0.primitive.sphere.face.${role}`
      );
      expect(
        selectionFeature(before.document, before.body, {
          bodyId,
          kind: 'face',
          topologyId: patch.topologyId,
          hash: patch.hash,
          ...(patch.reference ? { reference: patch.reference } : {})
        })?.name
      ).toBe('Sphere');
    }
    const source = listFeaturesInOrder(manager.document).find(
      (feature) => feature.name === 'Sphere'
    );
    if (source?.data.featureKind !== 'primitive')
      throw new Error('Sphere feature not found.');
    manager.execute(
      commandFactories.updateFeature(
        {
          featureId: source.featureId,
          data: { dimensions: { ...source.data.dimensions, radius: 75 } }
        },
        'Resize Sphere'
      )
    );
    const after = await rebuild(manager.document, bodyId);
    expectSound(after.body);
    faceNamed(after.body, 'boolean.face.operand.0.primitive.sphere.face.z-max');
    // The sphere sits at x 25.5: its extent grows by the radius change.
    expect(after.body.bbox.min.x).toBeCloseTo(25.5 - 75, 6);
    expect(after.body.volume).toBeGreaterThan(before.body.volume);
  });
});
