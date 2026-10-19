import { describe, expect, it } from 'vitest';
import { toUserId } from '@openzcad/shared';
import {
  constantRigidTransform,
  createProjectDocument,
  importStepBody,
  listFeaturesInOrder,
  rigidImportedSource,
  setNodeMetadata,
  transformBody
} from './index';

describe('fixed imported source placement', () => {
  it('evaluates constants without allowing parameter dependencies, scaling or non-finite values', () => {
    const fixed = {
      translation: { x: '2 + 3', y: 0, z: -7 },
      rotationDeg: { x: 0, y: '90 / 2', z: 0 }
    };
    expect(constantRigidTransform({ ...fixed, scale: '1' })).toEqual({
      translation: { x: 5, y: 0, z: -7 },
      rotationDeg: { x: 0, y: 45, z: 0 }
    });
    for (const x of ['offset', 'opening_width', '1 / 0', NaN, Infinity])
      expect(
        constantRigidTransform({
          ...fixed,
          translation: { ...fixed.translation, x }
        })
      ).toBeNull();
    for (const scale of [0, -1, 2, 'size', Infinity])
      expect(constantRigidTransform({ ...fixed, scale })).toBeNull();
  });

  it('folds a constant pivot into the origin-based placement and rejects a parametric one (M10)', () => {
    // 90° about z through (10, 5, 0): x' = 10 − (y − 5), y' = 5 + (x − 10),
    // i.e. the same turn about the origin followed by (15, −5, 0).
    const placed = constantRigidTransform({
      translation: { x: 1, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 90 },
      pivot: { x: 10, y: 5, z: 0 }
    })!;
    expect(placed.rotationDeg).toEqual({ x: 0, y: 0, z: 90 });
    expect(placed.translation.x).toBeCloseTo(16, 12);
    expect(placed.translation.y).toBeCloseTo(-5, 12);
    expect(placed.translation.z).toBeCloseTo(0, 12);
    expect(
      constantRigidTransform({
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 90 },
        pivot: { x: 'centre_x', y: 0, z: 0 }
      })
    ).toBeNull();
  });

  it('isolates the selected import and rejects suppressed placement or source history', () => {
    const imported = importStepBody(
      createProjectDocument('Placement', toUserId('test')),
      {
        name: 'Holder',
        artifactId: 'holder',
        sourceName: 'holder.step',
        stepText: 'ISO-10303-21;'
      }
    );
    const other = importStepBody(imported.document, {
      name: 'Other',
      artifactId: 'other',
      sourceName: 'other.step',
      stepText: 'ISO-10303-21;'
    });
    const document = transformBody(other.document, {
      name: 'Move other',
      targetBodyId: other.bodyId,
      translation: { x: 'unknown', y: 0, z: 0 }
    }).document;
    expect(rigidImportedSource(document, imported.bodyId)?.placement).toEqual(
      []
    );
    const moved = transformBody(document, {
      name: 'Move holder',
      targetBodyId: imported.bodyId,
      translation: { x: 5, y: 7, z: -4 }
    }).document;
    expect(rigidImportedSource(moved, imported.bodyId)?.placement).toHaveLength(
      1
    );
    const features = listFeaturesInOrder(moved);
    for (const nodeId of [features[0]!.id, features.at(-1)!.id])
      for (const key of ['suppressed', 'rollbackSuppressed'])
        expect(
          rigidImportedSource(
            setNodeMetadata(moved, {
              nodeId,
              metadata: { [key]: true }
            }),
            imported.bodyId
          )
        ).toBeNull();
  });
});

describe('constant placement with unit suffixes', () => {
  it('resolves a suffixed pivot in document units and refuses a parameter', () => {
    const turn = {
      translation: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 90 }
    };
    const placed = constantRigidTransform(
      { ...turn, pivot: { x: '1 cm', y: 0, z: 0 } },
      'mm'
    );
    expect(placed?.translation.x).toBeCloseTo(10, 9);
    expect(placed?.translation.y).toBeCloseTo(-10, 9);
    expect(
      constantRigidTransform(
        { ...turn, pivot: { x: 'width', y: 0, z: 0 } },
        'mm'
      )
    ).toBeNull();
  });
});
