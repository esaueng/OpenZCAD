import type {
  FaceTopologyReferenceV5,
  FaceWitnessV1,
  FeatureId,
  SketchPlaneFrame,
  Vector3
} from '@openzcad/shared';
import { describe, expect, it } from 'vitest';

import {
  FaceAttachmentResolutionError,
  resolveFaceAttachment,
  type FaceAttachmentCandidate,
  type FaceAttachmentSnapshot,
  type ResolveFaceAttachmentInput
} from './face-attachment';
import { topologyHashOfWitness } from './topology-lineage';

const FEATURE_ID = 'feature_base_extrusion' as FeatureId;
const LINEAGE_NAME = 'primitive.box.face.z-max';

const SOURCE_WITNESS: FaceWitnessV1 = {
  surfaceType: 'plane',
  perimeter: 40_000_000,
  centroid: [5_000_000, 5_000_000, 10_000_000],
  analytic: {
    kind: 'plane',
    normal: [0, 0, 1_000_000_000],
    offset: 10_000_000
  },
  closure: { u: 'open', v: 'open' }
};

const REFERENCE: FaceTopologyReferenceV5 = {
  kind: 'face',
  producingFeatureId: FEATURE_ID,
  lineageName: LINEAGE_NAME,
  currentHash: topologyHashOfWitness('face', SOURCE_WITNESS),
  witnessVersion: 1,
  witness: SOURCE_WITNESS
};

const SNAPSHOT_FRAME: SketchPlaneFrame = {
  origin: { x: 5, y: 5, z: 10 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 }
};

const SNAPSHOT: FaceAttachmentSnapshot = {
  sourceArea: 100,
  sourceCenter: { x: 5, y: 5, z: 10 },
  sourceNormal: { x: 0, y: 0, z: 1 },
  frame: SNAPSHOT_FRAME
};

function candidate(
  witness: FaceWitnessV1,
  plane: FaceAttachmentCandidate['plane'],
  options: {
    readonly lineageName?: string;
    readonly lineageSource?: 'semantic' | 'derived';
    readonly withLineage?: boolean;
  } = {}
): FaceAttachmentCandidate {
  const withLineage = options.withLineage ?? true;
  return {
    kind: 'face',
    currentHash: topologyHashOfWitness('face', witness),
    witnessVersion: 1,
    witness,
    plane,
    ...(withLineage
      ? {
          lineage: {
            source: options.lineageSource ?? ('semantic' as const),
            identity: {
              producingFeatureId: FEATURE_ID,
              lineageName: options.lineageName ?? LINEAGE_NAME
            }
          }
        }
      : {})
  };
}

function input(
  candidates: readonly FaceAttachmentCandidate[],
  overrides: Partial<ResolveFaceAttachmentInput> = {}
): ResolveFaceAttachmentInput {
  return {
    reference: REFERENCE,
    candidates,
    snapshot: SNAPSHOT,
    sketchName: 'Mounted sketch',
    sourceFeatureName: 'Base extrusion',
    ...overrides
  };
}

function vectorLength(vector: Vector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function dot(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x
  };
}

function expectVectorClose(actual: Vector3, expected: Vector3): void {
  expect(actual.x).toBeCloseTo(expected.x, 12);
  expect(actual.y).toBeCloseTo(expected.y, 12);
  expect(actual.z).toBeCloseTo(expected.z, 12);
}

function expectFramesClose(
  actual: SketchPlaneFrame,
  expected: SketchPlaneFrame
): void {
  expectVectorClose(actual.origin, expected.origin);
  expectVectorClose(actual.xAxis, expected.xAxis);
  expectVectorClose(actual.yAxis, expected.yAxis);
  expectVectorClose(actual.zAxis, expected.zAxis);
}

