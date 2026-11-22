import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  findSketch,
  listFeaturesInOrder,
  patternBody,
  ribBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  patternSourceProblem,
  toUserId,
  type BodyId,
  type DerivedState,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * M02: a feature pattern repeats ribs. A rib's own faces are named after
 * themselves, so a click on one names the rib; each copy's material is made
 * again against the body the rib was made on and added where the copy
 * lands. On an L bracket (a base x 0..40, y 0..5 and a wall x 0..5, y 0..40,
 * 20 deep in Z: 7 500 mm³) whose gusset across the inside corner, 2 thick,
 * fills a 25 × 25 right triangle: 625 mm³ a copy.
 */

const user = toUserId('user_pattern_ribs');
const BRACKET = 7500;
const GUSSET = 625;

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;

/** The bracket and its gusset at mid-depth, and the rib's id. */
function gusseted(thickness: number = 2): {
  document: ProjectDocument;
  ribId: FeatureId;
} {
  let document = createProjectDocument('Bracket', user);
  document = addPrimitiveFeature(document, {
    name: 'Base',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 5, depth: 20 }
  });
  const base = last(document);
  document = addPrimitiveFeature(document, {
    name: 'Wall',
    primitiveKind: 'box',
    dimensions: { width: 5, height: 40, depth: 20 }
  });
  const wall = last(document);
  const joined = booleanBodies(document, {
    name: 'Bracket',
    operation: 'union',
    targetBodyIds: [base, wall]
  });
  const sketch = addSketchFeature(joined.document, {
    name: 'Rib profile',
    plane: 'XY',
    offset: 10,
    objects: [{ objectKind: 'line', x1: 5, y1: 30, x2: 30, y2: 5 }]
  });
  const rib = ribBody(sketch.document, {
    name: 'Gusset',
    targetBodyId: joined.bodyId,
    profile: {
      sketchId: sketch.sketchId,
      entityIds: findSketch(sketch.document, sketch.sketchId)!.objectIds
    },
    thickness,
    thicknessSide: 'symmetric',
    direction: 'parallel'
  });
  return {
    document: rib.document,
    ribId: listFeaturesInOrder(rib.document).at(-1)!.featureId
  };
}

/** Copies of the rib 4 apart along Z, at z = 14 and 18 beside 10. */
const row = (document: ProjectDocument, ribId: FeatureId) =>
  patternBody(document, {
    name: 'Row',
    targetBodyId: last(document),
    patternKind: 'linear',
    count: 3,
    axis: 'z',
    spacing: 4,
    sourceFeatureIds: [ribId]
  }).document;

describe('M02 patterns of ribs', { timeout: 180_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  const failures = (derived: DerivedState) =>
    (derived.featureWarnings ?? []).filter((w) => w.kind !== 'advisory');

  it('names a rib’s own faces after it', async () => {
    const { document, ribId } = gusseted();
    const derived = await adapter.syncDocument(document);
    expect(failures(derived)).toEqual([]);
    const own = derived.bodyRepresentations[
      last(document)
    ]!.topology!.faces.filter(
      (face) => face.reference?.producingFeatureId === ribId
    );
    // Its two sides and its slanted top.
    expect(own.length).toBeGreaterThanOrEqual(3);
    for (const face of own) {
      expect(face.reference!.lineageName).toMatch(/^rib\.face\.w[0-9a-f]{32}$/);
    }
  });

  it('adds every copy of a rib along the bracket, named by copy', async () => {
    const { document, ribId } = gusseted();
    const patterned = row(document, ribId);
    const derived = await adapter.syncDocument(patterned);
    expect(failures(derived)).toEqual([]);
    const body = derived.bodyRepresentations[last(patterned)]!;
    expect(body.volume).toBeCloseTo(BRACKET + 3 * GUSSET, 5);
    const names = body.topology!.faces.map(
      (face) => face.reference?.lineageName ?? ''
    );
    for (const copy of ['1', '2']) {
      expect(
        names.some((name) =>
          name.startsWith(
            `pattern.face.instance.${copy}.source.${ribId}.rib.face.w`
          )
        )
      ).toBe(true);
    }
  });

  it('refuses to repeat a rib that did not build', async () => {
    const { document, ribId } = gusseted();
    // A profile in open space closes off nothing: the rib refuses, and its
    // pattern says so.
    const broken = structuredClone(document);
    for (const node of Object.values(broken.nodes)) {
      const data = (node as { data?: Record<string, unknown> }).data;
      if (data?.objectKind === 'line') {
        Object.assign(data, { x1: 50, y1: 60, x2: 70, y2: 80 });
      }
    }
    const derived = await adapter.syncDocument(row(broken, ribId));
    expect(
      (derived.featureWarnings ?? []).map((w) => w.message).join('\n')
    ).toMatch(/Gusset did not build, so a pattern cannot repeat it/);
  });

  it('takes a rib as a source', () => {
    const { document, ribId } = gusseted();
    const rib = listFeaturesInOrder(document).find(
      (feature) => feature.featureId === ribId
    )!;
    expect(patternSourceProblem(rib.data, rib.name)).toBeNull();
  });

  it('refuses a copy that lands clear of the bracket (review)', async () => {
    const { document, ribId } = gusseted();
    // 20 along (1, 1, 0): clear of both legs and the gusset, though its box
    // overlaps the bracket's.
    const floating = patternBody(document, {
      name: 'Row',
      targetBodyId: last(document),
      patternKind: 'linear',
      count: 2,
      axis: 'x',
      direction: { x: 1, y: 1, z: 0 },
      spacing: 20,
      sourceFeatureIds: [ribId]
    }).document;
    const derived = await adapter.syncDocument(floating);
    expect(
      (derived.featureWarnings ?? []).map((w) => w.message).join('\n')
    ).toMatch(/Copy 1 of Gusset does not join/);
  });
});
