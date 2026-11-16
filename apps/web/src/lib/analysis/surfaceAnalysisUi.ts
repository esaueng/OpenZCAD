import * as THREE from 'three';
import {
  type CurvatureMeasure,
  draftBand,
  draftVerdict,
  type DraftFaceVerdict,
  type SurfaceAnalysisKind,
  type SurfaceAnalysisReport,
  type SurfaceAnalysisRequest,
  type SurfaceAnalysisUnsupported
} from '@openzcad/shared';
import type { AnalysisOverlayDisplay } from '@openzcad/viewport/analysis-overlay';
import { formatNumber } from '../model';

/**
 * M09 analysis overlays, in words and colours. Every overlay says where its
 * numbers come from (the exact kernel, evaluated at samples) and what it
 * does not cover, next to the legend that reads it.
 */

export { ANALYSIS_LABELS } from './analysisRuntime';

/** Legend bands, in sRGB hex; the overlay uses the same values. */
export const DRAFT_COLORS: Record<
  'positive' | 'insufficient' | 'negative' | 'unevaluated',
  string
> = {
  positive: '#2f9e5c',
  insufficient: '#e2b100',
  negative: '#d64545',
  unevaluated: '#8f8f8f'
};

/** The colour band a draft sample falls in; NaN was never evaluated. */
export function draftBandOf(
  value: number,
  minimumDegrees: number
): keyof typeof DRAFT_COLORS {
  if (!Number.isFinite(value)) return 'unevaluated';
  return draftBand(value, minimumDegrees);
}

function linear(hex: string): [number, number, number] {
  const color = new THREE.Color(hex);
  return [color.r, color.g, color.b];
}

/**
 * Curvature map stops, sRGB: concave blue through neutral grey to convex
 * red for the signed measures; neutral through amber to red for the
 * maximum, which has no sign.
 */
export const CURVATURE_COLORS = {
  concave: '#2f6fd6',
  flat: '#d4d4d4',
  tight: '#e2862f',
  convex: '#d64545',
  unevaluated: '#8f8f8f'
} as const;

/** Zebra stripes are untinted; an unevaluated sample is drawn grey. */
const ZEBRA_EVALUATED = '#ffffff';

function mix(
  a: readonly number[],
  b: readonly number[],
  t: number
): [number, number, number] {
  return [
    a[0]! + (b[0]! - a[0]!) * t,
    a[1]! + (b[1]! - a[1]!) * t,
    a[2]! + (b[2]! - a[2]!) * t
  ];
}

/**
 * The magnitude a curvature map spans: the largest |value| over every
 * evaluated sample of every body, so one scale reads across bodies. Zero
 * when every face is flat (the map is then all neutral).
 */
export function curvatureScale(report: SurfaceAnalysisReport): number {
  let scale = 0;
  for (const body of report.bodies) {
    for (const value of body.values) {
      if (Number.isFinite(value)) scale = Math.max(scale, Math.abs(value));
    }
  }
  return scale;
}

/** The colour of one curvature value on a map spanning ±scale. */
export function curvatureColor(
  value: number,
  scale: number,
  signed: boolean
): [number, number, number] {
  if (!Number.isFinite(value)) return linear(CURVATURE_COLORS.unevaluated);
  const flat = linear(CURVATURE_COLORS.flat);
  if (!(scale > 0)) return flat;
  const t = Math.max(-1, Math.min(1, value / scale));
  if (!signed) {
    const magnitude = Math.abs(t);
    return magnitude <= 0.5
      ? mix(flat, linear(CURVATURE_COLORS.tight), magnitude * 2)
      : mix(
          linear(CURVATURE_COLORS.tight),
          linear(CURVATURE_COLORS.convex),
          (magnitude - 0.5) * 2
        );
  }
  return t >= 0
    ? mix(flat, linear(CURVATURE_COLORS.convex), t)
    : mix(flat, linear(CURVATURE_COLORS.concave), -t);
}

/**
 * Per-vertex colours for one body's samples. `scale` is the curvature
 * map's span (ignored by the other kinds).
 */
