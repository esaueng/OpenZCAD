import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  holeBody,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type {
  BodyId,
  FeatureData,
  FeatureId,
  FeatureNode,
  SketchId
} from '@openzcad/shared';
import {
  inPlaceEditMovedBodies,
  inPlaceEditSeed,
  inPlaceFeatureUpdate,
  inPlaceToolForFeature,
  type InPlaceEditContext
} from './edit';
import {
  IN_PLACE_TOOL_SPECS,
  type FacePick,
  type InPlaceContext,
  type InPlaceRequest,
  type InPlaceSlots
} from './tools';

const BODY = 'body_a' as BodyId;
const SKETCH = 'sketch_1' as SketchId;
const TOP: FacePick = {
  bodyId: BODY,
  hash: 11,
  topologyId: 'f11',
  surfaceType: 'plane',
  normal: { x: 0, y: 0, z: 1 },
  centroid: { x: 10, y: 5, z: 4 },
  center: { x: 10, y: 5, z: 4 }
};

const EDIT_CTX: InPlaceEditContext = {
  evaluate: (value) =>
    typeof value === 'number' ? value : value === 'wall' ? 2.5 : null,
  profile: (sketchId, reference) => ({
    sketchId,
    reference,
    regionFingerprint: 7
  }),
  firstRegion: () => 7,
  face: (bodyId, hash) => (hash === 11 ? { ...TOP, bodyId } : null),
  anyFace: (bodyId) => ({ ...TOP, bodyId }),
  curve: (_sketchId, entityId) => entityId !== 'gone',
  body: (bodyId) => ({
    bodyId,
    min: { x: 0, y: 0, z: 0 },
    max: { x: 20, y: 10, z: 4 }
  })
};

function feature(data: FeatureData, bodyId?: BodyId): FeatureNode {
  return {
    id: 'node_1',
    kind: 'feature',
    featureId: 'feat_1' as FeatureId,
    name: 'Stored',
    data,
    ...(bodyId ? { bodyId } : {})
  } as unknown as FeatureNode;
}

/** The request the seeded command would commit, untouched. */
function untouched(node: FeatureNode): InPlaceRequest | null {
  const armed = inPlaceEditSeed(node, EDIT_CTX)!;
  const spec = IN_PLACE_TOOL_SPECS[armed.tool];
  const axis =
    armed.seed.axes.find(
      (candidate) => candidate.id === armed.seed.slots.axisId
    ) ??
    (armed.seed.slots.axisId === 'datum:axis_1'
      ? {
          id: 'datum:axis_1',
          label: 'Axis 1',
          origin: { x: 0, y: 0, z: 0 },
          direction: { x: 0, y: 0, z: 1 },
          choice: { datumFeatureId: 'axis_1' as FeatureId }
        }
      : armed.seed.slots.axisId === 'sketch-vertical'
        ? {
            id: 'sketch-vertical',
            label: 'Sketch vertical axis',
            origin: { x: 0, y: 0, z: 0 },
            direction: { x: 0, y: 0, z: 1 },
            choice: { axis: 'vertical' as const }
          }
        : null);
  const slots: InPlaceSlots = {
    profiles: armed.seed.slots.profiles,
    axis,
    path: armed.seed.slots.path,
    guide: armed.seed.slots.guide,
    faces: armed.seed.slots.faces,
    bodies: armed.seed.slots.bodies,
    plane: armed.seed.slots.plane
  };
  const values: Record<string, number | string> = { ...armed.seed.values };
  for (const [id, raw] of Object.entries(armed.seed.raws)) values[id] = raw;
  const ctx: InPlaceContext = {
    sketchViews: [],
    datumAxes: undefined,
    datumLabel: () => 'Axis',
    saved: node.data,
    evaluate: EDIT_CTX.evaluate
  };
  return spec.request(
    slots,
    values,
    armed.seed.options,
    ctx,
    armed.seed.values
  );
}