function expectFrame(frame: SketchPlaneFrame): void {
  expect(vectorLength(frame.xAxis)).toBeCloseTo(1, 12);
  expect(vectorLength(frame.yAxis)).toBeCloseTo(1, 12);
  expect(vectorLength(frame.zAxis)).toBeCloseTo(1, 12);
  expect(dot(frame.xAxis, frame.yAxis)).toBeCloseTo(0, 12);
  expect(dot(frame.xAxis, frame.zAxis)).toBeCloseTo(0, 12);
  expect(dot(frame.yAxis, frame.zAxis)).toBeCloseTo(0, 12);
  expectVectorClose(cross(frame.xAxis, frame.yAxis), frame.zAxis);
}

function capturedError(run: () => unknown): FaceAttachmentResolutionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(FaceAttachmentResolutionError);
    return error as FaceAttachmentResolutionError;
  }
  throw new Error('Expected face attachment resolution to fail.');
}

describe('face attachment resolver', () => {
  it('follows dimension and rigid-transform evolution by lineage', () => {
    const dimensionWitness: FaceWitnessV1 = {
      ...SOURCE_WITNESS,
      perimeter: 60_000_000,
      centroid: [10_000_000, 5_000_000, 10_000_000]
    };
    const dimensionFrame = resolveFaceAttachment(
      input([
        candidate(dimensionWitness, {
          center: { x: 10, y: 5, z: 10 },
          normal: { x: 0, y: 0, z: 1 }
        })
      ])
    );
    expectVectorClose(dimensionFrame.origin, { x: 10, y: 5, z: 10 });
    expectFrame(dimensionFrame);

    const transformedWitness: FaceWitnessV1 = {
      ...SOURCE_WITNESS,
      centroid: [30_000_000, 5_000_000, -5_000_000],
      analytic: {
        kind: 'plane',
        normal: [1_000_000_000, 0, 0],
        offset: 30_000_000
      }
    };
    const transformedFrame = resolveFaceAttachment(
      input([
        candidate(
          transformedWitness,
          {
            center: { x: 30, y: 5, z: -5 },
            normal: { x: 1, y: 0, z: 0 }
          },
          { lineageSource: 'derived' }
        )
      ])
    );
    expectVectorClose(transformedFrame.origin, { x: 30, y: 5, z: -5 });
    expectVectorClose(transformedFrame.zAxis, { x: 1, y: 0, z: 0 });
    expectFrame(transformedFrame);
  });

  it('is stable under normal sign and unrelated candidate ordering', () => {
    const attachedPositive = candidate(SOURCE_WITNESS, {
      center: { x: 5, y: 5, z: 10 },
      normal: { x: 0, y: 0, z: 1 }
    });
    const attachedNegative = candidate(SOURCE_WITNESS, {
      center: { x: 5, y: 5, z: 10 },
      normal: { x: 0, y: 0, z: -1 }
    });
    const unrelated = candidate(
      { ...SOURCE_WITNESS, centroid: [0, 0, 0] },
      { center: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } },
      { lineageName: 'primitive.box.face.y-min' }
    );

    const forward = resolveFaceAttachment(input([unrelated, attachedPositive]));
    const reversed = resolveFaceAttachment(
      input([attachedNegative, unrelated])
    );

    expectFramesClose(reversed, forward);
    expectFramesClose(forward, SNAPSHOT_FRAME);
    expectFrame(forward);
  });

  it('reports deletion with sketch/source names and snapshot diagnostics', () => {
    const error = capturedError(() => resolveFaceAttachment(input([])));

    expect(error.reason).toBe('deleted');
    expect(error.message).toContain('Sketch "Mounted sketch"');
    expect(error.message).toContain('source feature "Base extrusion"');
    expect(error.message).toContain('attached face was deleted');
    expect(error.message).toContain('was not used to resolve a face');
  });

  it('reports ambiguous lineage instead of depending on candidate order', () => {
    const first = candidate(SOURCE_WITNESS, {
      center: { x: 5, y: 5, z: 10 },
      normal: { x: 0, y: 0, z: 1 }
    });
    const secondWitness: FaceWitnessV1 = {
      ...SOURCE_WITNESS,
      centroid: [6_000_000, 5_000_000, 10_000_000]
    };
    const second = candidate(secondWitness, {
      center: { x: 6, y: 5, z: 10 },
      normal: { x: 0, y: 0, z: 1 }
    });

    const error = capturedError(() =>
      resolveFaceAttachment(input([first, second]))
    );
    expect(error.reason).toBe('ambiguous');
    expect(error.message).toContain('multiple compatible candidates');
  });

  it('rejects a lineage-resolved non-planar face', () => {
    const cylinder: FaceWitnessV1 = {
      surfaceType: 'cylinder',
      perimeter: 40_000_000,
      centroid: [5_000_000, 5_000_000, 10_000_000],
      analytic: {
        kind: 'cylinder',
        axis: [0, 0, 1_000_000_000],
        axisFoot: [5_000_000, 5_000_000, 0],
        radius: 5_000_000
      },
      closure: { u: 'closed', v: 'open' }
    };
    const error = capturedError(() =>
      resolveFaceAttachment(input([candidate(cylinder, null)]))
    );

    expect(error.reason).toBe('non-planar');
    expect(error.message).toContain('no longer an exact planar face');
  });

  it('rejects invalid exact planar center/normal data', () => {
    const invalidCenter = capturedError(() =>
      resolveFaceAttachment(
        input([
          candidate(SOURCE_WITNESS, {
            center: { x: Number.NaN, y: 5, z: 10 },
            normal: { x: 0, y: 0, z: 1 }
          })
        ])
      )
    );
    expect(invalidCenter.reason).toBe('invalid');

    const zeroNormal = capturedError(() =>
      resolveFaceAttachment(
        input([
          candidate(SOURCE_WITNESS, {
            center: { x: 5, y: 5, z: 10 },
            normal: { x: 0, y: 0, z: 0 }
          })
        ])
      )
    );
    expect(zeroNormal.reason).toBe('invalid');
  });

  it('never uses an exact nearby face or the stored frame as fallback', () => {
    const exactButUnnamed = candidate(
      SOURCE_WITNESS,
      {
        center: { ...SNAPSHOT.sourceCenter },
        normal: { ...SNAPSHOT.sourceNormal }
      },
      { withLineage: false }
    );
    const error = capturedError(() =>
      resolveFaceAttachment(input([exactButUnnamed]))
    );

    expect(error.reason).toBe('deleted');
    expect(error.message).toContain('lineage no longer exists');
    expect(error.message).toContain('was not used to resolve a face');
  });
});

