import { evaluateFieldExpression } from '@openzcad/document-core';
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
 * A docked panel the keypad must clear.
 *
 * Modelled as a full-height band rather than a rectangle, because that is what
 * the panels covering the viewport are: the inspector and the tool palette
 * both run the height of the viewer, so their vertical extent never decides
 * anything.
 */
export interface KeypadExclusion {
  /** Host-relative left edge of the band. */
  x: number;
  width: number;
}

/**
 * The widest gap the excluded bands leave that can hold the keypad. The gaps
 * are what no band covers: the bands are merged first, so neither a band's
 * own interior nor the overlap of two bands (the right lane's inspector and
 * the panel under it share their whole width) ever reads as free room.
 */
function horizontalRange(
  size: KeypadSize,
  viewport: KeypadSize,
  exclusions: readonly KeypadExclusion[]
): { min: number; max: number } {
  const full = {
    min: VIEWPORT_MARGIN,
    max: Math.max(
      viewport.width - size.width - VIEWPORT_MARGIN,
      VIEWPORT_MARGIN
    )
  };
  const bands = exclusions
    .filter((band) => band.width > 0)
    .map((band) => ({ start: band.x, end: band.x + band.width }))
    .sort((a, b) => a.start - b.start);
  const gaps: Array<{ start: number; end: number }> = [];
  let free = 0;
  for (const band of bands) {
    if (band.start > free) {
      gaps.push({ start: free, end: band.start });
    }
    free = Math.max(free, band.end);
  }
  gaps.push({ start: free, end: viewport.width });
  let best = full;
  let bestWidth = -1;
  for (const gap of gaps) {
    const gapStart = Math.max(gap.start, 0) + VIEWPORT_MARGIN;
    const gapEnd = Math.min(gap.end, viewport.width) - VIEWPORT_MARGIN;
    const usable = gapEnd - gapStart;
    // A gap that cannot hold the keypad is not a placement, it is a squeeze.
    if (usable >= size.width && usable > bestWidth) {
      bestWidth = usable;
      best = { min: gapStart, max: gapEnd - size.width };
    }
  }
  return best;
}

/**
 * Places the keypad near its 3D anchor without leaving the viewport or hiding
 * under a docked panel: preferred position is centered below the anchor; it
 * flips above when the bottom would clip, and clamps horizontally into the
 * widest gap the panels leave. When nothing fits, it clamps to the viewport
 * rather than pushing itself off-screen — overlapping a panel is recoverable,
 * being outside the window is not.
 */
export function keypadClampPosition(
  anchor: KeypadPoint,
  size: KeypadSize,
  viewport: KeypadSize,
  exclusions: readonly KeypadExclusion[] = []
): KeypadPlacement {
  const range = horizontalRange(size, viewport, exclusions);
  const x = Math.min(
    Math.max(anchor.x - size.width / 2, range.min),
    Math.max(range.max, range.min)
  );
  const below = anchor.y + ANCHOR_GAP;
  if (below + size.height + VIEWPORT_MARGIN <= viewport.height) {
    return { x, y: below, side: 'below' };
  }
  const above = anchor.y - ANCHOR_GAP - size.height;
  return {
    x,
    y: Math.min(
      Math.max(above, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, viewport.height - size.height - VIEWPORT_MARGIN)
    ),
    side: 'above'
  };
}

/** Every document unit, plus the one angles use. */
/** `count` is a plain whole-number entry: no conversion, no units allowed. */
export type KeypadUnit = UnitSystem | 'deg' | 'count';

/**
 * Units a value may name for itself, e.g. `25 mm` or `1 in`.
 *
 * A typed suffix beats the selected chip, which is the point: the chips cover
 * the document's own units, and this is how a value in some other unit gets
 * entered without changing them.
 */
const TYPED_UNITS: Record<string, UnitSystem> = {
  mm: 'mm',
  millimeter: 'mm',
  millimetre: 'mm',
  cm: 'cm',
  centimeter: 'cm',
  centimetre: 'cm',
  m: 'm',
  meter: 'm',
  metre: 'm',
  in: 'inch',
  inch: 'inch',
  '"': 'inch',
  '″': 'inch'
};

export interface TypedUnitValue {
  value: number;
  unit: UnitSystem;
}

