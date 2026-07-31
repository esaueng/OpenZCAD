import { describe, expect, it } from 'vitest';
import {
  toBodyId,
  toFeatureId,
  type BodyTopology,
  type FaceTopologyReferenceV5
} from '@openzcad/shared';
import {
  OCCT_SHARP_OFFSET_LIMITATION,
  buildModelingOperationSubmission,
  modelingFaceOptions,
  modelingFormValidationReason,
  modelingOperationDisabledReason
} from './modelingOperations';

const bodyId = toBodyId('body_modeling');
const reference: FaceTopologyReferenceV5 = {
  kind: 'face',
  producingFeatureId: toFeatureId('feat_box'),
  lineageName: 'primitive.box.face.z-max',
  currentHash: 42,
  witnessVersion: 1,
  witness: {
    surfaceType: 'plane',
    perimeter: 120,
    centroid: [0, 0, 30_000_000],
    analytic: {
      kind: 'plane',
      normal: [0, 0, 1_000_000_000],
      offset: 30_000_000
    },
    closure: { u: 'open', v: 'open' }
  }
};
const topology: BodyTopology = {
  faces: [
    {
      topologyId: 'face:42',
      hash: 42,
      reference,
      triangleStart: 0,
      triangleCount: 2,
      geometry: {
        surfaceType: 'plane',
        area: 200,
        center: { x: 5, y: 10, z: 30 }
      }
    }
  ],
  edges: []
};

describe('modeling operation form contracts', () => {
  it('preserves expression-valued mirror fields in the command input', () => {
    const submission = buildModelingOperationSubmission({
      operation: 'mirror',
      value: {
        name: ' Mirror copy ',
        targetBodyId: bodyId,
        origin: { x: 'width / 2', y: '0', z: '0' },
        normal: { x: '1', y: '0', z: '0' }
      }
    });

    expect(submission).toEqual({
      operation: 'mirror',
      input: {
        name: 'Mirror copy',
        targetBodyId: bodyId,
        plane: {
          origin: { x: 'width / 2', y: 0, z: 0 },
          normal: { x: 1, y: 0, z: 0 }
        }
      }
    });
  });

  it('projects semantic topology labels and complete shell references', () => {
    const faces = modelingFaceOptions(topology);
    expect(faces[0]?.label).toBe('Plane face box · face · z max · #0000002a');
    expect(
      buildModelingOperationSubmission(
        {
          operation: 'shell',
          value: {
            name: 'Open top',
            targetBodyId: bodyId,
            thickness: 'wall / 2',
            openingFaceHashes: [42]
          }
        },
        faces
      )
    ).toEqual({
      operation: 'shell',
      input: {
        name: 'Open top',
        targetBodyId: bodyId,
        openingFaceHashes: [42],
        openingFaceReferences: [reference],
        thickness: 'wall / 2'
      }
    });
  });

  it('validates positive values and a non-zero mirror normal', () => {
    expect(
      modelingFormValidationReason(
        {
          operation: 'mirror',
          value: {
            name: 'Mirror',
            targetBodyId: bodyId,
            origin: { x: '0', y: '0', z: '0' },
            normal: { x: 'axis', y: '0', z: '0' }
          }
        },
        { axis: 0 }
      )
    ).toBe('Mirror plane normal must be non-zero.');
    expect(
      modelingFormValidationReason(
        {
          operation: 'solid-offset',
          value: {
            name: 'Offset',
            targetBodyId: bodyId,
            distance: '-wall'
          }
        },
        { wall: 2 }
      )
    ).toBe('Solid offset distance must resolve to a positive value.');
  });

  it('states the OCCT sharp-offset limitation explicitly', () => {
    expect(
      modelingOperationDisabledReason('solid-offset', {
        exactState: 'ready',
        hasTargetBody: true,
        kernel: 'occt',
        offsetTopology: 'curved'
      })
    ).toBe(OCCT_SHARP_OFFSET_LIMITATION);
    expect(OCCT_SHARP_OFFSET_LIMITATION).toContain('rounded joins');
  });
});
