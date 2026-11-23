import {
  FEATURE_QUANTITIES,
  PARAMETER_QUANTITIES,
  SKETCH_NODE_QUANTITIES,
  SKETCH_OBJECT_QUANTITIES,
  MESH_PAYLOAD_UNITS_SCHEMA_VERSION,
  millimetresPerUnit,
  walkQuantities,
  type ConfigurationRow,
  type DocumentNode,
  type ParameterId,
  type ParameterKind,
  type ProjectDocument,
  type QuantityClass,
  type QuantityLeaf,
  type QuantityMap,
  type QuantityMapShape,
  type SwitchQuantity,
  type UnitSystem
} from '@openzcad/shared';
import { documentForConfiguration } from './configurations';
import {
  evaluateExpression,
  expressionIdentifiers,
  getParameterScope,
  listParameters,
  refreshParameterValues,
  traceExpression,
  type ExpressionQuantityValue
} from './index';

/**
 * I03 stored-unit conversion, phase 2 (plan
 * `docs/plans/i03-stored-unit-conversion-plan.md` §2, §5.4, §6 step 1, §9):
 * the pure document transform that rewrites a document from `units = A` to
 * `units = B`, and the field-level oracle that checks it. The
 * `units.convert` command (phase 5, `units-convert-command.ts`) applies it
 * and then the re-captured reference map (phase 4).
 *
 * What it does, per quantity registry class:
 *
 * - `length` and `position`: numbers scale by k = mm(A) / mm(B), rounded to
 *   15 significant digits; expressions follow rule D (below).
 * - `area` (fingerprint source areas): numbers scale by k².
 * - everything else (angles, counts, ratios, directions, conditions,
 *   unitless parameters): unchanged. `hash` leaves are not touched; phase 4
 *   re-captures every persisted reference from a rebuild.
 *
 * Rule D for an expression in a length field, judged by evaluating it in the
 * source document:
 *
 * 1. it evaluates to a length (`5 mm`, a typed-length parameter): unchanged,
 *    since suffixes convert themselves and typed parameters convert at
 *    their own definition;
 * 2. it is a pure numeral (`"10"`): replaced by the scaled numeral;
 * 3. it is unit-free (`w * 2`, `20 / 2`): wrapped as `(E) / 25.4`,
 *    `(E) * 25.4` and so on, with an exact short factor. A wrapper this
 *    function wrote (or one of the same exact form) is recognised and
 *    rewritten for the new unit instead of stacking, so mm → in → mm
 *    restores the text byte for byte.
 *
 * Typed-length parameters convert by the same rule, and so does every
 * configuration row's cell for one. Parameter `value` caches are recomputed
 * by evaluation in the target unit, and `derived` (a session projection) is
 * replaced by an empty one so nothing reads geometry in the old unit.
 *
 * It refuses, listing every reason, rather than guess:
 *
 * - a source or target of `m` (owner decision Q1), or no change of unit;
 * - a custom feature (its script's literals cannot be rewritten, Q5);
 * - stored data in an area the registry does not classify yet: drawings,
 *   PMI, assemblies and reference images, and node metadata that stores
 *   lengths (a growing holder's recipe) or that is not recognised (see
 *   {@link UNITS_CONVERSION_REFUSED_METADATA});
 * - an imported mesh that keeps embedded triangles beside a payload
 *   reference (only a referenced payload alone can carry `payloadUnits`),
 *   or a referenced payload in a document older than schema v153;
 * - a length field whose expression does not evaluate, or evaluates to
 *   something other than a length or a plain number;
 * - any expression (field, parameter or configuration cell) that applies an
 *   operation which is not continuous and equivariant in a length to a
 *   length, whatever its value today: `round(width)`, `mod(width, 10 mm)`
 *   or `require_min(width, 3 mm)` with a typed `width`, or a length in a
 *   parameter that does not scale (see
 *   {@link UNITS_CONVERSION_OPERATION_SCALING});
 * - any field that does not scale (an angle, count, ratio, fraction or
 *   condition) whose value depends on a length at all, directly or through
 *   a parameter: the kernel rounds counts and compares conditions and
 *   angles, so a value that moves by an ulp in the new unit can land on the
 *   other side of a threshold after a later edit, even when today's value
 *   agrees;
 * - a stored number, or the value of a length expression, whose scaled
 *   value is not a finite normal double (zero only when it was zero);
 * - any field whose converted value is not the scaled original (the oracle,
 *   §6 step 1), the second line of defence.
 *
 * An imported mesh whose triangles live in a content-addressed payload
 * keeps the blob (and, for E2EE projects, its encryption) as it is: the
 * conversion records the unit the payload was written in as `payloadUnits`
 * (schema v153, plan §3.4), and the kernel scales the triangles on load.
 *
 * Two narrow cases convert but are reported as warnings
 * ({@link UnitsConversionWarning}), because a later edit could make them
 * mean something else even though today's value agrees:
 *
 * - `rounding-of-length-ratio`: a rounding, modulo, sign or guard applied to
 *   a unit-free value computed from lengths (`round(width / 1 mm) * 1 mm`).
 *   The ratio is the same number in every unit only to within an ulp, so a
 *   value that lands exactly on a jump (`.5`) can round the other way;
 * - `pole-or-domain-edge`: a division by, or a square root of, a sum or
 *   difference of lengths (`1 / (width - 3 mm)`,
 *   `sqrt((width - 3 mm) * 1 mm)`),
 *   which an ulp can move across zero when an edit brings it there.
 *
 * The input is never mutated.
 */

/** The stored units a conversion may go from or to (owner decision Q1). */
export type ConvertibleUnit = 'mm' | 'cm' | 'inch';

const CONVERTIBLE_UNITS: readonly UnitSystem[] = ['mm', 'cm', 'inch'];

export type UnitsConversionRefusalCode =
  | 'unsupported-unit'
  | 'same-unit'
  | 'custom-feature'
  | 'unsupported-area'
  | 'imported-mesh-payload'
  | 'unclassifiable'
  | 'scale-variant'
  | 'out-of-range'
  | 'oracle-mismatch';

export interface UnitsConversionRefusal {
  code: UnitsConversionRefusalCode;
  /** Where: a node (`Extrude 1`), an area (`drawings`) or the document. */
  subject: string;
  /** The field's path below its subject, when one field is at fault. */
  field?: string;
  /** A sentence for the review screen. */
  message: string;
}

/** One expression whose text changed (a wrap, an unwrap or a numeral). */
export interface UnitsConversionRewrite {
  subject: string;
  field: string;
  before: string;
  after: string;
}

export type UnitsConversionWarningCode =
  'rounding-of-length-ratio' | 'pole-or-domain-edge';

/**
 * A field that converts and agrees today but could change meaning after a
 * later edit (see the module comment). The review screen lists them.
 */
export interface UnitsConversionWarning {
  code: UnitsConversionWarningCode;
  subject: string;
  field: string;
  /** The expression as written before conversion. */
  expression: string;
  /** The operation at risk: `round`, `/`, `sqrt` and so on. */
  operation: string;
  /** A sentence for the review screen. */
  message: string;
}

