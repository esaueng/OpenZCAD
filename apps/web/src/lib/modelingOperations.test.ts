import { describe, expect, it } from 'vitest';
import {
  toBodyId,
  toEntityId,
  toFeatureId,
  toSketchId,
  type BodyTopology,
  type FaceTopologyReferenceV5
} from '@openzcad/shared';
import {
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

  it('rejects helical sweeps above the bounded turn count', () => {
    expect(
      modelingFormValidationReason(
        {
          operation: 'helical-sweep',
          value: {
            name: 'Helix',
            profileId: 'profile',
            axisOrigin: { x: '0', y: '0', z: '0' },
            axisDirection: { x: '0', y: '0', z: '1' },
            radius: '2',
            pitch: '1',
            turns: '101'
          }
        },
        {}
      )
    ).toMatch(/must not exceed 100/);
  });

  /**
   * K0.6 gave imported bodies persistent references, and their lineage name IS
   * the fingerprint because an import has no feature contract to name faces
   * from. Spelling it out would read "Plane face import · step · face ·
   * 3f2a1b7c · #3f2a1b7c", so an imported face keeps the positional label.
   */
  it('does not render a content-addressed import name as an identity', () => {
    const imported = modelingFaceOptions({
      ...topology,
      faces: [
        {
          ...topology.faces[0]!,
          reference: {
            ...reference,
            lineageName: 'import.step.face.0000002a'
          }
        }
      ]
    });
    expect(imported[0]?.label).toBe('Plane face 1 · #0000002a');
  });

  it('allows solid offset on any ready body with one kernel', () => {
    // The OpenCascade convex-planar refusal used to answer here. Z5 deleted
    // the kernel that needed it, so a ready body with a live target is now
    // simply offsettable; the assertion is that nothing refuses it silently.
    expect(
      modelingOperationDisabledReason('solid-offset', {
        exactState: 'ready',
        hasTargetBody: true
      })
    ).toBeNull();
  });

  it('preserves ordered loft sections and parametric helical inputs', () => {
    const profiles = ['lower', 'upper'].map((name, index) => ({
      id: name,
      label: name,
      section: {
        sketchId: toSketchId(`sketch_${name}`),
        profile: {
          profileId: `profile_${name}`,
          regionFingerprint: index + 1,
          samplePoint: { x: 0, y: 0 },
          sourceArea: 10 + index
        }
      }
    }));
    expect(
      buildModelingOperationSubmission(
        {
          operation: 'loft',
          value: {
            name: ' Loft ',
            sectionIds: ['upper', 'lower'],
            mode: 'smooth'
          }
        },
        [],
        profiles
      )
    ).toEqual({
      operation: 'loft',
      input: {
        name: 'Loft',
        sections: [profiles[1]!.section, profiles[0]!.section],
        mode: 'smooth'
      }
    });
    expect(
      buildModelingOperationSubmission(
        {
          operation: 'helical-sweep',
          value: {
            name: 'Helix',
            profileId: 'lower',
            axisOrigin: { x: '0', y: '0', z: 'base' },
            axisDirection: { x: '0', y: '0', z: '1' },
            radius: 'coil_radius',
            pitch: '-5',
            turns: '3'
          }
        },
        [],
        profiles
      )
    ).toMatchObject({
      operation: 'helical-sweep',
      input: {
        axisOrigin: { x: 0, y: 0, z: 'base' },
        radius: 'coil_radius',
        pitch: -5,
        turns: 3
      }
    });
  });

  it('builds sweep paths and face modifiers with persistent references', () => {
    const profile = {
      id: 'profile',
      label: 'Profile',
      section: {
        sketchId: toSketchId('sketch_profile'),
        profile: {
          profileId: 'profile_1',
          regionFingerprint: 1,
          samplePoint: { x: 0, y: 0 },
          sourceArea: 4
        }
      }
    };
    const path = {
      id: 'path',
      label: 'Path',
      path: {
        sketchId: toSketchId('sketch_path'),
        entityIds: [toEntityId('entity_path')]
      }
    };
    expect(
      buildModelingOperationSubmission(
        {
          operation: 'sweep',
          value: {
            name: 'Sweep',
            profileId: 'profile',
            pathId: 'path',
            mode: 'standard'
          }
        },
        [],
        [profile],
        [path]
      )
    ).toEqual({
      operation: 'sweep',
      input: {
        name: 'Sweep',
        profile: profile.section,
        path: path.path,
        mode: 'standard'
      }
    });
    expect(
      buildModelingOperationSubmission(
        {
          operation: 'draft',
          value: {
            name: 'Draft',
            targetBodyId: bodyId,
            faceHashes: [42],
            pullDirection: { x: '0', y: '0', z: '1' },
            neutralPoint: { x: '0', y: '0', z: '0' },
            angleDeg: '3'
          }
        },
        modelingFaceOptions(topology)
      )
    ).toMatchObject({
      operation: 'draft',
      input: { faceHashes: [42], faceReferences: [reference], angleDeg: 3 }
    });
  });
});
