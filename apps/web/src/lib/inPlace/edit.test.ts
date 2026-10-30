import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  holeBody,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import type { FeatureUpdateInput } from '@openzcad/document-core';
import type {
  BodyId,
  FaceTopologyReferenceV5,
  FeatureData,
  FeatureId,
  FeatureNode,
  SketchId
} from '@openzcad/shared';
import {
  withFeatureBuilt,
  inPlaceEditBodyBox,
  inPlaceEditLineage,
  keepAbsentHoleSteps,
  inPlaceEditMovedBodies,
  inPlaceEditSeed,
  inPlaceEditSourceSketchIds,
  inPlaceFeatureUpdate,
  inPlaceToolForFeature,
  laterDirectEdit,
  laterInPlaceSteps,
  laterStepsOnBody,
  type InPlaceEditContext
} from './edit';
import {
  IN_PLACE_TOOL_SPECS,
  type FacePick,
  type InPlaceContext,
  type ResolvedInPlaceRequest,
  type InPlaceSlots,
  resolveNewAxis
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
  edge: (bodyId, hash) =>
    hash === 21 || hash === 22
      ? {
          bodyId,
          hash,
          topologyId: `e${hash}`,
          // The live body's own name, which an edit must not swap in.
          reference: { kind: 'edge', currentHash: hash } as never,
          middle: { x: 5, y: 0, z: 4 },
          outward: { x: 0, y: -1, z: 1 }
        }
      : null,
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

/**
 * The request the seeded command would commit, untouched, or after the user
 * sets `changed` (the tool's defaults fill the rest, as the hook's do).
 */
function untouched(
  node: FeatureNode,
  changed: Record<string, number> = {}
): ResolvedInPlaceRequest | null {
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
    plane: armed.seed.slots.plane,
    edges: armed.seed.slots.edges,
    refs: [],
    image: null
  };
  const ctx: InPlaceContext = {
    sketchViews: [],
    datumAxes: undefined,
    datumLabel: () => 'Axis',
    saved: node.data,
    evaluate: EDIT_CTX.evaluate,
    touched: [...armed.seed.touched, ...Object.keys(changed)]
  };
  const numbers: Record<string, number> = {
    ...armed.seed.values,
    ...changed
  };
  const touched = new Set([...armed.seed.touched, ...Object.keys(changed)]);
  for (const [id, value] of Object.entries(
    spec.defaults?.(slots, ctx, numbers) ?? {}
  )) {
    if (!touched.has(id)) numbers[id] = value;
  }
  const values: Record<string, number | string> = { ...numbers };
  for (const [id, raw] of Object.entries(armed.seed.raws)) {
    if (!(id in changed)) values[id] = raw;
  }
  const request = spec.request(slots, values, armed.seed.options, ctx, numbers);
  return request && resolveNewAxis(request, null);
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
  it('gear: a new gear keeps its placement, pitch expression and form', () => {
    const data: FeatureData = {
      featureKind: 'gear',
      gearType: 'external',
      sizing: 'module',
      pitch: 'wall',
      teeth: 24,
      faceWidth: 8,
      pressureAngleDeg: 25,
      origin: { x: 1, y: 2, z: 'wall' },
      axis: { x: 0, y: 0, z: 1 },
      xDirection: { x: 0, y: 1, z: 0 }
    };
    const node = feature(data, 'body_b' as BodyId);
    expect(inPlaceToolForFeature(data)).toBe('gear');
    const request = untouched(node)!;
    expect(request).toMatchObject({
      tool: 'gear',
      gear: {
        gearType: 'external',
        sizing: 'module',
        pitch: 'wall',
        teeth: 24,
        faceWidth: 8,
        pressureAngleDeg: 25,
        origin: { x: 1, y: 2, z: 'wall' },
        axis: { x: 0, y: 0, z: 1 },
        xDirection: { x: 0, y: 1, z: 0 }
      }
    });
    if (request.tool !== 'gear') throw new Error('not a gear request');
    // Unset form fields stay unset: the kernel default, not a copy of it.
    expect(request.gear).not.toHaveProperty('profileShift');
    expect(request.gear).not.toHaveProperty('rimDiameter');
    const update = inPlaceFeatureUpdate(
      { featureId: node.featureId, name: node.name, data },
      request
    );
    expect(update).not.toHaveProperty('clearData');
    // Dropping the stored pressure angle clears it rather than keeping it.
    const { pressureAngleDeg: _dropped, ...rest } = request.gear;
    expect(
      inPlaceFeatureUpdate(
        { featureId: node.featureId, name: node.name, data },
        { tool: 'gear', gear: rest }
      )?.clearData
    ).toEqual(['pressureAngleDeg']);
  });

  it('gear: teeth on a body reopen on their face with the stored fit', () => {
    const data: FeatureData = {
      featureKind: 'gear',
      gearType: 'internal',
      sizing: 'diametral-pitch',
      pitch: 16,
      teeth: 40,
      fit: 'module',
      targetBodyId: BODY,
      faceHash: 11
    };
    expect(inPlaceToolForFeature(data)).toBe('gear-teeth');
    const armed = inPlaceEditSeed(feature(data, BODY), EDIT_CTX)!;
    expect(armed.seed.options).toMatchObject({
      side: 'inside',
      fit: 'module',
      sizing: 'diametral-pitch'
    });
    expect(untouched(feature(data, BODY))).toMatchObject({
      tool: 'gear',
      gear: {
        gearType: 'internal',
        sizing: 'diametral-pitch',
        pitch: 16,
        teeth: 40,
        fit: 'module',
        targetBodyId: BODY,
        faceHash: 11
      }
    });
  });

  it('gear: a helical gear keeps its helix angle and hand', () => {
    const data: FeatureData = {
      featureKind: 'gear',
      gearType: 'external',
      sizing: 'module',
      pitch: 2,
      teeth: 20,
      fit: 'module',
      helixAngleDeg: 'helix',
      hand: 'left',
      targetBodyId: BODY,
      faceHash: 11
    };
    const armed = inPlaceEditSeed(feature(data, BODY), EDIT_CTX)!;
    expect(armed.seed.options).toMatchObject({ hand: 'left' });
    const request = untouched(feature(data, BODY))!;
    expect(request).toMatchObject({
      tool: 'gear',
      gear: { helixAngleDeg: 'helix', hand: 'left' }
    });
    if (request.tool !== 'gear') throw new Error('not a gear request');
    expect(
      inPlaceFeatureUpdate(
        { featureId: 'feature_g' as FeatureId, name: 'Gear', data },
        request
      )
    ).not.toHaveProperty('clearData');
    // Back to a spur gear: the helix and its hand are cleared together.
    const { helixAngleDeg: _helix, hand: _hand, ...spur } = request.gear;
    expect(
      inPlaceFeatureUpdate(
        { featureId: 'feature_g' as FeatureId, name: 'Gear', data },
        { tool: 'gear', gear: spur }
      )?.clearData
    ).toEqual(['helixAngleDeg', 'hand']);
  });

  it('gear: a herringbone gear reopens as one and returns to a single helix', () => {
    const data: FeatureData = {
      featureKind: 'gear',
      gearType: 'external',
      sizing: 'module',
      pitch: 2,
      teeth: 20,
      fit: 'module',
      helixAngleDeg: 25,
      herringbone: true,
      targetBodyId: BODY,
      faceHash: 11
    };
    const armed = inPlaceEditSeed(feature(data, BODY), EDIT_CTX)!;
    expect(armed.seed.options).toMatchObject({ helix: 'herringbone' });
    const request = untouched(feature(data, BODY))!;
    expect(request).toMatchObject({
      tool: 'gear',
      gear: { helixAngleDeg: 25, herringbone: true }
    });
    if (request.tool !== 'gear') throw new Error('not a gear request');
    const saved = { featureId: 'feature_g' as FeatureId, name: 'Gear', data };
    expect(inPlaceFeatureUpdate(saved, request)).not.toHaveProperty(
      'clearData'
    );
    const { herringbone: _herringbone, ...single } = request.gear;
    expect(
      inPlaceFeatureUpdate(saved, { tool: 'gear', gear: single })?.clearData
    ).toEqual(['herringbone']);
  });

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
      pull: 'custom',
      neutral: 'custom'
    });
    expect(armed.seed.raws).toMatchObject({ pullY: 'tilt' });
    expect(untouched(feature(data))).toMatchObject({
      state: {
        value: {
          pullDirection: { x: '0', y: 'tilt', z: '1' },
          neutralPoint: { x: '1', y: '2', z: '3' },
          angleDeg: '4'
        }
      }
    });
    // A plain world pull is its preset.
    const preset = inPlaceEditSeed(
      feature({ ...data, pullDirection: { x: 0, y: 0, z: -1 } }),
      EDIT_CTX
    )!;
    expect(preset.seed.options.pull).toBe('-Z');
  });

  it('mirror: a datum plane it may no longer use is not restored', () => {
    const data: FeatureData = {
      featureKind: 'mirror',
      targetBodyId: BODY,
      plane: { type: 'datum', datumFeatureId: 'plane_1' as FeatureId }
    };
    const armed = inPlaceEditSeed(feature(data), {
      ...EDIT_CTX,
      datumPlaneUsable: () => false
    })!;
    expect(armed.seed.slots.plane).toBeNull();
    expect(armed.seed.notice).toMatch(/saved plane no longer resolves/);
    const usable = inPlaceEditSeed(feature(data), {
      ...EDIT_CTX,
      datumPlaneUsable: () => true
    })!;
    expect(usable.seed.slots.plane).toEqual({
      kind: 'datum',
      featureId: 'plane_1'
    });
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
      request as Exclude<
        ResolvedInPlaceRequest,
        { tool: 'modeling' | 'edge-modifier' }
      >
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
      ResolvedInPlaceRequest,
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

  it('linear pattern: a stored vector opens as a custom one, each part editable', () => {
    const data: FeatureData = {
      featureKind: 'pattern',
      targetBodyId: BODY,
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 12,
      angleDeg: 0,
      direction: { x: 1, y: 'tilt', z: 0 }
    };
    const node = feature(data, 'body_p' as BodyId);
    const armed = inPlaceEditSeed(node, EDIT_CTX)!;
    expect(armed.seed.options.axis).toBe('custom');
    expect(armed.seed.raws.dirY).toBe('tilt');
    // A new Y part is stored as the vector's, the rest as stored.
    const request = untouched(node, { dirY: 2 }) as Extract<
      ResolvedInPlaceRequest,
      { tool: 'pattern' }
    >;
    expect(
      inPlaceFeatureUpdate(
        { featureId: node.featureId, name: node.name, data },
        request
      )?.data
    ).toMatchObject({ direction: { x: 1, y: 2, z: 0 } });
  });

  it('loft: a stored apex opens as a point, each coordinate editable', () => {
    const data: FeatureData = {
      featureKind: 'loft',
      sections: [
        { sketchId: SKETCH, profile: { regionFingerprint: 7 } as never },
        { sketchId: SKETCH, profile: { regionFingerprint: 7 } as never }
      ],
      mode: 'ruled',
      endPoint: { x: 3, y: 'off', z: 40 }
    };
    const node = feature(data, 'body_l' as BodyId);
    const armed = inPlaceEditSeed(node, EDIT_CTX)!;
    expect(armed.seed.options.end).toBe('point');
    expect(armed.seed.raws.apexY).toBe('off');
    const untouchedRequest = untouched(node) as Extract<
      ResolvedInPlaceRequest,
      { tool: 'loft' }
    >;
    expect(untouchedRequest.endPoint).toEqual({ x: 3, y: 'off', z: 40 });
    const moved = untouched(node, { apexX: 9 }) as Extract<
      ResolvedInPlaceRequest,
      { tool: 'loft' }
    >;
    expect(moved.endPoint).toEqual({ x: 9, y: 'off', z: 40 });
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
      ResolvedInPlaceRequest,
      { tool: 'pattern' }
    >;
    const update = inPlaceFeatureUpdate(
      { featureId: node.featureId, name: node.name, data },
      request
    );
    expect(update?.data).not.toHaveProperty('axis2');
    expect(update?.data).not.toHaveProperty('spacing2');
    expect(update?.data).not.toHaveProperty('count2');
    // A new first spacing or count carries the second along: still absent.
    const followed = inPlaceFeatureUpdate(
      { featureId: node.featureId, name: node.name, data },
      untouched(node, { spacing: 15, count: 4 }) as Extract<
        ResolvedInPlaceRequest,
        { tool: 'pattern' }
      >
    );
    expect(followed?.data).toMatchObject({ spacing: 15, count: 4 });
    expect(followed?.data).not.toHaveProperty('spacing2');
    expect(followed?.data).not.toHaveProperty('count2');
    // Set to the first's value on purpose, it is written and stops following.
    const pinned = inPlaceFeatureUpdate(
      { featureId: node.featureId, name: node.name, data },
      untouched(node, { spacing2: 12, count2: 3 }) as Extract<
        ResolvedInPlaceRequest,
        { tool: 'pattern' }
      >
    );
    expect(pinned?.data).toMatchObject({ spacing2: 12, count2: 3 });
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
    // It opens about the origin it scaled about, and stays so.
    expect(armed.seed.options.pivot).toBe('origin');
    expect(untouched(node)).not.toHaveProperty('pivot');
    const update = (pivot?: { x: number; y: number; z: number }) =>
      inPlaceFeatureUpdate(
        { featureId: node.featureId, name: node.name, data },
        {
          tool: 'transform',
          targetBodyId: BODY,
          translation: { x: 0, y: 0, z: 0 },
          scale: 3,
          ...(pivot ? { pivot } : {})
        }
      );
    expect(update()?.data).toEqual({
      featureKind: 'transform',
      targetBodyId: BODY,
      transform: {
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: 3
      }
    });
    // A pivot chosen in the edit is written.
    expect(update({ x: 5, y: 2.5, z: 1 })?.data).toMatchObject({
      transform: { scale: 3, pivot: { x: 5, y: 2.5, z: 1 } }
    });
  });

  it('rotate about axis: the rig works on the body before the turn', () => {
    const data: FeatureData = {
      featureKind: 'transform',
      targetBodyId: BODY,
      transform: {
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      },
      axisRotation: {
        axis: { type: 'datum-axis', datumFeatureId: 'axis_1' as FeatureId },
        angleDeg: 90
      }
    };
    // Shown turned a quarter about Z: the 20 × 10 × 4 box now runs 10 in x.
    const ctx: InPlaceEditContext = {
      ...EDIT_CTX,
      body: (bodyId) => ({
        bodyId,
        min: { x: -10, y: 0, z: 0 },
        max: { x: 0, y: 20, z: 4 }
      }),
      datumAxis: () => ({
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: 1 }
      })
    };
    const armed = inPlaceEditSeed(feature(data), ctx)!;
    expect(armed.seed.slots.bodies[0]).toMatchObject({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 20, y: 10, z: 4 }
    });
  });

  it("scale: a copy's handle works on its source as it stands", () => {
    const data: FeatureData = {
      featureKind: 'transform',
      targetBodyId: BODY,
      copy: true,
      transform: {
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 },
        scale: 2
      }
    };
    const armed = inPlaceEditSeed(feature(data), EDIT_CTX)!;
    // The source is live and unscaled: its box is not shrunk again.
    expect(armed.seed.slots.bodies[0]).toMatchObject({
      max: { x: 20, y: 10, z: 4 }
    });
  });

  it('a suppressed feature previews built, its document left as it is', () => {
    const node = {
      id: 'node_s',
      kind: 'feature',
      featureId: 'feat_s',
      name: 'Shell',
      data: {},
      metadata: { suppressed: true, colour: 'red' }
    };
    const document = {
      nodes: { node_s: node }
    } as unknown as ProjectDocument;
    const built = withFeatureBuilt(document, 'feat_s' as FeatureId);
    expect(built.nodes.node_s?.metadata).toEqual({ colour: 'red' });
    expect(node.metadata).toEqual({ suppressed: true, colour: 'red' });
    // A live feature, or another one, leaves the document alone.
    expect(withFeatureBuilt(built, 'feat_s' as FeatureId)).toBe(built);
    expect(withFeatureBuilt(document, 'feat_x' as FeatureId)).toBe(document);
  });
  it('hole: step sizes it never stored stay absent until they are set', () => {
    const saved: FeatureData = {
      featureKind: 'hole',
      targetBodyId: BODY,
      faceHash: 11,
      style: 'counterbore',
      diameter: 6,
      depthMode: 'through',
      position: { u: 0, v: 0 }
    };
    const update = {
      featureId: 'feat_1' as FeatureId,
      data: {
        ...saved,
        counterboreDiameter: 11,
        counterboreDepth: 3
      }
    } as unknown as FeatureUpdateInput;
    expect(keepAbsentHoleSteps(update, saved, []).data).not.toHaveProperty(
      'counterboreDiameter'
    );
    expect(
      keepAbsentHoleSteps(update, saved, ['counterboreDepth']).data
    ).toMatchObject({ counterboreDepth: 3 });
    expect(
      keepAbsentHoleSteps(update, saved, ['counterboreDepth']).data
    ).not.toHaveProperty('counterboreDiameter');
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

  it('fillet: its stored edge set and names, its end radius and law', () => {
    const references = [
      { kind: 'edge', currentHash: 21, stored: true },
      { kind: 'edge', currentHash: 22, stored: true }
    ] as never[];
    const data: FeatureData = {
      featureKind: 'fillet',
      targetBodyId: BODY,
      edgeHashes: [21, 22],
      edgeReferences: references,
      radius: 'r',
      endRadius: 3,
      radiusLaw: 'scurve'
    };
    expect(untouched(feature(data, 'body_f' as BodyId))).toEqual({
      tool: 'edge-modifier',
      kind: 'fillet',
      targetBodyId: BODY,
      edgeHashes: [21, 22],
      edgeReferences: references,
      size: 'r',
      endRadius: 3,
      radiusLaw: 'scurve'
    });
    // A set stored hash-only stays hash-only, whatever the body names now.
    const { edgeReferences: _named, ...hashOnly } = data;
    expect(untouched(feature(hashOnly, 'body_f' as BodyId))).not.toHaveProperty(
      'edgeReferences'
    );
  });

  it('fillet: an edge that no longer resolves is left for a new pick', () => {
    const data: FeatureData = {
      featureKind: 'fillet',
      targetBodyId: BODY,
      edgeHashes: [21, 99],
      radius: 1
    };
    const armed = inPlaceEditSeed(feature(data, 'body_f' as BodyId), EDIT_CTX)!;
    expect(armed.seed.slots.edges.map((edge) => edge.hash)).toEqual([21]);
    expect(armed.seed.notice).toMatch(/no longer resolves/);
  });

  it('chamfer: a stored second distance is its shape', () => {
    const data: FeatureData = {
      featureKind: 'chamfer',
      targetBodyId: BODY,
      edgeHashes: [21],
      distance: 1,
      distance2: 'd2'
    };
    expect(untouched(feature(data, 'body_c' as BodyId))).toMatchObject({
      kind: 'chamfer',
      size: 1,
      distance2: 'd2'
    });
  });

  it('sweep: a path curve the sketch no longer has is left out, and said', () => {
    const sweep = (entityIds: string[]): FeatureData => ({
      featureKind: 'sweep',
      profile: {
        sketchId: SKETCH,
        profile: { all: true, sourceEntityIds: ['a'] }
      },
      path: { sketchId: SKETCH, entityIds: entityIds as never[] },
      mode: 'standard'
    });
    // A lost last curve: the rest stays, and a new pick takes its place.
    const end = inPlaceEditSeed(
      feature(sweep(['p1', 'p2', 'gone'])),
      EDIT_CTX
    )!;
    expect(end.seed.slots.path.map((curve) => curve.entityId)).toEqual([
      'p1',
      'p2'
    ]);
    expect(end.seed.notice).toMatch(
      /saved path no longer resolves · pick it again/
    );
    // A lost middle one: a new pick would land last, so the whole path is
    // picked again, in order.
    const middle = inPlaceEditSeed(
      feature(sweep(['p1', 'gone', 'p2'])),
      EDIT_CTX
    )!;
    expect(middle.seed.slots.path).toEqual([]);
    expect(middle.seed.notice).toMatch(/pick its path again, in order/);
  });

  it('loft and subtract: a lost first entry clears the ordered list', () => {
    const loft = inPlaceEditSeed(
      feature({
        featureKind: 'loft',
        mode: 'ruled',
        sections: [
          {
            sketchId: 'gone' as SketchId,
            profile: { all: true, sourceEntityIds: ['a'] }
          },
          { sketchId: SKETCH, profile: { all: true, sourceEntityIds: ['a'] } }
        ]
      }),
      {
        ...EDIT_CTX,
        profile: (sketchId, reference) =>
          sketchId === 'gone' ? null : EDIT_CTX.profile(sketchId, reference)
      }
    )!;
    expect(loft.seed.slots.profiles).toEqual([]);
    expect(loft.seed.notice).toMatch(/pick its sections again, in order/);
    const subtract = inPlaceEditSeed(
      feature(
        {
          featureKind: 'boolean',
          operation: 'subtract',
          targetBodyIds: ['body_gone' as BodyId, BODY]
        },
        'body_r' as BodyId
      ),
      {
        ...EDIT_CTX,
        body: (bodyId) =>
          bodyId === 'body_gone' ? null : EDIT_CTX.body(bodyId)
      }
    )!;
    expect(subtract.seed.slots.bodies).toEqual([]);
    expect(subtract.seed.notice).toMatch(/pick its bodies again, in order/);
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

  it('finds a stored face by its lineage reference, as the rebuild does', () => {
    const reference = {
      kind: 'face',
      producingFeatureId: 'feat_box',
      lineageName: 'top'
    } as unknown as FaceTopologyReferenceV5;
    const asked: unknown[] = [];
    const ctx: InPlaceEditContext = {
      ...EDIT_CTX,
      // An upstream edit changed the hash; the lineage still names the face.
      face: (bodyId, hash, ref) => {
        asked.push([hash, ref]);
        return ref === reference ? { ...TOP, bodyId } : null;
      }
    };
    const data: FeatureData = {
      featureKind: 'shell',
      targetBodyId: BODY,
      openingFaceHashes: [99],
      openingFaceReferences: [reference],
      thickness: 1
    };
    const armed = inPlaceEditSeed(feature(data), ctx)!;
    expect(asked).toEqual([[99, reference]]);
    expect(armed.seed.slots.faces).toHaveLength(1);
    expect(armed.seed.notice).toBeNull();
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
    // A suppressed copy moved nothing, nor did what is built on it.
    const copyNode = Object.values(document.nodes).find(
      (node) => node.kind === 'feature' && node.name === 'Copy'
    )!;
    const suppressed: ProjectDocument = {
      ...document,
      nodes: {
        ...document.nodes,
        [copyNode.id]: {
          ...copyNode,
          metadata: {
            ...copyNode.metadata,
            [FEATURE_SUPPRESSED_METADATA_KEY]: true
          }
        }
      }
    };
    expect(inPlaceEditMovedBodies(suppressed, hole).has(copy.bodyId)).toBe(
      false
    );
    // Nor did a copy written to change nothing.
    const still = transformBody(drilled.document, {
      name: 'Still copy',
      targetBodyId: drilled.bodyId,
      translation: { x: 0, y: 0, z: 0 },
      copy: true
    });
    expect(inPlaceEditMovedBodies(still.document, hole).has(still.bodyId)).toBe(
      false
    );
  });
});

describe('inPlaceEditSourceSketchIds', () => {
  it("names a sweep's profile, path and guide sketches from what it stores", () => {
    const path = 'sketch_path' as SketchId;
    const guide = 'sketch_guide' as SketchId;
    expect(
      inPlaceEditSourceSketchIds({
        featureKind: 'sweep',
        profile: { sketchId: SKETCH },
        path: { sketchId: path, entityIds: ['gone'] },
        guide: { sketchId: guide, entityIds: ['gone'] }
      } as unknown as FeatureData)
    ).toEqual([SKETCH, path, guide]);
    expect(
      inPlaceEditSourceSketchIds({
        featureKind: 'shell'
      } as unknown as FeatureData)
    ).toEqual([]);
  });
});

describe('inPlaceEditLineage', () => {
  it("tells the result's own reshapes from bodies another one joined", () => {
    let document = createProjectDocument('Lineage', toUserId('user_test'));
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
    const moved = transformBody(document, {
      name: 'Nudge',
      targetBodyId: drilled.bodyId,
      translation: { x: 1, y: 0, z: 0 }
    });
    document = moved.document;
    const joined = booleanBodies(document, {
      name: 'Join',
      operation: 'union',
      targetBodyIds: [drilled.bodyId, post!]
    });
    document = joined.document;
    const lineage = inPlaceEditLineage(document, hole, []);
    // The hole's own result, moved in place, is still only its body.
    expect(lineage.pure.has(drilled.bodyId)).toBe(true);
    // The union carries the post's faces too.
    expect(lineage.mixed.has(joined.bodyId)).toBe(true);
    expect(lineage.pure.has(joined.bodyId)).toBe(false);
    // The post itself was never the hole's.
    expect(lineage.pure.has(post!)).toBe(false);
    expect(lineage.mixed.has(post!)).toBe(false);
  });
});

describe('inPlaceEditBodyBox', () => {
  const box = {
    bodyId: BODY,
    min: { x: 0, y: 0, z: 0 },
    max: { x: 20, y: 10, z: 4 }
  };
  const scale = (copy: boolean): FeatureData => ({
    featureKind: 'transform',
    targetBodyId: BODY,
    ...(copy ? { copy: true } : {}),
    transform: {
      translation: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 },
      scale: 2
    }
  });

  it("gives an in-place scale's handle the body before the scale", () => {
    expect(inPlaceEditBodyBox(box, scale(false), EDIT_CTX).max).toEqual({
      x: 10,
      y: 5,
      z: 2
    });
  });

  it('takes a later in-place move of the body back first', () => {
    // Shown: the body scaled ×2 about the origin, then moved +10 in x.
    const shown = {
      bodyId: BODY,
      min: { x: 10, y: 0, z: 0 },
      max: { x: 30, y: 10, z: 4 }
    };
    const nudge = {
      featureKind: 'transform',
      targetBodyId: BODY,
      transform: {
        translation: { x: 10, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      }
    } as FeatureData;
    expect(
      inPlaceEditBodyBox(shown, scale(false), EDIT_CTX, [nudge])
    ).toMatchObject({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 5, z: 2 } });
  });

  it("takes a copy's source back through its later steps alone", () => {
    // A copy never scaled its source; a later move did shift it +10 in x.
    const shown = {
      bodyId: BODY,
      min: { x: 10, y: 0, z: 0 },
      max: { x: 30, y: 10, z: 4 }
    };
    const nudge = {
      featureKind: 'transform',
      targetBodyId: BODY,
      transform: {
        translation: { x: 10, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      }
    } as FeatureData;
    expect(
      inPlaceEditBodyBox(shown, scale(true), EDIT_CTX, [nudge])
    ).toMatchObject({ min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 10, z: 4 } });
    // With no later step, the source is as shown.
    expect(inPlaceEditBodyBox(box, scale(true), EDIT_CTX)).toBe(box);
  });

  it('takes a later turn about an axis back too', () => {
    // Shown: scaled ×2 about the origin, then turned a quarter about Z.
    const shown = {
      bodyId: BODY,
      min: { x: -10, y: 0, z: 0 },
      max: { x: 0, y: 20, z: 4 }
    };
    const turn = {
      featureKind: 'transform',
      targetBodyId: BODY,
      transform: {
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      },
      axisRotation: {
        axis: { type: 'datum-axis', datumFeatureId: 'axis_1' as FeatureId },
        angleDeg: 90
      }
    } as FeatureData;
    const ctx = {
      ...EDIT_CTX,
      datumAxis: () => ({
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: 1 }
      })
    };
    expect(inPlaceEditBodyBox(shown, scale(false), ctx, [turn])).toMatchObject({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 5, z: 2 }
    });
    // A Move's own turn, the same way.
    const moved = {
      ...turn,
      axisRotation: undefined,
      transform: {
        ...(turn as { transform: object }).transform,
        rotationDeg: { x: 0, y: 0, z: 90 }
      }
    } as unknown as FeatureData;
    expect(inPlaceEditBodyBox(shown, scale(false), ctx, [moved])).toMatchObject(
      {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 10, y: 5, z: 2 }
      }
    );
  });

  it("takes a turn back from the body's own vertices, exactly", () => {
    // A 20 × 10 box turned 30° about Z: its turned box is larger than it.
    const turnBy = (degrees: number) => (x: number, y: number) => {
      const a = (degrees * Math.PI) / 180;
      return [
        x * Math.cos(a) - y * Math.sin(a),
        x * Math.sin(a) + y * Math.cos(a)
      ];
    };
    const corners = [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10]
    ].map(([x, y]) => turnBy(30)(x!, y!));
    const vertices = corners.flatMap(([x, y]) => [x!, y!, 0, x!, y!, 4]);
    const shown = {
      bodyId: BODY,
      min: {
        x: Math.min(...corners.map((c) => c[0]!)),
        y: Math.min(...corners.map((c) => c[1]!)),
        z: 0
      },
      max: {
        x: Math.max(...corners.map((c) => c[0]!)),
        y: Math.max(...corners.map((c) => c[1]!)),
        z: 4
      }
    };
    const rotate = {
      featureKind: 'transform',
      targetBodyId: BODY,
      transform: {
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      },
      axisRotation: {
        axis: { type: 'datum-axis', datumFeatureId: 'axis_1' as FeatureId },
        angleDeg: 30
      }
    } as FeatureData;
    const box = inPlaceEditBodyBox(shown, rotate, {
      ...EDIT_CTX,
      datumAxis: () => ({
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: 1 }
      }),
      bodyVertices: () => vertices
    });
    expect(box).toMatchObject({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 20, y: 10, z: 4 }
    });
  });

  it('leaves a suppressed scale out of what it takes back', () => {
    const box = {
      bodyId: BODY,
      min: { x: 0, y: 0, z: 0 },
      max: { x: 20, y: 10, z: 4 }
    };
    // Suppressed, the body shown is the one before the scale already.
    expect(inPlaceEditBodyBox(box, scale(false), EDIT_CTX, [], false)).toEqual(
      box
    );
  });

  it('leaves a copy source, and any other body, as the model shows it', () => {
    expect(inPlaceEditBodyBox(box, scale(true), EDIT_CTX)).toBe(box);
    expect(
      inPlaceEditBodyBox(
        box,
        { featureKind: 'solid-offset', targetBodyId: BODY, distance: 1 },
        EDIT_CTX
      )
    ).toBe(box);
  });
});