export interface UnitsConversionReport {
  from: ConvertibleUnit;
  to: ConvertibleUnit;
  /** k = N / D: millimetres per source unit over millimetres per target. */
  factor: readonly [number, number];
  /** Stored numbers scaled (lengths, positions and areas). */
  scaledNumbers: number;
  /** Unit-free expressions wrapped with the factor. */
  wrapped: UnitsConversionRewrite[];
  /** Wrappers recognised and rewritten for the new unit (or removed). */
  unwrapped: UnitsConversionRewrite[];
  /** Pure numerals replaced by their scaled value. */
  numerals: UnitsConversionRewrite[];
  /** Length expressions left as written (they carry their own units). */
  unchangedExpressions: number;
  /**
   * Configuration rows whose cells were rewritten, active row included. The
   * active row's stored parameter cells are replaced by the converted live
   * parameters, which is what that row holds (see `convertConfigurations`).
   */
  configurationRows: number;
  /** What happened to `displayUnits` (plan §5.4). */
  displayUnits: 'none' | 'cleared' | 'kept';
  /**
   * Imported meshes whose referenced payload now names the unit it was
   * written in (`payloadUnits`), or no longer needs to; the blob is kept.
   */
  meshPayloads: number;
  /** Fields that convert but could change meaning after a later edit. */
  warnings: UnitsConversionWarning[];
  /** Fields the oracle evaluated in both documents. */
  oracleChecks: number;
}

export type UnitsConversionResult =
  | { ok: true; document: ProjectDocument; report: UnitsConversionReport }
  | { ok: false; refusals: UnitsConversionRefusal[] };

/** Relative tolerance of the field-level oracle (plan §6 step 1). */
export const UNITS_CONVERSION_ORACLE_TOLERANCE = 1e-12;

// ---------------------------------------------------------------------------
// Factors, numerals and wrappers
// ---------------------------------------------------------------------------

/** The fewest significant digits that write `value` exactly. */
function significantDigits(value: number): number {
  for (let digits = 1; digits < 17; digits += 1)
    if (Number(value.toPrecision(digits)) === value) return digits;
  return 17;
}

/**
 * Scales `value` by `N / D` and rounds it (plan §2.2 rule 3): to 15
 * significant digits, `Number((x * N / D).toPrecision(15))`, whenever that
 * converts back exactly; to 16 or 17 digits only when 15 would not.
 *
 * Fifteen digits alone do not round-trip: 3 mm is 0.118110236220472 in, and
 * that is 2.99999999999999 mm back. So the result is the shortest of the
 * 15-, 16- and 17-digit roundings that scales back by `D / N` to `value` at
 * `value`'s own precision (at least 15 digits), which makes mm → in → mm
 * restore every stored number written in 15 digits or fewer exactly. A
 * full-precision double (a kernel-captured fingerprint) may still come back
 * one unit in the last place off when no rounding inverts; the error stays
 * near 1e-16 relative, far below every kernel tolerance.
 */
export function canonicalScaledNumber(
  value: number,
  N: number,
  D: number
): number {
  const scaled = scaleBy(value, N, D);
  if (scaled === 0 || !Number.isFinite(scaled))
    return scaled === 0 ? 0 : scaled;
  const precision = Math.max(15, significantDigits(value));
  for (const digits of [15, 16, 17]) {
    const candidate = Number(scaled.toPrecision(digits));
    if (Number(scaleBy(candidate, D, N).toPrecision(precision)) === value)
      return candidate;
  }
  return scaled;
}

/**
 * `value * N / D` without an intermediate overflow: multiplying first keeps
 * the usual rounding, and only when `value * N` overflows (a value near
 * `Number.MAX_VALUE`) is it divided first. The result is infinite only when
 * the true result is out of range; callers refuse that.
 */
function scaleBy(value: number, N: number, D: number): number {
  const product = value * N;
  return Number.isFinite(product) || !Number.isFinite(value)
    ? product / D
    : (value / D) * N;
}

/** The smallest positive normal double; below it precision is lost. */
const MIN_NORMAL = 2 ** -1022;

/**
 * Whether a value `value` scaled to `scaled` is still representable: finite,
 * zero only when `value` was zero, and otherwise a normal double. A
 * non-zero value that underflows to zero or to a subnormal would cross zero
 * or lose its digits.
 */
function representable(value: number, scaled: number): boolean {
  if (!Number.isFinite(scaled)) return false;
  return value === 0 ? scaled === 0 : Math.abs(scaled) >= MIN_NORMAL;
}

const PURE_NUMERAL = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/**
 * The exact factors a wrapper may carry, as written. Every pair of mm, cm
 * and inch is one multiplication or division by one of these, so `E` keeps
 * its exact meaning ("a number of the old unit").
 */
const WRAPPER_FACTORS: Readonly<Record<string, number>> = {
  '10': 10,
  '25.4': 25.4,
  '2.54': 2.54
};

/** `mm(from) / mm(to)` as one `* f` or `/ f` with an exact short `f`. */
function wrapperSuffix(from: ConvertibleUnit, to: ConvertibleUnit): string {
  const a = millimetresPerUnit(from);
  const b = millimetresPerUnit(to);
  const [operator, ratio] = a >= b ? ['*', a / b] : ['/', b / a];
  const written = Object.keys(WRAPPER_FACTORS).find(
    (text) => Math.abs(WRAPPER_FACTORS[text]! - ratio) < 1e-12 * ratio
  );
  if (!written) throw new Error(`No exact factor from ${from} to ${to}.`);
  return ` ${operator} ${written}`;
}

const WRAPPED = /^\((.*)\) ([*/]) (10|25\.4|2\.54)$/s;

/** Whether `(` at 0 closes exactly at `end` (the wrapper's own parens). */
function closesAt(text: string, end: number): boolean {
  let depth = 0;
  for (let index = 0; index <= end; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index === end;
    }
  }
  return false;
}

/**
 * If `expression` is a wrapper `(E) op f`, the unit `E` is written in when
 * the document is in `units`: `(E) / 25.4` in an inch document is E
 * millimetres. Undefined for anything else.
 */
function unwrap(
  expression: string,
  units: ConvertibleUnit
): { inner: string; unit: ConvertibleUnit } | undefined {
  const match = WRAPPED.exec(expression);
  if (!match) return undefined;
  const inner = match[1]!;
  if (!closesAt(expression, inner.length + 1)) return undefined;
  const factor = WRAPPER_FACTORS[match[3]!]!;
  const mmPerInner =
    match[2] === '*'
      ? millimetresPerUnit(units) * factor
      : millimetresPerUnit(units) / factor;
  const unit = CONVERTIBLE_UNITS.find(
    (candidate) =>
      Math.abs(millimetresPerUnit(candidate) - mmPerInner) < 1e-9 * mmPerInner
  ) as ConvertibleUnit | undefined;
  return unit ? { inner, unit } : undefined;
}

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

/** The top-level authored fields (plan §1.1); the rest of the top level is ids and tags. */
const DOCUMENT_TOP_LEVEL_QUANTITIES: QuantityMap<
  Pick<ProjectDocument, 'printClearance'>
> = { printClearance: 'length' };

/**
 * A copy in which no two fields share an object. A document built in memory
 * may reuse one vector for two fields, even fields of different classes (a
 * position and a direction); converting it in place would scale it twice or
 * scale the direction. `derived` and `editHistory` are not copied: `derived`
 * is replaced and the history is never written.
 */
function treeClone(document: ProjectDocument): ProjectDocument {
  const copy = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(copy);
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) out[key] = copy(child);
      return out;
    }
    return value;
  };
  const { derived, editHistory, ...content } = document;
  return {
    ...(copy(content) as Omit<ProjectDocument, 'derived' | 'editHistory'>),
    derived,
    ...(editHistory ? { editHistory } : {})
  };
}

