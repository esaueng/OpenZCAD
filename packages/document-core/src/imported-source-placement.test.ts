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
