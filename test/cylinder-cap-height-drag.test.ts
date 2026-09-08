import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  directEditBody,
  filletEdges,
  chamferEdges,
  listFeaturesInOrder,
  updateFeature,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import {
  primitiveCylinderHeightAncestor,
  primitiveCylinderRadiusAncestor
} from '../apps/web/src/lib/interaction/cylinderPrimitiveAncestry';

/**
 * Dragging the top cap of a rounded cylinder.
 *
 * Offsetting that face is not what the gesture means once the rim carries a
 * blend: the flat remainder is smaller than the part, so pushing it alone
 * grows a narrow boss out of the fillet instead of making the cylinder
 * taller. The UI resolves the cap back to the primitive that owns it and
 * edits `height` instead — this pins both halves of that: the kernel really
 * does name the blended cap, and the resulting solid is the taller rounded
 * cylinder rather than a stepped one.
 */

const user = toUserId('user_cap_height_drag');
const RADIUS = 10;
const FILLET = 3;

/** The planar face with the highest exact center — the top cap. */
function topCapFace(body: BodyRepresentation | undefined) {
  const planes = (body?.topology?.faces ?? []).filter(
    (face) => face.geometry?.surfaceType === 'plane'
  );
  return planes.sort(
    (left, right) =>
      (right.geometry?.center.z ?? 0) - (left.geometry?.center.z ?? 0)
  )[0];
}

/** Cap area as a fraction of the disc the rounded rim should have left. */
function capRadiusRatio(cap: ReturnType<typeof topCapFace>) {
  return (cap?.geometry?.area ?? 0) / (Math.PI * (RADIUS - FILLET) ** 2);
}

