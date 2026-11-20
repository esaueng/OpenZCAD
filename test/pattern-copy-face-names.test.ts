import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  listFeaturesInOrder,
  patternBody,
  type PatternInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  closeCarriers,
  placedCarrier
} from '../packages/kernel-adapter/src/exact-feature-pattern';
import { planeCarrier } from '../packages/kernel-adapter/src/exact-lineage-builders';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * M02: the faces of a repeated boss's or cut's copies are named after the
 * faces of the feature they copy,
 * `pattern.face.instance.<label>.source.<feature>.<its name>`, where a copy
 * comes back congruent to the original. On a 100 × 40 × 10 plate with 4 × 4
 * squares, so every name's face can be checked by where it stands.
 */

const PLATE = { x: 100, y: 40, z: 10 };

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;
const lastFeature = (document: ProjectDocument): FeatureId =>
  listFeaturesInOrder(document).at(-1)!.featureId;

function plate(): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument('Plate', toUserId('user_m02')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: PLATE.x, height: PLATE.y, depth: PLATE.z }
    }
  );
}

interface NamedFace {
  producer: string;
  name: string;
  centroid: { x: number; y: number; z: number };
}

function namedFaces(derived: DerivedState, bodyId: BodyId): NamedFace[] {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.flatMap((face) =>
    face.reference && face.geometry
      ? [
          {
            producer: face.reference.producingFeatureId,
            name: face.reference.lineageName,
            centroid: face.geometry.centroid ?? face.geometry.center
          }
        ]
      : []
  );
}