describe('the steps after a copying transform', () => {
  it("are the source's later steps in history, which a copy is not upstream of", () => {
    let document = createProjectDocument(
      'Copy then move',
      toUserId('user_test')
    );
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 30, depth: 20 }
    });
    const [block] = listFeaturesInOrder(document).flatMap((feature) =>
      feature.bodyId ? [feature.bodyId] : []
    );
    document = transformBody(document, {
      name: 'Copy',
      targetBodyId: block!,
      translation: { x: 0, y: 0, z: 0 },
      scale: 2,
      copy: true
    }).document;
    const copy = listFeaturesInOrder(document).at(-1)!;
    document = transformBody(document, {
      name: 'Nudge',
      targetBodyId: block!,
      translation: { x: 10, y: 0, z: 0 }
    }).document;
    const later = laterInPlaceSteps(document, copy);
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({
      featureKind: 'transform',
      transform: { translation: { x: 10, y: 0, z: 0 } }
    });
    expect(laterDirectEdit(document, copy)).toBe(false);
    // A body an edit is retargeted to is taken back through its own later
    // steps, by history order.
    expect(laterStepsOnBody(document, copy, block!)).toEqual(later);
    // A later direct edit of the source, likewise not downstream of the copy.
    const edit = {
      ...copy,
      id: 'node_direct' as typeof copy.id,
      featureId: 'feature_direct' as typeof copy.featureId,
      name: 'Push face',
      data: { featureKind: 'direct-edit', targetBodyId: block! } as never
    };
    const withEdit: ProjectDocument = {
      ...document,
      nodes: { ...document.nodes, [edit.id]: edit },
      featureOrder: [...document.featureOrder, edit.featureId]
    };
    expect(laterDirectEdit(withEdit, copy)).toBe(true);
  });
});
