import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  directEditBody,
  findFeature
} from '@openzcad/document-core';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type DirectEditOperation,
  type FaceTopologyReferenceV5
} from '@openzcad/shared';
import { cylinderResizeFold } from './cylinderResizeFold';

const axisStart = { x: 20, y: 20, z: 0 };
const axisEnd = { x: 20, y: 20, z: 10 };

function resized(operation: Partial<DirectEditOperation> = {}) {
  const base = addPrimitiveFeature(
    createProjectDocument('Fold', toUserId('user_fold')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 40, depth: 10 }
    }
  );
  const bodyId = base.bodyOrder.at(-1)!;
  const document = directEditBody(base, {
    name: 'Resize Hole',
    targetBodyId: bodyId,
    operation: {
      kind: 'resize-cylindrical-face',
      faceHash: 7,
      sourceRadius: 3,
      sourceAxisStart: axisStart,
      sourceAxisEnd: axisEnd,
      concavity: 'hole',
      radius: 4,
      ...operation
    } as DirectEditOperation
  }).document;
  return { document, bodyId };
}

const heldAt = (bodyId: string, radius = 4) => ({
  bodyId,
  radius,
  // The resized wall's own span along the same axis line.
  axisStart: { x: 20, y: 20, z: 10 },
  axisEnd: { x: 20, y: 20, z: 0 },
  concavity: 'hole' as const
});

