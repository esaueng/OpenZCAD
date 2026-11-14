import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  chamferEdges,
  extrudeSketch,
  createProjectDocument,
  listFeaturesInOrder,
  mirrorBody,
  setParameter,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  onlyDimensionEdits,
  referencedSketchIds,
  upstreamSnapshot
} from './exact-carry-edit-gate';

/**
 * The carry's edit gate is an explicit allow-list: dimension edits pass,
 * everything else (a turn, a mirror, a feature added) refuses.
 */
const user = toUserId('user_carry_edit_gate');

function turnedPart(
  options: { width?: string | number; turn?: string | number } = {}
) {
  const start = setParameter(createProjectDocument('Gate', user), {
    name: 'w',
    expression: '30'
  });
  const box = addPrimitiveFeature(start, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: options.width ?? 30, height: 18, depth: 24 }
  });
  const turned = transformBody(box, {
    name: 'Turn',
    targetBodyId: box.bodyOrder[0]!,
    translation: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: options.turn ?? 0 }
  }).document;
  return chamferEdges(turned, {
    name: 'Break',
    targetBodyId: box.bodyOrder[0]!,
    edgeHashes: [1234567],
    size: 1
  }).document;
}

const named = (document: ProjectDocument, name: string) =>
  listFeaturesInOrder(document).find((feature) => feature.name === name)!;

/** A build state with no sketches, datums or projections resolved. */
const nothingResolved = () => ({
  sketchBases: new Map(),
  datumFrames: new Map(),
  datumAxes: new Map()
});

function judged(
  before: ProjectDocument,
  after: ProjectDocument,
  resolved: {
    before?: ReturnType<typeof nothingResolved>;
    after?: ReturnType<typeof nothingResolved>;
  } = {}
): boolean {
  const modifier = named(before, 'Break').featureId;
  return onlyDimensionEdits(
    upstreamSnapshot(before, modifier, resolved.before ?? nothingResolved())!,
    upstreamSnapshot(after, modifier, resolved.after ?? nothingResolved())!
  );
}

function resized(part: ProjectDocument, dimensions: Record<string, unknown>) {
  return updateFeature(part, {
    featureId: named(part, 'Box').featureId,
    data: { dimensions: dimensions as Record<string, number> }
  });
}

