import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  extrudeSketch,
  createProjectDocument,
  findSketch,
  normalizeDocument,
  ribBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';

/**
 * M06 (schema v101): ribs. The material is exactly the region the open
 * profile and the body close off, built by exact booleans and united with
 * the body; a profile that closes off nothing is refused by name.
 */

const user = toUserId('user_rib');

/**
 * An L bracket in the XY cross-section, 20 deep in Z: a base x 0..40,
 * y 0..5 and a wall x 0..5, y 0..40. 7 500 mm³.
 */
function bracket(): { document: ProjectDocument; bodyId: BodyId } {
  let document = createProjectDocument('Bracket', user);
  document = addPrimitiveFeature(document, {
    name: 'Base',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 5, depth: 20 }
  });
  const base = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Wall',
    primitiveKind: 'box',
    dimensions: { width: 5, height: 40, depth: 20 }
  });
  const wall = document.bodyOrder.at(-1)!;
  const joined = booleanBodies(document, {
    name: 'Bracket',
    operation: 'union',
    targetBodyIds: [base, wall]
  });
  return { document: joined.document, bodyId: joined.bodyId };
}

/** A sketch on XY at height `z` holding `objects`, and its curve ids. */
function profileSketch(
  document: ProjectDocument,
  z: number,
  objects: SketchObjectData[]
) {
  const sketch = addSketchFeature(document, {
    name: 'Rib profile',
    plane: 'XY',
    offset: z,
    objects
  });
  return {
    document: sketch.document,
    path: {
      sketchId: sketch.sketchId,
      entityIds: findSketch(sketch.document, sketch.sketchId)!.objectIds
    }
  };
}

/** The gusset across the bracket's inside corner, mid-depth. */
const gussetLine: SketchObjectData = {
  objectKind: 'line',
  x1: 5,
  y1: 30,
  x2: 30,
  y2: 5
};

function gusset(thickness: number | string = 2) {
  const start = bracket();
  const sketch = profileSketch(start.document, 10, [gussetLine]);
  return ribBody(sketch.document, {
    name: 'Gusset',
    targetBodyId: start.bodyId,
    profile: sketch.path,
    thickness,
    thicknessSide: 'symmetric',
    direction: 'parallel'
  });
}