/** The registry map for the part of a node it classifies. */
function nodeScope(
  node: DocumentNode
):
  { value: object; map: QuantityMapShape | SwitchQuantity<never> } | undefined {
  switch (node.kind) {
    case 'feature':
      return { value: node.data, map: FEATURE_QUANTITIES };
    case 'sketch-object':
      return { value: node.data, map: SKETCH_OBJECT_QUANTITIES };
    case 'sketch':
      return { value: node, map: SKETCH_NODE_QUANTITIES };
    case 'parameter':
      return { value: node, map: PARAMETER_QUANTITIES };
    default:
      return undefined;
  }
}

function subjectOf(node: DocumentNode): string {
  return node.name ? `${node.name} (${node.id})` : node.id;
}

function fieldOf(leaf: QuantityLeaf): string {
  return leaf.path.join('.');
}

/** Every classified leaf of a document, keyed `subject|field`, in a stable order. */
function collectLeaves(
  document: ProjectDocument
): { subject: string; field: string; leaf: QuantityLeaf }[] {
  const out: { subject: string; field: string; leaf: QuantityLeaf }[] = [];
  for (const id of Object.keys(document.nodes).sort()) {
    const node = document.nodes[id]!;
    // Parameters are checked through the evaluated scope instead.
    if (node.kind === 'parameter') continue;
    const scoped = nodeScope(node);
    if (!scoped) continue;
    walkQuantities(scoped.value, scoped.map, (leaf) =>
      out.push({ subject: subjectOf(node), field: fieldOf(leaf), leaf })
    );
  }
  walkQuantities(document, DOCUMENT_TOP_LEVEL_QUANTITIES, (leaf) =>
    out.push({ subject: 'document', field: fieldOf(leaf), leaf })
  );
  return out;
}

/** How a class converts: scaled by k^power, or never (`null`). */
function scalePower(quantity: QuantityClass): 0 | 1 | 2 | null {
  switch (quantity) {
    case 'length':
    case 'position':
      return 1;
    case 'area':
      return 2;
    case 'hash':
      return null;
    default:
      return 0;
  }
}

