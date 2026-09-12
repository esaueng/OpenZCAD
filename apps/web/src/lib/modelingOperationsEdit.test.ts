import { describe, expect, it } from 'vitest';
import type { FeatureId, FeatureNode } from '@openzcad/shared';
import {
  modelingFeatureIsEditable,
  modelingFeatureUpdate,
  modelingFormStateFromFeature,
  type ModelingOperationSubmission
} from './modelingOperations';

const hole: Extract<FeatureNode['data'], { featureKind: 'hole' }> = {
  featureKind: 'hole',
  targetBodyId: 'body_plate' as never,
  faceHash: 3697740096,
  style: 'counterbore',
  diameter: 'd',
  depthMode: 'blind',
  depth: 10,
  counterboreDiameter: 11,
  counterboreDepth: 3,
  position: { u: 30, v: -20 }
};

describe('editing a modeling feature through its creation form', () => {
  it('lifts stored hole data into the form, expressions as written', () => {
    expect(modelingFormStateFromFeature('Bolt hole', hole)).toEqual({
      operation: 'hole',
      value: {
        name: 'Bolt hole',
        targetBodyId: 'body_plate',
        faceHash: 3697740096,
        style: 'counterbore',
        diameter: 'd',
        depthMode: 'blind',
        depth: '10',
        counterboreDiameter: '11',
        counterboreDepth: '3',
        countersinkDiameter: '12',
        countersinkAngleDeg: '90',
        position: { u: '30', v: '-20' }
      }
    });
  });

  it('turns a submission into a patch of exactly the stored keys', () => {
    const submission: ModelingOperationSubmission = {
      operation: 'hole',
      input: {
        name: 'Bolt hole',
        targetBodyId: 'body_plate' as never,
        faceHash: 3697740096,
        style: 'simple',
        diameter: 8,
        depthMode: 'through',
        position: { u: 30, v: -20 },
        positionAnchor: 'centroid'
      }
    };
    expect(modelingFeatureUpdate('feat_hole' as FeatureId, submission)).toEqual(
      {
        featureId: 'feat_hole',
        name: 'Bolt hole',
        data: {
          featureKind: 'hole',
          targetBodyId: 'body_plate',
          faceHash: 3697740096,
          style: 'simple',
          diameter: 8,
          depthMode: 'through',
          position: { u: 30, v: -20 }
        }
      }
    );
    expect(modelingFeatureIsEditable('hole')).toBe(true);
    expect(modelingFeatureIsEditable('loft')).toBe(false);
  });

  it('lifts and patches the plane and face kinds through the same seam', () => {
    expect(
      modelingFormStateFromFeature('Mirror', {
        featureKind: 'mirror',
        targetBodyId: 'body_arm' as never,
        plane: {
          origin: { x: 0, y: 'w / 2', z: 0 },
          normal: { x: 1, y: 0, z: 0 }
        }
      })
    ).toEqual({
      operation: 'mirror',
      value: {
        name: 'Mirror',
        targetBodyId: 'body_arm',
        origin: { x: '0', y: 'w / 2', z: '0' },
        normal: { x: '1', y: '0', z: '0' }
      }
    });
    expect(
      modelingFeatureUpdate('feat_shell' as FeatureId, {
        operation: 'shell',
        input: {
          name: 'Shell',
          targetBodyId: 'body_cup' as never,
          openingFaceHashes: [7, 9],
          thickness: 1.5
        }
      })
    ).toEqual({
      featureId: 'feat_shell',
      name: 'Shell',
      data: {
        featureKind: 'shell',
        targetBodyId: 'body_cup',
        openingFaceHashes: [7, 9],
        thickness: 1.5
      }
    });
    expect(modelingFeatureIsEditable('mirror')).toBe(true);
    expect(modelingFeatureIsEditable('loft')).toBe(false);
  });
});
