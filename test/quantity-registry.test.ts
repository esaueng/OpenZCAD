/**
 * I03 quantity registry (`packages/shared/src/quantity-registry.ts`).
 *
 * 1. Type level: an unclassified numeric field fails `pnpm typecheck` (the
 *    `@ts-expect-error` lines below fail the typecheck if that stops being
 *    true).
 * 2. Characterization: `rewriteNodeExpressions`, now derived from the
 *    registry, visits exactly the fields the hand-written visitor did, in the
 *    same order, with the same F05 tags.
 * 3. Coverage: every numeric leaf of the parity documents, the repository's
 *    document fixtures and the representative samples has a classification.
 */
import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  normalizeDocument,
  rewriteNodeExpressions
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_QUANTITIES,
  FEATURE_QUANTITY_CASES,
  LiteralQuantity,
  PARAMETER_QUANTITIES,
  SKETCH_NODE_QUANTITIES,
  SKETCH_OBJECT_QUANTITIES,
  walkQuantities,
  type DocumentNode,
  type FeatureData,
  type ParametricVector3,
  type ParamValue,
  type ProjectDocument,
  type QuantityClass,
  type QuantityLeaf,
  type QuantityMap,
  type QuantityMapShape,
  type SwitchQuantity
} from '@openzcad/shared';

import { PARITY_SCENARIOS } from './parity/scenarios';
import { legacyRewriteNodeExpressions } from './support/legacy-rewrite-node-expressions';
import {
  SAMPLE_FEATURES,
  SAMPLE_PARAMETERS,
  SAMPLE_SKETCH_NODES,
  SAMPLE_SKETCH_OBJECTS
} from './support/quantity-registry-samples';

// ---------------------------------------------------------------------------
// 1. Type level
// ---------------------------------------------------------------------------

interface Probe {
  length: ParamValue;
  hash: number;
  name: string;
  at: ParametricVector3;
  steps?: { depth: ParamValue }[];
}

export const completeProbe: QuantityMap<Probe> = {
  length: 'length',
  hash: new LiteralQuantity('hash'),
  at: 'position',
  steps: { depth: 'length' }
};

// @ts-expect-error -- `hash` holds a number and is not classified.
export const missingField: QuantityMap<Probe> = {
  length: 'length',
  at: 'position',
  steps: { depth: 'length' }
};

export const literalAsExpression: QuantityMap<Probe> = {
  length: 'length',
  // @ts-expect-error -- a stored number never holds an expression.
  hash: 'hash',
  at: 'position',
  steps: { depth: 'length' }
};

export const expressionAsLiteral: QuantityMap<Probe> = {
  // @ts-expect-error -- an expression field is not a stored number.
  length: new LiteralQuantity('length'),
  hash: new LiteralQuantity('hash'),
  at: 'position',
  steps: { depth: 'length' }
};

export const nestedMissing: QuantityMap<Probe> = {
  length: 'length',
  hash: new LiteralQuantity('hash'),
  at: 'position',
  // @ts-expect-error -- `depth`, beneath an array, is not classified.
  steps: {}
};

// A new numeric field on an existing feature kind is refused.
type ExtrudeWithNewField = Extract<FeatureData, { featureKind: 'extrude' }> & {
  taper: ParamValue;
};
// @ts-expect-error -- `taper` is not classified.
export const extrudeWithNewField: QuantityMap<ExtrudeWithNewField> =
  FEATURE_QUANTITY_CASES.extrude;

// A new stored number deep in a shared reference type is refused too.
type HoleWithDeepField = Extract<FeatureData, { featureKind: 'hole' }> & {
  tapped?: { minorDiameter: number };
};
// @ts-expect-error -- `tapped.minorDiameter` is not classified.
export const holeWithDeepField: QuantityMap<HoleWithDeepField> =
  FEATURE_QUANTITY_CASES.hole;

