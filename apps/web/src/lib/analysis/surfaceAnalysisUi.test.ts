import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type {
  SurfaceAnalysisReport,
  SurfaceAnalysisRequest
} from '@openzcad/shared';
import {
  DRAFT_COLORS,
  analysisColors,
  analysisLimits,
  analysisOverlayFor,
  analysisProvenance,
  describeDraftSummary,
  describeUnsupported,
  draftBandOf,
  summarizeDraft
} from './surfaceAnalysisUi';
import { measuredPart } from './useSurfaceAnalysis';

const draft = (minimumDegrees = 1): SurfaceAnalysisRequest => ({
  kind: 'draft',
  pull: { x: 0, y: 0, z: 1 },
  minimumDegrees
});

function face(min: number, max: number, exact = true) {
  return {
    face: 0,
    surface: exact ? 'plane' : 'sphere',
    min,
    max,
    samples: 4,
    exact
  };
}

function report(
  faces: ReturnType<typeof face>[],
  values: number[] = []
): SurfaceAnalysisReport {
  return {
    request: draft(),
    bodies: [
      {
        bodyId: 'body_a',
        positions: new Float32Array(values.length * 3),
        normals: new Float32Array(values.length * 3),
        indices: new Uint32Array(),
        values: Float32Array.from(values),
        faces: faces.map((f, index) => ({ ...f, face: index }))
      }
    ],
    unsupported: [],
    missing: []
  };
}

function hex(rgb: ArrayLike<number>, at: number) {
  return `#${new THREE.Color(rgb[at * 3]!, rgb[at * 3 + 1]!, rgb[at * 3 + 2]!).getHexString()}`;
}

describe('draft colours (M09)', () => {
  it('colours each sample by its band, and an unevaluated one grey', () => {
    expect(draftBandOf(5, 1)).toBe('positive');
    expect(draftBandOf(-5, 1)).toBe('negative');
    expect(draftBandOf(0.5, 1)).toBe('insufficient');
    expect(draftBandOf(Number.NaN, 1)).toBe('unevaluated');
    const colors = analysisColors(
      Float32Array.from([5, -5, 0.5, Number.NaN]),
      draft()
    );
    expect([0, 1, 2, 3].map((at) => hex(colors, at))).toEqual([
      DRAFT_COLORS.positive,
      DRAFT_COLORS.negative,
      DRAFT_COLORS.insufficient,
      DRAFT_COLORS.unevaluated
    ]);
  });

  it('recolours against the minimum on screen without measuring again', () => {
    const measured = report([face(3, 3)], [3]);
    const strict = analysisOverlayFor(measured, draft(5));
    expect(hex(strict.bodies[0]!.colors, 0)).toBe(DRAFT_COLORS.insufficient);
    const loose = analysisOverlayFor(measured, draft(1));
    expect(hex(loose.bodies[0]!.colors, 0)).toBe(DRAFT_COLORS.positive);
    // The minimum is not part of what the kernel measures.
    expect(measuredPart(draft(1))).toEqual(measuredPart(draft(5)));
    expect(measuredPart(draft(1))).not.toEqual(
      measuredPart({ ...draft(1), pull: { x: 1, y: 0, z: 0 } })
    );
  });
});

describe('draft summary (M09)', () => {
  it('counts faces by verdict and exact ranges', () => {
    const summary = summarizeDraft(
      report([face(90, 90), face(-90, -90), face(0, 0), face(0, 90, false)]),
      1
    );
    expect(summary).toEqual({
      faces: { positive: 1, negative: 1, insufficient: 1, mixed: 1 },
      exactFaces: 3,
      totalFaces: 4
    });
    expect(describeDraftSummary(summary)).toBe(
      '1 face drafted away, 1 face below the minimum, 1 face crossing bands.'
    );
    expect(
      describeDraftSummary(summarizeDraft(report([face(5, 9), face(2, 3)]), 1))
    ).toBe('All 2 faces drafted toward the pull.');
  });

  it('says where the numbers come from and what they do not cover', () => {
    expect(analysisProvenance('draft')).toMatch(
      /^Exact draft from the kernel at sample points/
    );
    expect(analysisProvenance('draft')).toMatch(/a plane’s draft is exact/);
    expect(analysisLimits('draft')).toMatch(/not a parting-line check/);
  });

  it('names every refused face and body', () => {
    const names = (id: string) => (id === 'body_a' ? 'Bracket' : 'Other');
    expect(
      describeUnsupported(
        [
          {
            bodyId: 'body_a',
            face: 2,
            reason: 'kernel-refused',
            message: 'Undefined normal.'
          },
          {
            bodyId: 'body_b',
            face: null,
            reason: 'too-many-samples',
            message: 'Too many samples'
          },
          {
            bodyId: 'body_a',
            face: 0,
            reason: 'partly-evaluated',
            message: '3 of 40 samples could not be evaluated: apex'
          }
        ],
        names
      )
    ).toEqual([
      'Bracket, face 3: not analysed (Undefined normal).',
      'Other: not analysed (Too many samples).',
      'Bracket, face 1: partly evaluated (3 of 40 samples could not be evaluated: apex).'
    ]);
  });
});