describe('which in-place command edits a stored feature', () => {
  it('maps kinds, booleans by operation and patterns by kind', () => {
    expect(
      inPlaceToolForFeature({
        featureKind: 'boolean',
        operation: 'subtract',
        targetBodyIds: []
      })
    ).toBe('subtract');
    expect(
      inPlaceToolForFeature({
        featureKind: 'pattern',
        targetBodyId: BODY,
        patternKind: 'grid',
        count: 2,
        axis: 'x',
        spacing: 5,
        angleDeg: 0
      })
    ).toBe('grid-pattern');
  });

  it('leaves a Move to its own editor; a pure scale or datum turn is in place', () => {
    const transform = (
      extra: Partial<Extract<FeatureData, { featureKind: 'transform' }>>,
      translation = { x: 0, y: 0, z: 0 }
    ): FeatureData => ({
      featureKind: 'transform',
      targetBodyId: BODY,
      transform: {
        translation,
        rotationDeg: { x: 0, y: 0, z: 0 },
        ...(extra.transform ?? {})
      },
      ...(extra.axisRotation ? { axisRotation: extra.axisRotation } : {})
    });
    expect(inPlaceToolForFeature(transform({}, { x: 5, y: 0, z: 0 }))).toBe(
      null
    );
    expect(
      inPlaceToolForFeature(
        transform({
          transform: {
            translation: { x: 0, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 },
            scale: 2
          }
        })
      )
    ).toBe('scale');
    expect(
      inPlaceToolForFeature(
        transform({
          axisRotation: {
            axis: { type: 'datum-axis', datumFeatureId: 'axis_1' as FeatureId },
            angleDeg: 30
          }
        })
      )
    ).toBe('axis-rotate');
  });
});

