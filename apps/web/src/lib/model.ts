import { evaluateExpression } from '@openzcad/document-core';
import type {
  FeatureKind,
  ParamValue,
  PlaneId,
  RevolveAxis
} from '@openzcad/shared';

/** Raw text shown in an editable field for a stored parametric value. */
export function paramValueText(value: ParamValue | undefined): string {
  if (value === undefined) {
    return '';
  }
  return typeof value === 'number' ? String(value) : value;
}

export interface EvalPreview {
  ok: boolean;
  text: string;
  /** The evaluated number, present exactly when `ok`. */
  value?: number;
}

/** Live evaluation preview for expression inputs ("= 42" or the error). */
export function previewExpression(
  raw: string,
  scope: Record<string, number>
): EvalPreview {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, text: 'required' };
  }
  try {
    const value = evaluateExpression(trimmed, scope);
    return {
      ok: true,
      text: `= ${formatNumber(value)}`,
      value
    };
  } catch (error) {
    return {
      ok: false,
      text: error instanceof Error ? error.message : 'invalid'
    };
  }
}

/** Resolve a stored parametric value to a number, or null if it can't evaluate. */
export function evalParamValue(
  value: ParamValue,
  scope: Record<string, number>
): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  try {
    const result = evaluateExpression(value, scope);
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-3)) {
    return value.toExponential(3);
  }
  return String(Math.round(value * 1000) / 1000);
}

export const FEATURE_KIND_LABELS: Record<FeatureKind, string> = {
  primitive: 'Primitive',
  sketch: 'Sketch',
  extrude: 'Extrude',
  revolve: 'Revolve',
  loft: 'Loft',
  sweep: 'Sweep',
  'helical-sweep': 'Helical sweep',
  boolean: 'Boolean',
  transform: 'Move / Rotate',
  mirror: 'Mirror',
  split: 'Split',
  shell: 'Shell',
  'solid-offset': 'Solid offset',
  draft: 'Draft',
  thicken: 'Thicken',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  pattern: 'Pattern',
  'direct-edit': 'Direct edit',
  'imported-step': 'Imported STEP',
  'imported-mesh': 'Imported mesh'
};

/**
 * Sketch plane names, in the Z-up terms the rest of the app already uses.
 *
 * These were Y-up and had never been swapped when the app became Z-up, so they
 * named the wrong planes: measured by extruding the same rectangle on each,
 * "Ground (XZ)" built an upright wall and "Front (XY)" built a slab lying on
 * the grid. The app already contradicted them — its Front view looks down -Y
 * and its face labels call the +Z face "Top face" — so the fix is to say what
 * the standard views and face names have been saying all along. PLANE_BASES
 * gives XY the +Z normal (horizontal, hence Top) and XZ the +Y normal
 * (vertical, hence Front).
 */
export const PLANE_LABELS: Record<PlaneId, string> = {
  XZ: 'Front (XZ)',
  XY: 'Top (XY)',
  YZ: 'Right (YZ)'
};

export const REVOLVE_AXIS_LABELS: Record<RevolveAxis, string> = {
  vertical: 'Sketch vertical axis',
  horizontal: 'Sketch horizontal axis'
};

export function inferContentType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.stl')) {
    return 'model/stl';
  }
  if (lower.endsWith('.step') || lower.endsWith('.stp')) {
    return 'model/step';
  }
  return 'application/octet-stream';
}

export function downloadText(
  name: string,
  value: string,
  contentType = 'text/plain'
): void {
  const blob = new Blob([value], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** File-safe stem derived from the project name (e.g. for exports). */
export function exportFileStem(projectName: string): string {
  const cleaned = projectName
    .trim()
    .replace(/[^a-zA-Z0-9._ -]+/g, '')
    .replace(/\s+/g, '-');
  return cleaned.length > 0 ? cleaned : 'openzcad-part';
}