describe('cylinder cap height drag', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  /** A cylinder with every outside edge rounded, as the screenshot has it. */
  async function roundedCylinder(
    height: number,
    separate = false,
    modifier: 'fillet' | 'chamfer' = 'fillet'
  ): Promise<{
    document: ProjectDocument;
    sourceBodyId: BodyId;
    filletBodyId: BodyId;
    derived: Awaited<ReturnType<ExactKernelAdapter['syncDocument']>>;
  }> {
    const base = addPrimitiveFeature(
      createProjectDocument('Rounded cylinder', user),
      {
        name: 'Cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: RADIUS, height }
      }
    );
    const sourceBodyId = base.bodyOrder.at(-1)!;
    const primitive = await adapter.syncDocument(base);
    expect(primitive.warnings).toEqual([]);

    const rims = (
      primitive.bodyRepresentations[sourceBodyId]?.topology?.edges ?? []
    ).filter((edge) => edge.displayRole !== 'seam' && edge.reference);
    expect(rims).toHaveLength(2);

    let filleted = (modifier === 'fillet' ? filletEdges : chamferEdges)(base, {
      name: 'Round All Outside Edges',
      targetBodyId: sourceBodyId,
      edgeHashes: (separate ? rims.slice(0, 1) : rims).map((edge) => edge.hash),
      edgeReferences: (separate ? rims.slice(0, 1) : rims).map(
        (edge) => edge.reference!
      ),
      size: FILLET
    });
    if (separate) {
      const first = await adapter.syncDocument(filleted.document);
      const untouched = first.bodyRepresentations[
        filleted.bodyId
      ]!.topology!.edges.find(
        (edge) =>
          edge.reference &&
          edge.displayRole !== 'seam' &&
          edge.reference.lineageName.endsWith(
            rims[1]!.reference!.lineageName.endsWith('.start')
              ? '.rim.start'
              : '.rim.end'
          )
      )!;
      filleted = filletEdges(filleted.document, {
        name: 'Round Other Rim',
        targetBodyId: filleted.bodyId,
        edgeHashes: [untouched.hash],
        edgeReferences: [untouched.reference!],
        size: FILLET
      });
    }
    const derived = await adapter.syncDocument(filleted.document);
    expect(derived.warnings).toEqual([]);
    return {
      document: filleted.document,
      sourceBodyId,
      filletBodyId: filleted.bodyId,
      derived
    };
  }

  function cylinderFeatureId(document: ProjectDocument) {
    return listFeaturesInOrder(document).find(
      (feature) => feature.name === 'Cylinder'
    )!.featureId;
  }

  it('resolves the blended top cap back to the cylinder it belongs to', async () => {
    const model = await roundedCylinder(20);
    const cap = topCapFace(
      model.derived.bodyRepresentations[model.filletBodyId]
    );

    // The blended cap is a *smaller* disc than the cylinder — this is exactly
    // why offsetting it in place is the wrong answer. (Reported face area is
    // a sampled measure, so compare it proportionally; the volumes below are
    // the exact numbers.)
    expect(cap?.geometry?.area).toBeLessThan(Math.PI * RADIUS ** 2);
    expect(capRadiusRatio(cap)).toBeCloseTo(1, 3);
    expect(cap?.reference?.lineageName).toBe('modifier.cylinder.face.cap.end');

    expect(
      primitiveCylinderHeightAncestor(
        model.document,
        model.filletBodyId,
        cap!.reference,
        cap!.hash
      )?.featureId
    ).toBe(cylinderFeatureId(model.document));
  });

  it('makes the whole cylinder taller and keeps the rounds intact', async () => {
    const model = await roundedCylinder(20);
    const grown = await adapter.syncDocument(
      updateFeature(model.document, {
        featureId: cylinderFeatureId(model.document),
        data: { dimensions: { radius: RADIUS, height: 28 } }
      })
    );
    expect(grown.warnings).toEqual([]);
    const body = grown.bodyRepresentations[model.filletBodyId];

    // Indistinguishable from building the taller rounded cylinder outright.
    const rebuilt = await roundedCylinder(28);
    expect(body!.volume).toBeCloseTo(
      rebuilt.derived.bodyRepresentations[rebuilt.filletBodyId]!.volume,
      6
    );
    // Still rounded, and still one blended cap rather than a new step.
    expect(
      body!.topology?.faces.filter(
        (face) => face.geometry?.surfaceType === 'torus'
      )
    ).toHaveLength(2);
    expect(capRadiusRatio(topCapFace(body))).toBeCloseTo(1, 3);
  });

  it('is a different solid from offsetting the blended cap in place', async () => {
    const model = await roundedCylinder(20);
    const cap = topCapFace(
      model.derived.bodyRepresentations[model.filletBodyId]
    );
    const offset = await adapter.syncDocument(
      directEditBody(model.document, {
        name: 'Offset face',
        targetBodyId: model.filletBodyId,
        operation: {
          kind: 'offset-face',
          faceHash: cap!.hash,
          faceReference: cap!.reference,
          sourceSurfaceType: 'plane',
          sourceArea: cap!.geometry!.area,
          sourceCenter: cap!.geometry!.center,
          sourceNormal: cap!.geometry!.normal!,
          offset: 8
        }
      }).document
    );
    expect(offset.warnings).toEqual([]);

    // The old behaviour adds a boss the width of the flat remainder; the new
    // one adds a full-diameter slice. Both are exact — only one is the drag.
    const before =
      model.derived.bodyRepresentations[model.filletBodyId]!.volume;
    expect(offset.bodyRepresentations[model.filletBodyId]!.volume).toBeCloseTo(
      before + Math.PI * (RADIUS - FILLET) ** 2 * 8,
      3
    );
    const rebuilt = await roundedCylinder(28);
    expect(
      rebuilt.derived.bodyRepresentations[rebuilt.filletBodyId]!.volume
    ).toBeCloseTo(before + Math.PI * RADIUS ** 2 * 8, 3);
  });
  it.each([false, true])(
    'keeps the far cap fixed and preserves later edits, replay, and one-step undo (separate rims: %s)',
    async (separate) => {
      const model = await roundedCylinder(20, separate);
      const manager = new CommandManager(model.document);
      const before = model.derived.bodyRepresentations[model.filletBodyId]!;
      const bottom = before.topology!.faces.find(
        (face) =>
          face.reference?.lineageName === 'modifier.cylinder.face.cap.start'
      )!;
      const plan = planFaceOffset({
        document: manager.document,
        bodyId: model.filletBodyId,
        face: bottom,
        faceHash: bottom.hash,
        offset: 8
      })!;
      expect(plan.kind).toBe('primitive-dimension');
      const grown = await adapter.syncDocument(
        plan.command.apply(manager.document)
      );
      expect(grown.warnings).toEqual([]);
      manager.execute(plan.command);
      const body = grown.bodyRepresentations[model.filletBodyId]!;
      const capZ = (b: BodyRepresentation, side: string) =>
        b.topology!.faces.find(
          (f) =>
            f.reference?.lineageName === `modifier.cylinder.face.cap.${side}`
        )!.geometry!.center.z;
      expect(capZ(body, 'start')).toBeCloseTo(-8, 8);
      expect(capZ(body, 'end')).toBeCloseTo(20, 8);
      expect(body.volume - before.volume).toBeCloseTo(
        Math.PI * RADIUS ** 2 * 8,
        3
      );
      expect(
        body.topology!.faces.filter((f) => f.geometry?.surfaceType === 'torus')
      ).toHaveLength(2);
      expect(body.topology!.faces).toHaveLength(5);
      expect(
        isClosedConsistentlyOrientedMesh(
          inspectTriangleMeshClosure(body.mesh.vertices, body.mesh.indices)
        )
      ).toBe(true);
      expect(
        manager.document.commandLog.some((c) => c.kind === 'transaction')
      ).toBe(false);
      const replayed = replayCommands(
        model.document,
        manager.document.commandLog.slice(model.document.commandLog.length)
      );
      expect(
        (await adapter.syncDocument(replayed)).bodyRepresentations[
          model.filletBodyId
        ]!.volume
      ).toBeCloseTo(body.volume, 6);
      manager.undo();
      expect(
        (await adapter.syncDocument(manager.document)).bodyRepresentations[
          model.filletBodyId
        ]!.volume
      ).toBeCloseTo(before.volume, 6);
      manager.redo();
      for (const [side, offset] of [
        ['start', 2],
        ['end', 4],
        ['start', -3]
      ] as const) {
        const derived = await adapter.syncDocument(manager.document);
        const face = derived.bodyRepresentations[
          model.filletBodyId
        ]!.topology!.faces.find(
          (f) =>
            f.reference?.lineageName === `modifier.cylinder.face.cap.${side}`
        )!;
        const next = planFaceOffset({
          document: manager.document,
          bodyId: model.filletBodyId,
          face,
          faceHash: face.hash,
          offset
        })!;
        expect(next.kind).toBe('primitive-dimension');
        manager.execute(next.command);
        expect((await adapter.syncDocument(manager.document)).warnings).toEqual(
          []
        );
      }
      expect(
        listFeaturesInOrder(manager.document).filter(
          (f) => f.data.featureKind === 'transform'
        )
      ).toHaveLength(1);
      expect(
        listFeaturesInOrder(manager.document).filter(
          (f) => f.data.featureKind === 'direct-edit'
        )
      ).toHaveLength(0);
      const ancestor = primitiveCylinderRadiusAncestor(
        manager.document,
        model.filletBodyId
      )!;
      manager.execute(
        commandFactories.updateFeature({
          featureId: ancestor.featureId,
          data: { dimensions: { radius: 12, height: 31 } }
        })
      );
      const resized = await adapter.syncDocument(manager.document);
      expect(resized.warnings).toEqual([]);
      expect(
        resized.bodyRepresentations[model.filletBodyId]!.topology!.faces
      ).toHaveLength(5);
      expect(
        capZ(resized.bodyRepresentations[model.filletBodyId]!, 'start')
      ).toBeCloseTo(-7, 8);
      expect(
        capZ(resized.bodyRepresentations[model.filletBodyId]!, 'end')
      ).toBeCloseTo(24, 8);
    }
  );

  it('keeps the opposite cap fixed through rotated and scaled placement', async () => {
    const model = await roundedCylinder(20);
    const placed = transformBody(model.document, {
      name: 'Place cylinder',
      targetBodyId: model.filletBodyId,
      translation: { x: 13, y: -9, z: 4 },
      rotationDeg: { x: 35, y: 20, z: 60 },
      scale: 3
    }).document;
    const before = await adapter.syncDocument(placed);
    const cap = (body: BodyRepresentation, side: string) =>
      body.topology!.faces.find(
        (f) => f.reference?.lineageName === `modifier.cylinder.face.cap.${side}`
      )!;
    const body = before.bodyRepresentations[model.filletBodyId]!;
    const bottom = cap(body, 'start');
    const plan = planFaceOffset({
      document: placed,
      bodyId: model.filletBodyId,
      face: bottom,
      faceHash: bottom.hash,
      offset: 8
    })!;
    expect(plan.kind).toBe('primitive-dimension');
    const grown = await adapter.syncDocument(plan.command.apply(placed));
    expect(grown.warnings).toEqual([]);
    const result = grown.bodyRepresentations[model.filletBodyId]!;
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(cap(result, 'end').geometry!.center[axis]).toBeCloseTo(
        cap(body, 'end').geometry!.center[axis],
        6
      );
      expect(cap(result, 'start').geometry!.center[axis]).toBeCloseTo(
        bottom.geometry!.center[axis] + 8 * bottom.geometry!.normal![axis],
        6
      );
    }
    expect(result.volume - body.volume).toBeCloseTo(
      Math.PI * (RADIUS * 3) ** 2 * 8,
      2
    );
  });
  it('regenerates chamfers when the bottom cap moves', async () => {
    const model = await roundedCylinder(20, false, 'chamfer');
    const before = model.derived.bodyRepresentations[model.filletBodyId]!;
    const bottom = before.topology!.faces.find(
      (f) => f.reference?.lineageName === 'modifier.cylinder.face.cap.start'
    )!;
    const plan = planFaceOffset({
      document: model.document,
      bodyId: model.filletBodyId,
      face: bottom,
      faceHash: bottom.hash,
      offset: 8
    })!;
    expect(plan.kind).toBe('primitive-dimension');
    const rebuilt = await adapter.syncDocument(
      plan.command.apply(model.document)
    );
    expect(rebuilt.warnings).toEqual([]);
    const after = rebuilt.bodyRepresentations[model.filletBodyId]!;
    expect(after.volume - before.volume).toBeCloseTo(
      Math.PI * RADIUS ** 2 * 8,
      3
    );
    expect(
      after.topology!.faces.filter((f) => f.geometry?.surfaceType === 'cone')
    ).toHaveLength(2);
    expect(
      after.topology!.faces.find(
        (f) => f.reference?.lineageName === 'modifier.cylinder.face.cap.start'
      )!.geometry!.center.z
    ).toBeCloseTo(-8, 6);
    expect(topCapFace(after)!.geometry!.center.z).toBeCloseTo(20, 6);
    expect(
      isClosedConsistentlyOrientedMesh(
        inspectTriangleMeshClosure(after.mesh.vertices, after.mesh.indices)
      )
    ).toBe(true);
  });
});