function parameterScalePower(quantity: ParameterKind | undefined): 0 | 1 {
  return quantity === 'length' ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

/**
 * Node `metadata` keys whose values hold no stored length: flags, colours,
 * ids and a unit-free opacity. Node metadata is an open record the quantity
 * registry does not walk, so every key a node may carry is decided here
 * (PR #1999 audit, `test/units-convert-document-audit.test.ts`).
 */
export const UNITS_CONVERSION_UNIT_FREE_METADATA: readonly string[] = [
  'suppressed',
  'rollbackSuppressed',
  'color',
  'colorChosen',
  'opacity',
  'primitivePlacement',
  'openzcad.growingHolderTextBody'
];

/**
 * Node `metadata` keys whose JSON value stores lengths in document units,
 * and what they are called on the review screen. The conversion refuses a
 * document that has one rather than leave the numbers in the old unit: a
 * growing holder's recipe (envelope, cuts, openings, section) and the source
 * placement its history is verified against.
 */
export const UNITS_CONVERSION_REFUSED_METADATA: Readonly<
  Record<string, string>
> = {
  'openzcad.growingHolderRecipe': 'a growing-holder recipe',
  'openzcad.growingHolderSourcePlacement': 'a growing-holder source placement'
};

/** Whether an unlisted metadata value could be a stored number. */
function mayHoldNumbers(value: unknown): boolean {
  if (typeof value === 'number') return true;
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

function hasArrayContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object' && value !== null)
    return Object.values(value).some(hasArrayContent);
  return false;
}

function preconditionRefusals(
  document: ProjectDocument,
  to: UnitSystem
): UnitsConversionRefusal[] {
  const refusals: UnitsConversionRefusal[] = [];
  for (const [role, unit] of [
    ['source', document.units],
    ['target', to]
  ] as const)
    if (!CONVERTIBLE_UNITS.includes(unit))
      refusals.push({
        code: 'unsupported-unit',
        subject: 'document',
        message: `Stored units convert only between millimetres, centimetres and inches; the ${role} unit is "${String(unit)}".`
      });
  if (refusals.length === 0 && document.units === to)
    refusals.push({
      code: 'same-unit',
      subject: 'document',
      message: `The document is already stored in ${to}.`
    });

  const areas: [string, unknown, string][] = [
    ['drawings', document.drawings, 'drawing sheets'],
    ['pmi', document.pmi, 'model annotations (PMI)'],
    ['assembly', document.assembly, 'an assembly'],
    ['referenceImages', document.referenceImages, 'reference images']
  ];
  for (const [area, value, label] of areas)
    if (value !== undefined && hasArrayContent(value))
      refusals.push({
        code: 'unsupported-area',
        subject: area,
        message: `The document has ${label}, which stored-unit conversion does not convert yet.`
      });

  for (const id of Object.keys(document.nodes).sort()) {
    const node = document.nodes[id]!;
    for (const [key, value] of Object.entries(node.metadata ?? {})) {
      if (value === undefined || value === null) continue;
      const refused = UNITS_CONVERSION_REFUSED_METADATA[key];
      if (refused)
        refusals.push({
          code: 'unsupported-area',
          subject: subjectOf(node),
          field: `metadata.${key}`,
          message: `${node.name || node.id} keeps ${refused}, whose lengths stored-unit conversion does not convert yet.`
        });
      else if (
        !UNITS_CONVERSION_UNIT_FREE_METADATA.includes(key) &&
        mayHoldNumbers(value)
      )
        refusals.push({
          code: 'unsupported-area',
          subject: subjectOf(node),
          field: `metadata.${key}`,
          message: `${node.name || node.id} keeps data under "${key}" that stored-unit conversion does not recognise, so it cannot tell whether it holds lengths.`
        });
    }
    if (node.kind !== 'feature') continue;
    if (node.data.featureKind === 'custom-feature')
      refusals.push({
        code: 'custom-feature',
        subject: subjectOf(node),
        message: `${node.name} is a custom feature: numbers inside its script cannot be converted.`
      });
    if (
      node.data.featureKind === 'imported-mesh' &&
      node.data.meshPayloadRef !== undefined
    ) {
      if (node.data.vertices !== undefined || node.data.indices !== undefined)
        refusals.push({
          code: 'imported-mesh-payload',
          subject: subjectOf(node),
          field: 'meshPayloadRef',
          message: `${node.name} keeps embedded triangles beside a stored payload, so the payload's unit cannot be recorded.`
        });
      else if (
        typeof document.schemaVersion !== 'number' ||
        document.schemaVersion < MESH_PAYLOAD_UNITS_SCHEMA_VERSION
      )
        refusals.push({
          code: 'imported-mesh-payload',
          subject: subjectOf(node),
          field: 'meshPayloadRef',
          message: `${node.name} keeps its triangles in a stored payload, whose unit needs project schema v${MESH_PAYLOAD_UNITS_SCHEMA_VERSION} or newer to record.`
        });
    }
  }
  return refusals;
}

// ---------------------------------------------------------------------------
// Scale audit: operations that do not commute with a change of length unit
// ---------------------------------------------------------------------------

/**
 * How each operation of the expression evaluator behaves when every length
 * in it is multiplied by the same k > 0 (a change of stored unit).
 *
 * The rule: the converted document is evaluated in floating point, so every
 * length is k times the original only to within a few ulps, and stays so
 * after any later edit. An operation that is continuous and equivariant
 * turns a few ulps in into a few ulps out, which no consumer can see. An
 * operation that is discontinuous in a length (rounding, a comparison, a
 * modulo, a guard, a branch cut) can put the two documents on opposite
 * sides of the jump, today or after the next edit, so it is refused
 * structurally whenever a length reaches it, whatever today's value.
 *
 * - `equivariant`: continuous, and the result scales by k to its own
 *   length power, so the formula means the same in any unit: `+ - * /`,
 *   juxtaposition, `abs`, `sqrt`, `min`, `max`, `avg` and `pi`.
 * - `unit-free-only`: refused when an argument carries a length. A
 *   unit-free argument (`round(width / 1 mm)`, `round(n)`) is the same
 *   number in every unit up to rounding, and rule D wraps a unit-free result
 *   outside the operation, so it is fine.
 *   - `round`, `floor`, `ceil`: depend on the number a length happens to be
 *     (`round(127 mm)` is 127 in millimetres, 5 in inches).
 *   - `mod`: `mod(k·a, k·b) = k·mod(a, b)` in exact arithmetic, but it
 *     jumps by `b` where `a / b` crosses an integer, and k-scaling moves
 *     `a / b` by an ulp: `10 mm + mod(width, 10 mm)` at `width = 30 mm` is
 *     10 mm in millimetres and 20 mm in inches.
 *   - `require_min`, `require_one_of`: a guard either returns or throws,
 *     and comparing `k·a` with `k·b` in floating point need not decide as
 *     comparing `a` with `b` (`require_one_of(width, 3 mm)` at
 *     `width = 1 mm + 2 mm`).
 *   - `sign`: jumps at zero, which a difference of lengths can cross.
 *   - `atan2`: jumps by 360° across its branch cut.
 *   - trigonometry and the inverse functions, which the evaluator already
 *     refuses for lengths; listed so a future relaxation still refuses.
 * - `^` is decided per use: a length base needs an integer exponent (the
 *   evaluator enforces it too) and the exponent must be unit-free.
 *
 * The evaluator has no `%`, `log` or `exp`, and no comparison operators
 * outside the `require_*` guards and `min`/`max`. An operation missing from
 * this table (a function added to the evaluator later) is treated as
 * `unit-free-only`, so it refuses conversion until it is classified.
 */
export const UNITS_CONVERSION_OPERATION_SCALING: Readonly<
  Record<string, 'equivariant' | 'unit-free-only' | 'per-use'>
> = {
  '+': 'equivariant',
  '-': 'equivariant',
  '*': 'equivariant',
  '/': 'equivariant',
  juxtapose: 'equivariant',
  '^': 'per-use',
  abs: 'equivariant',
  sqrt: 'equivariant',
  min: 'equivariant',
  max: 'equivariant',
  avg: 'equivariant',
  pi: 'equivariant',
  mod: 'unit-free-only',
  sign: 'unit-free-only',
  atan2: 'unit-free-only',
  require_min: 'unit-free-only',
  require_one_of: 'unit-free-only',
  round: 'unit-free-only',
  floor: 'unit-free-only',
  ceil: 'unit-free-only',
  sin: 'unit-free-only',
  cos: 'unit-free-only',
  tan: 'unit-free-only',
  asin: 'unit-free-only',
  acos: 'unit-free-only',
  atan: 'unit-free-only'
};

/** Why `operation` on `operands` does not survive a change of unit, if so. */
function scaleVariantOperation(
  operation: string,
  operands: readonly ExpressionQuantityValue[]
): string | undefined {
  const scaling = UNITS_CONVERSION_OPERATION_SCALING[operation];
  if (scaling === 'equivariant') return undefined;
  if (scaling === 'per-use') {
    const [base, exponent] = operands;
    if (exponent && exponent.length !== 0) return '^ with a length exponent';
    if (base && exponent && base.length !== 0)
      return Number.isInteger(exponent.value)
        ? undefined
        : '^ of a length with a non-integer exponent';
    return undefined;
  }
  return operands.some((operand) => operand.length !== 0)
    ? `${operation}() of a length`
    : undefined;
}

/** One residual risk an audit found (see {@link UnitsConversionWarning}). */
interface ScaleRisk {
  code: UnitsConversionWarningCode;
  operation: string;
}

interface ScaleAudit {
  result: ExpressionQuantityValue;
  /** Whether any value inside the expression carries a length. */
  dimensional: boolean;
  /** The first scale-variant operation, described. */
  variant?: string;
  /**
   * Operations that survive a change of unit today but sit on a jump a
   * later edit could reach (see {@link auditScale}).
   */
  risks: ScaleRisk[];
  /**
   * Whether the value is a sum or difference computed from a length (or
   * one scaled by a product or quotient), which a later edit can zero.
   */
  lengthSum: boolean;
}

/**
 * Evaluates `expression` once, auditing every operation; throws as the
 * evaluator does.
 *
 * Besides refusals, it records two residual risks (plan §2.2, owner-approved
 * as warnings). The trace reports each operation after its operands were
 * evaluated, in evaluation order, so it is an approximation of data flow:
 *
 * - a unit-free-only operation (`round`, `mod`, a guard) whose operands are
 *   unit-free but computed from a length, or that follows a length traced
 *   earlier in the expression, or sits in an expression that reads a
 *   parameter computed from a length (`lengthNames`): the unit-free value
 *   may be a ratio of lengths. This over-approximates (`2 mm + round(n)`
 *   warns), which a warning may and a refusal may not;
 * - a division by, or a square root (or a negative or non-integer power)
 *   of, a value that is a sum or difference computed from a length, or one
 *   scaled from it by a product or quotient, inside the expression or a
 *   parameter of that kind it reads (`sumNames`). Values are matched by
 *   value, since the trace reports operands and not where they came from.
 */
function auditScale(
  expression: string,
  scope: Record<string, number>,
  units: UnitSystem,
  context: ScaleRiskContext = NO_RISK_CONTEXT
): ScaleAudit {
  let dimensional = false;
  let variant: string | undefined;
  let lastSum = false;
  const risks: ScaleRisk[] = [];
  const identifiers = expressionIdentifiers(expression);
  const readsLengthRatio = identifiers.some((name) =>
    context.lengthNames.has(name)
  );
  // Values computed from a length (`derived`), and those of them that a
  // sum or difference produced, directly or scaled by a product or a
  // quotient (`sums`): the ones a later edit can bring to zero. Matched by
  // value, since the trace reports operands, not where they came from.
  const derived = new Set<number>();
  const sums = new Set<number>();
  for (const name of identifiers) {
    const value = scope[name];
    if (value === undefined) continue;
    if (context.lengthNames.has(name)) derived.add(value);
    if (context.sumNames.has(name)) sums.add(value);
  }
  const risk = (code: UnitsConversionWarningCode, operation: string) => {
    if (!risks.some((r) => r.code === code && r.operation === operation))
      risks.push({ code, operation });
  };
  const result = traceExpression(
    expression,
    scope,
    { documentUnits: units },
    (operation, operands) => {
      const carriesLength = operands.some((operand) => operand.length !== 0);
      const fromLength = operands.some(
        (operand) => operand.length !== 0 || derived.has(operand.value)
      );
      const scaling = UNITS_CONVERSION_OPERATION_SCALING[operation];
      if (
        !carriesLength &&
        scaling !== 'equivariant' &&
        scaling !== 'per-use' &&
        (fromLength || dimensional || readsLengthRatio)
      )
        risk('rounding-of-length-ratio', operation);
      const [a, b] = operands;
      const nearZero = (operand: ExpressionQuantityValue | undefined) =>
        operand !== undefined && sums.has(operand.value);
      if (operation === '/' && nearZero(b)) risk('pole-or-domain-edge', '/');
      if (operation === 'sqrt' && nearZero(a))
        risk('pole-or-domain-edge', 'sqrt');
      if (
        operation === '^' &&
        nearZero(a) &&
        b !== undefined &&
        (b.value < 0 || !Number.isInteger(b.value))
      )
        risk('pole-or-domain-edge', '^');

      let value: number | undefined;
      let sum = false;
      if (
        a &&
        b &&
        (operation === '+' || operation === '-' || operation === 'juxtapose')
      ) {
        value = operation === '-' ? a.value - b.value : a.value + b.value;
        sum = fromLength;
      } else if (a && b && operation === '*') {
        value = a.value * b.value;
        sum = nearZero(a) || nearZero(b);
      } else if (a && b && operation === '/') {
        value = a.value / b.value;
        sum = nearZero(a);
      } else if (a && operation === 'abs') {
        value = Math.abs(a.value);
        sum = nearZero(a);
      } else if (a && operation === 'sqrt') value = Math.sqrt(a.value);
      if (value !== undefined) {
        if (fromLength) derived.add(value);
        if (sum) sums.add(value);
      }
      lastSum = sum;
      if (carriesLength) dimensional = true;
      variant ??= scaleVariantOperation(operation, operands);
    }
  );
  return {
    result,
    dimensional: dimensional || result.length !== 0,
    ...(variant ? { variant } : {}),
    risks,
    lengthSum: lastSum
  };
}

/** What an audit needs to know about the parameters an expression reads. */
interface ScaleRiskContext {
  /** Parameters whose value is computed from a length. */
  lengthNames: ReadonlySet<string>;
  /** Parameters whose value is a sum or difference computed from a length. */
  sumNames: ReadonlySet<string>;
}

const NO_RISK_CONTEXT: ScaleRiskContext = {
  lengthNames: new Set(),
  sumNames: new Set()
};

/**
 * The parameters whose value is a sum or difference computed from a length
 * (`gap = width - 3 mm`, and `half = gap / 2` through it): a division by
 * one is a pole a later edit can reach. Evaluated in the document as it
 * stands, to a fixed point over chains of parameters.
 */
function lengthSumParameters(
  document: ProjectDocument,
  lengthNames: ReadonlySet<string>
): Set<string> {
  const scope = getParameterScope(document).scope;
  const parameters = listParameters(document);
  const names = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const parameter of parameters) {
      if (names.has(parameter.name)) continue;
      try {
        if (
          auditScale(parameter.expression, scope, document.units, {
            lengthNames,
            sumNames: names
          }).lengthSum
        ) {
          names.add(parameter.name);
          changed = true;
        }
      } catch {
        // Not in scope: nothing evaluates against it.
      }
    }
  }
  return names;
}

