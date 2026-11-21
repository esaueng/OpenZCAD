import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  holeBody,
  listFeaturesInOrder,
  patternBody,
  transformBody,
  updateFeature,
  type PatternInput
} from '@openzcad/document-core';
import { commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DerivedState,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * M02 feature patterns and skipped copies (schema v62). Every expectation is
 * a closed form: a 100 × 40 × 10 plate, Ø6 through holes, 4 × 4 square cuts
 * and bosses, so a copy that is missing, doubled or misplaced changes a
 * volume or a bore position by a whole feature.
 */

const PLATE = { x: 100, y: 40, z: 10 };
const PLATE_VOLUME = PLATE.x * PLATE.y * PLATE.z;
const HOLE_R = 3;
const HOLE_VOLUME = Math.PI * HOLE_R ** 2 * PLATE.z;

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;
const lastFeature = (document: ProjectDocument): FeatureId =>
  listFeaturesInOrder(document).at(-1)!.featureId;

function plate(): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument('Feature patterns', toUserId('user_m02')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: PLATE.x, height: PLATE.y, depth: PLATE.z }
    }
  );
}

function topFace(derived: DerivedState, bodyId: BodyId) {
  const body = derived.bodyRepresentations[bodyId]!;
  const top = body.topology!.faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      (face.geometry.normal?.z ?? 0) > 0.999 &&
      Math.abs(
        (face.geometry.centroid ?? face.geometry.center).z - body.bbox.max.z
      ) < 1e-6
  );
  if (!top) throw new Error('No top face.');
  return { face: top, body };
}

/**
 * A Ø6 hole through the plate at world `x` (and the plate's middle in Y).
 * The top face's frame runs its V along +X from the face's centroid.
 */
async function drilled(
  adapter: ExactKernelAdapter,
  x: number,
  extra: Partial<Parameters<typeof holeBody>[1]> = {}
): Promise<{ document: ProjectDocument; holeId: FeatureId }> {
  const document = plate();
  const derived = await adapter.syncDocument(document);
  const { face, body } = topFace(derived, last(document));
  const centreX = (body.bbox.min.x + body.bbox.max.x) / 2;
  const next = holeBody(document, {
    name: 'Hole',
    targetBodyId: last(document),
    faceHash: face.hash,
    ...(face.reference ? { faceReference: face.reference } : {}),
    style: 'simple',
    diameter: 2 * HOLE_R,
    depthMode: 'through',
    position: { u: 0, v: x - centreX },
    positionAnchor: 'centroid',
    ...extra
  }).document;
  return { document: next, holeId: lastFeature(next) };
}

function pattern(
  document: ProjectDocument,
  input: Omit<PatternInput, 'name' | 'targetBodyId'>
): ProjectDocument {
  return patternBody(document, {
    name: 'Pattern',
    targetBodyId: last(document),
    ...input
  }).document;
}

/** World X of every Ø6 bore on the body, sorted. */
function boreXs(derived: DerivedState, bodyId: BodyId): number[] {
  return (
    derived.bodyRepresentations[bodyId]!.topology!.faces.filter(
      (face) =>
        face.geometry?.surfaceType === 'cylinder' &&
        Math.abs(face.geometry.area - 2 * Math.PI * HOLE_R * PLATE.z) < 1e-6
    )
      // A whole bore's area centroid lies on its axis.
      .map((face) =>
        Math.round((face.geometry!.centroid ?? face.geometry!.center).x)
      )
      .sort((left, right) => left - right)
  );
}

function boreNames(derived: DerivedState, bodyId: BodyId): string[] {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.flatMap((face) =>
    face.reference?.lineageName.includes('hole.face.bore')
      ? [face.reference.lineageName]
      : []
  ).sort();
}

