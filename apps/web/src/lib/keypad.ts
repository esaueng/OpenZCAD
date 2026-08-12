import { evaluateExpression } from '@openzcad/document-core';
import { UNIT_TO_MM, type UnitSystem } from '@openzcad/shared';

/**
 * Pure math for the floating numeric keypad: on-screen placement and value
 * evaluation. Kept free of React/DOM so it is unit-testable.
 */

export interface KeypadPoint {
  x: number;
  y: number;
}

export interface KeypadSize {
  width: number;
  height: number;
}

export interface KeypadPlacement {
  x: number;
  y: number;
  /** Which side of the anchor the keypad settled on. */
  side: 'below' | 'above';
}

const ANCHOR_GAP = 14;
const VIEWPORT_MARGIN = 8;

/**
 * Places the keypad near its 3D anchor without leaving the viewport:
 * preferred position is centered below the anchor; it flips above when the
 * bottom would clip, and clamps horizontally.
 */
export function keypadClampPosition(
  anchor: KeypadPoint,
  size: KeypadSize,
  viewport: KeypadSize
): KeypadPlacement {
  const x = Math.min(
    Math.max(anchor.x - size.width / 2, VIEWPORT_MARGIN),
    Math.max(viewport.width - size.width - VIEWPORT_MARGIN, VIEWPORT_MARGIN)
  );
  const below = anchor.y + ANCHOR_GAP;
  if (below + size.height + VIEWPORT_MARGIN <= viewport.height) {
    return { x, y: below, side: 'below' };
  }
  const above = anchor.y - ANCHOR_GAP - size.height;
  return {
    x,
    y: Math.max(above, VIEWPORT_MARGIN),
    side: 'above'
  };
}

export type KeypadUnit = 'mm' | 'cm' | 'm' | 'deg';
export type DimensionMode = 'diameter' | 'radius';

export interface KeypadEvaluation {
  ok: boolean;
  /** Value converted into document units and normalized to radius when radial. */
  value?: number;
  /** Evaluated display value before radial normalization. */
  displayValue?: number;
  /** Expression/plain value normalized for the document commit path. */
  normalizedRaw?: string;
  /** True when the input is an expression rather than a plain number. */
  isExpression: boolean;
  error?: string;
}

/**
 * Evaluates keypad input. Plain numbers are interpreted in the selected entry
 * unit and converted into document units; expressions evaluate against the
 * parameter scope and are taken to already be in document units (parameters
 * are document-unit values, so scaling them would double-convert).
 */
export function evaluateKeypadInput(
  raw: string,
  entryUnit: KeypadUnit,
  documentUnits: UnitSystem,
  scope: Record<string, number>,
  dimensionMode?: DimensionMode
): KeypadEvaluation {
  const explicitMode = dimensionModeForInput(raw);
  const effectiveMode = explicitMode ?? dimensionMode;
  const trimmed = raw
    .trim()
    .replace(/^(?:Ø|⌀|R)\s*/iu, '')
    .trim();
  if (trimmed.length === 0) {
    return { ok: false, isExpression: false, error: 'required' };
  }
  const normalize = (displayValue: number, isExpression: boolean) => {
    const value =
      effectiveMode === 'diameter' ? displayValue / 2 : displayValue;
    return {
      ok: true,
      value,
      displayValue,
      normalizedRaw: isExpression
        ? effectiveMode === 'diameter'
          ? `(${trimmed}) / 2`
          : trimmed
        : String(value),
      isExpression
    } satisfies KeypadEvaluation;
  };
  const plainNumber = Number(trimmed);
  if (Number.isFinite(plainNumber)) {
    if (entryUnit === 'deg') {
      return normalize(plainNumber, false);
    }
    const factor = UNIT_TO_MM[entryUnit] / UNIT_TO_MM[documentUnits];
    return normalize(plainNumber * factor, false);
  }
  try {
    const value = evaluateExpression(trimmed, scope);
    if (!Number.isFinite(value)) {
      return { ok: false, isExpression: true, error: 'not finite' };
    }
    return normalize(value, true);
  } catch (error) {
    return {
      ok: false,
      isExpression: true,
      error: error instanceof Error ? error.message : 'invalid expression'
    };
  }
}

/** Explicit Ø/R typed into the field wins over the current keypad mode. */
export function dimensionModeForInput(raw: string): DimensionMode | undefined {
  const prefix = raw
    .trim()
    .match(/^(Ø|⌀|R)\s*/iu)?.[1]
    ?.toUpperCase();
  return prefix === 'R' ? 'radius' : prefix ? 'diameter' : undefined;
}

/** Switch entry notation without changing the radius the field represents. */
export function convertDimensionInput(
  raw: string,
  from: DimensionMode,
  to: DimensionMode
): string {
  const value = raw
    .trim()
    .replace(/^(?:Ø|⌀|R)\s*/iu, '')
    .trim();
  if (!value || from === to) {
    return value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return String(to === 'diameter' ? numeric * 2 : numeric / 2);
  }
  return to === 'diameter' ? `2 * (${value})` : `(${value}) / 2`;
}

/** Keys the on-screen pad may append to the value field. */
export function appendKeypadKey(current: string, key: string): string {
  if (key === '⌫') {
    return current.slice(0, -1);
  }
  if (key === '±') {
    return current.startsWith('-') ? current.slice(1) : `-${current}`;
  }
  return current + key;
}
