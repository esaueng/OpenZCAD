import { describe, expect, it } from 'vitest';
import {
  toBodyId,
  toFeatureId,
  type FaceTopology,
  type Vector3
} from '@openzcad/shared';
import {
  offsetPreviewRejection,
  resolveOffsetPreviewFace
} from './offsetPreview';

const point = (x: number, y: number, z: number): Vector3 => ({ x, y, z });

function plane(
  topologyId: string,
  center: Vector3,
  normal = point(0, 0, 1)
): FaceTopology {
  return {
    topologyId,
    hash: topologyId.length,
    triangleStart: 0,
    triangleCount: 2,
    geometry: {
      surfaceType: 'plane',
      area: 100,
      center,
      normal
    }
  };
}

const target = {
  point: point(2, 3, 10),
  center: point(0, 0, 10),
  normal: point(0, 0, 1)
};

describe('offset preview face resolution', () => {
  it('follows the selected plane by the requested signed offset', () => {
    const moved = plane('regenerated', point(0, 0, 14));
    const result = resolveOffsetPreviewFace(
      [plane('opposite', point(0, 0, 0)), moved],
      target,
      4
    );
    expect(result).toBe(moved);
  });

  it('accepts an equivalent reversed plane normal', () => {
    const moved = plane('reversed', point(0, 0, 7), point(0, 0, -1));
    expect(resolveOffsetPreviewFace([moved], target, -3)).toBe(moved);
  });

  it('uses the frozen center to distinguish coplanar faces', () => {
    const moved = plane('selected', point(0, 0, 12));
    const neighbor = plane('neighbor', point(40, 0, 12));
    expect(resolveOffsetPreviewFace([neighbor, moved], target, 2)).toBe(moved);
  });

  it('fails closed when coplanar candidates remain indistinguishable', () => {
    expect(
      resolveOffsetPreviewFace(
        [plane('left', point(1, 0, 12)), plane('right', point(-1, 0, 12))],
        target,
        2
      )
    ).toBeNull();
  });

  it('rejects a face on the wrong plane or analytic carrier', () => {
    const tilted = plane('tilted', point(0, 0, 14), point(1, 0, 0));
    const wrongHeight = plane('wrong-height', point(0, 0, 13));
    expect(
      resolveOffsetPreviewFace([tilted, wrongHeight], target, 4)
    ).toBeNull();
  });
});

describe('offset preview validation', () => {
  const bodyId = toBodyId('body_source');
  const sourceFeatureId = toFeatureId('feat_source');
  const suppressedFeatureId = toFeatureId('feat_suppressed');
  const suppression =
    'Feature "Shared name": Suppressed; skipped during exact rebuild.';
  const derived = {
    bodyRepresentations: { [bodyId]: {} },
    warnings: [suppression],
    featureWarnings: [
      {
        featureId: suppressedFeatureId,
        featureName: 'Shared name',
        message: suppression,
        kind: 'suppressed' as const
      }
    ]
  };

  it('ignores a same-named suppression outside the targeted feature', () => {
    expect(
      offsetPreviewRejection({
        label: 'Resize Cylinder Height',
        bodyId,
        validationTargets: [
          {
            featureName: 'Shared name',
            featureId: sourceFeatureId,
            resultBodyId: bodyId
          }
        ],
        derived,
        documentMoved: false
      })
    ).toBeNull();
  });

  it('uses structured warning kinds for a generic preview verdict', () => {
    expect(
      offsetPreviewRejection({
        label: 'Shared name',
        bodyId,
        derived,
        documentMoved: false
      })
    ).toBeNull();
  });

  describe('a new direct edit beside an older failed one of the same name', () => {
    // Every generic face offset is labelled "Offset face". A history that
    // already holds a failed one (its mirrored target was lost) must not
    // refuse a new offset that built its body: attribution is by the new
    // feature's id, which the command carries.
    const oldFeatureId = toFeatureId('feat_old_offset');
    const newFeatureId = toFeatureId('feat_new_offset');
    const oldFailure =
      'Feature "Offset face": Direct-edit target is unavailable.';
    const command = {
      payload: {
        name: 'Offset face',
        ids: { featureId: newFeatureId, featureNodeId: 'node_new_offset' }
      }
    };
    const withOldFailure = {
      bodyRepresentations: { [bodyId]: {} },
      warnings: [oldFailure],
      featureWarnings: [
        {
          featureId: oldFeatureId,
          featureName: 'Offset face',
          message: oldFailure,
          kind: 'build-failed' as const
        }
      ]
    };

    it('passes the new edit that built its body', () => {
      expect(
        offsetPreviewRejection({
          label: 'Offset face',
          bodyId,
          command,
          derived: withOldFailure,
          documentMoved: false
        })
      ).toBeNull();
      // Without the command the shared name is all there is, which is how
      // the earlier failure used to be blamed on the new edit.
      expect(
        offsetPreviewRejection({
          label: 'Offset face',
          bodyId,
          derived: withOldFailure,
          documentMoved: false
        })?.message
      ).toMatch(/Direct-edit target is unavailable/);
    });

    it('still refuses the new edit by its own failure', () => {
      const ownFailure =
        'Feature "Offset face": The face cannot move that far.';
      expect(
        offsetPreviewRejection({
          label: 'Offset face',
          bodyId,
          command,
          derived: {
            ...withOldFailure,
            warnings: [oldFailure, ownFailure],
            featureWarnings: [
              ...withOldFailure.featureWarnings,
              {
                featureId: newFeatureId,
                featureName: 'Offset face',
                message: ownFailure,
                kind: 'build-failed' as const
              }
            ]
          },
          documentMoved: false
        })?.message
      ).toMatch(/cannot move that far/);
    });

    it('still refuses a new edit that lost its body', () => {
      expect(
        offsetPreviewRejection({
          label: 'Offset face',
          bodyId,
          command,
          derived: { ...withOldFailure, bodyRepresentations: {} },
          documentMoved: false
        })?.message
      ).toMatch(/did not produce the selected body/);
    });
  });
});