describe('an untouched edit writes the feature back as stored', () => {
  it('hole: its stored position, anchor, step and expressions', () => {
    const data: FeatureData = {
      featureKind: 'hole',
      targetBodyId: BODY,
      faceHash: 11,
      style: 'counterbore',
      diameter: 'bore',
      depthMode: 'blind',
      depth: 8,
      counterboreDiameter: 11,
      counterboreDepth: 'wall',
      position: { u: '-3', v: 'offset_v' }
    };
    const request = untouched(feature(data, 'body_b' as BodyId));
    expect(request).toMatchObject({
      tool: 'modeling',
      state: {
        operation: 'hole',
        value: {
          targetBodyId: BODY,
          faceHash: 11,
          style: 'counterbore',
          diameter: 'bore',
          depthMode: 'blind',
          depth: '8',
          counterboreDiameter: '11',
          counterboreDepth: 'wall',
          position: { u: '-3', v: 'offset_v' }
        }
      }
    });
  });

  it('draft: a typed pull and its hinge stay as stored', () => {
    const data: FeatureData = {
      featureKind: 'draft',
      targetBodyId: BODY,
      faceHashes: [11],
      pullDirection: { x: 0, y: 'tilt', z: 1 },
      neutralPoint: { x: 1, y: 2, z: 3 },
      angleDeg: 4
    };
    const armed = inPlaceEditSeed(feature(data), EDIT_CTX)!;
    expect(armed.seed.options).toMatchObject({
      pull: 'saved',
      neutral: 'saved'
    });
    expect(untouched(feature(data))).toMatchObject({
      state: {
        value: {
          pullDirection: { x: '0', y: 'tilt', z: '1' },
          neutralPoint: { x: '1', y: '2', z: '3' },
          angleDeg: '4'
        }
      }
    });
    // A plain world pull is its preset, still offering the stored one.
    const preset = inPlaceEditSeed(
      feature({ ...data, pullDirection: { x: 0, y: 0, z: -1 } }),
      EDIT_CTX
    )!;
    expect(preset.seed.options.pull).toBe('-Z');
  });

  it('mirror: a typed plane goes back as written', () => {
    const data: FeatureData = {
      featureKind: 'mirror',
      targetBodyId: BODY,
      plane: {
        origin: { x: 'wall', y: 0, z: 0 },
        normal: { x: 1, y: 0, z: 0 }
      }
    };
    expect(untouched(feature(data))).toMatchObject({
      state: {
        value: {
          origin: { x: 'wall', y: '0', z: '0' },
          normal: { x: '1', y: '0', z: '0' }
        }
      }
    });
  });

  it('helical sweep: its typed axis is kept', () => {
    const profile = { all: true as const, sourceEntityIds: ['a'] };
    const data: FeatureData = {
      featureKind: 'helical-sweep',
      profile: { sketchId: SKETCH, profile },
      axisOrigin: { x: 'wall', y: 0, z: 0 },
      axisDirection: { x: 0, y: 0, z: 1 },
      radius: 'wall',
      pitch: 4,
      turns: 3
    };
    expect(untouched(feature(data))).toEqual({
      tool: 'helical-sweep',
      profile: { sketchId: SKETCH, profile },
      axisOrigin: { x: 'wall', y: 0, z: 0 },
      axisDirection: { x: 0, y: 0, z: 1 },
      radius: 'wall',
      pitch: 4,
      turns: 3
    });
  });

  it('revolve: a profile-less revolve stays profile-less; a full turn stays 360', () => {
    const data: FeatureData = {
      featureKind: 'revolve',
      sketchId: SKETCH,
      axis: 'vertical',
      angleDeg: 360
    };
    const node = feature(data, BODY);
    const request = untouched(node)!;
    expect(request).not.toHaveProperty('profile');
    const update = inPlaceFeatureUpdate(
      { featureId: node.featureId, name: node.name, data },
      request as Exclude<InPlaceRequest, { tool: 'modeling' }>
    );
    expect(update).toEqual({
      featureId: 'feat_1',
      name: 'Stored',
      data: {
        featureKind: 'revolve',
        sketchId: SKETCH,
        axis: 'vertical',
        angleDeg: 360
      },
      clearData: ['axisRef']
    });
  });

  it('linear pattern: a stored direction is kept, and a world axis replaces it', () => {
    const data: FeatureData = {
      featureKind: 'pattern',
      targetBodyId: BODY,
      patternKind: 'linear',
      count: 'n',
      axis: 'x',
      spacing: 12,
      angleDeg: 0,
      direction: { x: 1, y: 1, z: 0 }
    };
    const node = feature(data, 'body_p' as BodyId);
    const request = untouched(node) as Extract<
      InPlaceRequest,
      { tool: 'pattern' }
    >;
    expect(request).toMatchObject({
      count: 'n',
      spacing: 12,
      direction: { x: 1, y: 1, z: 0 }
    });
    // The stored vector cannot be cleared: Y writes the Y axis as one.
    const { direction: _kept, ...along } = request;
    const update = inPlaceFeatureUpdate(
      { featureId: node.featureId, name: node.name, data },
      { ...along, axis: 'y' }
    );
    expect(update?.data).toMatchObject({
      axis: 'y',
      direction: { x: 0, y: 1, z: 0 }
    });
  });

  it('grid pattern: an absent second direction stays absent while it follows', () => {
    const data: FeatureData = {
      featureKind: 'pattern',
      targetBodyId: BODY,
      patternKind: 'grid',
      count: 3,
      axis: 'x',
      spacing: 12,
      angleDeg: 0
    };
    const node = feature(data, 'body_p' as BodyId);
    const request = untouched(node) as Extract<
      InPlaceRequest,
      { tool: 'pattern' }
    >;
    const update = inPlaceFeatureUpdate(
      { featureId: node.featureId, name: node.name, data },
      request
    );
    expect(update?.data).not.toHaveProperty('axis2');
    expect(update?.data).not.toHaveProperty('spacing2');
    expect(update?.data).not.toHaveProperty('count2');
    // Set apart from the first, it is written.
    expect(
      inPlaceFeatureUpdate(
        { featureId: node.featureId, name: node.name, data },
        { ...request, spacing2: 30 }
      )?.data
    ).toMatchObject({ spacing2: 30 });
  });

  it('scale: the pivot and the rest of the transform stay as stored', () => {
    const data: FeatureData = {
      featureKind: 'transform',
      targetBodyId: BODY,
      transform: {
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: 2
      }
    };
    const node = feature(data);
    const armed = inPlaceEditSeed(node, EDIT_CTX)!;
    // The box the handle works on is the body before the scale, about the
    // origin an old scale (no pivot) turned about.
    expect(armed.seed.slots.bodies[0]).toMatchObject({
      max: { x: 10, y: 5, z: 2 }
    });
    expect(armed.seed.lockedOptions).toContain('copy');
    const update = inPlaceFeatureUpdate(
      { featureId: node.featureId, name: node.name, data },
      {
        tool: 'transform',
        targetBodyId: BODY,
        translation: { x: 0, y: 0, z: 0 },
        scale: 3,
        pivot: { x: 5, y: 2.5, z: 1 }
      }
    );
    expect(update?.data).toEqual({
      featureKind: 'transform',
      targetBodyId: BODY,
      transform: {
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: 3
      }
    });
  });

  it('boolean: its bodies, operation and kept inputs', () => {
    const data: FeatureData = {
      featureKind: 'boolean',
      operation: 'subtract',
      targetBodyIds: [BODY, 'body_b' as BodyId],
      keepOriginals: 'tools'
    };
    expect(untouched(feature(data, 'body_r' as BodyId))).toEqual({
      tool: 'boolean',
      operation: 'subtract',
      targetBodyIds: [BODY, 'body_b'],
      keepOriginals: 'tools'
    });
  });

  it('sweep: a path curve the sketch no longer has is left out, and said', () => {
    const data: FeatureData = {
      featureKind: 'sweep',
      profile: {
        sketchId: SKETCH,
        profile: { all: true, sourceEntityIds: ['a'] }
      },
      path: { sketchId: SKETCH, entityIds: ['p1', 'gone', 'p2'] as never[] },
      mode: 'standard'
    };
    const armed = inPlaceEditSeed(feature(data), EDIT_CTX)!;
    expect(armed.seed.slots.path.map((curve) => curve.entityId)).toEqual([
      'p1',
      'p2'
    ]);
    expect(armed.seed.notice).toMatch(/saved path no longer resolves/);
  });

  it('boolean: an input with no body left is left out to pick again', () => {
    const data: FeatureData = {
      featureKind: 'boolean',
      operation: 'union',
      targetBodyIds: [BODY, 'body_gone' as BodyId]
    };
    const armed = inPlaceEditSeed(feature(data, 'body_r' as BodyId), {
      ...EDIT_CTX,
      body: (bodyId) =>
        bodyId === 'body_gone'
          ? null
          : {
              bodyId,
              min: { x: 0, y: 0, z: 0 },
              max: { x: 1, y: 1, z: 1 }
            }
    })!;
    expect(armed.seed.slots.bodies.map((body) => body.bodyId)).toEqual([BODY]);
    expect(armed.seed.notice).toMatch(/saved body no longer resolves/);
  });

  it('names what no longer resolves, and leaves that slot to pick again', () => {
    const data: FeatureData = {
      featureKind: 'shell',
      targetBodyId: BODY,
      openingFaceHashes: [99],
      thickness: 'wall'
    };
    const armed = inPlaceEditSeed(feature(data), EDIT_CTX)!;
    expect(armed.seed.slots.faces).toEqual([]);
    expect(armed.seed.notice).toMatch(/saved face no longer resolves/);
    expect(armed.seed.raws.thickness).toBe('wall');
    expect(armed.seed.values.thickness).toBe(2.5);
    expect(armed.seed.touched).toEqual(['thickness']);
  });
});

