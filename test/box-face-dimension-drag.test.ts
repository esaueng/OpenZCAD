import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  chamferEdges,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';

/**
 * Dragging a side of a box that carries blends.
 *
 * Same gesture as the cylinder cap drag, one dimension further: the +z face
 * of a filleted or chamfered box is a *trimmed* rectangle, so offsetting it
 * in place raises a boss inside the blend rim instead of making the block
 * thicker. The UI resolves that face back to the box primitive and edits the
 * dimension the face rides on, which regenerates the blends at the new
 * extent. Both halves are pinned here: the plan the app makes, and the solid
 * it produces, measured against the same part modelled outright.
 *
 * The kernel lays `makeBox(width, height, depth)` along x, y, z, so the face
 * a user drags upward is governed by DEPTH — not by the dimension spelled
 * "height". The box is anchored at its minimum corner, so only a max side
 * moves under a pure dimension edit.
 */

const user = toUserId('user_box_face_dimension_drag');
const WIDTH = 40;
const HEIGHT = 24;
const DEPTH = 10;
const BLEND = 1.5;

/** The planar face whose outward normal is ±z and whose centre is extreme. */
function capFace(body: BodyRepresentation | undefined, sign: 1 | -1) {
  const candidates = (body?.topology?.faces ?? []).filter(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      face.geometry.normal !== undefined &&
      Math.abs(face.geometry.normal.z - sign) < 1e-9
  );
  const chosen = candidates.reduce<FaceTopology | null>((best, face) => {
    if (!best) {
      return face;
    }
    const z = face.geometry?.center.z ?? 0;
    const bestZ = best.geometry?.center.z ?? 0;
    return sign === 1 ? (z > bestZ ? face : best) : z < bestZ ? face : best;
  }, null);
  expect(
    chosen,
    `the body must expose a ${sign > 0 ? '+' : '-'}z face`
  ).not.toBeNull();
  return chosen!;
}

function boxFeatureId(document: ProjectDocument, name = 'Block') {
  return listFeaturesInOrder(document).find((feature) => feature.name === name)!
    .featureId;
}

function boxDimensions(document: ProjectDocument, name = 'Block') {
  const feature = listFeaturesInOrder(document).find(
    (candidate) => candidate.name === name
  )!;
  expect(feature.data.featureKind).toBe('primitive');
  if (feature.data.featureKind !== 'primitive') {
    throw new Error('The named feature is not a primitive.');
  }
  return feature.data.dimensions;
}