export function analysisColors(
  values: Float32Array,
  request: SurfaceAnalysisRequest,
  scale = 0
): Float32Array {
  const colors = new Float32Array(values.length * 3);
  const put = (index: number, rgb: readonly number[]) => {
    colors[index * 3] = rgb[0]!;
    colors[index * 3 + 1] = rgb[1]!;
    colors[index * 3 + 2] = rgb[2]!;
  };
  if (request.kind === 'draft') {
    const palette = {
      positive: linear(DRAFT_COLORS.positive),
      insufficient: linear(DRAFT_COLORS.insufficient),
      negative: linear(DRAFT_COLORS.negative),
      unevaluated: linear(DRAFT_COLORS.unevaluated)
    };
    for (let index = 0; index < values.length; index += 1)
      put(index, palette[draftBandOf(values[index]!, request.minimumDegrees)]);
    return colors;
  }
  if (request.kind === 'curvature') {
    const signed = request.measure !== 'maximum';
    for (let index = 0; index < values.length; index += 1)
      put(index, curvatureColor(values[index]!, scale, signed));
    return colors;
  }
  const evaluated = linear(ZEBRA_EVALUATED);
  const grey = linear(CURVATURE_COLORS.unevaluated);
  for (let index = 0; index < values.length; index += 1)
    put(index, Number.isFinite(values[index]!) ? evaluated : grey);
  return colors;
}

/**
 * The overlay the viewport draws for a report, coloured against `request`:
 * the settings on screen now, which may differ from the query's only in
 * what colouring reads (draft's minimum, zebra's stripe count), never in
 * what was measured.
 */
export function analysisOverlayFor(
  report: SurfaceAnalysisReport,
  request: SurfaceAnalysisRequest
): AnalysisOverlayDisplay {
  // A face the kernel could not mesh leaves a hole in the overlay: that
  // body keeps its own faces drawn under it.
  const holed = new Set(
    report.unsupported
      .filter((entry) => entry.reason === 'not-tessellated')
      .map((entry) => entry.bodyId)
  );
  const scale = request.kind === 'curvature' ? curvatureScale(report) : 0;
  return {
    bodies: report.bodies.map((body) => ({
      bodyId: body.bodyId,
      positions: body.positions,
      normals: body.normals,
      indices: body.indices,
      colors: analysisColors(body.values, request, scale),
      covers: !holed.has(body.bodyId)
    })),
    shading:
      request.kind === 'zebra'
        ? { kind: 'zebra', stripes: request.stripes }
        : { kind: 'colors' }
  };
}

export const DRAFT_VERDICT_LABELS: Record<DraftFaceVerdict, string> = {
  positive: 'Drafted toward the pull',
  negative: 'Drafted away (undercut)',
  insufficient: 'Below the minimum',
  mixed: 'Crosses bands'
};

export interface DraftSummary {
  faces: Record<DraftFaceVerdict, number>;
  /** Faces whose range is exact (planes), of those counted. */
  exactFaces: number;
  totalFaces: number;
}

export function summarizeDraft(
  report: SurfaceAnalysisReport,
  minimumDegrees: number
): DraftSummary {
  const faces: Record<DraftFaceVerdict, number> = {
    positive: 0,
    negative: 0,
    insufficient: 0,
    mixed: 0
  };
  let exactFaces = 0;
  let totalFaces = 0;
  for (const body of report.bodies) {
    for (const face of body.faces) {
      totalFaces += 1;
      if (face.exact) exactFaces += 1;
      faces[draftVerdict(face.min, face.max, minimumDegrees)] += 1;
    }
  }
  return { faces, exactFaces, totalFaces };
}

/** Where the numbers come from, for the panel's provenance note. */
export function analysisProvenance(kind: SurfaceAnalysisKind): string {
  switch (kind) {
    case 'draft':
      return 'Exact draft from the kernel at sample points on each face’s own surface, against the pull direction. Colours between samples are interpolated: a plane’s draft is exact, a curved face’s range is its sampled range.';
    case 'curvature':
      return 'Exact principal curvatures from the kernel at sample points on each face’s own surface. Colours between samples are interpolated: planes, cylinders and spheres are exact (constant), cones, tori and freeform faces are sampled. The smallest radius is the kernel’s over the whole face: closed-form on analytic faces, approximate on freeform ones.';
    case 'zebra':
      return 'Stripes reflected from the kernel’s exact outward normals at sample points on each face’s own surface; between samples the normals, and so the stripes, are interpolated by the display.';
  }
}

