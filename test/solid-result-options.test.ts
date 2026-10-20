import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  addSplitFeature,
  booleanBodies,
  booleanConsumedBodyIds,
  createProjectDocument,
  extrudeSketch,
  listFeaturesInOrder,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { extrudeEditTargets } from '../apps/web/src/lib/extrudeEditing';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type BooleanKeepOriginals,
  type BooleanOperation,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * Research-audit Stage 4 solid options (schema v24): the extrude Intersect
 * result intent (ZC-060) and keep-originals for Boolean and Split (M11,
 * ZC-075–078). Every expected volume below is an independent closed form,
 * never a recorded kernel value.
 *
 * Cube pair: A = [0,10]³ and B = A moved by (5, 5, 0), so they share a
 * 5 × 5 × 10 column of 250. Union 1000 + 1000 − 250 = 1750, A − B = 750,
 * A ∩ B = 250. A 10 mm cube split at x = 5 gives 500 / 500.
 */
const CUBE = 1000;
const SHARED = 5 * 5 * 10;
const ORACLE: Record<BooleanOperation, number> = {
  union: 2 * CUBE - SHARED,
  subtract: CUBE - SHARED,
  intersect: SHARED
};

function cubePair(): { document: ProjectDocument; a: BodyId; b: BodyId } {
  let document = createProjectDocument(
    'Solid options',
    toUserId('user_solid_options')
  );
  for (const name of ['A', 'B']) {
    document = addPrimitiveFeature(document, {
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
  }
  const [a, b] = document.bodyOrder as [BodyId, BodyId];
  document = transformBody(document, {
    name: 'Offset B',
    targetBodyId: b,
    translation: { x: 5, y: 5, z: 0 }
  }).document;
  return { document, a, b };
}

/** A 10 × 10 square centred at (10, 10), on XY offset −5, swept 20 up. */
function throughBlock(): {
  document: ProjectDocument;
  blockId: BodyId;
  sketchId: ReturnType<typeof addSketchFeature>['sketchId'];
} {
  let document = createProjectDocument(
    'Intersect extrude',
    toUserId('user_intersect_extrude')
  );
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 10 }
  });
  const blockId = document.bodyOrder[0]!;
  const sketched = addSketchFeature(document, {
    name: 'Square',
    planeRef: { type: 'canonical', plane: 'XY', offset: -5 },
    objects: [
      {
        objectKind: 'rectangle',
        width: 10,
        height: 10,
        centerX: 10,
        centerY: 10
      }
    ]
  });
  return { document: sketched.document, blockId, sketchId: sketched.sketchId };
}

