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
