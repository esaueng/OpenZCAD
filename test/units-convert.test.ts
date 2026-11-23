/**
 * I03 stored-unit conversion, phase 2: `convertDocumentUnits`, expression
 * rule D, numeral canonicalization and the field-level oracle (plan
 * `docs/plans/i03-stored-unit-conversion-plan.md` §2.2, §5.4, §6, §9).
 */
import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  RESERVED_IDENTIFIERS,
  UNITS_CONVERSION_OPERATION_SCALING,
  activateConfiguration,
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  canonicalScaledNumber,
  convertDocumentUnits,
  createConfigurations,
  createProjectDocument,
  evaluateExpression,
  getParameterScope,
  listParameters,
  normalizeDocument,
  setConfigurationCell,
  setDisplayUnits,
  setParameter,
  unitsConversionOracle,
  type UnitsConversionRefusal,
  type UnitsConversionResult
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_QUANTITIES,
  SKETCH_NODE_QUANTITIES,
  SKETCH_OBJECT_QUANTITIES,
  toUserId,
  walkQuantities,
  type DocumentNode,
  type FeatureData,
  type ParameterKind,
  type ProjectDocument,
  type QuantityLeaf,
  type QuantityMapShape,
  type SwitchQuantity,
  type UnitSystem
} from '@openzcad/shared';

import { PARITY_SCENARIOS } from './parity/scenarios';
import {
  assertUnitRoundTrips,
  reportRefusalRate
} from './support/units-convert-round-trip';
import {
  SAMPLE_FEATURES,
  SAMPLE_SKETCH_NODES,
  SAMPLE_SKETCH_OBJECTS
} from './support/quantity-registry-samples';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newDocument(units: UnitSystem = 'mm'): ProjectDocument {
  return createProjectDocument('Units', toUserId('user_units'), units);
}

function withParameter(
  document: ProjectDocument,
  name: string,
  expression: string,
  quantity?: ParameterKind
): ProjectDocument {
  return setParameter(document, {
    name,
    expression,
    ...(quantity ? { quantity } : {})
  });
}

function withBox(
  document: ProjectDocument,
  name: string,
  dimensions: Record<string, string | number>
): ProjectDocument {
  return addPrimitiveFeature(document, {
    name,
    primitiveKind: 'box',
    dimensions: { width: 1, height: 1, depth: 1, ...dimensions }
  });
}

function feature(
  document: ProjectDocument,
  name: string
): Extract<DocumentNode, { kind: 'feature' }> {
  const node = Object.values(document.nodes).find(
    (candidate) => candidate.kind === 'feature' && candidate.name === name
  );
  if (!node || node.kind !== 'feature') throw new Error(`no feature ${name}`);
  return node;
}

function boxWidth(document: ProjectDocument, name: string): string | number {
  const data = feature(document, name).data as Extract<
    FeatureData,
    { featureKind: 'primitive' }
  >;
  return data.dimensions.width!;
}

function converted(result: UnitsConversionResult): ProjectDocument {
  if (!result.ok)
    throw new Error(
      `refused: ${result.refusals.map((refusal) => refusal.message).join(' | ')}`
    );
  return result.document;
}

function refusals(result: UnitsConversionResult): UnitsConversionRefusal[] {
  if (result.ok) throw new Error('expected a refusal');
  return result.refusals;
}

/** One box whose width is `expression`, converted mm → `to`. */
function convertWidth(
  expression: string,
  to: UnitSystem = 'inch',
  parameters: [string, string, ParameterKind?][] = []
): UnitsConversionResult {
  let document = newDocument('mm');
  for (const [name, value, quantity] of parameters)
    document = withParameter(document, name, value, quantity);
  document = withBox(document, 'Box', { width: expression });
  return convertDocumentUnits(document, to);
}