function recordRisks(
  converter: Converter,
  audit: ScaleAudit,
  expression: string,
  subject: string,
  field: string
): void {
  for (const { code, operation } of audit.risks)
    converter.report.warnings.push({
      code,
      subject,
      field,
      expression,
      operation,
      message:
        code === 'rounding-of-length-ratio'
          ? `"${expression}" applies ${operation}() to a ratio of lengths. It converts exactly today, but the ratio is the same number in ${converter.to} only to within rounding, so a value that lands exactly on a step (such as .5) after a later edit could round the other way.`
          : `"${expression}" ${operation === '/' ? 'divides by' : operation === 'sqrt' ? 'takes the square root of' : 'raises to a fractional or negative power'} a sum or difference of lengths. It converts exactly today, but if a later edit brings that value to zero, the two units can land on opposite sides of it.`
    });
}

// ---------------------------------------------------------------------------
// Rule D
// ---------------------------------------------------------------------------

interface Converter {
  from: ConvertibleUnit;
  to: ConvertibleUnit;
  /** Millimetres per source unit and per target unit: k = N / D. */
  N: number;
  D: number;
  report: UnitsConversionReport;
  refusals: UnitsConversionRefusal[];
  /**
   * Parameters whose value depends on a length, in any configuration row
   * (see {@link lengthDependentParameters}).
   */
  lengthDependent: ReadonlySet<string>;
  /** What audits need to report residual risks. */
  risks: ScaleRiskContext;
}

function refuseScaleVariant(
  converter: Converter,
  expression: string,
  reason: string,
  subject: string,
  field: string
): void {
  converter.refusals.push({
    code: 'scale-variant',
    subject,
    field,
    message: `"${expression}" applies ${reason}, so the formula would mean something else in ${converter.to} even where today's value agrees. Rewrite it unit-free (divide the length by a unit, e.g. round(width / 1 mm) * 1 mm) and convert again.`
  });
}

/**
 * Audits an expression in a field or parameter that does not scale (angle,
 * number, ratio, fraction, condition, unitless parameter). Refuses a
 * scale-variant operation on a length, and then:
 *
 * - a field (`parameter` false) whose value depends on a length at all,
 *   directly or through a parameter. The kernel rounds counts (pattern
 *   counts, gear teeth, thread and worm starts, polygon sides), reads a
 *   condition as zero or not and compares angles and ratios against
 *   limits; a value that is a few ulps off in the new unit (`a / b * 343`
 *   is 3.4999999999999996 in millimetres and 3.500000000000002 in inches)
 *   can land on the other side, today or after any edit. The field must be
 *   written without lengths to convert;
 * - a parameter whose result carries a length (`5 mm` in a unitless
 *   parameter would be another number after conversion). A unitless
 *   parameter computed from lengths (`width / 1 mm`) is allowed: every field
 *   that does not scale and reads it is refused by the rule above, and a
 *   length field reading it scales continuously.
 *
 * An expression that does not evaluate is left to the oracle.
 */
function auditUnscaledExpression(
  converter: Converter,
  expression: string,
  scope: Record<string, number>,
  subject: string,
  field: string,
  parameter: boolean
): void {
  let audit: ScaleAudit;
  try {
    audit = auditScale(expression, scope, converter.from, converter.risks);
  } catch {
    return;
  }
  const before = converter.refusals.length;
  auditUnscaledFindings(
    converter,
    audit,
    expression,
    subject,
    field,
    parameter
  );
  if (converter.refusals.length === before)
    recordRisks(converter, audit, expression, subject, field);
}

function auditUnscaledFindings(
  converter: Converter,
  audit: ScaleAudit,
  expression: string,
  subject: string,
  field: string,
  parameter: boolean
): void {
  if (audit.variant)
    refuseScaleVariant(converter, expression, audit.variant, subject, field);
  else if (parameter ? audit.result.length !== 0 : audit.dimensional)
    refuseScaleVariant(
      converter,
      expression,
      parameter
        ? 'a length where the value does not scale (a number, angle or unitless parameter)'
        : 'a length in a field that does not scale (a count, angle, ratio, fraction or condition), which the kernel may round or compare',
      subject,
      field
    );
  else if (
    !parameter &&
    expressionIdentifiers(expression).some((name) =>
      converter.lengthDependent.has(name)
    )
  )
    refuseScaleVariant(
      converter,
      expression,
      'a parameter computed from a length in a field that does not scale (a count, angle, ratio, fraction or condition), which the kernel may round or compare',
      subject,
      field
    );
}