describe('Stage 4 solid options: document contract', () => {
  it('is schema v24', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(28);
  });

  it('stores nothing new when no option is chosen', () => {
    const { document, a, b } = cubePair();
    const combined = booleanBodies(document, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [a, b]
    }).document;
    const split = addSplitFeature(document, {
      name: 'Split',
      targetBodyId: a,
      plane: {
        origin: { x: 5, y: 0, z: 0 },
        normal: { x: 1, y: 0, z: 0 }
      }
    }).document;
    expect(listFeaturesInOrder(combined).at(-1)!.data).not.toHaveProperty(
      'keepOriginals'
    );
    expect(listFeaturesInOrder(split).at(-1)!.data).not.toHaveProperty(
      'keepOriginal'
    );
  });

  it('maps each keep choice to the inputs it consumes', () => {
    const ids = ['t', 'u', 'v'] as BodyId[];
    expect(booleanConsumedBodyIds({ targetBodyIds: ids })).toEqual(ids);
    expect(
      booleanConsumedBodyIds({ targetBodyIds: ids, keepOriginals: 'all' })
    ).toEqual([]);
    expect(
      booleanConsumedBodyIds({ targetBodyIds: ids, keepOriginals: 'target' })
    ).toEqual(['u', 'v']);
    expect(
      booleanConsumedBodyIds({ targetBodyIds: ids, keepOriginals: 'tools' })
    ).toEqual(['t']);
  });

  it('refuses malformed keep choices on create and on edit', () => {
    const { document, a, b } = cubePair();
    expect(() =>
      booleanBodies(document, {
        name: 'Bad',
        operation: 'union',
        targetBodyIds: [a, b],
        keepOriginals: 'none' as never
      })
    ).toThrow(/Unknown Boolean keep-originals choice "none"/);
    const split = addSplitFeature(document, {
      name: 'Split',
      targetBodyId: a,
      plane: {
        origin: { x: 5, y: 0, z: 0 },
        normal: { x: 1, y: 0, z: 0 }
      }
    }).document;
    const splitId = listFeaturesInOrder(split).at(-1)!.featureId;
    expect(() =>
      updateFeature(split, {
        featureId: splitId,
        data: { featureKind: 'split', keepOriginal: false as never }
      })
    ).toThrow(/keeps its original only as `keepOriginal: true`/);
  });

  it('clears a keep choice back to the absent field in one undoable edit', () => {
    const { document, a, b } = cubePair();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Union',
        operation: 'union',
        targetBodyIds: [a, b],
        keepOriginals: 'all'
      })
    );
    const featureId = listFeaturesInOrder(manager.document).at(-1)!.featureId;
    manager.execute(
      commandFactories.updateFeature({
        featureId,
        clearData: ['keepOriginals']
      })
    );
    expect(
      listFeaturesInOrder(manager.document).at(-1)!.data
    ).not.toHaveProperty('keepOriginals');
    manager.undo();
    expect(listFeaturesInOrder(manager.document).at(-1)!.data).toMatchObject({
      keepOriginals: 'all'
    });
  });

  it('stores an intersect extrude with its target and refuses one without', () => {
    const { document, blockId, sketchId } = throughBlock();
    const created = extrudeSketch(document, {
      name: 'Keep column',
      sketchId,
      distance: 20,
      operation: 'intersect',
      targetBodyId: blockId
    });
    expect(listFeaturesInOrder(created.document).at(-1)!.data).toMatchObject({
      operation: 'intersect',
      targetBodyId: blockId
    });
    expect(() =>
      commandFactories
        .extrudeSketch({
          name: 'No target',
          sketchId,
          distance: 20,
          operation: 'intersect'
        })
        .validate(document)
    ).toThrow(/Extrude intersect requires a stored target body/);
    expect(() =>
      extrudeSketch(document, {
        name: 'Unknown',
        sketchId,
        distance: 20,
        operation: 'common' as never,
        targetBodyId: blockId
      })
    ).toThrow(/Unknown extrude operation "common"/);
    // Through all stays a cut-only extent.
    expect(() =>
      extrudeSketch(document, {
        name: 'Through intersect',
        sketchId,
        distance: 20,
        operation: 'intersect',
        targetBodyId: blockId,
        endCondition: 'through-all',
        throughAllSide: 'forward'
      })
    ).toThrow(/cut extrusion only/);
  });
});