describe('M02 feature patterns: document contract', () => {
  it('stores the repeated features and skipped copies at schema v62', () => {
    const document = plate();
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(62);
    const body = last(document);
    const patterned = patternBody(document, {
      name: 'Row',
      targetBodyId: body,
      patternKind: 'linear',
      count: 4,
      axis: 'x',
      spacing: 120,
      skippedInstances: ['2']
    }).document;
    expect(listFeaturesInOrder(patterned).at(-1)!.data).toMatchObject({
      featureKind: 'pattern',
      skippedInstances: ['2']
    });
  });

  it.each([
    [{ skippedInstances: ['0'] }, /cannot skip its original/],
    [{ skippedInstances: ['1-1'] }, /not a copy of a linear pattern/],
    [{ skippedInstances: ['2', '2'] }, /skipped twice/],
    [{ skippedInstances: [] }, /lists the copies it skips/],
    [{ sourceFeatureIds: [] }, /at least one feature/]
  ])('refuses %o', (patch, message) => {
    const document = plate();
    expect(() =>
      pattern(document, {
        patternKind: 'linear',
        count: 3,
        axis: 'x',
        spacing: 20,
        ...patch
      })
    ).toThrow(message);
  });

  it('refuses a grid copy written as a linear one, and the grid original', () => {
    const document = plate();
    const grid = (skippedInstances: string[]) =>
      pattern(document, {
        patternKind: 'grid',
        count: 2,
        count2: 2,
        axis: 'x',
        axis2: 'y',
        spacing: 20,
        skippedInstances
      });
    expect(() => grid(['1'])).toThrow(/not a copy of a grid pattern/);
    expect(() => grid(['0-0'])).toThrow(/cannot skip its original/);
    expect(() => grid(['1-0'])).not.toThrow();
  });

  it('refuses a feature that is not a hole, boss, cut, fillet, chamfer or wrap', () => {
    const document = plate();
    const box = listFeaturesInOrder(document)[0]!.featureId;
    expect(() =>
      pattern(document, {
        patternKind: 'linear',
        count: 3,
        axis: 'x',
        spacing: 20,
        sourceFeatureIds: [box]
      })
    ).toThrow(/not a hole, boss, cut, fillet, chamfer or wrap/);
  });

  it('refuses either field on a document that declares schema v61', () => {
    const document = {
      ...plate(),
      schemaVersion: 61
    } as unknown as ProjectDocument;
    expect(() =>
      pattern(document, {
        patternKind: 'linear',
        count: 3,
        axis: 'x',
        spacing: 20,
        skippedInstances: ['1']
      })
    ).toThrow(/require project schema v62/);
  });

  it('validates a skip list through the pattern command and an edit', () => {
    const document = plate();
    const command = commandFactories.patternBody({
      name: 'Row',
      targetBodyId: last(document),
      patternKind: 'circular',
      count: 4,
      axis: 'z',
      angleDeg: 360,
      skippedInstances: ['0']
    });
    expect(() => command.validate(document)).toThrow(
      /cannot skip its original/
    );
    const patterned = pattern(document, {
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 120
    });
    expect(() =>
      updateFeature(patterned, {
        featureId: lastFeature(patterned),
        data: { featureKind: 'pattern', skippedInstances: ['x'] }
      })
    ).toThrow(/not a copy/);
    const skipped = updateFeature(patterned, {
      featureId: lastFeature(patterned),
      data: { featureKind: 'pattern', skippedInstances: ['1'] }
    });
    const cleared = updateFeature(skipped, {
      featureId: lastFeature(skipped),
      clearData: ['skippedInstances']
    });
    expect(listFeaturesInOrder(cleared).at(-1)!.data).not.toHaveProperty(
      'skippedInstances'
    );
  });
});