/** What the analysis does not answer, said before anyone relies on it. */
export function analysisLimits(kind: SurfaceAnalysisKind): string {
  switch (kind) {
    case 'draft':
      return 'Not covered: whether the part can be moulded (a negative face is an undercut against this pull only, not a parting-line check), and faces the kernel cannot evaluate, shown grey and listed below.';
    case 'curvature':
      return 'Not covered: curvature along edges and at points where it is undefined (a cone’s apex, a freeform pole), which are left grey; the colour scale spans the largest value found, so one tight face mutes the rest.';
    case 'zebra':
      return 'Not covered: a certified continuity check. Stripes that run on smoothly across an edge suggest tangency (G1) and matching bends suggest curvature continuity (G2), read by eye at the sample density; faces the kernel cannot evaluate are grey.';
  }
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** One line per refused face or body, named. */
export function describeUnsupported(
  entries: readonly SurfaceAnalysisUnsupported[],
  nameOf: (bodyId: string) => string
): string[] {
  return entries.map((entry) => {
    const where =
      entry.face === null
        ? nameOf(entry.bodyId)
        : `${nameOf(entry.bodyId)}, face ${entry.face + 1}`;
    const reason = entry.message.replace(/[.\s]+$/, '');
    return entry.reason === 'partly-evaluated'
      ? `${where}: partly evaluated (${reason}).`
      : `${where}: not analysed (${reason}).`;
  });
}

/** The panel's one-line result. */
export function describeDraftSummary(summary: DraftSummary): string {
  if (summary.totalFaces === 0) return 'No faces analysed.';
  const parts = [
    summary.faces.negative > 0
      ? `${plural(summary.faces.negative, 'face')} drafted away`
      : '',
    summary.faces.insufficient > 0
      ? `${plural(summary.faces.insufficient, 'face')} below the minimum`
      : '',
    summary.faces.mixed > 0
      ? `${plural(summary.faces.mixed, 'face')} crossing bands`
      : ''
  ].filter(Boolean);
  return parts.length === 0
    ? `All ${plural(summary.totalFaces, 'face')} drafted toward the pull.`
    : `${parts.join(', ')}.`;
}

export function formatDegrees(value: number): string {
  return `${formatNumber(value)}°`;
}

/** Curvature units for a measure: 1/length, or 1/length² for Gaussian. */
export function curvatureUnit(
  measure: CurvatureMeasure,
  lengthUnit: string
): string {
  return measure === 'gaussian' ? `1/${lengthUnit}²` : `1/${lengthUnit}`;
}

export const CURVATURE_MEASURE_LABELS: Record<CurvatureMeasure, string> = {
  gaussian: 'Gaussian',
  mean: 'Mean',
  maximum: 'Maximum'
};

export interface CurvatureSummary {
  /** The value range over every evaluated sample. */
  min: number;
  max: number;
  /** The tightest face radius, where the kernel states one. */
  tightest: {
    radius: number;
    exact: boolean;
    bodyId: string;
    face: number;
  } | null;
  exactFaces: number;
  totalFaces: number;
}

export function summarizeCurvature(
  report: SurfaceAnalysisReport
): CurvatureSummary {
  let min = Infinity;
  let max = -Infinity;
  let tightest: CurvatureSummary['tightest'] = null;
  let exactFaces = 0;
  let totalFaces = 0;
  for (const body of report.bodies) {
    for (const face of body.faces) {
      totalFaces += 1;
      if (face.exact) exactFaces += 1;
      min = Math.min(min, face.min);
      max = Math.max(max, face.max);
      if (
        typeof face.minRadius === 'number' &&
        (tightest === null || face.minRadius < tightest.radius)
      ) {
        tightest = {
          radius: face.minRadius,
          exact: face.minRadiusExact === true,
          bodyId: body.bodyId,
          face: face.face
        };
      }
    }
  }
  return { min, max, tightest, exactFaces, totalFaces };
}

export function describeCurvatureSummary(
  summary: CurvatureSummary,
  lengthUnit: string,
  nameOf: (bodyId: string) => string
): string {
  if (summary.totalFaces === 0) return 'No faces analysed.';
  if (!summary.tightest) return 'Every analysed face is flat.';
  const { radius, exact, bodyId, face } = summary.tightest;
  return `Tightest radius ${formatNumber(radius)} ${lengthUnit} (${
    exact ? 'exact' : 'approximate'
  }) on ${nameOf(bodyId)}, face ${face + 1}.`;
}

export function describeZebraSummary(report: SurfaceAnalysisReport): string {
  let samples = 0;
  let faces = 0;
  for (const body of report.bodies) {
    faces += body.faces.length;
    for (const face of body.faces) samples += face.samples;
  }
  if (faces === 0) return 'No faces analysed.';
  return `${samples.toLocaleString('en-US')} exact ${
    samples === 1 ? 'normal' : 'normals'
  } on ${plural(faces, 'face')}.`;
}

export function formatCurvature(value: number): string {
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  return magnitude >= 0.001 && magnitude < 1000
    ? String(Number(value.toPrecision(3)))
    : value.toExponential(2);
}