/**
 * Continuity, swept rather than sampled.
 *
 * The defect was not a wrong value at one angle — it was a jump, and a jump is
 * only visible between neighbouring inputs. Two hand-picked angles would pass
 * against a rule that jumps somewhere else, so these walk the face all the way
 * around and assert that no single step moves the frame more than the step
 * itself could account for.
 */
describe('face attachment frame continuity', () => {
  const DEG = Math.PI / 180;

  function planeCandidate(normal: Vector3): FaceAttachmentCandidate {
    const length = vectorLength(normal);
    const unit = {
      x: normal.x / length,
      y: normal.y / length,
      z: normal.z / length
    };
    // The witness carries a sign-canonical normal, which the lineage inspector
    // requires; `plane.normal` carries the raw outward normal the kernel
    // measured, exactly as `faceAttachmentCandidatesForShape` builds them. The
    // frame is derived from the raw one, which is why it must survive that
    // normal's leading component crossing zero.
    const lead = [unit.x, unit.y, unit.z].find(
      (component) => Math.abs(component) > 1e-12
    );
    const sign = lead !== undefined && lead < 0 ? -1 : 1;
    const witness: FaceWitnessV1 = {
      ...SOURCE_WITNESS,
      analytic: {
        kind: 'plane',
        normal: [
          Math.round(unit.x * sign * 1_000_000_000),
          Math.round(unit.y * sign * 1_000_000_000),
          Math.round(unit.z * sign * 1_000_000_000)
        ],
        offset: 10_000_000
      }
    };
    return candidate(
      witness,
      { center: { x: 5, y: 5, z: 10 }, normal: unit },
      { lineageSource: 'derived' }
    );
  }

  const frameAt = (normal: Vector3): SketchPlaneFrame =>
    resolveFaceAttachment(input([planeCandidate(normal)]));

  const angleBetween = (left: Vector3, right: Vector3): number =>
    Math.acos(Math.min(1, Math.max(-1, dot(left, right)))) / DEG;

  const largestStep = (
    normalAt: (t: number) => Vector3,
    from: number,
    to: number,
    steps: number
  ): { degrees: number; at: number } => {
    let previous = frameAt(normalAt(from));
    let worst = { degrees: 0, at: from };
    for (let index = 1; index <= steps; index += 1) {
      const t = from + ((to - from) * index) / steps;
      const current = frameAt(normalAt(t));
      const moved = Math.max(
        angleBetween(current.xAxis, previous.xAxis),
        angleBetween(current.yAxis, previous.yAxis),
        angleBetween(current.zAxis, previous.zAxis)
      );
      if (moved > worst.degrees) {
        worst = { degrees: moved, at: t };
      }
      previous = current;
    }
    return worst;
  };

  it('does not jump when a tilted face turns past the world-axis tie', () => {
    // A 30-degree-tilted face rotated about Z. At 45 degrees |nx| equals |ny|,
    // and the old rule's "least aligned world axis" flipped there: measured,
    // 44.9 to 45.1 degrees rotated the sketch 81.8 degrees. The sweep steps by
    // 0.18 degrees, so anything above ~0.5 is a jump rather than the sweep.
    const tilted = (t: number): Vector3 => ({
      x: 0.5 * Math.sin(t * DEG),
      y: -0.5 * Math.cos(t * DEG),
      z: Math.cos(30 * DEG)
    });
    const worst = largestStep(tilted, 0, 360, 2000);
    expect(worst.degrees).toBeLessThan(0.5);
  });

  it('does not mirror when the normal crosses a canonicalization boundary', () => {
    // `canonicalNormal` orients by the sign of the first non-zero component,
    // so a normal whose x passes through zero used to reverse — taking yAxis
    // with it and mirroring every sketch on the face. Nothing warned.
    const crossing = (t: number): Vector3 => ({
      x: Math.sin(t * DEG),
      y: 0.6,
      z: 0.8
    });
    const worst = largestStep(crossing, 10, -10, 2000);
    expect(worst.degrees).toBeLessThan(0.5);
  });

  it('keeps the attached orientation rather than snapping to a world axis', () => {
    // The stored frame is x=+X on a +Z face. Tilting the face slightly must
    // carry that orientation along, not reset it to whichever world axis wins.
    const tilted = frameAt({ x: 0.05, y: 0, z: 1 });
    expect(angleBetween(tilted.xAxis, SNAPSHOT_FRAME.xAxis)).toBeLessThan(5);
    expect(angleBetween(tilted.zAxis, SNAPSHOT_FRAME.zAxis)).toBeLessThan(5);
    expectFrame(tilted);
  });

  it('still derives a usable frame when the seed cannot span the new plane', () => {
    // The face has turned to face along the stored xAxis, so projecting that
    // axis onto the new plane is numerical noise. The world-axis rule takes
    // over and the frame stays orthonormal and right-handed.
    const turned = frameAt({ x: 1, y: 0, z: 0 });
    expectFrame(turned);
    expect(dot(turned.zAxis, { x: 1, y: 0, z: 0 })).toBeCloseTo(1, 9);
  });
});