describe('carry edit gate', () => {
  it('passes an unchanged upstream and a primitive dimension edit', () => {
    const part = turnedPart();
    expect(judged(part, part)).toBe(true);
    const wider = updateFeature(part, {
      featureId: named(part, 'Box').featureId,
      data: { dimensions: { width: 22.5, height: 18, depth: 24 } }
    });
    expect(judged(part, wider)).toBe(true);
  });

  it('refuses a turn, a pivot and a translation of a transform', () => {
    const part = turnedPart();
    const turn = named(part, 'Turn');
    if (turn.data.featureKind !== 'transform') throw new Error('no turn');
    for (const transform of [
      { ...turn.data.transform, rotationDeg: { x: 0, y: 0, z: 180 } },
      { ...turn.data.transform, pivot: { x: 15, y: 9, z: 0 } },
      { ...turn.data.transform, translation: { x: 1, y: 0, z: 0 } }
    ]) {
      expect(
        judged(part, updateFeature(part, { featureId: turn.featureId, data: { transform } }))
      ).toBe(false);
    }
  });

  it('refuses a feature added upstream, such as a mirror', () => {
    const part = turnedPart();
    const box = named(part, 'Box');
    const mirrored = mirrorBody(part, {
      name: 'Mirror',
      targetBodyId: box.bodyId!,
      plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
    }).document;
    // Move the mirror before the modifier.
    const order = [...mirrored.featureOrder];
    const mirror = order.pop()!;
    order.splice(order.length - 1, 0, mirror);
    expect(judged(part, { ...mirrored, featureOrder: order })).toBe(false);
  });

  it('lets a parameter change only where every use is a dimension', () => {
    const sized = (document: ProjectDocument) =>
      setParameter(document, { name: 'w', expression: '22.5' });
    const asWidth = turnedPart({ width: 'w' });
    expect(judged(asWidth, sized(asWidth))).toBe(true);
    // The same parameter also turning the part: refused.
    const asTurn = turnedPart({ width: 'w', turn: 'w' });
    expect(judged(asTurn, sized(asTurn))).toBe(false);
  });

  it('refuses a size that changes sign or reaches zero', () => {
    const part = turnedPart();
    // A negative size mirrors what it builds; zero builds nothing.
    expect(judged(part, resized(part, { width: -30, height: 18, depth: 24 }))).toBe(
      false
    );
    expect(judged(part, resized(part, { width: 0, height: 18, depth: 24 }))).toBe(
      false
    );
    expect(judged(part, resized(part, { width: 12, height: 18, depth: 24 }))).toBe(
      true
    );
  });

  it('refuses an extrude distance that turns negative, which mirrors it', () => {
    const sketched = addSketchFeature(createProjectDocument('Gate', user), {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        { objectKind: 'rectangle', width: 20, height: 10, centerX: 10, centerY: 5 }
      ]
    });
    const extruded = extrudeSketch(sketched.document, {
      name: 'Slab',
      sketchId: sketched.sketchId,
      distance: 5
    });
    const part = chamferEdges(extruded.document, {
      name: 'Break',
      targetBodyId: extruded.bodyId,
      edgeHashes: [1234567],
      size: 1
    }).document;
    const distance = (value: number) =>
      updateFeature(part, {
        featureId: named(part, 'Slab').featureId,
        data: { distance: value }
      });
    expect(judged(part, distance(8))).toBe(true);
    expect(judged(part, distance(-5))).toBe(false);
  });

  it('refuses a primitive key that is not one of its kind’s dimensions', () => {
    const part = turnedPart();
    expect(
      judged(
        part,
        resized(part, { width: 30, height: 18, depth: 24, angle: 90 })
      )
    ).toBe(false);
  });

  it('refuses when a frame the build resolved moved, however the data reads', () => {
    // A datum through a body's points, or a re-solved linked projection,
    // turns with an allowed resize while its own data stays the same.
    const part = turnedPart();
    const wider = resized(part, { width: 22.5, height: 18, depth: 24 });
    const axis = (direction: number) => ({
      ...nothingResolved(),
      datumAxes: new Map([
        ['feat_axis', { origin: { x: 0, y: 0, z: 10 }, direction: { x: 0, y: 0, z: direction } }]
      ])
    });
    expect(judged(part, wider, { before: axis(1), after: axis(1) })).toBe(true);
    expect(judged(part, wider, { before: axis(1), after: axis(-1) })).toBe(false);
    // No build state at all proves nothing.
    const modifier = named(part, 'Break').featureId;
    expect(
      onlyDimensionEdits(
        upstreamSnapshot(part, modifier)!,
        upstreamSnapshot(part, modifier)!
      )
    ).toBe(false);
  });

  it('finds the sketches a loft, sweep or helical sweep names below the top level', () => {
    const found = new Set<string>();
    referencedSketchIds(
      {
        featureKind: 'loft',
        sections: [
          { sketchId: 'sk_lower', profile: {} },
          { sketchId: 'sk_upper', profile: {} }
        ]
      },
      found
    );
    referencedSketchIds(
      {
        featureKind: 'sweep',
        profile: { sketchId: 'sk_profile', profile: {} },
        path: { sketchId: 'sk_path', entityIds: [] },
        guide: { sketchId: 'sk_guide', entityIds: [] }
      },
      found
    );
    referencedSketchIds(
      { featureKind: 'helical-sweep', profile: { sketchId: 'sk_coil' } },
      found
    );
    expect([...found].sort()).toEqual([
      'sk_coil',
      'sk_guide',
      'sk_lower',
      'sk_path',
      'sk_profile',
      'sk_upper'
    ]);
  });

  it.each(['__proto__', 'constructor', 'toString', 'valueOf'])(
    'reads no inherited member for a forged kind "%s"',
    (name) => {
      const forge = (width: number) => {
        const part = structuredClone(turnedPart({ width }));
        const box = named(part, 'Box');
        const turn = named(part, 'Turn');
        (box.data as unknown as Record<string, unknown>).primitiveKind = name;
        (turn.data as unknown as Record<string, unknown>).featureKind = name;
        return part;
      };
      const before = forge(30);
      const after = forge(40);
      const snapshot = (part: ProjectDocument) =>
        upstreamSnapshot(
          part,
          named(part, 'Break').featureId,
          nothingResolved()
        )!;
      expect(() => snapshot(before)).not.toThrow();
      const box = named(before, 'Box').featureId;
      expect(
        [...snapshot(before).sizes.keys()].filter((key) =>
          key.startsWith(`${box}:`)
        )
      ).toEqual([]);
      // An unknown kind allows no dimension to change.
      expect(onlyDimensionEdits(snapshot(before), snapshot(after))).toBe(false);
    }
  );
});