describe('M02 names on boss and cut copies', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  /** A 4 × 4 square on the plate's top at x = 10, extruded `operation`. */
  async function squareFeature(
    operation: 'add' | 'cut'
  ): Promise<{ document: ProjectDocument; featureId: FeatureId; min: number }> {
    const document = plate();
    const plateId = last(document);
    const box = (await adapter.syncDocument(document)).bodyRepresentations[
      plateId
    ]!.bbox;
    const sketched = addSketchFeature(document, {
      name: 'Square',
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
    const extruded = extrudeSketch(sketched.document, {
      name: operation === 'add' ? 'Boss' : 'Pocket',
      sketchId: sketched.sketchId,
      // A cut runs down into the plate: a 4 deep pocket.
      distance: operation === 'add' ? 5 : -4,
      operation,
      targetBodyId: plateId
    }).document;
    return {
      document: extruded,
      featureId: lastFeature(extruded),
      min: box.min.x
    };
  }

  function row(
    document: ProjectDocument,
    featureId: FeatureId,
    extra: Partial<PatternInput> = {}
  ): ProjectDocument {
    return patternBody(document, {
      name: 'Row',
      targetBodyId: last(document),
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 25,
      sourceFeatureIds: [featureId],
      ...extra
    }).document;
  }

  it.each(['add', 'cut'] as const)(
    'names every face of each %s copy after the original’s, where it stands',
    async (operation) => {
      const { document, featureId } = await squareFeature(operation);
      const before = namedFaces(
        await adapter.syncDocument(document),
        last(document)
      ).filter((face) => face.producer === featureId);
      // The feature's own faces, its walls and its cap or floor; the plate's
      // faces it renamed as its boolean's target are the plate's, not copied.
      const own = before.filter(
        (face) => !face.name.startsWith('boolean.face.target.')
      );
      expect(own).toHaveLength(5);
      const patterned = row(document, featureId);
      const derived = await adapter.syncDocument(patterned);
      expect(derived.warnings).toEqual([]);
      const patternId = lastFeature(patterned);
      const after = namedFaces(derived, last(patterned));
      // The original keeps its names.
      expect(
        after
          .filter((face) => face.producer === featureId)
          .map((face) => face.name)
          .sort()
      ).toEqual(before.map((face) => face.name).sort());
      const copies = after.filter((face) => face.producer === patternId);
      expect(copies.map((face) => face.name).sort()).toEqual(
        [1, 2]
          .flatMap((label) =>
            own.map(
              (face) =>
                `pattern.face.instance.${label}.source.${featureId}.${face.name}`
            )
          )
          .sort()
      );
      // Each named face is the original's, 25 further along per copy.
      for (const face of copies) {
        // pattern.face.instance.<label>.source.<feature>.<name>
        const copy = Number(face.name.split('.')[3]);
        const name = face.name.split(`.source.${featureId}.`)[1]!;
        const source = own.find((candidate) => candidate.name === name)!;
        expect(face.centroid.x - source.centroid.x).toBeCloseTo(25 * copy, 6);
        expect(face.centroid.y).toBeCloseTo(source.centroid.y, 6);
        expect(face.centroid.z).toBeCloseTo(source.centroid.z, 6);
      }
    },
    120_000
  );

  it('keeps names off a copy the plate cuts short', async () => {
    const { document, featureId } = await squareFeature('cut');
    // Copy 4 lands on the plate's end, x = 100, half of it off the plate:
    // its floor and the walls the end cuts are not the original's, so only
    // a wall it still holds whole takes a name; copies 1–3 take all five.
    const patterned = row(document, featureId, { count: 5, spacing: 22.5 });
    const derived = await adapter.syncDocument(patterned);
    expect(derived.warnings).toEqual([]);
    const named = namedFaces(derived, last(patterned)).filter(
      (face) => face.producer === lastFeature(patterned)
    );
    const count = (label: string) =>
      named.filter((face) => face.name.split('.')[3] === label).length;
    expect([1, 2, 3].map((label) => count(String(label)))).toEqual([5, 5, 5]);
    expect(count('4')).toBeLessThan(5);
    for (const face of named.filter(
      (entry) => entry.name.split('.')[3] === '4'
    ))
      expect(face.name).not.toContain('cap.end');
  }, 120_000);

  it('leaves a copy’s floor unnamed when other cuts clip it (review)', async () => {
    const { document, featureId, min } = await squareFeature('cut');
    // Two 1 × 1 through cuts at opposite corners of where copy 1's 4 × 4
    // floor lands (x = 33–37): perimeter and centroid stay, area does not.
    const plate = last(document);
    const box = (await adapter.syncDocument(document)).bodyRepresentations[
      plate
    ]!.bbox;
    const cy = (box.min.y + box.max.y) / 2;
    const notches = addSketchFeature(document, {
      name: 'Notches',
      planeRef: { type: 'canonical', plane: 'XY', offset: box.max.z },
      objects: [
        {
          objectKind: 'rectangle',
          width: 1,
          height: 1,
          centerX: min + 33.5,
          centerY: cy - 1.5
        },
        {
          objectKind: 'rectangle',
          width: 1,
          height: 1,
          centerX: min + 36.5,
          centerY: cy + 1.5
        }
      ]
    });
    const notched = extrudeSketch(notches.document, {
      name: 'Notches',
      sketchId: notches.sketchId,
      distance: 2,
      operation: 'cut',
      targetBodyId: plate,
      endCondition: 'through-all',
      throughAllSide: 'backward'
    }).document;
    const patterned = row(notched, featureId, { count: 2 });
    const derived = await adapter.syncDocument(patterned);
    expect(derived.warnings).toEqual([]);
    const names = namedFaces(derived, last(patterned))
      .filter((face) => face.producer === lastFeature(patterned))
      .map((face) => face.name);
    expect(names.some((name) => name.includes('cap.end'))).toBe(false);
  }, 120_000);
});

describe('M02 copy names: carriers compared as lines (review)', () => {
  it('matches a wall turned onto an axis whatever way its normal rounds', () => {
    const angle = (21 * Math.PI) / 180;
    const wall = planeCarrier(
      { x: Math.cos(angle), y: Math.sin(angle), z: 0 },
      { x: 10 * Math.cos(angle), y: 10 * Math.sin(angle), z: 0 }
    )!;
    // 69° about +Z puts it on +Y, ten out.
    const turn = (69 * Math.PI) / 180;
    const c = Math.cos(turn);
    const t = Math.sin(turn);
    const matrix = new Float64Array([
      c,
      -t,
      0,
      0,
      t,
      c,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1
    ]);
    const moved = placedCarrier(wall, matrix)!;
    const actual = planeCarrier({ x: 0, y: 1, z: 0 }, { x: 0, y: 10, z: 0 })!;
    expect(closeCarriers(moved, actual)).toBe(true);
    // A parallel plane a millimetre away is still another plane.
    const beside = planeCarrier({ x: 0, y: 1, z: 0 }, { x: 0, y: 11, z: 0 })!;
    expect(closeCarriers(moved, beside)).toBe(false);
  });
});