/**
 * Splits a plain number from a unit it names for itself. Returns undefined for
 * anything that is not exactly `<number><unit>` — an expression that merely
 * mentions a parameter called `m` must reach the expression evaluator intact.
 */
export function typedUnitValue(raw: string): TypedUnitValue | undefined {
  const match = raw
    .trim()
    .match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z]+|"|″)$/iu);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  const suffix = match[2] ?? '';
  const unit =
    TYPED_UNITS[suffix.toLowerCase()] ??
    // Plural spellings are common enough to be worth accepting.
    TYPED_UNITS[suffix.toLowerCase().replace(/e?s$/u, '')];
  if (unit === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return { value, unit };
}
export type DimensionMode = 'diameter' | 'radius';

const DIMENSION_PREFIX = /^(Ø|⌀|R(?=$|[\s\d.(+-]))\s*/iu;

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
  /** Unit the value named for itself, when it did not use the entry chip. */
  typedUnit?: UnitSystem;
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
  // A count has no radial notation: Ø or R is not stripped (and halved),
  // so it reads as the invalid input it is.
  const count = entryUnit === 'count';
  const explicitMode = count ? undefined : dimensionModeForInput(raw, scope);
  const effectiveMode = count ? undefined : (explicitMode ?? dimensionMode);
  const trimmed = count ? raw.trim() : stripDimensionPrefix(raw, scope);
  if (trimmed.length === 0) {
    return { ok: false, isExpression: false, error: 'required' };
  }
  const normalize = (
    displayValue: number,
    isExpression: boolean,
    typedUnit?: UnitSystem
  ) => {
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
      isExpression,
      ...(typedUnit ? { typedUnit } : {})
    } satisfies KeypadEvaluation;
  };
  const plainNumber = Number(trimmed);
  if (Number.isFinite(plainNumber)) {
    if (entryUnit === 'deg' || entryUnit === 'count') {
      return normalize(plainNumber, false);
    }
    const factor = UNIT_TO_MM[entryUnit] / UNIT_TO_MM[documentUnits];
    return normalize(plainNumber * factor, false);
  }
  // A unit typed into the field wins over the selected chip. Angles have one
  // unit, so a suffix there would only ever contradict it.
  const typed =
    entryUnit === 'deg' || entryUnit === 'count'
      ? undefined
      : typedUnitValue(trimmed);
  if (typed) {
    const factor = UNIT_TO_MM[typed.unit] / UNIT_TO_MM[documentUnits];
    return normalize(typed.value * factor, false, typed.unit);
  }
  try {
    // Unit-suffixed quantities convert into document units here, exactly as
    // the parameter table does; bare scope values already are document units.
    // A length in an angle field (or an angle/area in a length field) is a
    // dimensional refusal, not a value: it previously threw as an unknown
    // identifier, and the audit keeps it refused. Dimensionless legacy
    // expressions (plain parameters, degree-based trig) still pass. The rule
    // is the evaluator's, shared with every typed expression field.
    const value = evaluateFieldExpression(trimmed, scope, {
      documentUnits,
      dimension:
        entryUnit === 'deg'
          ? 'angle'
          : entryUnit === 'count'
            ? 'number'
            : 'length'
    });
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
export function dimensionModeForInput(
  raw: string,
  scope: Record<string, number> = {}
): DimensionMode | undefined {
  const input = raw.trim();
  const identifier = input.match(/^[a-z_][a-z0-9_]*/iu)?.[0];
  // A parameter named r or r2 wins over the otherwise ambiguous R shorthand.
  if (identifier && Object.hasOwn(scope, identifier)) return undefined;
  const prefix = input.match(DIMENSION_PREFIX)?.[1]?.toUpperCase();
  return prefix === 'R' ? 'radius' : prefix ? 'diameter' : undefined;
}

function stripDimensionPrefix(
  raw: string,
  scope: Record<string, number>
): string {
  const input = raw.trim();
  return dimensionModeForInput(input, scope)
    ? input.replace(DIMENSION_PREFIX, '').trim()
    : input;
}

/** Switch entry notation without changing the radius the field represents. */
export function convertDimensionInput(
  raw: string,
  from: DimensionMode,
  to: DimensionMode,
  scope: Record<string, number> = {}
): string {
  const value = stripDimensionPrefix(raw, scope);
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