/**
 * Converts one expression in a length field (or a typed-length parameter)
 * by rule D, evaluating it against `scope` in the source unit. Returns the
 * new text, or undefined after recording a refusal.
 */
function convertLengthExpression(
  converter: Converter,
  expression: string,
  scope: Record<string, number>,
  subject: string,
  field: string
): string | undefined {
  const { from, to, N, D, report } = converter;
  let audit: ScaleAudit;
  try {
    audit = auditScale(expression, scope, from, converter.risks);
  } catch (error) {
    converter.refusals.push({
      code: 'unclassifiable',
      subject,
      field,
      message: `"${expression}" does not evaluate (${error instanceof Error ? error.message : 'evaluation failed'}), so its unit cannot be decided.`
    });
    return undefined;
  }
  if (audit.variant) {
    refuseScaleVariant(converter, expression, audit.variant, subject, field);
    return undefined;
  }
  const dimensions = audit.result;
  const isLength = dimensions.length === 1 && dimensions.angle === 0;
  if (!isLength && (dimensions.length !== 0 || dimensions.angle !== 0)) {
    converter.refusals.push({
      code: 'unclassifiable',
      subject,
      field,
      message: `"${expression}" is not a length or a plain number, so it cannot be converted.`
    });
    return undefined;
  }
  if (!representable(dimensions.value, scaleBy(dimensions.value, N, D))) {
    refuseOutOfRange(converter, expression, subject, field);
    return undefined;
  }
  recordRisks(converter, audit, expression, subject, field);
  if (isLength) {
    report.unchangedExpressions += 1;
    return expression;
  }
  if (PURE_NUMERAL.test(expression)) {
    const value = Number(expression);
    const scaled = canonicalScaledNumber(value, N, D);
    if (!representable(value, scaled)) {
      refuseOutOfRange(converter, expression, subject, field);
      return undefined;
    }
    const after = String(scaled);
    report.numerals.push({ subject, field, before: expression, after });
    return after;
  }
  const wrapped = unwrap(expression, from);
  if (wrapped) {
    const after =
      wrapped.unit === to
        ? wrapped.inner
        : `(${wrapped.inner})${wrapperSuffix(wrapped.unit, to)}`;
    report.unwrapped.push({ subject, field, before: expression, after });
    return after;
  }
  const after = `(${expression})${wrapperSuffix(from, to)}`;
  report.wrapped.push({ subject, field, before: expression, after });
  return after;
}

function refuseOutOfRange(
  converter: Converter,
  value: number | string,
  subject: string,
  field: string
): void {
  converter.refusals.push({
    code: 'out-of-range',
    subject,
    field,
    message: `${String(value)} ${converter.from} is out of range in ${converter.to}: it would not be a finite normal number (or would no longer be non-zero).`
  });
}

/** Converts one classified leaf of the clone in place. */
function convertLeaf(
  converter: Converter,
  leaf: QuantityLeaf,
  scope: Record<string, number>,
  subject: string,
  field: string
): void {
  const power = scalePower(leaf.quantity);
  if (power === null) return;
  if (power === 0) {
    if (typeof leaf.value === 'string' && leaf.quantity !== 'script')
      auditUnscaledExpression(
        converter,
        leaf.value,
        scope,
        subject,
        field,
        false
      );
    return;
  }
  if (typeof leaf.value === 'number') {
    const { N, D } = converter;
    const scaled = canonicalScaledNumber(leaf.value, N ** power, D ** power);
    if (!representable(leaf.value, scaled)) {
      refuseOutOfRange(converter, leaf.value, subject, field);
      return;
    }
    leaf.holder[leaf.key] = scaled;
    converter.report.scaledNumbers += 1;
    return;
  }
  if (power !== 1) {
    converter.refusals.push({
      code: 'unclassifiable',
      subject,
      field,
      message: `"${leaf.value}" is an expression in an area field, which cannot be converted.`
    });
    return;
  }
  const next = convertLengthExpression(
    converter,
    leaf.value,
    scope,
    subject,
    field
  );
  if (next !== undefined) leaf.holder[leaf.key] = next;
}

function convertNode(
  converter: Converter,
  node: DocumentNode,
  scope: Record<string, number>
): void {
  const subject = subjectOf(node);
  if (node.kind === 'parameter') {
    // The cached value is recomputed by evaluation after the units change.
    if (parameterScalePower(node.quantity) === 0) {
      auditUnscaledExpression(
        converter,
        node.expression,
        scope,
        subject,
        'expression',
        true
      );
      return;
    }
    const next = convertLengthExpression(
      converter,
      node.expression,
      scope,
      subject,
      'expression'
    );
    if (next !== undefined) node.expression = next;
    return;
  }
  const scoped = nodeScope(node);
  if (!scoped) return;
  walkQuantities(scoped.value, scoped.map, (leaf) =>
    convertLeaf(converter, leaf, scope, subject, fieldOf(leaf))
  );
}

/**
 * Rewrites the configuration table's parameter cells. Call it after the
 * nodes are converted: it reads the converted parameters.
 *
 * The active row's stored parameter cells are not what that row holds: the
 * model's parameters are its values, and every reader (the effective row,
 * setting a cell, switching rows, `documentForConfiguration`) takes them
 * from the model and overwrites the stored cells first, so an edit made
 * while the row is active may have left them stale. Evaluating a stale
 * cell could refuse a valid document (or convert a value the row no longer
 * holds), so the active row's cells for existing parameters are set to the
 * converted live expressions instead: the same values every reader would
 * take, now stored in the new unit. Switching rows afterwards behaves as it
 * did before conversion, because it would have captured those same live
 * values. A cell whose parameter was deleted is never read and is kept.
 *
 * Every other row's cells convert by rule D for a typed length (and are
 * audited for the rest), each evaluated in the document as that row makes
 * it, so a row's own values decide its own rewrite.
 */
function convertConfigurations(
  converter: Converter,
  source: ProjectDocument,
  target: ProjectDocument
): void {
  const set = target.configurations;
  if (!set) return;
  const kinds = new Map(
    listParameters(source).map((parameter) => [
      parameter.parameterId,
      parameter.quantity
    ])
  );
  const live = new Map(
    listParameters(target).map((parameter) => [
      parameter.parameterId,
      parameter.expression
    ])
  );
  for (const row of set.rows) {
    const subject = `configuration "${row.name}"`;
    if (row.id === set.activeRowId) {
      const cells: ConfigurationRow['parameters'] = { ...row.parameters };
      for (const column of set.columns) {
        if (column.kind !== 'parameter') continue;
        const expression = live.get(column.parameterId);
        if (expression !== undefined) cells[column.parameterId] = expression;
      }
      row.parameters = cells;
      converter.report.configurationRows += 1;
      continue;
    }
    let scope: Record<string, number>;
    try {
      scope = getParameterScope(documentForConfiguration(source, row.id)).scope;
    } catch (error) {
      converter.refusals.push({
        code: 'unclassifiable',
        subject,
        message: `The row cannot be evaluated (${error instanceof Error ? error.message : 'evaluation failed'}).`
      });
      continue;
    }
    let touched = false;
    const cells: ConfigurationRow['parameters'] = { ...row.parameters };
    for (const [parameterId, expression] of Object.entries(cells) as [
      ParameterId,
      string
    ][]) {
      if (!kinds.has(parameterId)) continue;
      const field = `parameters.${parameterId}`;
      if (parameterScalePower(kinds.get(parameterId)) === 0) {
        auditUnscaledExpression(
          converter,
          expression,
          scope,
          subject,
          field,
          true
        );
        continue;
      }
      const next = convertLengthExpression(
        converter,
        expression,
        scope,
        subject,
        field
      );
      if (next !== undefined && next !== expression) {
        cells[parameterId] = next;
        touched = true;
      }
    }
    if (touched) row.parameters = cells;
    converter.report.configurationRows += 1;
  }
}

