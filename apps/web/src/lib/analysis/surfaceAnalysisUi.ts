import * as THREE from 'three';
import {
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

/** Per-vertex colours for one body's samples. */
export function analysisColors(
  values: Float32Array,
  request: SurfaceAnalysisRequest
): Float32Array {
  const palette = {
    positive: linear(DRAFT_COLORS.positive),
    insufficient: linear(DRAFT_COLORS.insufficient),
    negative: linear(DRAFT_COLORS.negative),
    unevaluated: linear(DRAFT_COLORS.unevaluated)
  };
  const colors = new Float32Array(values.length * 3);
  for (let index = 0; index < values.length; index += 1) {
    const rgb = palette[draftBandOf(values[index]!, request.minimumDegrees)];
    colors[index * 3] = rgb[0];
    colors[index * 3 + 1] = rgb[1];
    colors[index * 3 + 2] = rgb[2];
  }
  return colors;
}

/**
 * The overlay the viewport draws for a report, coloured against `request`:
 * the settings on screen now, which may differ from the query's only in
 * what colouring reads (the minimum draft), never in what was measured.
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
  return {
    bodies: report.bodies.map((body) => ({
      bodyId: body.bodyId,
      positions: body.positions,
      normals: body.normals,
      indices: body.indices,
      colors: analysisColors(body.values, request),
      covers: !holed.has(body.bodyId)
    }))
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
  }
}

/** What the analysis does not answer, said before anyone relies on it. */
export function analysisLimits(kind: SurfaceAnalysisKind): string {
  switch (kind) {
    case 'draft':
      return 'Not covered: whether the part can be moulded (a negative face is an undercut against this pull only, not a parting-line check), and faces the kernel cannot evaluate, shown grey and listed below.';
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
