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
});
