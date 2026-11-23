/**
 * I03 stored-unit conversion: the audit of every numeric area of a project
 * outside the quantity registry's node maps (PR #1999 preview finding 1).
 *
 * `test/quantity-registry.test.ts` proves every numeric leaf of a feature,
 * sketch, sketch object and parameter is classified. This file covers the
 * rest:
 *
 * 1. Every top-level key of `ProjectDocument` carries a decision. The map is
 *    typed over `keyof ProjectDocument`, so a new key fails `pnpm typecheck`
 *    until it gets one; the corpus walk fails on a key a stored document has
 *    that the type does not name.
 * 2. Every numeric leaf inside an area decided "unit-free" or "own units"
 *    matches a listed path, so a new number in, say, a checkpoint record
 *    fails here until someone decides it.
 * 3. Node kinds outside the registry (project, assembly, part, body) carry
 *    no number outside `metadata`, and every `metadata` key is decided:
 *    unit-free or refused (`UNITS_CONVERSION_*_METADATA`).
 * 4. The decisions hold: refused areas refuse, unit-free areas come out
 *    unchanged, converted ones scale.
 *
 * Kept measurements are not document data (they live in the per-project
 * measurement store); `test/measurement-stored-units.test.ts` audits them.
 */
import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  GROWING_HOLDER_RECIPE_METADATA_KEY,
  SOURCE_PLACEMENT_METADATA_KEY,
  TEXT_BODY_METADATA_KEY
} from '../packages/command-system/src/growing-holder';
import { PRIMITIVE_PLACEMENT_METADATA_KEY } from '../apps/web/src/lib/primitivePlacement';
import { DEMO_DEFINITIONS, buildDemoSeed } from '../apps/web/src/lib/demos';
import {
  UNITS_CONVERSION_REFUSED_METADATA,
  UNITS_CONVERSION_UNIT_FREE_METADATA,
  addPrimitiveFeature,
  convertDocumentUnits,
  createProjectDocument,
  normalizeDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  BODY_COLOR_CHOSEN_METADATA_KEY,
  BODY_COLOR_METADATA_KEY,
  BODY_OPACITY_METADATA_KEY,
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';

import { PARITY_SCENARIOS } from './parity/scenarios';

type Decision =
  /** Scaled by the converter (registry maps or the converter's own walk). */
  | { kind: 'converted'; how: string }
  /** The conversion refuses a document that holds data here. */
  | { kind: 'refused'; how: string }
  /** Holds no stored length; every numeric leaf matches `numbers`. */
  | { kind: 'unit-free'; why: string; numbers: readonly string[] }
  /** A record of its own time, in the units of that time (plan §5.1, §5.3). */
  | { kind: 'own-units'; why: string; numbers: readonly string[] }
  /** Session state the converter replaces or never writes. */
  | { kind: 'not-stored'; why: string };

const TOP_LEVEL: { [K in keyof Required<ProjectDocument>]: Decision } = {
  editHistory: {
    kind: 'not-stored',
    why: 'undo diffs, each in the units of its step; the conversion is one more step (plan §5.2)'
  },
  schemaVersion: { kind: 'unit-free', why: 'version', numbers: [''] },
  projectId: { kind: 'unit-free', why: 'id', numbers: [] },
  ownerUserId: { kind: 'unit-free', why: 'id', numbers: [] },
  rootNodeId: { kind: 'unit-free', why: 'id', numbers: [] },
  rootAssemblyId: { kind: 'unit-free', why: 'id', numbers: [] },
  activePartId: { kind: 'unit-free', why: 'id', numbers: [] },
  name: { kind: 'unit-free', why: 'text', numbers: [] },
  units: { kind: 'converted', how: 'the tag itself, set to the target' },
  version: { kind: 'unit-free', why: 'document version', numbers: [''] },
  nodes: {
    kind: 'converted',
    how: 'feature, sketch, sketch-object and parameter maps of the registry; other kinds and metadata below'
  },
  featureOrder: { kind: 'unit-free', why: 'ids', numbers: [] },
  bodyOrder: { kind: 'unit-free', why: 'ids', numbers: [] },
  sketchOrder: { kind: 'unit-free', why: 'ids', numbers: [] },
  parameterOrder: { kind: 'unit-free', why: 'ids', numbers: [] },
  revisions: {
    kind: 'own-units',
    why: 'save points; restoring one restores its units (plan §5.3)',
    numbers: ['*.commandCount']
  },
  checkpoints: {
    kind: 'own-units',
    why: 'safety and save-state checkpoints, snapshots in their own units (plan §5.3)',
    numbers: ['*.documentVersion']
  },
  commandLog: {
    kind: 'own-units',
    why: 'replay is ordered, so each payload applies to a document in its own units (plan §5.1)',
    numbers: ['*.replayVersion', '*.payload.**']
  },
  assets: {
    kind: 'unit-free',
    why: 'blob references',
    numbers: ['*.bytes']
  },
  shaprImports: {
    kind: 'own-units',
    why: 'import provenance: raw source numbers, recorded only (plan §1.1)',
    numbers: ['**']
  },
  shaprImportOrder: { kind: 'unit-free', why: 'ids', numbers: [] },
  derived: {
    kind: 'not-stored',
    why: 'session projection; replaced by an empty one and rebuilt'
  },
  branchedFrom: { kind: 'unit-free', why: 'lineage record', numbers: [] },
  drawings: { kind: 'refused', how: 'unsupported-area while it has sheets' },
  objectFolders: { kind: 'unit-free', why: 'folder tree', numbers: [] },
  referenceImages: {
    kind: 'refused',
    how: 'unsupported-area while it has images'
  },
  pmi: { kind: 'refused', how: 'unsupported-area while it has annotations' },
  assembly: {
    kind: 'refused',
    how: 'unsupported-area while it has instances'
  },
  printClearance: {
    kind: 'converted',
    how: 'DOCUMENT_TOP_LEVEL_QUANTITIES: length'
  },
  configurations: {
    kind: 'converted',
    how: 'every row cell by its parameter quantity; material density is SI'
  },
  shareLinkSheetIds: { kind: 'unit-free', why: 'ids', numbers: [] },
  displayUnits: { kind: 'converted', how: 'kept or cleared (plan §5.4)' }
};

/** Numeric leaf paths inside a `converted` area that are not lengths. */
const CONVERTED_UNIT_FREE_NUMBERS: Partial<
  Record<keyof ProjectDocument, readonly string[]>
> = {
  configurations: ['rows.*.material.densityKgPerM3']
};

/** Node keys outside the registry maps that every node kind shares. */
const BASE_NODE_KEYS = new Set(['id', 'parentId', 'revisionId', 'name']);

/** Node kinds the registry does not map, and the numbers they may hold. */
const OTHER_NODE_KINDS: Record<string, readonly string[]> = {
  project: [],
  assembly: [],
  part: [],
  body: []
};

function numericLeaves(value: unknown, path: string[] = []): string[] {
  if (typeof value === 'number') return [path.join('.')];
  if (typeof value === 'object' && value !== null)
    return Object.entries(value).flatMap(([key, child]) =>
      numericLeaves(child, [...path, key])
    );
  return [];
}

function pathPattern(pattern: string): RegExp {
  const body = pattern
    .split('.')
    .map((part) =>
      part === '**'
        ? '.*'
        : part === '*'
          ? '[^.]+'
          : part.replace(/\W/g, '\\$&')
    )
    .join('\\.');
  return new RegExp(`^${body}$`);
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pathPattern(pattern).test(path));
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

function newDocument(): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument('Audit', toUserId('user_audit'), 'mm'),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 25.4, height: 18, depth: 24 }
    }
  );
}

