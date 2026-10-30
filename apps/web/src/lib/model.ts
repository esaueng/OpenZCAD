import {
  evaluateExpression,
  isValidParameterName,
  evaluateFieldExpression,
  type FieldQuantity
} from '@openzcad/document-core';
import type {
  FeatureKind,
  ParamValue,
  PlaneId,
  UnitSystem
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
  /**
   * Set when the expression's only problem is a name nobody has defined
   * yet: the first such name, which a field can offer to define on the
   * spot. Absent for anything else that is wrong with it — a syntax error,
   * trailing tokens, a name that is not a valid parameter name.
   */
  undefinedParameter?: string;
}

/**
 * Live evaluation preview for expression inputs ("= 42" or the error).
 *
 * `quantity` types the field: with the document's units and the quantity the
 * field holds, `1 in + 25.4 mm` previews in document units and an angle in a
 * length field is refused. Without it a unit suffix is refused, as before.
 */
export function previewExpression(
  raw: string,
  scope: Record<string, number>,
  quantity?: FieldQuantity
): EvalPreview {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, text: 'required' };
  }
  try {
    const value = quantity
      ? evaluateFieldExpression(trimmed, scope, quantity)
      : evaluateExpression(trimmed, scope);
    return {
      ok: true,
      text: `= ${formatNumber(value)}`,
      value
    };
  } catch (error) {
    const undefinedParameter = undefinedParameterIn(trimmed, scope, quantity);
    return {
      ok: false,
      text: error instanceof Error ? error.message : 'invalid',
      ...(undefinedParameter ? { undefinedParameter } : {})
    };
  }
}

/**
 * Refusals of a value rather than of the expression: what a name with no
 * value yet (read as NaN below) trips once it reaches a guard. Anything else
 * (syntax, trailing tokens, a reserved name, a unit or a dimension) is wrong
 * with the expression itself.
 */
const VALUE_REFUSAL =
  /^(?:Expression did not evaluate to a finite number|require_(?:min|one_of) needs a finite|a(?:sin|cos)\(\) expects an argument between)/;

/**
 * The first undefined parameter an expression reads, when defining the names
 * it is missing is all it would take for it to parse. Decided by the
 * evaluator's own parser, never by trying sample values: the scope records
 * every valid parameter name the parse reads that it does not hold and
 * answers NaN, so `sqrt(width - 1000)` names `width` although most values of
 * it would fail. Done here rather than as a parser mode in document-core,
 * whose chunk has no room left under the bundle budget.
 */
function undefinedParameterIn(
  expression: string,
  scope: Record<string, number>,
  quantity?: FieldQuantity
): string | undefined {
  const missing: string[] = [];
  const reading = new Proxy(scope, {
    get(target, key, receiver) {
      if (
        typeof key === 'string' &&
        !Object.hasOwn(target, key) &&
        isValidParameterName(key)
      ) {
        if (!missing.includes(key)) missing.push(key);
        return Number.NaN;
      }
      return Reflect.get(target, key, receiver) as unknown;
    }
  });
  try {
    if (quantity) evaluateFieldExpression(expression, reading, quantity);
    else evaluateExpression(expression, reading);
  } catch (error) {
    if (!(error instanceof Error) || !VALUE_REFUSAL.test(error.message)) {
      return undefined;
    }
  }
  return missing[0];
}

/** Resolve a stored parametric value to a number, or null if it can't evaluate. */
export function evalParamValue(
  value: ParamValue,
  scope: Record<string, number>,
  quantity?: FieldQuantity | UnitSystem
): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  try {
    const result =
      typeof quantity === 'object'
        ? evaluateFieldExpression(value, scope, quantity)
        : evaluateExpression(value, scope, { documentUnits: quantity });
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

/**
 * One display precision for a measured area or volume, wherever the
 * workspace reads one out: the selection callout, the inspector, the body
 * statistics and the section readout. They used to disagree — 511.73 mm²
 * on the callout, 511.726 mm² in the inspector for the same face. Two
 * decimals, trailing zeros dropped; below 1 three significant digits, so a
 * small face in inches does not round to nothing. Measure keeps its own
 * precision setting and does not come through here.
 */
export function formatMeasuredQuantity(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-3)) {
    return value.toExponential(3);
  }
  if (abs < 1) {
    return String(Number(value.toPrecision(3)));
  }
  return String(Math.round(value * 100) / 100);
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
  hole: 'Hole',
  gear: 'Gear',
  shell: 'Shell',
  'solid-offset': 'Solid offset',
  draft: 'Draft',
  thicken: 'Thicken',
  fillet: 'Fillet',
  chamfer: 'Chamfer',
  pattern: 'Pattern',
  'direct-edit': 'Direct edit',
  'imported-step': 'Imported STEP',
  'imported-mesh': 'Imported mesh',
  'datum-plane': 'Datum plane',
  'datum-axis': 'Datum axis'
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

export function inferContentType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.stl')) {
    return 'model/stl';
  }
  if (lower.endsWith('.step') || lower.endsWith('.stp')) {
    return 'model/step';
  }
  // The mesh interchange formats the kernel's translators read. Registered
  // media types where one exists; PLY has none, so it keeps the generic one.
  if (lower.endsWith('.3mf')) {
    return 'model/3mf';
  }
  if (lower.endsWith('.obj')) {
    return 'model/obj';
  }
  if (lower.endsWith('.glb')) {
    return 'model/gltf-binary';
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