// ---------------------------------------------------------------------------
// The oracle (plan §6 step 1)
// ---------------------------------------------------------------------------

function evaluateLeaf(
  value: number | string,
  scope: Record<string, number>,
  units: UnitSystem
): number {
  return typeof value === 'number'
    ? value
    : evaluateExpression(value, scope, { documentUnits: units });
}

/**
 * Whether `actual` (after conversion) is `expected` (before, already scaled
 * by k^power) as far as anything downstream can tell:
 *
 * - it is finite, and has the same sign and zero-ness. The kernel reads a
 *   condition as "exactly zero or not", and a zero length or radius often
 *   means "none", so no tolerance may move a value across zero. A scaled
 *   value is zero exactly when its `source` (the value before scaling) is,
 *   and otherwise a normal double, judged against `source` because
 *   `expected` itself may have underflowed;
 * - a length or area (power > 0) agrees to {@link
 *   UNITS_CONVERSION_ORACLE_TOLERANCE} relative, with an absolute floor of
 *   the same size below one unit, where the 15-digit rounding of a numeral
 *   and cancellation in `a - b` meet;
 * - a value that does not scale (power 0) must be bit-identical unless it
 *   is computed from lengths (`derived`): then it is a ratio of quantities
 *   that were each rounded in a different unit, `(a / 25.4) / (b / 25.4)`,
 *   and may legitimately differ from `a / b` by a few units in the last
 *   place. It gets relative tolerance only, never an absolute floor, and a
 *   count (`counted`: a number, index or unitless parameter) that is a whole
 *   number on either side must be exact, since 3 against 2.9999999999999996
 *   is a different number of pattern instances once floored.
 */
function agrees(
  source: number,
  expected: number,
  actual: number,
  power: number,
  derived: boolean,
  counted: boolean
): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  // Zero-ness against the source, not against `expected`, which may itself
  // have underflowed: a non-zero length must stay a normal non-zero double.
  if (power > 0 && !representable(source, actual)) return false;
  if (expected === actual) return true;
  if (Math.sign(expected) !== Math.sign(actual)) return false;
  const difference = Math.abs(expected - actual);
  const magnitude = Math.max(Math.abs(expected), Math.abs(actual));
  if (power > 0)
    return (
      difference <= UNITS_CONVERSION_ORACLE_TOLERANCE * Math.max(magnitude, 1)
    );
  if (!derived) return false;
  if (counted && (Number.isInteger(expected) || Number.isInteger(actual)))
    return false;
  return difference <= UNITS_CONVERSION_ORACLE_TOLERANCE * magnitude;
}

/** `value * k^power` without overflow when the true result is finite. */
function scaleValue(
  value: number,
  N: number,
  D: number,
  power: number
): number {
  return power === 0 ? value : scaleBy(value, N ** power, D ** power);
}

/**
 * The names of parameters whose value is computed from a length, directly
 * or through other parameters: their unit-free values are ratios that may
 * move by an ulp in another unit (see {@link agrees}).
 */
function lengthDerivedParameters(
  document: ProjectDocument,
  scope: Record<string, number>
): Set<string> {
  const parameters = listParameters(document);
  const derived = new Set<string>();
  for (const parameter of parameters) {
    if (parameter.quantity === 'length') {
      derived.add(parameter.name);
      continue;
    }
    try {
      if (auditScale(parameter.expression, scope, document.units).dimensional)
        derived.add(parameter.name);
    } catch {
      // Unevaluable parameters are not in scope; nothing reads them.
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const parameter of parameters)
      if (
        !derived.has(parameter.name) &&
        expressionIdentifiers(parameter.expression).some((name) =>
          derived.has(name)
        )
      ) {
        derived.add(parameter.name);
        changed = true;
      }
  }
  return derived;
}

/**
 * {@link lengthDerivedParameters} over the document and every configuration
 * row: a parameter that is a plain number in the active row may be computed
 * from a length in another. A row that cannot be applied is refused by
 * `convertConfigurations`.
 */
function lengthDependentParameters(document: ProjectDocument): Set<string> {
  const names = lengthDerivedParameters(
    document,
    getParameterScope(document).scope
  );
  for (const row of document.configurations?.rows ?? []) {
    if (row.id === document.configurations!.activeRowId) continue;
    try {
      const rowDocument = documentForConfiguration(document, row.id);
      for (const name of lengthDerivedParameters(
        rowDocument,
        getParameterScope(rowDocument).scope
      ))
        names.add(name);
    } catch {
      // Refused where the row's cells are converted.
    }
  }
  return names;
}

/** Whether `leaf` is a condition whose expression evaluates to a length. */
function lengthCondition(
  leaf: QuantityLeaf,
  scope: Record<string, number>,
  units: UnitSystem
): boolean {
  if (leaf.quantity !== 'condition' || typeof leaf.value !== 'string')
    return false;
  try {
    return auditScale(leaf.value, scope, units).result.length !== 0;
  } catch {
    return false;
  }
}

function expressionDerived(
  value: number | string,
  scope: Record<string, number>,
  units: UnitSystem,
  derived: ReadonlySet<string>
): boolean {
  if (typeof value === 'number') return false;
  if (expressionIdentifiers(value).some((name) => derived.has(name)))
    return true;
  try {
    return auditScale(value, scope, units).dimensional;
  } catch {
    return false;
  }
}

/**
 * Evaluates every classified field (and every parameter) of `source` and
 * `converted` and checks that lengths and positions scaled by k, areas by
 * k² and everything else kept its value, by the rules of {@link agrees}.
 * Stored numbers (mesh vertices, fingerprints' source measurements, plain
 * numbers in expression fields) are checked bit for bit against their
 * canonical scaled value: each scaled exactly once, finite, and non-zero
 * when it was. A field that evaluated
 * before and not after, or to another value, is a refusal naming it. Hash
 * leaves are skipped: phase 4 re-captures them.
 */