function withMetadata(
  document: ProjectDocument,
  metadata: Record<string, string | number | boolean>
): ProjectDocument {
  const feature = Object.values(document.nodes).find(
    (node) => node.kind === 'feature'
  )!;
  return {
    ...document,
    nodes: {
      ...document.nodes,
      [feature.id]: {
        ...feature,
        metadata: { ...feature.metadata, ...metadata }
      }
    }
  };
}

describe('stored-unit conversion: document audit', () => {
  const corpus: { source: string; document: ProjectDocument }[] = [];

  beforeAll(async () => {
    const adapter = await createExactKernelAdapter();
    for (const scenario of PARITY_SCENARIOS) {
      if (scenario.expectedBuildFailure) continue;
      corpus.push({
        source: `parity:${scenario.key}`,
        document: await scenario.build((doc) => adapter.syncDocument(doc))
      });
    }
    for (const path of FIXTURE_DOCUMENTS)
      corpus.push({ source: path, document: fixtureDocument(path) });
    for (const definition of DEMO_DEFINITIONS) {
      const seed = await buildDemoSeed(
        definition,
        toUserId('user_audit'),
        (doc) => adapter.syncDocument(doc)
      );
      for (const document of [seed.document, ...seed.saveStates])
        corpus.push({ source: `demo:${definition.key}`, document });
    }
    adapter.dispose();
  }, 300_000);

  it('decides every top-level key a stored document has', () => {
    expect(corpus.length).toBeGreaterThan(10);
    const undecided = new Set<string>();
    for (const { source, document } of corpus)
      for (const key of Object.keys(document))
        if (!(key in TOP_LEVEL)) undecided.add(`${key} (${source})`);
    expect([...undecided]).toEqual([]);
  });

  it('lists every number in an area that does not scale', () => {
    const undecided = new Set<string>();
    for (const { source, document } of corpus)
      for (const [key, decision] of Object.entries(TOP_LEVEL)) {
        const value = document[key as keyof ProjectDocument];
        if (value === undefined) continue;
        const allowed =
          decision.kind === 'unit-free' || decision.kind === 'own-units'
            ? decision.numbers
            : decision.kind === 'converted'
              ? CONVERTED_UNIT_FREE_NUMBERS[key as keyof ProjectDocument]
              : undefined;
        // Converted areas other than configurations are walked by the
        // registry (nodes) or are a single classified field.
        if (allowed === undefined) continue;
        for (const path of numericLeaves(value))
          if (!matchesAny(path, allowed))
            undecided.add(`${key}${path ? `.${path}` : ''} (${source})`);
      }
    expect([...undecided]).toEqual([]);
  });

  it('finds no number on a node kind the registry does not map, and decides every metadata key', () => {
    const undecided = new Set<string>();
    const metadataKeys = new Set([
      ...UNITS_CONVERSION_UNIT_FREE_METADATA,
      ...Object.keys(UNITS_CONVERSION_REFUSED_METADATA)
    ]);
    for (const { source, document } of corpus)
      for (const node of Object.values(document.nodes)) {
        for (const key of Object.keys(node.metadata ?? {}))
          if (!metadataKeys.has(key))
            undecided.add(`${node.kind} metadata.${key} (${source})`);
        const allowed = OTHER_NODE_KINDS[node.kind];
        if (allowed === undefined) continue;
        for (const [key, value] of Object.entries(node)) {
          if (BASE_NODE_KEYS.has(key) || key === 'metadata') continue;
          for (const path of numericLeaves(value, [key]))
            if (!matchesAny(path, allowed))
              undecided.add(`${node.kind} ${path} (${source})`);
        }
      }
    expect([...undecided]).toEqual([]);
  });

  it('names every metadata key the code base writes', () => {
    expect([...UNITS_CONVERSION_UNIT_FREE_METADATA].sort()).toEqual(
      [
        FEATURE_SUPPRESSED_METADATA_KEY,
        FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
        BODY_COLOR_METADATA_KEY,
        BODY_COLOR_CHOSEN_METADATA_KEY,
        BODY_OPACITY_METADATA_KEY,
        PRIMITIVE_PLACEMENT_METADATA_KEY,
        TEXT_BODY_METADATA_KEY
      ].sort()
    );
    expect(Object.keys(UNITS_CONVERSION_REFUSED_METADATA).sort()).toEqual(
      [GROWING_HOLDER_RECIPE_METADATA_KEY, SOURCE_PLACEMENT_METADATA_KEY].sort()
    );
  });

  it('refuses a growing holder, whose recipe stores lengths in metadata', () => {
    const document = withMetadata(newDocument(), {
      [GROWING_HOLDER_RECIPE_METADATA_KEY]: JSON.stringify({
        version: 1,
        cuts: [10, 20],
        center: 15
      }),
      [SOURCE_PLACEMENT_METADATA_KEY]: JSON.stringify([[0, 0, 5]])
    });
    const result = convertDocumentUnits(document, 'inch');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.refusals.map((refusal) => [refusal.code, refusal.field])
    ).toEqual([
      ['unsupported-area', `metadata.${GROWING_HOLDER_RECIPE_METADATA_KEY}`],
      ['unsupported-area', `metadata.${SOURCE_PLACEMENT_METADATA_KEY}`]
    ]);
    expect(result.refusals[0]!.message).toMatch(/growing-holder recipe/);
  });

  it('refuses an unrecognised metadata number or JSON value, and keeps unit-free ones', () => {
    const refused = convertDocumentUnits(
      withMetadata(newDocument(), { 'plugin.offset': 5 }),
      'inch'
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.refusals[0]!.field).toBe('metadata.plugin.offset');

    const flags = {
      [FEATURE_SUPPRESSED_METADATA_KEY]: false,
      [BODY_OPACITY_METADATA_KEY]: 0.5,
      'plugin.note': 'hello'
    };
    const kept = convertDocumentUnits(
      withMetadata(newDocument(), flags),
      'inch'
    );
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    const feature = Object.values(kept.document.nodes).find(
      (node) => node.kind === 'feature'
    )!;
    expect(feature.metadata).toMatchObject(flags);
  });

  it('keeps the unit-free and own-units areas byte for byte', () => {
    const document = newDocument();
    const result = convertDocumentUnits(document, 'inch');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const [key, decision] of Object.entries(TOP_LEVEL))
      if (decision.kind === 'unit-free' || decision.kind === 'own-units') {
        if (key === 'version' || key === 'schemaVersion') continue;
        expect(result.document[key as keyof ProjectDocument], key).toEqual(
          document[key as keyof ProjectDocument]
        );
      }
  });
});