describe('cylinder resize fold', () => {
  it('rewrites the last resize of the wall it produced', () => {
    const { document, bodyId } = resized();
    const fold = cylinderResizeFold(document, heldAt(bodyId), 5.5);
    expect(fold?.featureId).toBe(document.featureOrder.at(-1));
    expect(fold?.operation).toMatchObject({
      kind: 'resize-cylindrical-face',
      faceHash: 7,
      sourceRadius: 3,
      radius: 5.5
    });
  });

  it('folds a through-hole resize by diameter', () => {
    const { document, bodyId } = resized({
      kind: 'resize-through-hole',
      sourceDiameter: 6,
      diameter: 8
    });
    expect(
      cylinderResizeFold(document, heldAt(bodyId), 5)?.operation
    ).toMatchObject({ kind: 'resize-through-hole', diameter: 10 });
  });

  it('appends instead when the fold could not say what was meant', () => {
    const { document, bodyId } = resized();
    // Another wall: a different radius, or a parallel axis.
    expect(cylinderResizeFold(document, heldAt(bodyId, 3.5), 5)).toBeNull();
    expect(
      cylinderResizeFold(
        document,
        {
          ...heldAt(bodyId),
          axisStart: { x: 21, y: 20, z: 0 },
          axisEnd: { x: 21, y: 20, z: 10 }
        },
        5
      )
    ).toBeNull();
    // Another body, or back to where the resize started.
    expect(cylinderResizeFold(document, heldAt('other'), 5)).toBeNull();
    expect(cylinderResizeFold(document, heldAt(bodyId), 3)).toBeNull();
    // A symbolic size or a parameter-bound hole.
    expect(
      cylinderResizeFold(
        resized({ radius: 'bore' }).document,
        heldAt(bodyId),
        5
      )
    ).toBeNull();
    const bound = resized({
      kind: 'resize-through-hole',
      sourceDiameter: 6,
      diameter: 8,
      parameterBinding: true
    });
    expect(
      cylinderResizeFold(bound.document, heldAt(bound.bodyId), 5)
    ).toBeNull();
  });

  it('appends on a coaxial sibling patch at the size the resize produced', () => {
    // Same body, radius and axis line, but another span: a slot splits one
    // bore into patches, and the tip resized the one at z 0–10.
    const { document, bodyId } = resized();
    const sibling = {
      ...heldAt(bodyId),
      axisStart: { x: 20, y: 20, z: 12 },
      axisEnd: { x: 20, y: 20, z: 20 }
    };
    expect(cylinderResizeFold(document, sibling, 5)).toBeNull();
    // Overlapping the recorded span is still another face.
    expect(
      cylinderResizeFold(
        document,
        { ...sibling, axisStart: { x: 20, y: 20, z: 0 } },
        5
      )
    ).toBeNull();
  });

  it('folds by a shared face name when the span moved upstream', () => {
    const reference = {
      kind: 'face',
      producingFeatureId: 'feature_bore',
      lineageName: 'primitive.cylinder.face.wall',
      currentHash: 7,
      witnessVersion: 1
    } as unknown as FaceTopologyReferenceV5;
    const { document, bodyId } = resized({ faceReference: reference });
    const longer = {
      ...heldAt(bodyId),
      axisStart: { x: 20, y: 20, z: 0 },
      axisEnd: { x: 20, y: 20, z: 14 }
    };
    expect(
      cylinderResizeFold(document, { ...longer, reference }, 5)?.featureId
    ).toBe(document.featureOrder.at(-1));
    // Another name with another span is a sibling, not this face.
    expect(
      cylinderResizeFold(
        document,
        {
          ...longer,
          reference: { ...reference, lineageName: 'subtract.tool.face.wall' }
        },
        5
      )
    ).toBeNull();
    // Without a name the recorded span still decides.
    expect(cylinderResizeFold(document, heldAt(bodyId), 5)?.featureId).toBe(
      document.featureOrder.at(-1)
    );
    // Two different names never fold, even over the recorded span.
    expect(
      cylinderResizeFold(
        document,
        {
          ...heldAt(bodyId),
          reference: { ...reference, lineageName: 'subtract.tool.face.wall' }
        },
        5
      )
    ).toBeNull();
  });

  it('never merges walls by their distance from the origin', () => {
    // A tube 100 m out: the bore went from R4 to R4.95, and the outer wall,
    // R5 over the same span, is 0.05 mm away.
    const far = (z: number) => ({ x: 100_000, y: 0, z });
    const { document, bodyId } = resized({
      kind: 'resize-through-hole',
      sourceDiameter: 8,
      sourceAxisStart: far(0),
      sourceAxisEnd: far(10),
      diameter: 9.9
    });
    const wall = (radius: number, concavity: 'hole' | 'boss') => ({
      bodyId,
      radius,
      axisStart: far(0),
      axisEnd: far(10),
      concavity
    });
    expect(cylinderResizeFold(document, wall(5, 'boss'), 4.975)).toBeNull();
    // Neither the radius nor the side alone may let it through.
    expect(cylinderResizeFold(document, wall(5, 'hole'), 4.975)).toBeNull();
    expect(cylinderResizeFold(document, wall(4.95, 'boss'), 4.975)).toBeNull();
    expect(
      cylinderResizeFold(document, wall(4.95, 'hole'), 4.975)?.operation
    ).toMatchObject({ diameter: 9.95 });
  });

  it('folds a through-hole whose resize re-trimmed its ends', () => {
    // A chamfered bore spans z 1–9; shrinking it moves its ends to where
    // the narrower wall meets the chamfers, and an older pick stored no name.
    const { document, bodyId } = resized({
      kind: 'resize-through-hole',
      sourceDiameter: 6,
      sourceAxisStart: { x: 20, y: 20, z: 1 },
      sourceAxisEnd: { x: 20, y: 20, z: 9 },
      diameter: 4.2
    });
    const span = (lo: number, hi: number) => ({
      bodyId,
      radius: 2.1,
      axisStart: { x: 20, y: 20, z: hi },
      axisEnd: { x: 20, y: 20, z: lo },
      concavity: 'hole' as const
    });
    const tip = document.featureOrder.at(-1);
    expect(cylinderResizeFold(document, span(1.9, 8.1), 2.5)?.featureId).toBe(
      tip
    );
    expect(cylinderResizeFold(document, span(0.5, 9.5), 2.5)?.featureId).toBe(
      tip
    );
    // A coaxial patch beyond the recorded span, or touching only its end,
    // is a sibling.
    expect(cylinderResizeFold(document, span(11, 19), 2.5)).toBeNull();
    expect(cylinderResizeFold(document, span(9, 12), 2.5)).toBeNull();
  });

  it('keeps a moved-end wall resize as a new edit when it may be partial', () => {
    // The generic wall resize also covers partial turns, which can sit
    // beside a sibling over the same range: only the recorded ends prove it.
    const { document, bodyId } = resized({
      sourceAxisStart: { x: 20, y: 20, z: 1 },
      sourceAxisEnd: { x: 20, y: 20, z: 9 }
    });
    expect(
      cylinderResizeFold(
        document,
        {
          ...heldAt(bodyId),
          axisStart: { x: 20, y: 20, z: 1.5 },
          axisEnd: { x: 20, y: 20, z: 8.5 }
        },
        5
      )
    ).toBeNull();
  });

  it('appends after another feature or a suppressed resize', () => {
    const { document, bodyId } = resized();
    const later = addPrimitiveFeature(document, {
      name: 'Pin',
      primitiveKind: 'cylinder',
      dimensions: { radius: 1, height: 4 }
    });
    expect(cylinderResizeFold(later, heldAt(bodyId), 5)).toBeNull();
    findFeature(document, document.featureOrder.at(-1)!)!.metadata = {
      [FEATURE_SUPPRESSED_METADATA_KEY]: true
    };
    expect(cylinderResizeFold(document, heldAt(bodyId), 5)).toBeNull();
  });
});