export function unitsConversionOracle(
  source: ProjectDocument,
  converted: ProjectDocument,
  label = ''
): { refusals: UnitsConversionRefusal[]; checks: number } {
  const N = millimetresPerUnit(source.units);
  const D = millimetresPerUnit(converted.units);
  const refusals: UnitsConversionRefusal[] = [];
  let checks = 0;
  const sourceScope = getParameterScope(source).scope;
  const convertedScope = getParameterScope(converted).scope;
  const derived = lengthDerivedParameters(source, sourceScope);
  const mismatch = (subject: string, field: string, message: string): void => {
    refusals.push({
      code: 'oracle-mismatch',
      subject: `${label}${subject}`,
      field,
      message
    });
  };

  for (const parameter of listParameters(source)) {
    const expected = sourceScope[parameter.name];
    if (expected === undefined) continue;
    const actual = convertedScope[parameter.name];
    const power = parameterScalePower(parameter.quantity);
    const scaled = scaleValue(expected, N, D, power);
    checks += 1;
    if (
      actual === undefined ||
      !agrees(
        expected,
        scaled,
        actual,
        power,
        derived.has(parameter.name),
        parameter.quantity !== 'angle'
      )
    )
      mismatch(
        subjectOf(parameter),
        'expression',
        `${parameter.name} would change meaning: ${power ? `${expected} ${source.units} should become ${scaled} ${converted.units}` : `${expected} should stay ${expected}`}, but evaluates to ${actual ?? 'an error'}.`
      );
  }

  const before = collectLeaves(source);
  const after = collectLeaves(converted);
  if (before.length !== after.length) {
    mismatch('document', '', 'The converted document has different fields.');
    return { refusals, checks };
  }
  before.forEach(({ subject, field, leaf }, index) => {
    const other = after[index]!;
    if (other.field !== field || other.subject !== subject) {
      mismatch(subject, field, 'The converted document has different fields.');
      return;
    }
    const power = scalePower(leaf.quantity);
    if (power === null || leaf.quantity === 'script') return;
    if (typeof leaf.value === 'number') {
      // A stored number scales deterministically, so it must be exactly
      // the canonical scaled value: scaled once, never twice or not at all,
      // with no tolerance that a tiny coordinate could hide under.
      checks += 1;
      const want =
        power === 0
          ? leaf.value
          : canonicalScaledNumber(leaf.value, N ** power, D ** power);
      const got = other.leaf.value;
      if (
        typeof got !== 'number' ||
        !Object.is(got, want) ||
        (power > 0 && !representable(leaf.value, got))
      )
        mismatch(
          subject,
          field,
          `${leaf.value} ${source.units} should be stored as exactly ${want}${power ? ` ${converted.units}` : ''}, but is ${String(got)}.`
        );
      return;
    }
    let expected: number;
    try {
      expected = evaluateLeaf(leaf.value, sourceScope, source.units);
    } catch {
      return; // Broken before conversion: rule D already refused a length.
    }
    checks += 1;
    const scaled = scaleValue(expected, N, D, power);
    let actual: number | undefined;
    try {
      actual = evaluateLeaf(other.leaf.value, convertedScope, converted.units);
    } catch {
      actual = undefined;
    }
    const ok =
      actual !== undefined &&
      (lengthCondition(leaf, sourceScope, source.units)
        ? // A condition holding a length scales with it; the kernel reads
          // only whether it is exactly zero, so sign and zero-ness must hold.
          Number.isFinite(actual) && Math.sign(actual) === Math.sign(expected)
        : agrees(
            expected,
            scaled,
            actual,
            power,
            expressionDerived(leaf.value, sourceScope, source.units, derived),
            leaf.quantity === 'number' || leaf.quantity === 'index'
          ));
    if (!ok)
      mismatch(
        subject,
        field,
        `"${String(leaf.value)}" would change meaning: it is ${expected} ${source.units}${power ? ` (${scaled} ${converted.units})` : ''} before conversion, but "${String(other.leaf.value)}" evaluates to ${actual ?? 'an error'} after.`
      );
  });
  return { refusals, checks };
}

// ---------------------------------------------------------------------------
// The transform
// ---------------------------------------------------------------------------

/**
 * Converts `document`'s stored units to `to` (plan §2, §5.4, §6 step 1).
 * Pure: the input is not mutated, and the same input always gives the same
 * output. See the module comment for what converts and what refuses.
 */
export function convertDocumentUnits(
  document: ProjectDocument,
  to: UnitSystem
): UnitsConversionResult {
  const pre = preconditionRefusals(document, to);
  if (pre.length > 0) return { ok: false, refusals: pre };
  const from = document.units as ConvertibleUnit;
  const target = to as ConvertibleUnit;
  const N = millimetresPerUnit(from);
  const D = millimetresPerUnit(target);
  const lengthDependent = lengthDependentParameters(document);
  const converter: Converter = {
    from,
    to: target,
    N,
    D,
    refusals: [],
    lengthDependent,
    risks: {
      lengthNames: lengthDependent,
      sumNames: lengthSumParameters(document, lengthDependent)
    },
    report: {
      from,
      to: target,
      factor: [N, D],
      scaledNumbers: 0,
      wrapped: [],
      unwrapped: [],
      numerals: [],
      unchangedExpressions: 0,
      configurationRows: 0,
      displayUnits: 'none',
      meshPayloads: 0,
      warnings: [],
      oracleChecks: 0
    }
  };

  const scope = getParameterScope(document).scope;
  const next = treeClone(document);
  for (const id of Object.keys(next.nodes).sort())
    convertNode(converter, next.nodes[id]!, scope);
  walkQuantities(next, DOCUMENT_TOP_LEVEL_QUANTITIES, (leaf) =>
    convertLeaf(converter, leaf, scope, 'document', fieldOf(leaf))
  );
  convertConfigurations(converter, document, next);
  if (converter.refusals.length > 0)
    return { ok: false, refusals: converter.refusals };

  next.units = target;
  for (const node of Object.values(next.nodes))
    if (node.kind === 'project') node.units = target;
  // A referenced payload stays where it is, in the unit it was written in
  // (plan §3.4): absent means the document's unit, which just changed.
  for (const id of Object.keys(next.nodes).sort()) {
    const node = next.nodes[id]!;
    if (
      node.kind !== 'feature' ||
      node.data.featureKind !== 'imported-mesh' ||
      node.data.meshPayloadRef === undefined
    )
      continue;
    const written = node.data.payloadUnits ?? from;
    if (written === target) delete node.data.payloadUnits;
    else node.data.payloadUnits = written;
    converter.report.meshPayloads += 1;
  }
  if (next.displayUnits !== undefined) {
    if (next.displayUnits === target) {
      delete next.displayUnits;
      converter.report.displayUnits = 'cleared';
    } else converter.report.displayUnits = 'kept';
  }
  refreshParameterValues(next);
  // A session projection of the old geometry: drop it so nothing reads
  // meshes, datum frames or warnings in the old unit; a rebuild refills it.
  next.derived = {
    bodyRepresentations: {},
    exportableBodyIds: [],
    warnings: [],
    updatedAt: document.derived.updatedAt
  };
  next.version = document.version + 1;

  const oracle = runOracle(document, next);
  converter.report.oracleChecks = oracle.checks;
  if (oracle.refusals.length > 0)
    return { ok: false, refusals: oracle.refusals };
  return { ok: true, document: next, report: converter.report };
}

/** The oracle over the document and over every other configuration row. */
function runOracle(
  source: ProjectDocument,
  converted: ProjectDocument
): { refusals: UnitsConversionRefusal[]; checks: number } {
  const result = unitsConversionOracle(source, converted);
  const set = source.configurations;
  if (!set) return result;
  for (const row of set.rows) {
    if (row.id === set.activeRowId) continue;
    const label = `configuration "${row.name}": `;
    let rowSource: ProjectDocument;
    let rowConverted: ProjectDocument;
    try {
      rowSource = documentForConfiguration(source, row.id);
      rowConverted = documentForConfiguration(converted, row.id);
    } catch (error) {
      result.refusals.push({
        code: 'oracle-mismatch',
        subject: `configuration "${row.name}"`,
        message: `The converted row cannot be applied (${error instanceof Error ? error.message : 'evaluation failed'}).`
      });
      continue;
    }
    const rowResult = unitsConversionOracle(rowSource, rowConverted, label);
    result.refusals.push(...rowResult.refusals);
    result.checks += rowResult.checks;
  }
  return result;
}

/** The registry scope of one node (phase 4's reference sites walk the same). */
export const unitsConversionNodeScope = nodeScope;

/** How a conversion refusal names a node: `Name (id)`. */
export const unitsConversionSubject = subjectOf;
