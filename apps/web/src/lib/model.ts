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
    return {
      ok: true,
      text: `= ${formatNumber(evaluateExpression(trimmed, scope))}`
    };
  } catch (error) {
    return {
      ok: false,
      text: error instanceof Error ? error.message : 'invalid'
    };
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
  boolean: 'Boolean',
  transform: 'Move / Rotate',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  pattern: 'Pattern',
  'imported-step': 'Imported STEP',
  'imported-mesh': 'Imported mesh'
};

export const PLANE_LABELS: Record<PlaneId, string> = {
  XZ: 'Ground (XZ)',
  XY: 'Front (XY)',
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

export function downloadText(name: string, value: string): void {
  const blob = new Blob([value], { type: 'text/plain' });
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
