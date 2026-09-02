import { describe, expect, it } from 'vitest';
import type {
  BodyId,
  FaceTopology,
  FaceTopologyReferenceV5,
  FeatureId,
  SketchPlaneRef
} from '@openzcad/shared';
import {
  faceSketchAttachment,
  fixedPlaneRefForLegacyAttachment,
  UNSTABLE_FACE_SKETCH_REASON
} from './faceSketchAttachment';

const reference: FaceTopologyReferenceV5 = {
  kind: 'face',
  producingFeatureId: 'feature_box' as FeatureId,
  lineageName: 'primitive.box.face.z-max',
  currentHash: 12,
  witnessVersion: 1,
  witness: {
    surfaceType: 'plane',
    perimeter: 40,
    centroid: [0, 0, 5],
    analytic: { kind: 'plane', normal: [0, 0, 1], offset: 5 },
    closure: { u: 'open', v: 'open' }
  }
};

function face(overrides: Partial<FaceTopology> = {}): FaceTopology {
  return {
    topologyId: 'face:12',
    hash: 12,
    reference,
    triangleStart: 0,
    triangleCount: 2,
    geometry: {
      surfaceType: 'plane',
      area: 100,
      center: { x: 0, y: 0, z: 5 },
      normal: { x: 0, y: 0, z: 1 }
    },
    ...overrides
  };
}

describe('faceSketchAttachment', () => {
  it('copies a current exact planar face into an associative plane', () => {
    const result = faceSketchAttachment({
      bodyId: 'body_box' as BodyId,
      pickedHash: 12,
      face: face()
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment).toBe('associative');
    if (result.attachment !== 'associative') return;
    expect(result.planeRef.faceReference).toBe(reference);
    expect(result.planeRef.faceHash).toBe(12);
    expect(result.planeRef.frame.origin).toEqual({ x: 0, y: 0, z: 5 });
    expect(result.planeRef.frame.zAxis).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('places the sketch on the face centroid, not on its vertex mean', () => {
    // A disc: the boundary is one closed circle, so the face's only vertex is
    // its seam and `center` sits a whole radius off the axis.
    const result = faceSketchAttachment({
      bodyId: 'body_disc' as BodyId,
      pickedHash: 12,
      face: face({
        geometry: {
          surfaceType: 'plane',
          area: Math.PI * 100,
          center: { x: 10, y: 0, z: 5 },
          centroid: { x: 0, y: 0, z: 5 },
          normal: { x: 0, y: 0, z: 1 }
        }
      })
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.attachment !== 'associative') return;
    expect(result.planeRef.frame.origin).toEqual({ x: 0, y: 0, z: 5 });
    // Both points are persisted: the centroid is the anchor, and its presence
    // is what tells a rebuild to re-anchor there rather than on `sourceCenter`.
    expect(result.planeRef.sourceCentroid).toEqual({ x: 0, y: 0, z: 5 });
    expect(result.planeRef.sourceCenter).toEqual({ x: 10, y: 0, z: 5 });
  });

  it('keeps the old anchor for a face that reports no centroid', () => {
    // A NURBS-backed plane has no walkable boundary. Claiming a centroid it
    // does not have would move the sketch; the absent field says so.
    const result = faceSketchAttachment({
      bodyId: 'body_box' as BodyId,
      pickedHash: 12,
      face: face()
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.attachment !== 'associative') return;
    expect(result.planeRef.sourceCentroid).toBeUndefined();
    expect(result.planeRef.frame.origin).toEqual(result.planeRef.sourceCenter);
  });

  it('places the sketch on a fixed frame when lineage is absent or stale', () => {
    for (const candidate of [
      face({ reference: undefined }),
      face({ reference: { ...reference, currentHash: 99 } })
    ]) {
      const result = faceSketchAttachment({
        bodyId: 'body_box' as BodyId,
        pickedHash: 12,
        face: candidate
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Not associative: nothing in the plane names the face, so a rebuild
      // that moves the face leaves the sketch where it was drawn — and the
      // note is how the user is told.
      expect(result.attachment).toBe('fixed');
      expect(result.planeRef.type).toBe('frame');
      if (result.attachment !== 'fixed') return;
      expect(result.note).toBe(UNSTABLE_FACE_SKETCH_REASON);
      expect(result.planeRef.frame.origin).toEqual({ x: 0, y: 0, z: 5 });
      expect(result.planeRef.frame.zAxis).toEqual({ x: 0, y: 0, z: 1 });
    }
  });

  it('refuses stale picks and invalid exact plane measurements', () => {
    expect(
      faceSketchAttachment({
        bodyId: 'body_box' as BodyId,
        pickedHash: 99,
        face: face()
      }).ok
    ).toBe(false);
    expect(
      faceSketchAttachment({
        bodyId: 'body_box' as BodyId,
        pickedHash: 12,
        face: face({
          geometry: {
            surfaceType: 'plane',
            area: 100,
            center: { x: 0, y: 0, z: 5 },
            normal: { x: 0, y: 0, z: 0 }
          }
        })
      }).ok
    ).toBe(false);
  });
});

describe('fixedPlaneRefForLegacyAttachment', () => {
  const legacy: SketchPlaneRef = {
    type: 'face',
    bodyId: 'body_box' as BodyId,
    faceHash: 12,
    sourceArea: 100,
    sourceCenter: { x: 0, y: 0, z: 5 },
    sourceNormal: { x: 0, y: 0, z: 1 },
    frame: {
      origin: { x: 0, y: 0, z: 5 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 }
    }
  };

  it('preserves the stored migration frame as an explicit fixed plane', () => {
    expect(fixedPlaneRefForLegacyAttachment(legacy)).toEqual({
      type: 'frame',
      frame: legacy.frame
    });
  });

  it('does not convert current associative or already-fixed planes', () => {
    expect(
      fixedPlaneRefForLegacyAttachment({ ...legacy, faceReference: reference })
    ).toBeNull();
    expect(
      fixedPlaneRefForLegacyAttachment({ type: 'frame', frame: legacy.frame })
    ).toBeNull();
  });
});