describe('M02 feature patterns: exact build', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  it('repeats a through hole along X, naming each copy by its own axis', async () => {
    const { document, holeId } = await drilled(adapter, 10);
    const row = pattern(document, {
      patternKind: 'linear',
      count: 5,
      axis: 'x',
      spacing: 20,
      sourceFeatureIds: [holeId]
    });
    const derived = await adapter.syncDocument(row);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[last(row)]!;
    expect(body.volume).toBeCloseTo(PLATE_VOLUME - 5 * HOLE_VOLUME, 6);
    expect(boreXs(derived, last(row))).toEqual([10, 30, 50, 70, 90]);
    expect(boreNames(derived, last(row))).toEqual([
      'hole.face.bore',
      `pattern.face.instance.1.source.${holeId}.hole.face.bore`,
      `pattern.face.instance.2.source.${holeId}.hole.face.bore`,
      `pattern.face.instance.3.source.${holeId}.hole.face.bore`,
      `pattern.face.instance.4.source.${holeId}.hole.face.bore`
    ]);
    // The plate is still one body, and the pattern consumed the drilled one.
    expect(row.bodyOrder).toHaveLength(3);
  }, 120_000);

  it('names the copies of each repeated hole apart (review: two holes, one label)', async () => {
    const first = await drilled(adapter, 10);
    // A second hole on the drilled plate, 10 further along X.
    const built = await adapter.syncDocument(first.document);
    const { face, body } = topFace(built, last(first.document));
    const centreX = (body.bbox.min.x + body.bbox.max.x) / 2;
    const both = holeBody(first.document, {
      name: 'Hole 2',
      targetBodyId: last(first.document),
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      style: 'simple',
      diameter: 2 * HOLE_R,
      depthMode: 'through',
      position: { u: 0, v: 20 - centreX },
      positionAnchor: 'centroid'
    }).document;
    const secondId = lastFeature(both);
    const row = pattern(both, {
      patternKind: 'linear',
      count: 2,
      axis: 'x',
      spacing: 50,
      sourceFeatureIds: [first.holeId, secondId]
    });
    const derived = await adapter.syncDocument(row);
    expect(derived.warnings).toEqual([]);
    expect(boreXs(derived, last(row))).toEqual([10, 20, 60, 70]);
    const names = boreNames(derived, last(row));
    // Every bore named, and no two references alike (a reference is its
    // producer and name), so each finds exactly one face.
    const references = derived.bodyRepresentations[
      last(row)
    ]!.topology!.faces.flatMap((face) =>
      face.reference?.lineageName.includes('hole.face.bore')
        ? [`${face.reference.producingFeatureId}|${face.reference.lineageName}`]
        : []
    );
    expect(references).toHaveLength(4);
    expect(new Set(references).size).toBe(4);
    expect(names).toEqual(
      expect.arrayContaining([
        `pattern.face.instance.1.source.${first.holeId}.hole.face.bore`,
        `pattern.face.instance.1.source.${secondId}.hole.face.bore`
      ])
    );
  }, 120_000);

  it('skips a copy without renaming the others', async () => {
    const { document, holeId } = await drilled(adapter, 10);
    const row = pattern(document, {
      patternKind: 'linear',
      count: 5,
      axis: 'x',
      spacing: 20,
      sourceFeatureIds: [holeId],
      skippedInstances: ['2']
    });
    const derived = await adapter.syncDocument(row);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[last(row)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 4 * HOLE_VOLUME,
      6
    );
    expect(boreXs(derived, last(row))).toEqual([10, 30, 70, 90]);
    expect(boreNames(derived, last(row))).toEqual([
      'hole.face.bore',
      `pattern.face.instance.1.source.${holeId}.hole.face.bore`,
      `pattern.face.instance.3.source.${holeId}.hole.face.bore`,
      `pattern.face.instance.4.source.${holeId}.hole.face.bore`
    ]);
  }, 120_000);

  it('repeats a hole on a grid with a copy skipped', async () => {
    // U runs along −Y on a top face: the hole stands at (10, 10).
    const { document, holeId } = await drilled(adapter, 10, {
      position: { u: 10, v: -40 }
    });
    const grid = pattern(document, {
      patternKind: 'grid',
      count: 3,
      count2: 2,
      axis: 'x',
      axis2: 'y',
      spacing: 30,
      spacing2: 20,
      sourceFeatureIds: [holeId],
      skippedInstances: ['1-1']
    });
    const derived = await adapter.syncDocument(grid);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[last(grid)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 5 * HOLE_VOLUME,
      6
    );
    expect(boreXs(derived, last(grid))).toEqual([10, 10, 40, 70, 70]);
  }, 120_000);

  it('follows an edit of the repeated hole', async () => {
    const { document, holeId } = await drilled(adapter, 10);
    const row = pattern(document, {
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 30,
      sourceFeatureIds: [holeId]
    });
    const wider = updateFeature(row, {
      featureId: holeId,
      data: { featureKind: 'hole', diameter: 8 }
    });
    const derived = await adapter.syncDocument(wider);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[last(wider)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 3 * Math.PI * 16 * PLATE.z,
      6
    );
  }, 120_000);

  it('refuses a copy that misses the body by its label, until it is skipped', async () => {
    const { document, holeId } = await drilled(adapter, 10);
    const row = pattern(document, {
      patternKind: 'linear',
      count: 4,
      axis: 'x',
      spacing: 40,
      sourceFeatureIds: [holeId]
    });
    const refused = await adapter.syncDocument(row);
    expect(
      refused.featureWarnings?.map((warning) => warning.message).join('\n')
    ).toMatch(/Copy 3 of Hole misses /);
    const skipped = updateFeature(row, {
      featureId: lastFeature(row),
      data: { featureKind: 'pattern', skippedInstances: ['3'] }
    });
    const derived = await adapter.syncDocument(skipped);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[last(skipped)]!.volume).toBeCloseTo(
      PLATE_VOLUME - 3 * HOLE_VOLUME,
      6
    );
  }, 120_000);

  it('repeats a through-all square cut around a ring', async () => {
    let document = addPrimitiveFeature(
      createProjectDocument('Ring', toUserId('user_m02')),
      {
        name: 'Disc',
        primitiveKind: 'cylinder',
        dimensions: { radius: 40, height: 10 }
      }
    );
    const disc = last(document);
    const derivedDisc = await adapter.syncDocument(document);
    const box = derivedDisc.bodyRepresentations[disc]!.bbox;
    const sketched = addSketchFeature(document, {
      name: 'Square',
      planeRef: { type: 'canonical', plane: 'XY', offset: box.max.z },
      objects: [
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: (box.min.x + box.max.x) / 2 + 25,
          centerY: (box.min.y + box.max.y) / 2
        }
      ]
    });
    document = extrudeSketch(sketched.document, {
      name: 'Slot',
      sketchId: sketched.sketchId,
      distance: 2,
      operation: 'cut',
      targetBodyId: disc,
      endCondition: 'through-all',
      throughAllSide: 'backward'
    }).document;
    const cutId = lastFeature(document);
    const centre = {
      x: (box.min.x + box.max.x) / 2,
      y: (box.min.y + box.max.y) / 2
    };
    // About the disc's own axis: through the origin when the disc is.
    expect(Math.hypot(centre.x, centre.y)).toBeLessThan(1e-9);
    document = pattern(document, {
      patternKind: 'circular',
      count: 6,
      axis: 'z',
      angleDeg: 360,
      sourceFeatureIds: [cutId]
    });
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[last(document)]!.volume).toBeCloseTo(
      Math.PI * 40 ** 2 * 10 - 6 * 16 * 10,
      4
    );
  }, 120_000);

  it('repeats a boss along X, skipping one', async () => {
    let document = plate();
    const plateId = last(document);
    const derivedPlate = await adapter.syncDocument(document);
    const box = derivedPlate.bodyRepresentations[plateId]!.bbox;
    const sketched = addSketchFeature(document, {
      name: 'Boss sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: box.max.z },
      objects: [
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: box.min.x + 10,
          centerY: (box.min.y + box.max.y) / 2
        }
      ]
    });
    document = extrudeSketch(sketched.document, {
      name: 'Boss',
      sketchId: sketched.sketchId,
      distance: 5,
      operation: 'add',
      targetBodyId: plateId
    }).document;
    const bossId = lastFeature(document);
    document = pattern(document, {
      patternKind: 'linear',
      count: 4,
      axis: 'x',
      spacing: 25,
      sourceFeatureIds: [bossId],
      skippedInstances: ['1']
    });
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[last(document)]!;
    expect(body.volume).toBeCloseTo(PLATE_VOLUME + 3 * 4 * 4 * 5, 6);
    // Bosses at 10, 60 and 85 along the plate: their tops stand 5 above.
    const tops = body
      .topology!.faces.filter(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          Math.abs(
            (face.geometry.centroid ?? face.geometry.center).z - (box.max.z + 5)
          ) < 1e-6
      )
      .map((face) =>
        Math.round(
          (face.geometry!.centroid ?? face.geometry!.center).x - box.min.x
        )
      )
      .sort((left, right) => left - right);
    expect(tops).toEqual([10, 60, 85]);
  }, 120_000);

  it('refuses a hole the body was moved after, naming the move', async () => {
    const { document, holeId } = await drilled(adapter, 10);
    const moved = transformBody(document, {
      name: 'Shift',
      targetBodyId: last(document),
      translation: { x: 0, y: 0, z: 5 }
    }).document;
    const row = pattern(moved, {
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 20,
      sourceFeatureIds: [holeId]
    });
    const derived = await adapter.syncDocument(row);
    expect(
      derived.featureWarnings?.map((warning) => warning.message).join('\n')
    ).toMatch(/Shift moves .* after Hole; pattern Hole before it/);
  }, 120_000);

  it('skips copies of a whole-body pattern and keeps the others named', async () => {
    const document = plate();
    const row = pattern(document, {
      patternKind: 'linear',
      count: 4,
      axis: 'x',
      spacing: 120,
      skippedInstances: ['1']
    });
    const derived = await adapter.syncDocument(row);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[last(row)]!;
    expect(body.volume).toBeCloseTo(3 * PLATE_VOLUME, 6);
    const instances = new Set(
      body.topology!.faces.flatMap((face) => {
        const match = /^pattern\.face\.instance\.(\d+)\./.exec(
          face.reference?.lineageName ?? ''
        );
        return match ? [match[1]] : [];
      })
    );
    expect([...instances].sort()).toEqual(['0', '2', '3']);
  }, 120_000);

  it('warns about a skipped copy a lowered count no longer reaches', async () => {
    const document = plate();
    const row = pattern(document, {
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 120,
      skippedInstances: ['5']
    });
    const derived = await adapter.syncDocument(row);
    expect(derived.bodyRepresentations[last(row)]!.volume).toBeCloseTo(
      3 * PLATE_VOLUME,
      6
    );
    expect(
      derived.featureWarnings?.map((warning) => warning.message).join('\n')
    ).toMatch(/Skipped copy 5 is not in this pattern any more/);
  }, 120_000);

  it('skips a copy of an overlapping full ring, fusing the rest', async () => {
    let document = addPrimitiveFeature(
      createProjectDocument('Spokes', toUserId('user_m02')),
      {
        name: 'Spoke',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 4, depth: 4 }
      }
    );
    const spoke = last(document);
    const built = await adapter.syncDocument(document);
    const box = built.bodyRepresentations[spoke]!.bbox;
    // From x = −2 out along +X, 4 wide about the X axis: every copy
    // overlaps every other in the same 4 × 4 square about the origin.
    document = transformBody(document, {
      name: 'Centre',
      targetBodyId: spoke,
      translation: {
        x: -2 - box.min.x,
        y: -(box.min.y + box.max.y) / 2,
        z: 0
      }
    }).document;
    const full = pattern(document, {
      patternKind: 'circular',
      count: 4,
      axis: 'z',
      angleDeg: 360
    });
    const skipped = pattern(document, {
      patternKind: 'circular',
      count: 4,
      axis: 'z',
      angleDeg: 360,
      skippedInstances: ['1']
    });
    const [whole, partial] = [
      await adapter.syncDocument(full),
      await adapter.syncDocument(skipped)
    ];
    const spokeVolume = 40 * 4 * 4;
    const square = 4 * 4 * 4;
    expect(whole.warnings).toEqual([]);
    expect(whole.bodyRepresentations[last(full)]!.volume).toBeCloseTo(
      4 * spokeVolume - 3 * square,
      4
    );
    // Without copy 1 (at 90°) three spokes share the square.
    expect(partial.warnings).toEqual([]);
    expect(partial.bodyRepresentations[last(skipped)]!.volume).toBeCloseTo(
      3 * spokeVolume - 2 * square,
      4
    );
    expect(partial.bodyRepresentations[last(skipped)]!.bbox.max.y).toBeCloseTo(
      2,
      6
    );
  }, 120_000);
});
