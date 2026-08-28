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
    expect(resolveOffsetPreviewFace([tilted, wrongHeight], target, 4)).toBeNull();
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
});
