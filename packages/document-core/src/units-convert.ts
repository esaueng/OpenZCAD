import {
  FEATURE_QUANTITIES,
  PARAMETER_QUANTITIES,
  SKETCH_NODE_QUANTITIES,
  SKETCH_OBJECT_QUANTITIES,
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
  getExpressionDimensions,
  getParameterScope,
  listParameters,
  refreshParameterValues
} from './index';

/**
 * I03 stored-unit conversion, phase 2 (plan
 * `docs/plans/i03-stored-unit-conversion-plan.md` §2, §5.4, §6 step 1, §9):
 * the pure document transform that rewrites a document from `units = A` to
 * `units = B`, and the field-level oracle that checks it. Nothing calls it
 * yet: the `units.convert` command (phase 5) and the reference re-capture
 * (phase 4) wire it in.
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
 *   PMI, assemblies and reference images;
 * - an imported mesh whose triangles live in a content-addressed payload
 *   with no unit of its own (plan §3.4, phase 3);
 * - a length field whose expression does not evaluate, or evaluates to
 *   something other than a length or a plain number;
 * - any field whose converted value is not the scaled original (the oracle,
 *   §6 step 1): `round(width)` with a typed `width` is the classic case.
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
  /** Configuration rows whose cells were rewritten, active row included. */
  configurationRows: number;
  /** What happened to `displayUnits` (plan §5.4). */
  displayUnits: 'none' | 'cleared' | 'kept';
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
  const scaled = (value * N) / D;
  if (scaled === 0 || !Number.isFinite(scaled))
    return scaled === 0 ? 0 : scaled;
  const precision = Math.max(15, significantDigits(value));
  for (const digits of [15, 16, 17]) {
    const candidate = Number(scaled.toPrecision(digits));
    if (Number(((candidate * D) / N).toPrecision(precision)) === value)
      return candidate;
  }
  return scaled;
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
    )
      refusals.push({
        code: 'imported-mesh-payload',
        subject: subjectOf(node),
        field: 'meshPayloadRef',
        message: `${node.name} keeps its triangles in a stored payload in document units, which cannot be converted yet.`
      });
  }
  return refusals;
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
  let dimensions: { length: number; angle: number };
  try {
    dimensions = getExpressionDimensions(expression, scope, {
      documentUnits: from
    });
  } catch (error) {
    converter.refusals.push({
      code: 'unclassifiable',
      subject,
      field,
      message: `"${expression}" does not evaluate (${error instanceof Error ? error.message : 'evaluation failed'}), so its unit cannot be decided.`
    });
    return undefined;
  }
  if (dimensions.length === 1 && dimensions.angle === 0) {
    report.unchangedExpressions += 1;
    return expression;
  }
  if (dimensions.length !== 0 || dimensions.angle !== 0) {
    converter.refusals.push({
      code: 'unclassifiable',
      subject,
      field,
      message: `"${expression}" is not a length or a plain number, so it cannot be converted.`
    });
    return undefined;
  }
  if (PURE_NUMERAL.test(expression)) {
    const after = String(canonicalScaledNumber(Number(expression), N, D));
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

/** Converts one classified leaf of the clone in place. */
function convertLeaf(
  converter: Converter,
  leaf: QuantityLeaf,
  scope: Record<string, number>,
  subject: string,
  field: string
): void {
  const power = scalePower(leaf.quantity);
  if (!power) return;
  if (typeof leaf.value === 'number') {
    const { N, D } = converter;
    leaf.holder[leaf.key] = canonicalScaledNumber(
      leaf.value,
      N ** power,
      D ** power
    );
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
    if (parameterScalePower(node.quantity) === 0) return;
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
 * Rewrites every row's cells for typed-length parameters, each evaluated
 * in the document as that row makes it (the active row in the document
 * itself), so a row's own values decide its own rewrite.
 */
function convertConfigurations(
  converter: Converter,
  source: ProjectDocument,
  target: ProjectDocument
): void {
  const set = target.configurations;
  if (!set) return;
  const lengthParameters = new Set(
    listParameters(source)
      .filter((parameter) => parameter.quantity === 'length')
      .map((parameter) => parameter.parameterId)
  );
  for (const row of set.rows) {
    const subject = `configuration "${row.name}"`;
    let scope: Record<string, number>;
    try {
      scope = getParameterScope(
        row.id === set.activeRowId
          ? source
          : documentForConfiguration(source, row.id)
      ).scope;
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
      if (!lengthParameters.has(parameterId)) continue;
      const next = convertLengthExpression(
        converter,
        expression,
        scope,
        subject,
        `parameters.${parameterId}`
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

function agrees(expected: number, actual: number): boolean {
  if (expected === actual) return true;
  const magnitude = Math.max(Math.abs(expected), Math.abs(actual));
  return (
    Math.abs(expected - actual) <=
    UNITS_CONVERSION_ORACLE_TOLERANCE * Math.max(magnitude, 1)
  );
}

/**
 * Evaluates every classified field (and every parameter) of `source` and
 * `converted` and checks that lengths scaled by k, areas by k² and
 * everything else is equal, at {@link UNITS_CONVERSION_ORACLE_TOLERANCE}
 * relative (absolute below one unit, where rounding to 15 digits and
 * cancellation meet). A field that evaluated before and not after, or to
 * another value, is a refusal naming it. Hash leaves are skipped: phase 4
 * re-captures them.
 */
export function unitsConversionOracle(
  source: ProjectDocument,
  converted: ProjectDocument,
  label = ''
): { refusals: UnitsConversionRefusal[]; checks: number } {
  const k =
    millimetresPerUnit(source.units) / millimetresPerUnit(converted.units);
  const refusals: UnitsConversionRefusal[] = [];
  let checks = 0;
  const sourceScope = getParameterScope(source).scope;
  const convertedScope = getParameterScope(converted).scope;
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
    const scaled = expected * k ** parameterScalePower(parameter.quantity);
    checks += 1;
    if (actual === undefined || !agrees(scaled, actual))
      mismatch(
        subjectOf(parameter),
        'expression',
        `${parameter.name} would change meaning: ${expected} ${source.units} should become ${scaled} ${converted.units}, but evaluates to ${actual ?? 'an error'}.`
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
    if (power === null || leaf.role === 'literal' || leaf.quantity === 'script')
      return;
    let expected: number;
    try {
      expected = evaluateLeaf(leaf.value, sourceScope, source.units);
    } catch {
      return; // Broken before conversion: rule D already refused a length.
    }
    checks += 1;
    const scaled = expected * k ** power;
    let actual: number | undefined;
    try {
      actual = evaluateLeaf(other.leaf.value, convertedScope, converted.units);
    } catch {
      actual = undefined;
    }
    if (actual === undefined || !agrees(scaled, actual))
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
  const converter: Converter = {
    from,
    to: target,
    N,
    D,
    refusals: [],
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