describe('box face dimension drag', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 60_000);

  afterAll(() => {
    adapter.dispose();
  });

  /** A bare box 40 x 24 x depth, anchored at the origin corner. */
  async function bareBox(depth = DEPTH): Promise<{
    document: ProjectDocument;
    bodyId: BodyId;
    body: BodyRepresentation;
  }> {
    const document = addPrimitiveFeature(
      createProjectDocument('Box face drag', user),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: WIDTH, height: HEIGHT, depth }
      }
    );
    const bodyId = document.bodyOrder[0]!;
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    return { document, bodyId, body: derived.bodyRepresentations[bodyId]! };
  }

  /** The same box with EVERY non-seam edge blended at 1.5 mm. */
  async function blendedBox(
    kind: 'fillet' | 'chamfer',
    depth = DEPTH
  ): Promise<{
    document: ProjectDocument;
    bodyId: BodyId;
    body: BodyRepresentation;
  }> {
    const base = await bareBox(depth);
    const edges = (base.body.topology?.edges ?? []).filter(
      (edge) => edge.displayRole !== 'seam' && edge.reference
    );
    expect(edges).toHaveLength(12);
    const modify = kind === 'fillet' ? filletEdges : chamferEdges;
    const modified = modify(base.document, {
      name: kind === 'fillet' ? 'Blend all edges' : 'Break all edges',
      targetBodyId: base.bodyId,
      edgeHashes: edges.map((edge) => edge.hash),
      edgeReferences: edges.map((edge) => edge.reference!),
      size: BLEND
    });
    const derived = await adapter.syncDocument(modified.document);
    expect(derived.warnings).toEqual([]);
    return {
      document: modified.document,
      bodyId: modified.bodyId,
      body: derived.bodyRepresentations[modified.bodyId]!
    };
  }

  /** Apply a plan's command and measure the body it lands on. */
  async function applied(
    document: ProjectDocument,
    command: { apply(document: ProjectDocument): ProjectDocument },
    bodyId: BodyId
  ): Promise<{ document: ProjectDocument; volume: number }> {
    const next = command.apply(document);
    const derived = await adapter.syncDocument(next);
    expect(derived.warnings).toEqual([]);
    return {
      document: next,
      volume: derived.bodyRepresentations[bodyId]!.volume
    };
  }

  it('routes a bare box +z face to the depth dimension', async () => {
    const model = await bareBox();
    const face = capFace(model.body, 1);
    expect(face.reference?.lineageName).toBe('primitive.box.face.z-max');

    const plan = planFaceOffset({
      document: model.document,
      bodyId: model.bodyId,
      face,
      faceHash: face.hash,
      offset: 5
    });
    expect(plan?.kind).toBe('primitive-dimension');
    if (plan?.kind !== 'primitive-dimension') {
      return;
    }
    expect(plan.dimension).toBe('depth');
    expect(plan.value).toBe(15);
    expect(plan.preflightRejection).toBeUndefined();

    const result = await applied(model.document, plan.command, model.bodyId);
    expect(result.volume).toBeCloseTo(WIDTH * HEIGHT * 15, 6);
  });

  for (const kind of ['fillet', 'chamfer'] as const) {
    it(`routes a ${kind}ed box +z face to the depth dimension`, async () => {
      const model = await blendedBox(kind);
      const face = capFace(model.body, 1);
      expect(face.reference?.lineageName).toBe('modifier.box.face.z-max');

      const plan = planFaceOffset({
        document: model.document,
        bodyId: model.bodyId,
        face,
        faceHash: face.hash,
        offset: 5
      });
      expect(plan?.kind).toBe('primitive-dimension');
      if (plan?.kind !== 'primitive-dimension') {
        return;
      }
      expect(plan.dimension).toBe('depth');
      expect(plan.value).toBe(15);

      // The oracle: the same blended box modelled at the new depth outright.
      const oracle = await blendedBox(kind, 15);
      const result = await applied(model.document, plan.command, model.bodyId);
      expect(result.volume).toBeCloseTo(oracle.body.volume, 6);
      // ... and genuinely different from leaving the blend rim standing.
      expect(result.volume).not.toBeCloseTo(
        model.body.volume + (face.geometry?.area ?? 0) * 5,
        3
      );
    });
  }

  it('shrinks a filleted box through the same route', async () => {
    const model = await blendedBox('fillet');
    const face = capFace(model.body, 1);
    const plan = planFaceOffset({
      document: model.document,
      bodyId: model.bodyId,
      face,
      faceHash: face.hash,
      offset: -3
    });
    expect(plan?.kind).toBe('primitive-dimension');
    if (plan?.kind !== 'primitive-dimension') {
      return;
    }
    expect(plan.dimension).toBe('depth');
    expect(plan.value).toBe(7);
    expect(plan.preflightRejection).toBeUndefined();

    // r 1.5 still fits in a 7 mm depth, so the oracle is a real part.
    const oracle = await blendedBox('fillet', 7);
    const result = await applied(model.document, plan.command, model.bodyId);
    expect(result.volume).toBeCloseTo(oracle.body.volume, 6);
  });

  it('keeps a min side on the local push/pull', async () => {
    const model = await blendedBox('fillet');
    const face = capFace(model.body, -1);
    expect(face.reference?.lineageName).toBe('modifier.box.face.z-min');

    // The box grows from its minimum corner: moving the min side would have
    // to move the body too, so the drag stays a face offset.
    const plan = planFaceOffset({
      document: model.document,
      bodyId: model.bodyId,
      face,
      faceHash: face.hash,
      offset: 5
    });
    expect(plan?.kind).toBe('direct-edit');
    expect(plan?.command.kind).toBe('feature.direct-edit');
  });

  it('still resolves the +z face after an upstream width change', async () => {
    const model = await blendedBox('fillet');
    const widened = updateFeature(model.document, {
      featureId: boxFeatureId(model.document),
      data: { dimensions: { width: 50, height: HEIGHT, depth: DEPTH } }
    });
    const derived = await adapter.syncDocument(widened);
    expect(derived.warnings).toEqual([]);
    const face = capFace(derived.bodyRepresentations[model.bodyId], 1);
    expect(face.reference?.lineageName).toBe('modifier.box.face.z-max');

    const plan = planFaceOffset({
      document: widened,
      bodyId: model.bodyId,
      face,
      faceHash: face.hash,
      offset: 5
    });
    expect(plan?.kind).toBe('primitive-dimension');
    if (plan?.kind !== 'primitive-dimension') {
      return;
    }
    expect(plan.dimension).toBe('depth');
    expect(plan.value).toBe(15);

    const oracle = await blendedBox('fillet', 15);
    const oracleWidened = await adapter.syncDocument(
      updateFeature(oracle.document, {
        featureId: boxFeatureId(oracle.document),
        data: { dimensions: { width: 50, height: HEIGHT, depth: 15 } }
      })
    );
    expect(oracleWidened.warnings).toEqual([]);
    const result = await applied(widened, plan.command, model.bodyId);
    expect(result.volume).toBeCloseTo(
      oracleWidened.bodyRepresentations[oracle.bodyId]!.volume,
      6
    );
  });

  it('refuses an offset that would empty the box', async () => {
    const model = await bareBox();
    const face = capFace(model.body, 1);
    const plan = planFaceOffset({
      document: model.document,
      bodyId: model.bodyId,
      face,
      faceHash: face.hash,
      offset: -DEPTH
    });
    expect(plan?.kind).toBe('primitive-dimension');
    if (plan?.kind !== 'primitive-dimension') {
      return;
    }
    expect(plan.value).toBe(0);
    expect(plan.preflightRejection).toBeDefined();
    expect(plan.preflightRejection).toContain('depth');
  });

  it('keeps a boolean result on the local push/pull', async () => {
    // No primitive chain survives a boolean: the union's cap descends from
    // two operands, so a dimension edit would be ambiguous.
    const base = addPrimitiveFeature(
      createProjectDocument('Box face drag', user),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: WIDTH, height: HEIGHT, depth: DEPTH }
      }
    );
    const plateBodyId = base.bodyOrder[0]!;
    const withBlock = addPrimitiveFeature(base, {
      name: 'Boss',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 12, depth: 20 }
    });
    const blockBodyId = withBlock.bodyOrder[1]!;
    const placed = transformBody(withBlock, {
      name: 'Place boss',
      targetBodyId: blockBodyId,
      translation: { x: 10, y: 6, z: 5 }
    });
    const united = booleanBodies(placed.document, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [plateBodyId, blockBodyId]
    });
    const derived = await adapter.syncDocument(united.document);
    expect(derived.warnings).toEqual([]);
    const face = capFace(derived.bodyRepresentations[united.bodyId], 1);

    const plan = planFaceOffset({
      document: united.document,
      bodyId: united.bodyId,
      face,
      faceHash: face.hash,
      offset: 5
    });
    expect(plan?.kind).toBe('direct-edit');
    expect(plan?.command.kind).toBe('feature.direct-edit');
  });

  it('keeps a typed expression live in the document', async () => {
    const model = await bareBox();
    const face = capFace(model.body, 1);
    const plan = planFaceOffset({
      document: model.document,
      bodyId: model.bodyId,
      face,
      faceHash: face.hash,
      offset: 5,
      exact: '5'
    });
    expect(plan?.kind).toBe('primitive-dimension');
    if (plan?.kind !== 'primitive-dimension') {
      return;
    }
    // The drag composes onto the stored value rather than replacing it, so a
    // dimension already driven by an expression keeps its authorship.
    const next = plan.command.apply(model.document);
    expect(boxDimensions(next).depth).toBe('10 + (5)');
    const derived = await adapter.syncDocument(next);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[model.bodyId]!.volume).toBeCloseTo(
      WIDTH * HEIGHT * 15,
      6
    );
  });
});