// A new feature kind is refused.
type WiderFeatureData =
  FeatureData | { featureKind: 'knurl'; pitch: ParamValue };
// @ts-expect-error -- `knurl` has no map.
export const widerFeatureCases: {
  [K in WiderFeatureData['featureKind']]: QuantityMap<
    Extract<WiderFeatureData, { featureKind: K }>
  >;
} = FEATURE_QUANTITY_CASES;

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const BASE_NODE_KEYS = new Set(['id', 'parentId', 'revisionId', 'name']);

function sampleNodes(): DocumentNode[] {
  const base = { id: 'n', parentId: null, revisionId: null, name: 'n' };
  return [
    ...SAMPLE_FEATURES.map(
      (data) =>
        ({
          ...base,
          kind: 'feature',
          featureId: 'f',
          featureKind: data.featureKind,
          data
        }) as unknown as DocumentNode
    ),
    ...SAMPLE_SKETCH_OBJECTS.map(
      (data) =>
        ({
          ...base,
          kind: 'sketch-object',
          objectKind: data.objectKind,
          data
        }) as unknown as DocumentNode
    ),
    ...SAMPLE_SKETCH_NODES,
    ...SAMPLE_PARAMETERS
  ];
}

function fixtureDocument(path: string): ProjectDocument {
  return normalizeDocument(
    JSON.parse(readFileSync(path, 'utf8')) as ProjectDocument
  );
}

const FIXTURE_DOCUMENTS = [
  'test/fixtures/legacy-documents/writer-8dcb1643b.json',
  'test/scripting/contract/v1/history/document.json'
];

/** Every number below `value` replaced by a distinct expression. */
function expressionsEverywhere<T>(value: T): T {
  let next = 0;
  const replace = (item: unknown): unknown => {
    if (typeof item === 'number') return `q${next++}`;
    if (Array.isArray(item)) return item.map(replace);
    if (typeof item === 'object' && item !== null)
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [key, replace(child)])
      );
    return item;
  };
  return replace(structuredClone(value)) as T;
}

type Visitor = typeof rewriteNodeExpressions;

/** `path=expression:tag` for every field the visitor reports, in order. */
function visits(node: DocumentNode, visitor: Visitor): string[] {
  const paths = new Map<object, string>();
  const index = (value: unknown, path: string) => {
    if (typeof value !== 'object' || value === null) return;
    paths.set(value, path);
    for (const [key, child] of Object.entries(value))
      index(child, `${path}.${key}`);
  };
  index(node, '');
  const seen: string[] = [];
  visitor(node, (expression, dimension, site) => {
    seen.push(
      `${paths.get(site.container)}.${site.key}=${expression}:${String(dimension)}`
    );
    return expression;
  });
  return seen;
}

function label(node: DocumentNode): string {
  if (node.kind === 'feature') {
    const data = node.data as { definition?: { kind: string } } & FeatureData;
    const operation =
      data.featureKind === 'direct-edit' ? `/${data.operation.kind}` : '';
    return `feature:${data.featureKind}${operation}${
      data.definition ? `/${data.definition.kind}` : ''
    }`;
  }
  if (node.kind === 'sketch-object')
    return `sketch-object:${node.data.objectKind}`;
  if (node.kind === 'sketch') return `sketch:${node.planeRef.type}`;
  return node.kind;
}

/** The registry's map for the part of a node it classifies. */
function scope(
  node: DocumentNode
):
  | {
      value: object;
      map: QuantityMapShape | SwitchQuantity<never>;
      prefix: string;
    }
  | undefined {
  switch (node.kind) {
    case 'feature':
      return { value: node.data, map: FEATURE_QUANTITIES, prefix: '.data' };
    case 'sketch-object':
      return {
        value: node.data,
        map: SKETCH_OBJECT_QUANTITIES,
        prefix: '.data'
      };
    case 'sketch':
      return { value: node, map: SKETCH_NODE_QUANTITIES, prefix: '' };
    case 'parameter':
      return { value: node, map: PARAMETER_QUANTITIES, prefix: '' };
    default:
      return undefined;
  }
}