function parameterValues(document: ProjectDocument): Record<string, number> {
  return Object.fromEntries(
    listParameters(document).map((parameter) => [
      parameter.name,
      parameter.value
    ])
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A document holding every registry sample (plan §1, every class). */
function sampleDocument(units: UnitSystem = 'mm'): ProjectDocument {
  const document = newDocument(units);
  const base = { parentId: null, revisionId: null };
  let index = 0;
  const add = (node: Record<string, unknown>) => {
    const id = `sample-${String(index++).padStart(3, '0')}`;
    document.nodes[id] = { ...base, name: id, ...node, id } as DocumentNode;
  };
  for (const data of SAMPLE_FEATURES) {
    // A custom feature and a stored mesh payload refuse (tested below).
    if (data.featureKind === 'custom-feature') continue;
    const stored =
      data.featureKind === 'imported-mesh'
        ? (({ meshPayloadRef: _ref, ...rest }) => rest)(data)
        : data;
    add({
      kind: 'feature',
      featureId: `f${index}`,
      featureKind: data.featureKind,
      data: structuredClone(stored)
    });
  }
  for (const data of SAMPLE_SKETCH_OBJECTS)
    add({
      kind: 'sketch-object',
      objectKind: data.objectKind,
      data: structuredClone(data)
    });
  for (const node of SAMPLE_SKETCH_NODES)
    add(structuredClone(node) as unknown as Record<string, unknown>);
  return document;
}

function nodeMap(
  node: DocumentNode
): { value: object; map: QuantityMapShape | SwitchQuantity<never> } | null {
  if (node.kind === 'feature')
    return { value: node.data, map: FEATURE_QUANTITIES };
  if (node.kind === 'sketch-object')
    return { value: node.data, map: SKETCH_OBJECT_QUANTITIES };
  if (node.kind === 'sketch')
    return { value: node, map: SKETCH_NODE_QUANTITIES };
  return null;
}

function leaves(document: ProjectDocument): Map<string, QuantityLeaf> {
  const out = new Map<string, QuantityLeaf>();
  for (const [id, node] of Object.entries(document.nodes)) {
    const scoped = nodeMap(node);
    if (scoped)
      walkQuantities(scoped.value, scoped.map, (leaf) =>
        out.set(`${id} ${leaf.path.join('.')}`, leaf)
      );
  }
  return out;
}

/** Every expression-capable leaf of `document` set to `expression`. */
function expressionsEverywhere(
  document: ProjectDocument,
  expression: string
): ProjectDocument {
  const next = structuredClone(document);
  for (const node of Object.values(next.nodes)) {
    const scoped = nodeMap(node);
    if (scoped)
      walkQuantities(scoped.value, scoped.map, (leaf) => {
        if (leaf.role !== 'literal') leaf.holder[leaf.key] = expression;
      });
  }
  return next;
}

// ---------------------------------------------------------------------------
// Every registry class
// ---------------------------------------------------------------------------

describe('convertDocumentUnits: registry classes', () => {
  it('scales lengths and positions by k, areas by k², and nothing else', () => {
    const source = sampleDocument('mm');
    const result = convertDocumentUnits(source, 'inch');
    const target = converted(result);
    const before = leaves(source);
    const after = leaves(target);
    expect(after.size).toBe(before.size);
    const seen = new Set<string>();
    for (const [path, leaf] of before) {
      const next = after.get(path)!;
      seen.add(leaf.quantity);
      expect(typeof leaf.value, path).toBe('number');
      const value = leaf.value as number;
      switch (leaf.quantity) {
        case 'length':
        case 'position':
          expect(next.value, `${path} ${leaf.quantity}`).toBe(
            canonicalScaledNumber(value, 1, 25.4)
          );
          break;
        case 'area':
          expect(next.value, path).toBe(
            canonicalScaledNumber(value, 1, 25.4 * 25.4)
          );
          break;
        default:
          // Angles, radians, counts, ratios, directions, fractions,
          // conditions, indices and hashes keep their stored value.
          expect(next.value, `${path} ${leaf.quantity}`).toBe(value);
      }
    }
    // The samples reach every class a feature or sketch can hold.
    expect([...seen].sort()).toEqual([
      'angle',
      'angle-rad',
      'area',
      'condition',
      'direction',
      'fraction',
      'hash',
      'index',
      'length',
      'number',
      'position'
    ]);
    expect(target.units).toBe('inch');
    if (!result.ok) return;
    expect(result.report.scaledNumbers).toBeGreaterThan(100);
  });

  it('treats a gear pitch and an arc lock by their instance', () => {
    const target = converted(convertDocumentUnits(sampleDocument(), 'cm'));
    const pitches = Object.values(target.nodes)
      .filter(
        (node): node is Extract<DocumentNode, { kind: 'feature' }> =>
          node.kind === 'feature' && node.data.featureKind === 'gear'
      )
      .map(
        (node) =>
          (node.data as Extract<FeatureData, { featureKind: 'gear' }>).pitch
      );
    // Module sizing: a length. Diametral pitch: teeth per inch, unchanged.
    expect(pitches).toEqual([0.1, 1]);
    const sketch = Object.values(target.nodes).find(
      (node) => node.kind === 'sketch' && node.constraints?.length
    ) as Extract<DocumentNode, { kind: 'sketch' }>;
    const locks = sketch
      .constraints!.map((constraint) => constraint.data)
      .filter((data) => data.constraintKind === 'lock-entity')
      .map((data) => data.at);
    expect(locks).toEqual([
      [0.1, 0.1, 0.1, 0.1],
      [0.1, 0.1, 0.1, 1, 1]
    ]);
  });

  it('wraps a unitless expression in every length field and leaves the rest', () => {
    let source = sampleDocument('mm');
    source = withParameter(source, 'u', '2');
    source = expressionsEverywhere(source, 'u');
    const target = converted(convertDocumentUnits(source, 'inch'));
    const before = leaves(source);
    const after = leaves(target);
    let wrapped = 0;
    for (const [path, leaf] of before) {
      if (leaf.role === 'literal') continue;
      const next = after.get(path)!.value;
      if (leaf.quantity === 'length' || leaf.quantity === 'position') {
        expect(next, path).toBe('(u) / 25.4');
        wrapped += 1;
      } else expect(next, `${path} ${leaf.quantity}`).toBe('u');
    }
    // Including the fields `rewriteNodeExpressions` does not visit today
    // (a tapped hole's length, a sketch pattern's spacing): conversion goes
    // by class whatever the visit role.
    expect(
      after.get([...after.keys()].find((key) => key.endsWith('tapped.length'))!)
        ?.value
    ).toBe('(u) / 25.4');
    expect(wrapped).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Rule D (plan §2.2)
// ---------------------------------------------------------------------------

describe('convertDocumentUnits: expression rule D', () => {
  it('leaves an expression that carries its own length unchanged', () => {
    for (const expression of ['5 mm', '2 cm + 3 mm', '1\' 2"', 'w + 2 mm']) {
      const target = converted(
        convertWidth(expression, 'inch', [['w', '10', 'length']])
      );
      expect(boxWidth(target, 'Box')).toBe(expression);
    }
  });

  it('wraps a unit-free expression with an exact short factor', () => {
    const cases: [UnitSystem, string][] = [
      ['inch', '(20 / 2) / 25.4'],
      ['cm', '(20 / 2) / 10']
    ];
    for (const [to, expected] of cases)
      expect(boxWidth(converted(convertWidth('20 / 2', to)), 'Box')).toBe(
        expected
      );
    let inch = newDocument('inch');
    inch = withBox(inch, 'Box', { width: '20 / 2' });
    expect(boxWidth(converted(convertDocumentUnits(inch, 'mm')), 'Box')).toBe(
      '(20 / 2) * 25.4'
    );
    expect(boxWidth(converted(convertDocumentUnits(inch, 'cm')), 'Box')).toBe(
      '(20 / 2) * 2.54'
    );
    let cm = newDocument('cm');
    cm = withBox(cm, 'Box', { width: '20 / 2' });
    expect(boxWidth(converted(convertDocumentUnits(cm, 'inch')), 'Box')).toBe(
      '(20 / 2) / 2.54'
    );
  });

  it('keeps scale-variant functions over a unit-free length exact', () => {
    for (const expression of [
      'round(10.4)',
      'floor(w * 1.3)',
      'ceil(w / 3)',
      'mod(w, 4)'
    ]) {
      const result = convertWidth(expression, 'inch', [['w', '10']]);
      expect(boxWidth(converted(result), 'Box')).toBe(`(${expression}) / 25.4`);
    }
  });

  it('refuses round(width) over a typed length, naming the field', () => {
    const result = convertWidth('round(width)', 'inch', [
      ['width', '10.4', 'length']
    ]);
    const [refusal, ...rest] = refusals(result);
    expect(rest).toEqual([]);
    expect(refusal).toMatchObject({
      code: 'scale-variant',
      field: 'dimensions.width'
    });
    expect(refusal!.subject).toContain('Box');
    expect(refusal!.message).toContain('round(width)');
    expect(refusal!.message).toContain('round() of a length');
  });

  it('refuses a scale-variant typed parameter the same way', () => {
    const result = convertWidth('w2', 'inch', [
      ['width', '10.4', 'length'],
      ['w2', 'round(width)', 'length']
    ]);
    expect(refusals(result)).toEqual([
      expect.objectContaining({
        code: 'scale-variant',
        subject: expect.stringContaining('w2') as string,
        field: 'expression'
      })
    ]);
  });

  it('refuses an unitless parameter that holds a length', () => {
    // `5 mm` in a legacy unitless parameter is the number of document units:
    // after conversion it would be another number.
    const result = convertWidth('w', 'inch', [['w', '5 mm']]);
    expect(refusals(result)).toEqual([
      expect.objectContaining({
        code: 'scale-variant',
        subject: expect.stringContaining('w') as string,
        field: 'expression'
      })
    ]);
  });

  it('keeps trigonometry: angles never scale', () => {
    const lengths = converted(
      convertWidth('w * sin(30)', 'inch', [['w', '10', 'length']])
    );
    expect(boxWidth(lengths, 'Box')).toBe('w * sin(30)');
    const numbers = converted(convertWidth('10 * cos(60)', 'inch'));
    expect(boxWidth(numbers, 'Box')).toBe('(10 * cos(60)) / 25.4');
    const angle = converted(convertWidth('5', 'inch', [['a', '30', 'angle']]));
    expect(listParameters(angle)[0]).toMatchObject({
      expression: '30',
      value: 30
    });
  });

  it('keeps a*b as "a number of the old unit"', () => {
    const target = converted(
      convertWidth('a * b', 'inch', [
        ['a', '3'],
        ['b', '4']
      ])
    );
    expect(boxWidth(target, 'Box')).toBe('(a * b) / 25.4');
    // a and b are unitless: untouched, so every count or ratio use survives.
    expect(listParameters(target).map((p) => p.expression)).toEqual(['3', '4']);
  });

  it('converts typed-length parameters by the same rule and recomputes values', () => {
    let document = newDocument('mm');
    document = withParameter(document, 'w', '10', 'length');
    document = withParameter(document, 'h', '2 * 3', 'length');
    document = withParameter(document, 'd', 'w + 1 mm', 'length');
    document = withParameter(document, 'n', '4', 'number');
    document = withParameter(document, 'a', '45', 'angle');
    document = withParameter(document, 'u', '7');
    const target = converted(convertDocumentUnits(document, 'inch'));
    expect(
      listParameters(target).map((parameter) => [
        parameter.name,
        parameter.expression
      ])
    ).toEqual([
      ['w', '0.393700787401575'],
      ['h', '(2 * 3) / 25.4'],
      ['d', 'w + 1 mm'],
      ['n', '4'],
      ['a', '45'],
      ['u', '7']
    ]);
    const values = parameterValues(target);
    expect(values.w).toBeCloseTo(10 / 25.4, 14);
    expect(values.h).toBeCloseTo(6 / 25.4, 14);
    expect(values.d).toBeCloseTo(11 / 25.4, 14);
    expect([values.n, values.a, values.u]).toEqual([4, 45, 7]);
  });

  it('refuses a length field that does not evaluate', () => {
    const [refusal] = refusals(convertWidth('missing * 2'));
    expect(refusal).toMatchObject({
      code: 'unclassifiable',
      field: 'dimensions.width'
    });
  });
});

// ---------------------------------------------------------------------------
// Numerals and wrappers
// ---------------------------------------------------------------------------

describe('convertDocumentUnits: numerals and wrappers', () => {
  it('canonicalizes scaled numbers to 15 significant digits', () => {
    expect(canonicalScaledNumber(10, 1, 25.4)).toBe(0.393700787401575);
    expect(canonicalScaledNumber(0.393700787401575, 25.4, 1)).toBe(10);
    expect(canonicalScaledNumber(1, 1, 10)).toBe(0.1);
    expect(canonicalScaledNumber(0, 25.4, 1)).toBe(0);
    expect(Object.is(canonicalScaledNumber(-0, 25.4, 1), 0)).toBe(true);
    // Fifteen digits alone would bring 3 mm back as 2.99999999999999 mm:
    // the shortest rounding that converts back exactly is kept instead.
    expect(Number(((3 * 1) / 25.4).toPrecision(15))).toBe(0.118110236220472);
    const three = canonicalScaledNumber(3, 1, 25.4);
    expect(three).toBe(0.1181102362204725);
    expect(canonicalScaledNumber(three, 25.4, 1)).toBe(3);
    // Every short decimal survives mm → in → mm and mm → cm → mm.
    for (let tenths = -2000; tenths <= 2000; tenths += 1) {
      const value = tenths / 10;
      for (const D of [25.4, 10]) {
        const there = canonicalScaledNumber(value, 1, D);
        expect(canonicalScaledNumber(there, D, 1), `${value} via ${D}`).toBe(
          value === 0 ? 0 : value
        );
      }
    }
    const target = converted(convertWidth('12.5', 'inch'));
    expect(boxWidth(target, 'Box')).toBe('0.492125984251969');
    const numeric = converted(
      convertDocumentUnits(withBox(newDocument(), 'Box', { width: 12.5 }), 'cm')
    );
    expect(boxWidth(numeric, 'Box')).toBe(1.25);
  });

  it('unwraps its own wrapper so a round trip restores the text', () => {
    const there = converted(convertWidth('w * 2', 'inch', [['w', '3']]));
    expect(boxWidth(there, 'Box')).toBe('(w * 2) / 25.4');
    const back = converted(convertDocumentUnits(there, 'mm'));
    expect(boxWidth(back, 'Box')).toBe('w * 2');
  });

  it('never stacks wrappers, through any chain of units', () => {
    let document = withParameter(newDocument('mm'), 'w', '3');
    document = withBox(document, 'Box', { width: 'w * 2' });
    const texts: string[] = [];
    for (const to of ['cm', 'inch', 'cm', 'mm', 'inch', 'mm'] as const) {
      document = converted(convertDocumentUnits(document, to));
      texts.push(String(boxWidth(document, 'Box')));
    }
    expect(texts).toEqual([
      '(w * 2) / 10',
      '(w * 2) / 25.4',
      '(w * 2) / 10',
      'w * 2',
      '(w * 2) / 25.4',
      'w * 2'
    ]);
  });

  it('does not take a lookalike for a wrapper', () => {
    // `(a) * (b) / 25.4` ends like a wrapper but its first parenthesis
    // closes early: it is wrapped like any other unit-free expression.
    const target = converted(
      convertWidth('(a) * (b) / 25.4', 'inch', [
        ['a', '3'],
        ['b', '4']
      ])
    );
    expect(boxWidth(target, 'Box')).toBe('((a) * (b) / 25.4) / 25.4');
  });
});

// ---------------------------------------------------------------------------
// Configurations, display units, immutability
// ---------------------------------------------------------------------------

describe('convertDocumentUnits: the rest of the document', () => {
  it('rewrites every configuration row, not only the active one', () => {
    let document = newDocument('mm');
    document = withParameter(document, 'width', '20', 'length');
    document = withParameter(document, 'count', '3', 'number');
    document = withBox(document, 'Box', { width: 'width' });
    const [width, count] = listParameters(document).map((p) => p.parameterId);
    document = createConfigurations(document, { rowId: 'small', name: 'S' });
    for (const parameterId of [width!, count!])
      document = addConfigurationColumn(document, {
        column: { kind: 'parameter', parameterId }
      });
    document = addConfigurationRow(document, { rowId: 'large', name: 'L' });
    document = setConfigurationCell(document, {
      rowId: 'large',
      column: { kind: 'parameter', parameterId: width! },
      value: 'count * 15'
    });
    document = addConfigurationRow(document, { rowId: 'suffix', name: 'X' });
    document = setConfigurationCell(document, {
      rowId: 'suffix',
      column: { kind: 'parameter', parameterId: width! },
      value: '2 in'
    });
    const result = convertDocumentUnits(document, 'inch');
    const target = converted(result);
    const rows = target.configurations!.rows.map((row) => [
      row.id,
      row.parameters[width!],
      row.parameters[count!]
    ]);
    expect(rows).toEqual([
      ['small', '0.78740157480315', '3'],
      ['large', '(count * 15) / 25.4', '3'],
      ['suffix', '2 in', '3']
    ]);
    if (result.ok) expect(result.report.configurationRows).toBe(3);
  });

  it('refuses a configuration row that would change meaning', () => {
    let document = newDocument('mm');
    document = withParameter(document, 'width', '20', 'length');
    document = withParameter(document, 'w2', 'width', 'length');
    document = withBox(document, 'Box', { width: 'w2' });
    const [, w2] = listParameters(document).map((p) => p.parameterId);
    document = createConfigurations(document, { rowId: 'a', name: 'A' });
    document = addConfigurationColumn(document, {
      column: { kind: 'parameter', parameterId: w2! }
    });
    document = addConfigurationRow(document, { rowId: 'b', name: 'B' });
    document = setConfigurationCell(document, {
      rowId: 'b',
      column: { kind: 'parameter', parameterId: w2! },
      value: 'round(width / 3)'
    });
    expect(refusals(convertDocumentUnits(document, 'inch'))).toEqual([
      expect.objectContaining({
        code: 'scale-variant',
        subject: 'configuration "B"',
        field: `parameters.${w2!}`
      })
    ]);
  });

  it('converts the print clearance', () => {
    const document = { ...newDocument('mm'), printClearance: '0.2' };
    expect(converted(convertDocumentUnits(document, 'cm')).printClearance).toBe(
      '0.02'
    );
    const numeric = { ...newDocument('mm'), printClearance: 0.25 };
    expect(
      converted(convertDocumentUnits(numeric, 'inch')).printClearance
    ).toBe(0.00984251968503937);
  });

  it('sets both unit tags and shows the new stored unit (§5.4)', () => {
    const plain = converted(convertDocumentUnits(newDocument('mm'), 'inch'));
    expect(plain.units).toBe('inch');
    for (const node of Object.values(plain.nodes))
      if (node.kind === 'project') expect(node.units).toBe('inch');
    expect('displayUnits' in plain).toBe(false);

    const shownInInch = setDisplayUnits(newDocument('mm'), { units: 'inch' });
    const cleared = convertDocumentUnits(shownInInch, 'inch');
    expect('displayUnits' in converted(cleared)).toBe(false);
    if (cleared.ok) expect(cleared.report.displayUnits).toBe('cleared');

    const shownInCm = setDisplayUnits(newDocument('mm'), { units: 'cm' });
    const kept = convertDocumentUnits(shownInCm, 'inch');
    expect(converted(kept).displayUnits).toBe('cm');
    if (kept.ok) expect(kept.report.displayUnits).toBe('kept');

    const shownInM = setDisplayUnits(newDocument('mm'), { units: 'm' });
    expect(converted(convertDocumentUnits(shownInM, 'cm')).displayUnits).toBe(
      'm'
    );
  });

  it('drops derived state and bumps the version', () => {
    const document = withBox(newDocument('mm'), 'Box', {});
    const target = converted(convertDocumentUnits(document, 'cm'));
    expect(target.derived.bodyRepresentations).toEqual({});
    expect(target.derived.warnings).toEqual([]);
    expect(target.version).toBe(document.version + 1);
  });

  it('never mutates its input', () => {
    let document = newDocument('mm');
    document = withParameter(document, 'w', '10', 'length');
    document = withParameter(document, 'u', '3');
    document = withBox(document, 'Box', { width: 'w', height: 'u * 2' });
    document = setDisplayUnits(document, { units: 'inch' });
    const snapshot = JSON.stringify(document);
    deepFreeze(document);
    const target = converted(convertDocumentUnits(document, 'inch'));
    expect(JSON.stringify(document)).toBe(snapshot);
    expect(target).not.toBe(document);
    expect(target.nodes).not.toBe(document.nodes);
    // Refusals do not mutate either.
    convertDocumentUnits(document, 'm');
    convertWidth('round(width)', 'inch', [['width', '10.4', 'length']]);
    expect(JSON.stringify(document)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('convertDocumentUnits: refusals', () => {
  it('refuses metres either way, and no change of unit', () => {
    expect(refusals(convertDocumentUnits(newDocument('mm'), 'm'))).toEqual([
      expect.objectContaining({ code: 'unsupported-unit' })
    ]);
    expect(refusals(convertDocumentUnits(newDocument('m'), 'mm'))).toEqual([
      expect.objectContaining({ code: 'unsupported-unit' })
    ]);
    expect(refusals(convertDocumentUnits(newDocument('cm'), 'cm'))).toEqual([
      expect.objectContaining({ code: 'same-unit' })
    ]);
  });

  it('refuses any custom-feature script', () => {
    const document = newDocument('mm');
    const custom = SAMPLE_FEATURES.find(
      (data) => data.featureKind === 'custom-feature'
    )!;
    document.nodes.custom = {
      id: 'custom',
      parentId: null,
      revisionId: null,
      name: 'Knurl',
      kind: 'feature',
      featureId: 'custom' as never,
      featureKind: 'custom-feature',
      data: custom
    } as unknown as DocumentNode;
    expect(refusals(convertDocumentUnits(document, 'inch'))).toEqual([
      expect.objectContaining({
        code: 'custom-feature',
        subject: 'Knurl (custom)'
      })
    ]);
  });

  it('refuses an imported mesh with a stored payload', () => {
    const document = newDocument('mm');
    const mesh = SAMPLE_FEATURES.find(
      (data) => data.featureKind === 'imported-mesh'
    )!;
    expect('meshPayloadRef' in mesh).toBe(true);
    document.nodes.mesh = {
      id: 'mesh',
      parentId: null,
      revisionId: null,
      name: 'Scan',
      kind: 'feature',
      featureId: 'mesh' as never,
      featureKind: 'imported-mesh',
      data: mesh
    } as unknown as DocumentNode;
    expect(refusals(convertDocumentUnits(document, 'inch'))).toEqual([
      expect.objectContaining({ code: 'imported-mesh-payload' })
    ]);
  });

  it('refuses the areas it does not convert yet, and only when they hold data', () => {
    const empty: ProjectDocument = {
      ...newDocument('mm'),
      drawings: { sheets: [] },
      pmi: { annotations: [] },
      referenceImages: { images: [] },
      assembly: {
        components: [],
        joints: [],
        positions: [],
        studies: []
      }
    };
    expect(convertDocumentUnits(empty, 'inch').ok).toBe(true);
    const full = {
      ...empty,
      drawings: { sheets: [{}] },
      pmi: { annotations: [{}] },
      referenceImages: { images: [{}] },
      assembly: { ...empty.assembly!, components: [{}] }
    } as unknown as ProjectDocument;
    expect(
      refusals(convertDocumentUnits(full, 'inch')).map((refusal) => [
        refusal.code,
        refusal.subject
      ])
    ).toEqual([
      ['unsupported-area', 'drawings'],
      ['unsupported-area', 'pmi'],
      ['unsupported-area', 'assembly'],
      ['unsupported-area', 'referenceImages']
    ]);
  });

  it('has an oracle that catches a hand-made misconversion', () => {
    const document = withBox(newDocument('mm'), 'Box', { width: 10 });
    const target = converted(convertDocumentUnits(document, 'inch'));
    expect(unitsConversionOracle(document, target).refusals).toEqual([]);
    // Pretend a field was missed: left at 10 in an inch document.
    const broken = structuredClone(target);
    (
      feature(broken, 'Box').data as Extract<
        FeatureData,
        { featureKind: 'primitive' }
      >
    ).dimensions.width = 10;
    expect(unitsConversionOracle(document, broken).refusals).toEqual([
      expect.objectContaining({
        code: 'oracle-mismatch',
        field: 'dimensions.width'
      })
    ]);
  });
});

// ---------------------------------------------------------------------------
// Round trips over real documents
// ---------------------------------------------------------------------------

const FIXTURE_DOCUMENTS = [
  'test/fixtures/legacy-documents/writer-8dcb1643b.json',
  'test/scripting/contract/v1/history/document.json'
];

describe('convertDocumentUnits: round trips', () => {
  const corpus: { key: string; document: ProjectDocument }[] = [];

  beforeAll(async () => {
    const adapter = await createExactKernelAdapter();
    for (const scenario of PARITY_SCENARIOS) {
      if (scenario.expectedBuildFailure) continue;
      corpus.push({
        key: `parity:${scenario.key}`,
        document: await scenario.build((doc) => adapter.syncDocument(doc))
      });
    }
    for (const path of FIXTURE_DOCUMENTS)
      corpus.push({
        key: path,
        document: normalizeDocument(
          JSON.parse(readFileSync(path, 'utf8')) as ProjectDocument
        )
      });
    corpus.push({ key: 'samples', document: sampleDocument('mm') });
  }, 180_000);

  it('restores every document byte for byte, or refuses it with a reason', () => {
    const outcomes = new Map<string, string[]>();
    let checks = 0;
    for (const { key, document } of corpus) {
      const { reasons, oracleChecks } = assertUnitRoundTrips(key, document);
      outcomes.set(key, reasons);
      checks += oracleChecks;
    }
    // Not vacuous: the oracle evaluated real fields.
    expect(checks).toBeGreaterThan(200);
    const { converted: count, refused } = reportRefusalRate(
      'unit conversion (parity scenarios, fixtures, samples)',
      outcomes
    );
    // Pinned so a change in what converts is seen: the Scissors demo holds
    // an assembly and the scripting fixture a custom feature (both refused
    // by design until later I03 phases); everything else converts.
    expect({ count, refused }).toEqual({
      count: corpus.length - 2,
      refused: 2
    });
    expect(outcomes.get('parity:scissors')).toEqual([
      'unsupported-area: assembly'
    ]);
    expect(
      outcomes.get('test/scripting/contract/v1/history/document.json')
    ).toEqual([expect.stringMatching(/^custom-feature: /)]);
  });
});

// ---------------------------------------------------------------------------
// Review findings on #1965: zero crossings, overflow, scale-variant
// formulas whose value happens to agree, and the active row's stale cells
// ---------------------------------------------------------------------------

/** A raw feature node, for kinds without a document command here. */
function withFeatureNode(
  document: ProjectDocument,
  id: string,
  data: Record<string, unknown>
): ProjectDocument {
  const next = structuredClone(document);
  next.nodes[id] = {
    id,
    parentId: null,
    revisionId: null,
    name: id,
    kind: 'feature',
    featureId: id,
    featureKind: data.featureKind,
    data
  } as unknown as DocumentNode;
  return next;
}

function featureData<T>(document: ProjectDocument, id: string): T {
  return (document.nodes[id] as unknown as { data: T }).data;
}

/** Evaluates `expression` in `document`'s own scope and units. */
function valueIn(document: ProjectDocument, expression: string): number {
  return evaluateExpression(expression, getParameterScope(document).scope, {
    documentUnits: document.units
  });
}

/** The box's width as a number of millimetres, whatever the stored unit. */
function boxWidthMm(document: ProjectDocument): number {
  const width = boxWidth(document, 'Box');
  const value = typeof width === 'number' ? width : valueIn(document, width);
  return value * (document.units === 'inch' ? 25.4 : 1);
}

describe('convertDocumentUnits: the oracle keeps unscaled values exact (#1965 finding 1)', () => {
  const ACTIVE_WHEN = 'round(width) / width * 1e-13';

  function cutDocument(): ProjectDocument {
    const document = withParameter(
      newDocument('mm'),
      'width',
      '10.4',
      'length'
    );
    return withFeatureNode(document, 'cut', {
      featureKind: 'boolean',
      activeWhen: ACTIVE_WHEN,
      operation: 'subtract',
      targetBodyIds: []
    });
  }

  it('refuses a Boolean whose activation would become exactly zero', () => {
    const source = cutDocument();
    expect(valueIn(source, ACTIVE_WHEN)).toBeGreaterThan(0);
    // The transform refuses it structurally (round() of a length) ...
    expect(refusals(convertDocumentUnits(source, 'inch'))).toEqual([
      expect.objectContaining({ code: 'scale-variant', field: 'activeWhen' })
    ]);
    // ... and the oracle alone, given the converted document the transform
    // would have written, refuses it too: 9.6e-14 before, exactly 0 after,
    // which the kernel reads as "inactive". The old absolute 1e-12 floor
    // accepted that.
    const after = structuredClone(source);
    after.units = 'inch';
    for (const node of Object.values(after.nodes)) {
      if (node.kind === 'project') node.units = 'inch';
      if (node.kind === 'parameter') node.expression = '0.409448818897638';
    }
    expect(valueIn(after, ACTIVE_WHEN)).toBe(0);
    expect(unitsConversionOracle(source, after).refusals).toEqual([
      expect.objectContaining({
        code: 'oracle-mismatch',
        subject: 'cut (cut)',
        field: 'activeWhen'
      })
    ]);
  });

  it('demands bit-identical unscaled values unless they are ratios of lengths', () => {
    const source = sampleDocument('mm');
    const target = converted(convertDocumentUnits(source, 'inch'));
    expect(unitsConversionOracle(source, target).refusals).toEqual([]);
    // One ulp on a stored angle, a count and a condition is a refusal.
    for (const quantity of ['angle', 'number', 'condition', 'index']) {
      const broken = structuredClone(target);
      let done = false;
      for (const node of Object.values(broken.nodes)) {
        const scoped = nodeMap(node);
        if (!scoped || done) continue;
        walkQuantities(scoped.value, scoped.map, (leaf) => {
          if (done || leaf.quantity !== quantity) return;
          if (typeof leaf.value !== 'number') return;
          leaf.holder[leaf.key] =
            leaf.value === 0 ? Number.MIN_VALUE : leaf.value * (1 + 2 ** -52);
          done = true;
        });
      }
      expect(done, quantity).toBe(true);
      expect(
        unitsConversionOracle(source, broken).refusals.map((r) => r.code),
        quantity
      ).toEqual(['oracle-mismatch']);
    }
  });

  it('accepts a ratio of lengths that moves by an ulp, but not a count', () => {
    // a / b with typed a and b is a ratio of two numerals rounded to 15
    // digits in inches: it moves by a few ulps, legitimately. A whole
    // number of things must not: 7 becoming 6.9999999999999964 is six
    // pattern instances once floored.
    let source = newDocument('mm');
    source = withParameter(source, 'a', '7', 'length');
    source = withParameter(source, 'b', '3', 'length');
    source = withParameter(source, 'slope', 'a / b', 'angle');
    source = withParameter(source, 'count', 'a / b * 3', 'number');
    expect(parameterValues(source).count).toBe(7);
    const found = refusals(convertDocumentUnits(source, 'inch'));
    expect(found).toEqual([
      expect.objectContaining({
        code: 'oracle-mismatch',
        subject: expect.stringContaining('count') as string
      })
    ]);
    expect(found[0]!.message).toContain('7 should stay 7');
    // Without the count, the ulp-off slope converts.
    const slopeOnly = withParameter(
      withParameter(
        withParameter(newDocument('mm'), 'a', '7', 'length'),
        'b',
        '3',
        'length'
      ),
      'slope',
      'a / b',
      'angle'
    );
    const target = converted(convertDocumentUnits(slopeOnly, 'inch'));
    expect(parameterValues(target).slope).not.toBe(7 / 3);
    expect(parameterValues(target).slope).toBeCloseTo(7 / 3, 14);
  });
});

describe('convertDocumentUnits: no overflow, and every literal checked (#1965 finding 2)', () => {
  function meshDocument(
    units: UnitSystem,
    vertices: number[]
  ): ProjectDocument {
    return withFeatureNode(newDocument(units), 'mesh', {
      featureKind: 'imported-mesh',
      artifactId: 'artifact',
      sourceName: 'mesh.stl',
      triangleCount: 1,
      vertices,
      indices: [0, 1, 2]
    });
  }

  it('scales a huge stored coordinate without an intermediate overflow', () => {
    // 1e307 * 25.4 overflows before the division by 10 that brings it back.
    expect(canonicalScaledNumber(1e307, 25.4, 10)).toBe(2.54e307);
    expect(canonicalScaledNumber(2.54e307, 10, 25.4)).toBe(1e307);
    const target = converted(
      convertDocumentUnits(meshDocument('inch', [1e307, -1e307, 0]), 'cm')
    );
    expect(
      featureData<{ vertices: number[] }>(target, 'mesh').vertices
    ).toEqual([2.54e307, -2.54e307, 0]);
  });

  it('refuses a stored number whose scaled value is out of range, naming it', () => {
    expect(
      refusals(convertDocumentUnits(meshDocument('inch', [0, 1e308, 0]), 'mm'))
    ).toEqual([
      expect.objectContaining({
        code: 'out-of-range',
        subject: 'mesh (mesh)',
        field: 'vertices.1'
      })
    ]);
    // Underflow to zero is refused too: a value must not cross zero.
    expect(
      refusals(
        convertDocumentUnits(
          meshDocument('mm', [Number.MIN_VALUE, 0, 0]),
          'inch'
        )
      )
    ).toEqual([
      expect.objectContaining({ code: 'out-of-range', field: 'vertices.0' })
    ]);
    let inch = newDocument('inch');
    inch = withBox(inch, 'Box', { width: '1e308' });
    expect(refusals(convertDocumentUnits(inch, 'mm'))).toEqual([
      expect.objectContaining({
        code: 'out-of-range',
        field: 'dimensions.width'
      })
    ]);
  });

  it('checks stored literals: each scaled once, finite', () => {
    const source = meshDocument('inch', [1, 2, 3]);
    const target = converted(convertDocumentUnits(source, 'mm'));
    expect(unitsConversionOracle(source, target).refusals).toEqual([]);
    for (const [index, value] of [
      [0, 25.4 * 25.4], // scaled twice
      [1, 2], // never scaled
      [2, Number.POSITIVE_INFINITY]
    ] as const) {
      const broken = structuredClone(target);
      featureData<{ vertices: number[] }>(broken, 'mesh').vertices[index] =
        value;
      expect(unitsConversionOracle(source, broken).refusals).toEqual([
        expect.objectContaining({
          code: 'oracle-mismatch',
          field: `vertices.${index}`
        })
      ]);
    }
  });
});

describe('convertDocumentUnits: scale-variant formulas refuse whatever their value (#1965 finding 3)', () => {
  it('classifies every function the evaluator has', () => {
    const functions = [...RESERVED_IDENTIFIERS].filter((name) => name !== 'PI');
    for (const name of functions)
      expect(UNITS_CONVERSION_OPERATION_SCALING[name], name).toBeDefined();
    for (const operator of ['+', '-', '*', '/', '^', 'juxtapose'])
      expect(
        UNITS_CONVERSION_OPERATION_SCALING[operator],
        operator
      ).toBeDefined();
  });

  it('refuses round(width) even when 127 mm happens to round alike', () => {
    // 127 mm rounds to 127 and 5 in rounds to 5, so a value-only check
    // passes; but at 128 mm the original is 128 mm and the converted 5 in
    // (127 mm). The formula's meaning would change.
    const result = convertWidth('round(width)', 'inch', [
      ['width', '127 mm', 'length']
    ]);
    expect(refusals(result)).toEqual([
      expect.objectContaining({
        code: 'scale-variant',
        subject: expect.stringContaining('Box') as string,
        field: 'dimensions.width',
        message: expect.stringContaining('round() of a length') as string
      })
    ]);
  });

  it('refuses floor, ceil and the rest over a length, and a length where nothing scales', () => {
    for (const expression of [
      'floor(width)',
      'ceil(width / 2)',
      'round(width) * 2',
      'max(round(width), 1 mm)'
    ])
      expect(
        refusals(convertWidth(expression, 'inch', [['width', '10', 'length']])),
        expression
      ).toEqual([expect.objectContaining({ code: 'scale-variant' })]);
    // A length in an unscaled field: an angle parameter, a count parameter.
    let document = withParameter(newDocument('mm'), 'width', '10', 'length');
    document = withParameter(document, 'n', 'round(width / 1 mm)');
    document = withParameter(document, 'bad', 'round(width)');
    expect(
      refusals(convertDocumentUnits(document, 'inch')).map((refusal) => [
        refusal.code,
        refusal.subject.split(' ')[0]
      ])
    ).toEqual([['scale-variant', 'bad']]);
  });

  it('converts round(n) * 1 mm with a unitless n', () => {
    const target = converted(
      convertWidth('round(n) * 1 mm', 'inch', [['n', '7.6']])
    );
    expect(boxWidth(target, 'Box')).toBe('round(n) * 1 mm');
    expect(boxWidthMm(target)).toBeCloseTo(8, 12);
  });

  it('converts round(width / 1 mm) * 1 mm and keeps its meaning after an edit', () => {
    for (const formula of [
      'round(width / 1 mm) * 1 mm',
      'min(width, 3 mm)',
      'width ^ 2 / 1 mm'
    ]) {
      let original = withParameter(
        newDocument('mm'),
        'width',
        '127 mm',
        'length'
      );
      original = withBox(original, 'Box', { width: formula });
      let inch = converted(convertDocumentUnits(original, 'inch'));
      expect(boxWidth(inch, 'Box'), formula).toBe(formula);
      expect(boxWidthMm(inch)).toBeCloseTo(boxWidthMm(original), 9);
      for (const width of ['128.4 mm', '35 mm', '2.5 mm']) {
        original = withParameter(original, 'width', width, 'length');
        inch = withParameter(inch, 'width', width, 'length');
        expect(boxWidthMm(inch), `${formula} at ${width}`).toBeCloseTo(
          boxWidthMm(original),
          9
        );
      }
    }
  });

  it('refuses a scale-variant operation reached through a chain of parameters', () => {
    const result = convertWidth('round(b)', 'inch', [
      ['width', '10.4', 'length'],
      ['a', 'width * 2', 'length'],
      ['b', 'a + 1 mm', 'length']
    ]);
    expect(refusals(result)).toEqual([
      expect.objectContaining({
        code: 'scale-variant',
        field: 'dimensions.width'
      })
    ]);
    // The same operation inside the chain is refused where it is written.
    const inside = convertWidth('c', 'inch', [
      ['width', '10.4', 'length'],
      ['a', 'width * 2', 'length'],
      ['c', 'ceil(a)', 'length']
    ]);
    expect(refusals(inside)).toEqual([
      expect.objectContaining({
        code: 'scale-variant',
        subject: expect.stringContaining('c') as string,
        field: 'expression'
      })
    ]);
  });

  it('refuses a scale-variant configuration cell, for any parameter kind', () => {
    let document = withParameter(newDocument('mm'), 'width', '20', 'length');
    document = withParameter(document, 'n', '3');
    document = withBox(document, 'Box', { width: 'width * n' });
    const [, n] = listParameters(document).map((p) => p.parameterId);
    document = createConfigurations(document, { rowId: 'a', name: 'A' });
    document = addConfigurationColumn(document, {
      column: { kind: 'parameter', parameterId: n! }
    });
    document = addConfigurationRow(document, { rowId: 'b', name: 'B' });
    document = setConfigurationCell(document, {
      rowId: 'b',
      column: { kind: 'parameter', parameterId: n! },
      value: 'round(width) / 1 mm'
    });
    expect(refusals(convertDocumentUnits(document, 'inch'))).toEqual([
      expect.objectContaining({
        code: 'scale-variant',
        subject: 'configuration "B"',
        field: `parameters.${n!}`
      })
    ]);
  });
});

describe('convertDocumentUnits: the active configuration row (#1965 finding 4)', () => {
  function staleDocument(): ProjectDocument {
    let document = withParameter(newDocument('mm'), 'n', '4');
    document = withParameter(document, 'width', 'require_min(n, 3)', 'length');
    document = withBox(document, 'Box', { width: 'width' });
    const width = listParameters(document).find((p) => p.name === 'width')!;
    document = createConfigurations(document, { rowId: 'a', name: 'A' });
    document = addConfigurationColumn(document, {
      column: { kind: 'parameter', parameterId: width.parameterId }
    });
    document = addConfigurationRow(document, { rowId: 'b', name: 'B' });
    document = setConfigurationCell(document, {
      rowId: 'b',
      column: { kind: 'parameter', parameterId: width.parameterId },
      value: '20'
    });
    // Ordinary edits change the model, not the active row's stored cell.
    document = withParameter(document, 'width', '10', 'length');
    return withParameter(document, 'n', '2');
  }

  it('converts the model as the active row holds it, not its stale cell', () => {
    const source = staleDocument();
    const width = listParameters(source).find((p) => p.name === 'width')!;
    expect(source.configurations!.rows[0]!.parameters[width.parameterId]).toBe(
      'require_min(n, 3)'
    );
    const target = converted(convertDocumentUnits(source, 'inch'));
    // The active row's stored cell now holds the converted live value.
    expect(
      target.configurations!.rows.map(
        (row) => row.parameters[width.parameterId]
      )
    ).toEqual(['0.393700787401575', '0.78740157480315']);
  });

  it('switches rows afterwards exactly as before conversion', () => {
    const source = staleDocument();
    const target = converted(convertDocumentUnits(source, 'inch'));
    expect(boxWidthMm(target)).toBeCloseTo(10, 12);
    const sourceB = activateConfiguration(source, { rowId: 'b' });
    const targetB = activateConfiguration(target, { rowId: 'b' });
    expect(boxWidthMm(sourceB)).toBe(20);
    expect(boxWidthMm(targetB)).toBeCloseTo(20, 12);
    // Back to A: both restore the live 10 mm, not the stale guard.
    const sourceA = activateConfiguration(sourceB, { rowId: 'a' });
    const targetA = activateConfiguration(targetB, { rowId: 'a' });
    expect(boxWidthMm(sourceA)).toBe(10);
    expect(boxWidthMm(targetA)).toBeCloseTo(10, 12);
  });
});

// ---------------------------------------------------------------------------
// Scoped re-check on #1965: operations discontinuous in a length refuse
// structurally, ranges and literals are exact
// ---------------------------------------------------------------------------

describe('convertDocumentUnits: discontinuities in a length refuse structurally (#1965 re-check)', () => {
  /** A pattern whose count is `count`, beside typed lengths `a` and `b`. */
  function patternDocument(count: string): ProjectDocument {
    let document = withParameter(newDocument('mm'), 'a', '1', 'length');
    document = withParameter(document, 'b', '98', 'length');
    return withFeatureNode(document, 'pattern', {
      featureKind: 'pattern',
      targetBodyId: 'body',
      patternKind: 'linear',
      count,
      spacing: 10,
      direction: { x: 1, y: 0, z: 0 }
    });
  }

  it('refuses a count computed from lengths, which the kernel rounds (finding 1)', () => {
    const source = patternDocument('a / b * 343');
    // The hazard: 3.4999999999999996 rounds to 3 instances in millimetres,
    // 3.500000000000002 to 4 in inches, and a ratio within 1e-12 passed
    // the value oracle.
    expect(valueIn(source, 'a / b * 343')).toBe(3.4999999999999996);
    const inch = structuredClone(source);
    inch.units = 'inch';
    for (const node of Object.values(inch.nodes)) {
      if (node.kind === 'project') node.units = 'inch';
      if (node.kind === 'parameter')
        node.expression = String(
          canonicalScaledNumber(Number(node.expression), 1, 25.4)
        );
    }
    expect(Math.round(valueIn(inch, 'a / b * 343'))).toBe(4);
    expect(refusals(convertDocumentUnits(source, 'inch'))).toEqual([
      expect.objectContaining({
        code: 'scale-variant',
        subject: 'pattern (pattern)',
        field: 'count'
      })
    ]);
    // Through a unitless parameter, too.
    const viaParameter = withParameter(source, 'n', 'a / b * 343');
    featureData<{ count: string }>(viaParameter, 'pattern').count = 'n';
    expect(refusals(convertDocumentUnits(viaParameter, 'inch'))).toEqual([
      expect.objectContaining({ code: 'scale-variant', field: 'count' })
    ]);
    // A count without lengths converts.
    const plain = withParameter(patternDocument('n * 2'), 'n', '3');
    expect(
      featureData<{ count: string }>(
        converted(convertDocumentUnits(plain, 'inch')),
        'pattern'
      ).count
    ).toBe('n * 2');
  });

  it('refuses any unscaled field that depends on a length: angle, condition, any row', () => {
    // An angle from lengths.
    const angle = patternDocument('3');
    featureData<{ angleDeg: string }>(angle, 'pattern').angleDeg = 'a / b * 90';
    expect(refusals(convertDocumentUnits(angle, 'inch'))).toEqual([
      expect.objectContaining({ code: 'scale-variant', field: 'angleDeg' })
    ]);
    // A condition holding a length: `width - 10 mm` is exactly zero in
    // millimetres at 10 mm and need not be in inches after `width = 4 + 6`.
    const condition = withFeatureNode(
      withParameter(newDocument('mm'), 'width', '12 mm', 'length'),
      'cut',
      {
        featureKind: 'boolean',
        activeWhen: 'width - 10 mm',
        operation: 'subtract',
        targetBodyIds: []
      }
    );
    expect(refusals(convertDocumentUnits(condition, 'inch'))).toEqual([
      expect.objectContaining({ code: 'scale-variant', field: 'activeWhen' })
    ]);
    // A count reading a parameter that is a length ratio only in another row.
    let rows = withParameter(patternDocument('n'), 'n', '3');
    const n = listParameters(rows).find((p) => p.name === 'n')!;
    rows = createConfigurations(rows, { rowId: 'r1', name: 'One' });
    rows = addConfigurationColumn(rows, {
      column: { kind: 'parameter', parameterId: n.parameterId }
    });
    rows = addConfigurationRow(rows, { rowId: 'r2', name: 'Two' });
    rows = setConfigurationCell(rows, {
      rowId: 'r2',
      column: { kind: 'parameter', parameterId: n.parameterId },
      value: 'a / b * 343'
    });
    expect(refusals(convertDocumentUnits(rows, 'inch'))).toEqual([
      expect.objectContaining({
        code: 'scale-variant',
        subject: 'pattern (pattern)',
        field: 'count'
      })
    ]);
  });

  it('refuses mod of lengths, even under a huge offset (finding 2)', () => {
    for (const formula of [
      '10 mm + mod(width, 10 mm)',
      '1e13 mm + mod(width, 10 mm)'
    ])
      expect(
        refusals(convertWidth(formula, 'inch', [['width', '35 mm', 'length']])),
        formula
      ).toEqual([
        expect.objectContaining({
          code: 'scale-variant',
          field: 'dimensions.width',
          message: expect.stringContaining('mod() of a length') as string
        })
      ]);
    // The hazard after an edit to width = 1 mm + 29 mm: 10 mm in
    // millimetres, 20 mm in inches.
    const mm = withParameter(
      newDocument('mm'),
      'width',
      '1 mm + 29 mm',
      'length'
    );
    const inch = withParameter(
      newDocument('inch'),
      'width',
      '1 mm + 29 mm',
      'length'
    );
    expect(valueIn(mm, '10 mm + mod(width, 10 mm)')).toBe(10);
    expect(valueIn(inch, '10 mm + mod(width, 10 mm)') * 25.4).toBeCloseTo(
      20,
      9
    );
    // Unit-free mod is wrapped outside, so it converts.
    expect(
      boxWidth(
        converted(convertWidth('mod(w, 4)', 'inch', [['w', '10']])),
        'Box'
      )
    ).toBe('(mod(w, 4)) / 25.4');
  });

  it('refuses guards, sign and atan2 over lengths (finding 3)', () => {
    for (const formula of [
      'require_one_of(width, 4 mm, 3 mm)',
      'require_min(width, 3 mm)',
      'width * sign(width - 3 mm)',
      'width * atan2(width, 3 mm) / 45'
    ])
      expect(
        refusals(convertWidth(formula, 'inch', [['width', '4 mm', 'length']])),
        formula
      ).toEqual([
        expect.objectContaining({
          code: 'scale-variant',
          field: 'dimensions.width'
        })
      ]);
    // The hazard after an edit to width = 1 mm + 2 mm.
    const formula = 'require_one_of(width, 4 mm, 3 mm)';
    const mm = withParameter(
      newDocument('mm'),
      'width',
      '1 mm + 2 mm',
      'length'
    );
    const inch = withParameter(
      newDocument('inch'),
      'width',
      '1 mm + 2 mm',
      'length'
    );
    expect(valueIn(mm, formula)).toBe(3);
    expect(() => valueIn(inch, formula)).toThrow();
    // Guards over unit-free values are wrapped outside, so they convert.
    expect(
      boxWidth(
        converted(convertWidth('require_min(w, 3)', 'inch', [['w', '10']])),
        'Box'
      )
    ).toBe('(require_min(w, 3)) / 25.4');
  });

  it('keeps continuous, equivariant forms converting', () => {
    for (const formula of [
      'round(width / 1 mm) * 1 mm',
      'width ^ 2 / 1 mm',
      'min(width, 3 mm)',
      'max(width, 3 mm) + abs(width - 50 mm)',
      'sqrt(width * 2 mm)',
      'avg(width, 3 mm)'
    ]) {
      const target = converted(
        convertWidth(formula, 'inch', [['width', '127 mm', 'length']])
      );
      expect(boxWidth(target, 'Box'), formula).toBe(formula);
    }
    expect(
      boxWidth(
        converted(convertWidth('round(n) * 1 mm', 'inch', [['n', '7.6']])),
        'Box'
      )
    ).toBe('round(n) * 1 mm');
  });

  it('refuses a length expression whose value underflows (finding 4)', () => {
    for (const formula of ['5e-324 * 1', '5e-324 mm', '1e-310 * 1'])
      expect(refusals(convertWidth(formula, 'inch')), formula).toEqual([
        expect.objectContaining({
          code: 'out-of-range',
          field: 'dimensions.width'
        })
      ]);
    // The oracle judges zero-ness against the source value, not against an
    // expected value that underflowed with it.
    const source = withBox(newDocument('mm'), 'Box', { width: '5e-324 * 1' });
    const after = structuredClone(source);
    after.units = 'inch';
    for (const node of Object.values(after.nodes))
      if (node.kind === 'project') node.units = 'inch';
    const data = feature(after, 'Box').data as Extract<
      FeatureData,
      { featureKind: 'primitive' }
    >;
    data.dimensions.width = '(5e-324 * 1) / 25.4';
    data.dimensions.height = canonicalScaledNumber(1, 1, 25.4);
    data.dimensions.depth = canonicalScaledNumber(1, 1, 25.4);
    expect(valueIn(after, '(5e-324 * 1) / 25.4')).toBe(0);
    expect(unitsConversionOracle(source, after).refusals).toEqual([
      expect.objectContaining({
        code: 'oracle-mismatch',
        field: 'dimensions.width'
      })
    ]);
  });

  it('checks every stored literal bit for bit, however small (finding 5)', () => {
    const source = withFeatureNode(newDocument('mm'), 'mesh', {
      featureKind: 'imported-mesh',
      artifactId: 'artifact',
      sourceName: 'mesh.stl',
      triangleCount: 1,
      vertices: [1e-13, 2e-13, 3e-13],
      indices: [0, 1, 2]
    });
    const target = converted(convertDocumentUnits(source, 'inch'));
    expect(unitsConversionOracle(source, target).refusals).toEqual([]);
    for (const [index, value] of [
      [0, 1e-13], // never scaled
      [1, 2e-13 / 25.4 / 25.4], // scaled twice
      [2, canonicalScaledNumber(3e-13, 1, 25.4) * (1 + 2 ** -52)] // one ulp
    ] as const) {
      const broken = structuredClone(target);
      featureData<{ vertices: number[] }>(broken, 'mesh').vertices[index] =
        value;
      expect(unitsConversionOracle(source, broken).refusals).toEqual([
        expect.objectContaining({
          code: 'oracle-mismatch',
          field: `vertices.${index}`
        })
      ]);
    }
  });
});