describe('offsetPreviewRejection for a blend preview', () => {
  it('retains the typed diameter cause for a direct preview without validation targets', () => {
    const rejection = offsetPreviewRejection({
      label: 'Resize Cylinder',
      bodyId: toBodyId('body'),
      documentMoved: false,
      derived: {
        bodyRepresentations: { [toBodyId('body')]: {} },
        warnings: [],
        featureWarnings: [
          {
            featureId: toFeatureId('resize'),
            featureName: 'Resize Cylinder',
            message: 'opaque refusal',
            kind: 'refusal',
            kernelRefusal: {
              family: 'direct-edit',
              category: 'unsupported',
              code: 'cylinder-diameter-unbuildable'
            }
          }
        ]
      }
    });
    expect(rejection?.headline).toContain('smaller diameter');
    expect(rejection?.detail).toBe('opaque refusal');
  });
  it('names the kernel refusal without the feature prefix when the blend fails to build', () => {
    const rejection = offsetPreviewRejection({
      label: 'Fillet edges',
      bodyId: toBodyId('body_result'),
      validationTargets: [
        {
          featureId: toFeatureId('feat_fillet'),
          featureName: 'Fillet',
          resultBodyId: toBodyId('body_result')
        }
      ],
      derived: {
        bodyRepresentations: {},
        warnings: [
          'Feature "Fillet": Fillet could not be created on 1 selected edge with radius 12. Try a smaller radius.'
        ],
        featureWarnings: [
          {
            featureId: toFeatureId('feat_fillet'),
            featureName: 'Fillet',
            message:
              'Feature "Fillet": Fillet could not be created on 1 selected edge with radius 12. Try a smaller radius.',
            kind: 'build-failed'
          }
        ]
      },
      documentMoved: false
    });
    expect(rejection?.message).toBe(
      'Fillet could not be created on 1 selected edge with radius 12. Try a smaller radius.'
    );
    expect(rejection?.culprit).toMatchObject({ featureName: 'Fillet' });
  });

  it('passes a blend whose result body is present and unwarned', () => {
    expect(
      offsetPreviewRejection({
        label: 'Fillet edges',
        bodyId: toBodyId('body_result'),
        validationTargets: [
          {
            featureId: toFeatureId('feat_fillet'),
            featureName: 'Fillet',
            resultBodyId: toBodyId('body_result')
          }
        ],
        derived: {
          bodyRepresentations: { [toBodyId('body_result')]: {} },
          warnings: [],
          featureWarnings: []
        },
        documentMoved: false
      })
    ).toBeNull();
  });
});

describe('offsetPreviewRejection for a face pushed past a neighbour', () => {
  // The adapter's typed refusal for the Front face of a block whose Right
  // face keeps a 6.4 flat between two r8.8 rounds
  // (test/parity/offset-face-fillet-limit.spec.ts).
  const kernelWords =
    'resize blend: exact reconstruction refused: … exact prismatic blend translation failed (offset: move-face would change topology at face None, edge Some(Id(8)): line edge 8 with one moving end would reverse: a move of -9 against a fixed-to-moving extent of 6.400000000000002)';
  const message = `Feature "Offset Face": A neighbouring face would shrink to nothing past 6.4. Try a smaller offset.\n${kernelWords}`;

  it('keeps the category, the kernel words and the limit', () => {
    const rejection = offsetPreviewRejection({
      label: 'Offset Face',
      bodyId: toBodyId('body'),
      documentMoved: false,
      derived: {
        bodyRepresentations: {},
        warnings: [message],
        featureWarnings: [
          {
            featureId: toFeatureId('offset'),
            featureName: 'Offset Face',
            message,
            kind: 'build-failed',
            kernelRefusal: {
              family: 'direct-edit',
              operation: 'offset-face',
              category: 'invalid_topology',
              code: 'offset_face_collapses_neighbor',
              reason: 'reverse',
              limit: -6.400000000000002
            }
          }
        ]
      }
    });
    expect(rejection).toEqual({
      message:
        'A neighbouring face would shrink to nothing past 6.4. Try a smaller offset.',
      detail: kernelWords,
      category: 'invalid_topology',
      limit: -6.400000000000002
    });
  });
});