describe('ribs in the document (v101)', () => {
  it('stores a rib in the current schema and refuses it in an older one', () => {
    const rib = gusset();
    expect(rib.document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    const saved = JSON.parse(JSON.stringify(rib.document)) as ProjectDocument;
    expect(normalizeDocument(saved)).toEqual(rib.document);
    type Version = typeof PROJECT_DOCUMENT_SCHEMA_VERSION;
    const older = { ...rib.document, schemaVersion: 100 as Version };
    expect(() => normalizeDocument(structuredClone(older))).toThrow(
      /Ribs require project schema v101/
    );
  });
});

describe('ribs in the exact build', { timeout: 180_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  const volumeOf = async (document: ProjectDocument, bodyId: BodyId) => {
    const derived = await adapter.syncDocument(document);
    return { derived, body: derived.bodyRepresentations[bodyId] };
  };

  it('fills the inside corner of a bracket with an exact gusset', async () => {
    const rib = gusset();
    const { derived, body } = await volumeOf(rib.document, rib.bodyId);
    expect(derived.warnings).toEqual([]);
    // The 25 × 25 right triangle, 2 thick: 625 mm³ on 7 500.
    expect(body?.volume).toBeCloseTo(7500 + 625, 6);
    expect(
      body?.topology?.faces.every(
        (face) => face.geometry?.surfaceType === 'plane'
      )
    ).toBe(true);
  });

  it('rebuilds a thickness edit and refuses the side that never closes', async () => {
    const rib = gusset();
    const featureId = rib.document.featureOrder.at(-1)!;
    const thicker = updateFeature(rib.document, {
      featureId,
      data: { thickness: 4 }
    });
    expect((await volumeOf(thicker, rib.bodyId)).body?.volume).toBeCloseTo(
      7500 + 1250,
      6
    );
    // The other side of the gusset line is open space past the bracket.
    const flipped = updateFeature(rib.document, {
      featureId,
      data: { flip: true }
    });
    const refused = await volumeOf(flipped, rib.bodyId);
    expect(refused.derived.warnings.join('\n')).toMatch(
      /does not close against the body/
    );
  });

  it('runs a thickened profile along the sketch normal down to a block', async () => {
    let document = createProjectDocument('Block', user);
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 20 }
    });
    const block = document.bodyOrder.at(-1)!;
    const sketch = profileSketch(document, 30, [
      { objectKind: 'line', x1: 5, y1: 10, x2: 15, y2: 10 }
    ]);
    const rib = ribBody(sketch.document, {
      name: 'Web',
      targetBodyId: block,
      profile: sketch.path,
      thickness: 2,
      thicknessSide: 'symmetric',
      direction: 'normal'
    });
    const { derived, body } = await volumeOf(rib.document, rib.bodyId);
    expect(derived.warnings).toEqual([]);
    // 10 long, 2 thick, from the sketch at z 30 down to the top at z 20.
    expect(body?.volume).toBeCloseTo(8000 + 200, 6);
  });

  it('bounds an arched rib by its crown, not its ends', async () => {
    // A U bracket 20 deep: a base x 0..40, y 0..5 and walls x 0..5 and
    // 35..40 up to y 10. 250 mm² × 20 = 5 000 mm³.
    let document = createProjectDocument('U bracket', user);
    const corners = [
      [0, 0], [40, 0], [40, 10], [35, 10], [35, 5], [5, 5], [5, 10], [0, 10]
    ] as const;
    const outline = addSketchFeature(document, {
      name: 'U outline',
      plane: 'XY',
      objects: corners.map(([x1, y1], i) => {
        const [x2, y2] = corners[(i + 1) % corners.length]!;
        return { objectKind: 'line', x1, y1, x2, y2 };
      })
    });
    const outlineObjects = findSketch(
      outline.document,
      outline.sketchId
    )!.objectIds.flatMap((id) => {
      const node = outline.document.nodes[id];
      return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
    });
    const [region] = computeSketchRegions(outlineObjects, Number);
    const u = extrudeSketch(outline.document, {
      name: 'U',
      sketchId: outline.sketchId,
      distance: 20,
      profile: {
        regionFingerprint: region!.regionFingerprint,
        samplePoint: region!.samplePoint,
        sourceArea: region!.area
      }
    });
    document = u.document;
    // A half circle of radius 17 from wall top to wall top, its crown at
    // y 27: far above the bracket and both of the profile's ends.
    const sketch = profileSketch(document, 10, [
      {
        objectKind: 'arc',
        centerX: 20,
        centerY: 10,
        radius: 17,
        startAngleDeg: 0,
        endAngleDeg: 180
      }
    ]);
    const rib = ribBody(sketch.document, {
      name: 'Arch',
      targetBodyId: u.bodyId,
      profile: sketch.path,
      thickness: 2,
      thicknessSide: 'symmetric',
      direction: 'parallel'
    });
    const { derived, body } = await volumeOf(rib.document, rib.bodyId);
    expect(derived.warnings).toEqual([]);
    // The half disc over y 10 and the 30 × 5 pocket between the walls,
    // 2 thick.
    expect(body?.volume).toBeCloseTo(
      5000 + 2 * ((Math.PI * 17 * 17) / 2 + 30 * 5),
      6
    );
    expect(
      body?.topology?.faces.some(
        (face) => face.geometry?.surfaceType === 'cylinder'
      )
    ).toBe(true);
  });

  it('builds a profile whose coordinates are expressions', async () => {
    const start = bracket();
    const sketch = profileSketch(start.document, 10, [
      { ...gussetLine, y1: '15 + 15', x2: '60 / 2' }
    ]);
    const rib = ribBody(sketch.document, {
      name: 'Gusset',
      targetBodyId: start.bodyId,
      profile: sketch.path,
      thickness: 2,
      thicknessSide: 'first',
      direction: 'parallel'
    });
    const { derived, body } = await volumeOf(rib.document, rib.bodyId);
    expect(derived.warnings).toEqual([]);
    expect(body?.volume).toBeCloseTo(7500 + 625, 6);
  });

  it('refuses a profile in open space and one inside the body, by name', async () => {
    const start = bracket();
    const lonely = profileSketch(start.document, 10, [
      { objectKind: 'line', x1: 60, y1: 60, x2: 80, y2: 70 }
    ]);
    const open = ribBody(lonely.document, {
      name: 'Lonely',
      targetBodyId: start.bodyId,
      profile: lonely.path,
      thickness: 2,
      thicknessSide: 'symmetric',
      direction: 'parallel'
    });
    expect(
      (await volumeOf(open.document, open.bodyId)).derived.warnings.join('\n')
    ).toMatch(/does not close against the body/);

    const buried = profileSketch(start.document, 10, [
      { objectKind: 'line', x1: 10, y1: 1, x2: 30, y2: 1 }
    ]);
    const inside = ribBody(buried.document, {
      name: 'Buried',
      targetBodyId: start.bodyId,
      profile: buried.path,
      thickness: 2,
      thicknessSide: 'symmetric',
      direction: 'parallel'
    });
    expect(
      (await volumeOf(inside.document, inside.bodyId)).derived.warnings.join(
        '\n'
      )
    ).toMatch(/lies inside the body/);
  });
});