/** JSON paths of every numeric leaf the registry is responsible for. */
function numericLeaves(node: DocumentNode): string[] {
  const out: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'number') out.push(path);
    else if (typeof value === 'object' && value !== null)
      for (const [key, child] of Object.entries(value))
        walk(child, `${path}.${key}`);
  };
  const scoped = scope(node);
  if (!scoped) return out;
  if (scoped.prefix) walk(scoped.value, scoped.prefix);
  else
    for (const [key, child] of Object.entries(node))
      if (!BASE_NODE_KEYS.has(key) && key !== 'metadata')
        walk(child, `.${key}`);
  return out;
}

function classifiedLeaves(node: DocumentNode): QuantityLeaf[] {
  const scoped = scope(node);
  if (!scoped) return [];
  const leaves: QuantityLeaf[] = [];
  walkQuantities(scoped.value, scoped.map, (leaf) => leaves.push(leaf));
  return leaves;
}

function leafPath(node: DocumentNode, leaf: QuantityLeaf): string {
  return `${scope(node)!.prefix}${leaf.path.map((part) => `.${part}`).join('')}`;
}

describe('quantity registry', () => {
  const corpus: { source: string; node: DocumentNode }[] = [];

  beforeAll(async () => {
    const adapter = await createExactKernelAdapter();
    for (const scenario of PARITY_SCENARIOS) {
      if (scenario.expectedBuildFailure) continue;
      const document = await scenario.build((doc) => adapter.syncDocument(doc));
      for (const node of Object.values(document.nodes))
        corpus.push({ source: `parity:${scenario.key}`, node });
    }
    for (const path of FIXTURE_DOCUMENTS)
      for (const node of Object.values(fixtureDocument(path).nodes))
        corpus.push({ source: path, node });
    for (const node of sampleNodes()) corpus.push({ source: 'sample', node });
  }, 120_000);

  it('covers every feature kind, sketch object and constraint kind', () => {
    const labels = new Set(corpus.map(({ node }) => label(node)));
    for (const kind of Object.keys(FEATURE_QUANTITY_CASES))
      expect(
        [...labels].some((name) => name.startsWith(`feature:${kind}`))
      ).toBe(true);
    expect(
      corpus.filter(({ source }) => source !== 'sample').length
    ).toBeGreaterThan(100);
  });

  describe('rewriteNodeExpressions (characterization)', () => {
    it('visits what the hand-written visitor visited, with the same tags and order', () => {
      let compared = 0;
      for (const { source, node } of corpus) {
        for (const subject of [node, expressionsEverywhere(node)]) {
          const before = visits(subject, legacyRewriteNodeExpressions);
          const after = visits(subject, rewriteNodeExpressions);
          expect(after, `${source} ${label(node)}`).toEqual(before);
          compared += before.length;
        }
      }
      // Guard against a vacuous pass: the stringified samples alone hold
      // hundreds of expression fields.
      expect(compared).toBeGreaterThan(500);
    });

    it('rewrites the same fields in place', () => {
      for (const { source, node } of corpus) {
        const legacy = expressionsEverywhere(node);
        const derived = expressionsEverywhere(node);
        legacyRewriteNodeExpressions(
          legacy,
          (expression, dimension) => `${expression}|${String(dimension)}`
        );
        rewriteNodeExpressions(
          derived,
          (expression, dimension) => `${expression}|${String(dimension)}`
        );
        expect(derived, `${source} ${label(node)}`).toEqual(legacy);
      }
    });
  });

  describe('runtime coverage', () => {
    it('classifies every numeric leaf', () => {
      const unclassified = new Set<string>();
      const counts = new Map<QuantityClass, number>();
      const realKinds = new Set<string>();
      for (const { source, node } of corpus) {
        const classified = new Set(
          classifiedLeaves(node).map((leaf) => {
            counts.set(leaf.quantity, (counts.get(leaf.quantity) ?? 0) + 1);
            return leafPath(node, leaf);
          })
        );
        if (source !== 'sample' && classified.size > 0)
          realKinds.add(label(node));
        for (const path of numericLeaves(node))
          if (!classified.has(path))
            unclassified.add(`${label(node)} ${path} (${source})`);
      }
      // Coverage report: which kinds real documents exercise, and how many
      // leaves of each class the corpus holds. Kinds absent from real
      // documents are covered by the representative samples only.
      const sampleOnly = Object.keys(FEATURE_QUANTITY_CASES).filter(
        (kind) =>
          ![...realKinds].some((name) => name.startsWith(`feature:${kind}`))
      );
      console.info(
        [
          `quantity registry coverage: ${corpus.length} nodes`,
          `  real-document kinds: ${[...realKinds].sort().join(', ')}`,
          `  sample-only feature kinds: ${sampleOnly.join(', ')}`,
          `  leaves by class: ${[...counts]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, count]) => `${name} ${count}`)
            .join(', ')}`
        ].join('\n')
      );
      expect([...unclassified]).toEqual([]);
    });

    it('resolves per-instance classes', () => {
      const gears = SAMPLE_FEATURES.filter(
        (data) => data.featureKind === 'gear'
      );
      const pitches = gears.map((data) => {
        const leaves: QuantityLeaf[] = [];
        walkQuantities(data, FEATURE_QUANTITIES, (leaf) => leaves.push(leaf));
        return leaves.find((leaf) => leaf.path.join('.') === 'pitch')?.quantity;
      });
      expect(pitches).toEqual(['length', 'number']);

      const locks = SAMPLE_SKETCH_NODES[0]!.constraints!.filter(
        (constraint) => constraint.data.constraintKind === 'lock-entity'
      );
      const slots = locks.map((constraint) => {
        const leaves: QuantityLeaf[] = [];
        walkQuantities(
          { constraints: [constraint] },
          SKETCH_NODE_QUANTITIES,
          (leaf) => leaves.push(leaf)
        );
        return leaves.map((leaf) => leaf.quantity);
      });
      expect(slots).toEqual([
        ['length', 'length', 'length', 'length'],
        ['length', 'length', 'length', 'angle', 'angle']
      ]);

      const parameters = SAMPLE_PARAMETERS.map((parameter) => {
        const leaves: QuantityLeaf[] = [];
        walkQuantities(parameter, PARAMETER_QUANTITIES, (leaf) =>
          leaves.push(leaf)
        );
        return leaves.map(
          (leaf) => `${leaf.key}:${leaf.quantity}:${leaf.role}`
        );
      });
      expect(parameters).toEqual([
        ['expression:length:expression', 'value:length:literal'],
        ['expression:angle:expression', 'value:angle:literal'],
        ['expression:number:expression', 'value:number:literal'],
        ['expression:untyped:expression', 'value:untyped:literal']
      ]);
    });

    it('lists the expression fields not visited today', () => {
      const gaps = new Set<string>();
      for (const node of sampleNodes())
        for (const leaf of classifiedLeaves(node))
          if (leaf.role === 'unvisited')
            gaps.add(
              `${node.kind === 'feature' ? node.data.featureKind : node.kind} ${leaf.path
                .filter((part) => typeof part === 'string')
                .join('.')}`
            );
      expect([...gaps].sort()).toEqual([
        'hole tapped.clearance',
        'hole tapped.length',
        'sketch constraints.data.layout.spacing',
        'sketch constraints.data.layout.stepDeg',
        'sketch promotions.sourceData.centerX',
        'sketch promotions.sourceData.centerY',
        'sketch promotions.sourceData.height',
        'sketch promotions.sourceData.width'
      ]);
    });
  });
});