describe('Stage 4 solid options: exact build', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function derive(document: ProjectDocument) {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    return derived;
  }

  function near(actual: number | undefined, expected: number) {
    expect(actual).toBeDefined();
    expect(Math.abs(actual! - expected)).toBeLessThan(expected * 1e-6);
  }

  it.each(['union', 'subtract', 'intersect'] as const)(
    'matches the closed-form cube pair for %s and consumes both inputs',
    async (operation) => {
      const { document, a, b } = cubePair();
      const result = booleanBodies(document, {
        name: operation,
        operation,
        targetBodyIds: [a, b]
      });
      const derived = await derive(result.document);
      near(
        derived.bodyRepresentations[result.bodyId]?.volume,
        ORACLE[operation]
      );
      expect(derived.bodyRepresentations[a]?.consumed).toBe(true);
      expect(derived.bodyRepresentations[b]?.consumed).toBe(true);
    }
  );

  it.each([
    ['all', [false, false]],
    ['target', [false, true]],
    ['tools', [true, false]]
  ] as [BooleanKeepOriginals, [boolean, boolean]][])(
    'keeps originals "%s" beside an unchanged result',
    async (keepOriginals, [aConsumed, bConsumed]) => {
      for (const operation of ['union', 'subtract', 'intersect'] as const) {
        const { document, a, b } = cubePair();
        const result = booleanBodies(document, {
          name: operation,
          operation,
          targetBodyIds: [a, b],
          keepOriginals
        });
        const derived = await derive(result.document);
        near(
          derived.bodyRepresentations[result.bodyId]?.volume,
          ORACLE[operation]
        );
        expect(derived.bodyRepresentations[a]?.consumed).toBe(aConsumed);
        expect(derived.bodyRepresentations[b]?.consumed).toBe(bConsumed);
        // A kept original is the input, whole.
        if (!aConsumed) near(derived.bodyRepresentations[a]?.volume, CUBE);
        if (!bConsumed) near(derived.bodyRepresentations[b]?.volume, CUBE);
      }
    }
  );

  it('names a kept subtract base and its result apart', () => {
    const { document, a, b } = cubePair();
    const result = booleanBodies(document, {
      name: 'Subtract',
      operation: 'subtract',
      targetBodyIds: [a, b],
      bodyName: 'Subtract 1',
      keepOriginals: 'target'
    });
    const names = Object.values(result.document.nodes).flatMap((node) =>
      node.kind === 'body' ? [[node.bodyId, node.name] as const] : []
    );
    expect(new Map(names).get(result.bodyId)).toBe('Subtract 1');
    // Without a recorded numbered name the result still never borrows the
    // kept base's name.
    for (const keepOriginals of ['target', 'all'] as const) {
      for (const operation of ['subtract', 'union'] as const) {
        const fallback = booleanBodies(document, {
          name: 'Cut',
          operation,
          targetBodyIds: [a, b],
          keepOriginals
        });
        const byId = new Map(
          Object.values(fallback.document.nodes).flatMap((node) =>
            node.kind === 'body' ? [[node.bodyId, node.name] as const] : []
          )
        );
        expect(byId.get(fallback.bodyId)).toBe('Cut Body');
        expect(byId.get(fallback.bodyId)).not.toBe(byId.get(a));
      }
    }
  });

  it('renames a result that still carries its base name when an edit starts keeping the base', () => {
    const { document, a, b } = cubePair();
    const subtract = booleanBodies(document, {
      name: 'Subtract',
      operation: 'subtract',
      targetBodyIds: [a, b]
    });
    const split = addSplitFeature(subtract.document, {
      name: 'Split',
      targetBodyId: b,
      plane: {
        origin: { x: 10, y: 0, z: 0 },
        normal: { x: 1, y: 0, z: 0 }
      }
    });
    const [subtractFeature, splitFeature] = listFeaturesInOrder(
      split.document
    ).slice(-2);
    const nameOf = (doc: ProjectDocument, bodyId: BodyId) =>
      Object.values(doc.nodes).find(
        (node) => node.kind === 'body' && node.bodyId === bodyId
      )!.name;
    // Consume-all: each result takes its base's name, as before.
    expect(nameOf(split.document, subtract.bodyId)).toBe(
      nameOf(split.document, a)
    );
    let edited = updateFeature(split.document, {
      featureId: subtractFeature!.featureId,
      data: { featureKind: 'boolean', keepOriginals: 'target' }
    });
    edited = updateFeature(edited, {
      featureId: splitFeature!.featureId,
      data: { featureKind: 'split', keepOriginal: true }
    });
    expect(nameOf(edited, subtract.bodyId)).toBe('Subtract Body');
    expect(nameOf(edited, split.bodyId)).toBe(`${nameOf(edited, b)} (front)`);
  });

  it('lets a later feature consume a kept original', async () => {
    const { document, a, b } = cubePair();
    const union = booleanBodies(document, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [a, b],
      keepOriginals: 'target'
    });
    // A is still live, so a later intersect can take it with B's twin.
    const twin = addPrimitiveFeature(union.document, {
      name: 'C',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const c = twin.bodyOrder.at(-1)!;
    const moved = transformBody(twin, {
      name: 'Offset C',
      targetBodyId: c,
      translation: { x: 5, y: 5, z: 0 }
    }).document;
    const after = booleanBodies(moved, {
      name: 'Intersect',
      operation: 'intersect',
      targetBodyIds: [a, c]
    });
    const derived = await derive(after.document);
    near(derived.bodyRepresentations[union.bodyId]?.volume, ORACLE.union);
    near(derived.bodyRepresentations[after.bodyId]?.volume, ORACLE.intersect);
    expect(derived.bodyRepresentations[a]?.consumed).toBe(true);
  });

  it('passes nothing through for a suppressed Boolean that keeps its target', async () => {
    const { document, a, b } = cubePair();
    const result = booleanBodies(document, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [a, b],
      keepOriginals: 'target'
    });
    const feature = listFeaturesInOrder(result.document).at(-1)!;
    const manager = new CommandManager(result.document);
    manager.execute(
      commandFactories.setNodeMetadata({
        nodeId: feature.id,
        metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
      })
    );
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.bodyRepresentations[result.bodyId]).toBeUndefined();
    expect(derived.bodyRepresentations[a]?.consumed).toBe(false);
    expect(derived.bodyRepresentations[b]?.consumed).toBe(false);
  });

  it('splits a cube 500 / 500 and keeps the original only when asked', async () => {
    const { document, a } = cubePair();
    for (const keepOriginal of [undefined, true] as const) {
      const split = addSplitFeature(document, {
        name: 'Split',
        targetBodyId: a,
        plane: {
          origin: { x: 5, y: 0, z: 0 },
          normal: { x: 1, y: 0, z: 0 }
        },
        ...(keepOriginal ? { keepOriginal } : {})
      });
      const derived = await derive(split.document);
      near(derived.bodyRepresentations[split.bodyId]?.volume, CUBE / 2);
      near(derived.bodyRepresentations[split.secondBodyId]?.volume, CUBE / 2);
      expect(derived.bodyRepresentations[a]?.consumed).toBe(!keepOriginal);
      if (keepOriginal) near(derived.bodyRepresentations[a]?.volume, CUBE);
    }
  });

  it('labels a kept split original and its halves apart', () => {
    const { document, a } = cubePair();
    const split = addSplitFeature(document, {
      name: 'Split',
      targetBodyId: a,
      plane: {
        origin: { x: 5, y: 0, z: 0 },
        normal: { x: 1, y: 0, z: 0 }
      },
      keepOriginal: true
    });
    const names = new Map(
      Object.values(split.document.nodes).flatMap((node) =>
        node.kind === 'body' ? [[node.bodyId, node.name] as const] : []
      )
    );
    expect(
      new Set([a, split.bodyId, split.secondBodyId].map((id) => names.get(id)))
        .size
    ).toBe(3);
    expect(names.get(split.bodyId)).toBe(`${names.get(a)} (front)`);
  });

  it('offers a kept split original as a later extrude target', () => {
    const { document, a } = cubePair();
    const split = addSplitFeature(document, {
      name: 'Split',
      targetBodyId: a,
      plane: {
        origin: { x: 5, y: 0, z: 0 },
        normal: { x: 1, y: 0, z: 0 }
      },
      keepOriginal: true
    });
    const sketched = addSketchFeature(split.document, {
      name: 'Square',
      planeRef: { type: 'canonical', plane: 'XY', offset: -5 },
      objects: [
        { objectKind: 'rectangle', width: 2, height: 2, centerX: 1, centerY: 1 }
      ]
    });
    const extruded = extrudeSketch(sketched.document, {
      name: 'Pin',
      sketchId: sketched.sketchId,
      distance: 20
    });
    const feature = listFeaturesInOrder(extruded.document).at(-1)!;
    expect(
      extrudeEditTargets(extruded.document, feature).map((body) => body.bodyId)
    ).toContain(a);
  });

  it('keeps only the shared column for an intersect extrude', async () => {
    const { document, blockId, sketchId } = throughBlock();
    const created = extrudeSketch(document, {
      name: 'Keep column',
      sketchId,
      distance: 20,
      operation: 'intersect',
      targetBodyId: blockId
    });
    const derived = await derive(created.document);
    // 10 × 10 profile through a 10-deep block: 1000, independent of the
    // 20 mm the tool travels.
    near(derived.bodyRepresentations[created.bodyId]?.volume, 10 * 10 * 10);
    expect(derived.bodyRepresentations[blockId]?.consumed).toBe(true);
    const bbox = derived.bodyRepresentations[created.bodyId]!.bbox;
    expect(bbox.min.z).toBeCloseTo(0, 6);
    expect(bbox.max.z).toBeCloseTo(10, 6);
  });

  it('refuses an intersect extrude that shares nothing with its target', async () => {
    let document = createProjectDocument(
      'Missed intersect',
      toUserId('user_missed_intersect')
    );
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    });
    const blockId = document.bodyOrder[0]!;
    const sketched = addSketchFeature(document, {
      name: 'Away',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: 50,
          centerY: 50
        }
      ]
    });
    const created = extrudeSketch(sketched.document, {
      name: 'Miss',
      sketchId: sketched.sketchId,
      distance: 5,
      operation: 'intersect',
      targetBodyId: blockId
    });
    const derived = await adapter.syncDocument(created.document);
    expect(derived.bodyRepresentations[created.bodyId]).toBeUndefined();
    expect(derived.bodyRepresentations[blockId]?.consumed).toBe(false);
    expect(derived.warnings).toEqual([
      'Feature "Miss": Stored intersect extrusion no longer overlaps Block Body; operation was not re-inferred.'
    ]);
  });
});