describe('inPlaceEditMovedBodies', () => {
  it('names the copies a later move made of the edited body, and what is built on them', () => {
    let document = createProjectDocument('Moved', toUserId('user_test'));
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 30, depth: 20 }
    });
    document = addPrimitiveFeature(document, {
      name: 'Post',
      primitiveKind: 'box',
      dimensions: { width: 5, height: 5, depth: 40 }
    });
    const [block, post] = listFeaturesInOrder(document).flatMap((feature) =>
      feature.bodyId ? [feature.bodyId] : []
    );
    const drilled = holeBody(document, {
      name: 'Hole',
      targetBodyId: block!,
      faceHash: 1,
      style: 'simple',
      diameter: 4,
      depthMode: 'through',
      position: { u: 0, v: 0 }
    });
    document = drilled.document;
    const hole = listFeaturesInOrder(document).at(-1)!.featureId;
    const copy = transformBody(document, {
      name: 'Copy',
      targetBodyId: drilled.bodyId,
      translation: { x: 60, y: 0, z: 0 },
      copy: true
    });
    document = copy.document;
    const joined = booleanBodies(document, {
      name: 'Join',
      operation: 'union',
      targetBodyIds: [copy.bodyId, post!]
    });
    document = joined.document;
    const moved = inPlaceEditMovedBodies(document, hole);
    expect(moved.has(copy.bodyId)).toBe(true);
    expect(moved.has(joined.bodyId)).toBe(true);
    // The drilled body itself stands where the hole was made.
    expect(moved.has(drilled.bodyId)).toBe(false);
  });
});
