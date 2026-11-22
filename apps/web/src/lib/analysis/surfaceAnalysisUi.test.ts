import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type {
  DraftAnalysisRequest,
  SurfaceAnalysisReport
} from '@openzcad/shared';
import {
  THICKNESS_COLORS,
  describeThicknessSummary,
  summarizeThickness,
  thicknessBandOf,
  CURVATURE_COLORS,
  curvatureColor,
  curvatureScale,
  curvatureUnit,
  describeCurvatureSummary,
  describeZebraSummary,
  formatCurvature,
  summarizeCurvature,
  DRAFT_COLORS,
  analysisColors,
  analysisOverlayFor,
  analysisNotes,
  describeDraftSummary,
  describeUnsupported,
  draftBandOf,
  summarizeDraft
} from './surfaceAnalysisUi';
import { measuredPart } from './useSurfaceAnalysis';

const draft = (minimumDegrees = 1): DraftAnalysisRequest => ({
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
    expect(strict.bodies[0]!.covers).toBe(true);
    const holed = analysisOverlayFor(
      {
        ...measured,
        unsupported: [
          {
            bodyId: 'body_a',
            face: 0,
            reason: 'not-tessellated',
            message: 'No mesh'
          }
        ]
      },
      draft(1)
    );
    expect(holed.bodies[0]!.covers).toBe(false);
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
    const notes = analysisNotes('draft');
    expect(notes[0]).toMatch(/^Exact at sample points/);
    expect(notes.join(' ')).toMatch(/not a parting-line check/);
    // Short lines only: the panel keeps its text minimal.
    for (const kind of ['draft', 'curvature', 'zebra', 'thickness'] as const)
      for (const note of analysisNotes(kind))
        expect(note.length).toBeLessThanOrEqual(64);
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

describe('curvature colours and summary (M09)', () => {
  const curvatureReport = (): SurfaceAnalysisReport => ({
    request: { kind: 'curvature', measure: 'mean' },
    bodies: [
      {
        bodyId: 'body_a',
        positions: new Float32Array(9),
        normals: new Float32Array(9),
        indices: new Uint32Array([0, 1, 2]),
        values: Float32Array.from([-0.25, 0, 0.5]),
        faces: [
          {
            face: 0,
            surface: 'cylinder',
            min: -0.25,
            max: -0.25,
            samples: 1,
            exact: true,
            minRadius: 2,
            minRadiusExact: true
          },
          {
            face: 1,
            surface: 'plane',
            min: 0,
            max: 0,
            samples: 1,
            exact: true,
            minRadius: null,
            minRadiusExact: true
          },
          {
            face: 2,
            surface: 'bspline',
            min: 0.5,
            max: 0.5,
            samples: 1,
            exact: false,
            minRadius: 1.5,
            minRadiusExact: false
          }
        ]
      }
    ],
    unsupported: [],
    missing: []
  });

  it('spans one signed scale across bodies, concave blue to convex red', () => {
    const report = curvatureReport();
    expect(curvatureScale(report)).toBe(0.5);
    const overlay = analysisOverlayFor(report, report.request);
    expect(overlay.shading).toEqual({ kind: 'colors' });
    const colors = overlay.bodies[0]!.colors;
    expect(hex(colors, 1)).toBe(CURVATURE_COLORS.flat);
    expect(hex(colors, 2)).toBe(CURVATURE_COLORS.convex);
    // Half the scale toward concave: between flat and blue.
    const half = curvatureColor(-0.25, 0.5, true);
    const blue = curvatureColor(-0.5, 0.5, true);
    expect(`#${new THREE.Color(...blue).getHexString()}`).toBe(
      CURVATURE_COLORS.concave
    );
    expect(half[2]).toBeGreaterThan(half[0]);
    // Unsigned: the tightest end is red, the middle amber.
    expect(
      `#${new THREE.Color(...curvatureColor(0.25, 0.5, false)).getHexString()}`
    ).toBe(CURVATURE_COLORS.tight);
    // An all-flat model is neutral rather than divided by zero.
    expect(
      `#${new THREE.Color(...curvatureColor(0, 0, true)).getHexString()}`
    ).toBe(CURVATURE_COLORS.flat);
    expect(
      `#${new THREE.Color(...curvatureColor(Number.NaN, 1, true)).getHexString()}`
    ).toBe(CURVATURE_COLORS.unevaluated);
  });

  it('names the tightest radius, exact or approximate, and the units', () => {
    const summary = summarizeCurvature(curvatureReport());
    expect(summary).toMatchObject({
      min: -0.25,
      max: 0.5,
      exactFaces: 2,
      totalFaces: 3
    });
    expect(describeCurvatureSummary(summary, 'mm', () => 'Bracket')).toBe(
      'Tightest radius 1.5 mm (approximate) on Bracket, face 3.'
    );
    expect(curvatureUnit('mean', 'mm')).toBe('1/mm');
    expect(curvatureUnit('gaussian', 'in')).toBe('1/in²');
    expect(formatCurvature(0.08333333)).toBe('0.0833');
    expect(formatCurvature(-0.00001234)).toBe('-1.23e-5');
  });
});

describe('zebra overlay (M09)', () => {
  it('draws stripes from the exact normals, grey where none was evaluated', () => {
    const report: SurfaceAnalysisReport = {
      request: { kind: 'zebra', stripes: 12 },
      bodies: [
        {
          bodyId: 'body_a',
          positions: new Float32Array(6),
          normals: new Float32Array(6),
          indices: new Uint32Array(),
          values: Float32Array.from([0, Number.NaN]),
          faces: [
            {
              face: 0,
              surface: 'sphere',
              min: 0,
              max: 0,
              samples: 1,
              exact: true
            }
          ]
        }
      ],
      unsupported: [],
      missing: []
    };
    const overlay = analysisOverlayFor(report, { kind: 'zebra', stripes: 20 });
    // The stripe count is drawing, not measuring: no new query for it.
    expect(overlay.shading).toEqual({ kind: 'zebra', stripes: 20 });
    expect(measuredPart({ kind: 'zebra', stripes: 4 })).toEqual(
      measuredPart({ kind: 'zebra', stripes: 20 })
    );
    expect(hex(overlay.bodies[0]!.colors, 0)).toBe('#ffffff');
    expect(hex(overlay.bodies[0]!.colors, 1)).toBe(
      CURVATURE_COLORS.unevaluated
    );
    expect(describeZebraSummary(report)).toBe('1 exact normal on 1 face.');
    expect(analysisNotes('zebra').join(' ')).toMatch(
      /read by eye, not certified/
    );
  });
});

describe('thickness colours and summary (M09)', () => {
  const thicknessReport = (): SurfaceAnalysisReport => ({
    request: { kind: 'thickness', minimum: 1 },
    bodies: [
      {
        bodyId: 'body_a',
        positions: new Float32Array(12),
        normals: new Float32Array(12),
        indices: new Uint32Array([0, 1, 2, 3]),
        values: Float32Array.from([0.8, 1.5, 3, Number.NaN]),
        faces: [
          {
            face: 0,
            surface: 'plane',
            min: 2,
            max: 2,
            samples: 4,
            exact: true
          },
          {
            face: 1,
            surface: 'cylinder',
            min: 0.8,
            max: 1.5,
            samples: 9,
            exact: false
          },
          { face: 2, surface: 'plane', min: 3, max: 3, samples: 4, exact: true }
        ],
        resolution: 0.004
      }
    ],
    unsupported: [],
    missing: []
  });

  it('bands each sample against the minimum, recoloured without measuring', () => {
    expect(thicknessBandOf(0.8, 1)).toBe('thin');
    expect(thicknessBandOf(1.5, 1)).toBe('marginal');
    expect(thicknessBandOf(2, 1)).toBe('ample');
    expect(thicknessBandOf(Number.NaN, 1)).toBe('unevaluated');
    const report = thicknessReport();
    const colors = analysisOverlayFor(report, { kind: 'thickness', minimum: 1 })
      .bodies[0]!.colors;
    expect([0, 1, 2, 3].map((at) => hex(colors, at))).toEqual([
      THICKNESS_COLORS.thin,
      THICKNESS_COLORS.marginal,
      THICKNESS_COLORS.ample,
      THICKNESS_COLORS.unevaluated
    ]);
    // A stricter minimum: the 1.5 wall is thin now. Nothing re-measured.
    const strict = analysisOverlayFor(report, { kind: 'thickness', minimum: 2 })
      .bodies[0]!.colors;
    expect(hex(strict, 1)).toBe(THICKNESS_COLORS.thin);
    expect(measuredPart({ kind: 'thickness', minimum: 1 })).toEqual(
      measuredPart({ kind: 'thickness', minimum: 2 })
    );
  });

  it('names the thinnest wall, approximate or exact, and what is below the minimum', () => {
    const summary = summarizeThickness(thicknessReport(), 1);
    expect(summary).toMatchObject({
      belowMinimum: 1,
      faces: { thin: 1, marginal: 0, ample: 2 },
      exactFaces: 2,
      totalFaces: 3,
      resolution: 0.004
    });
    expect(describeThicknessSummary(summary, 1, 'mm', () => 'Bracket')).toBe(
      'Thinnest wall 0.8 mm (approximate) on Bracket, face 2. 1 face below the 1 mm minimum.'
    );
    expect(
      describeThicknessSummary(
        summarizeThickness(thicknessReport(), 0.5),
        0.5,
        'mm',
        () => 'Bracket'
      )
    ).toMatch(/Every face at least 0.5 mm\.$/);
    expect(analysisNotes('thickness')[0]).toMatch(/^Approximate: /);
    expect(analysisNotes('thickness').join(' ')).toMatch(
      /not a slicer’s or a simulation’s check/
    );
  });
});

describe('analysis defaults (M09)', () => {
  it('states the default minimum wall as 1 mm in the document units', async () => {
    const { defaultThicknessMinimum } = await import('./analysisRuntime');
    expect(defaultThicknessMinimum('mm')).toBe(1);
    expect(defaultThicknessMinimum('cm')).toBe(0.1);
    expect(defaultThicknessMinimum('inch')).toBe(0.039);
  });
});
