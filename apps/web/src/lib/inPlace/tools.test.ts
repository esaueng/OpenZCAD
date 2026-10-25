import { describe, expect, it } from 'vitest';
import type { BodyId, FeatureId } from '@openzcad/shared';
import {
  IN_PLACE_TOOL_SPECS,
  axisCandidatesFor,
  clampValue,
  isInPlaceTool,
  type BodyPick,
  type FacePick,
  type InPlaceContext,
  type InPlaceSlots
} from './tools';

const CTX: InPlaceContext = {
  sketchViews: [],
  datumAxes: {
    ['axis_1' as FeatureId]: {
      origin: { x: 10, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 }
    }
  },
  datumLabel: () => 'Axis 1',
  linearSnap: null
};

const EMPTY: InPlaceSlots = {
  profiles: [],
  axis: null,
  path: [],
  faces: [],
  bodies: [],
  plane: null
};

const BODY: BodyPick = {
  bodyId: 'body_a' as BodyId,
  min: { x: 0, y: 0, z: 0 },
  max: { x: 20, y: 10, z: 4 }
};
const OTHER: BodyPick = { ...BODY, bodyId: 'body_b' as BodyId };
const TOP: FacePick = {
  bodyId: 'body_a' as BodyId,
  hash: 11,
  topologyId: 'f11',
  surfaceType: 'plane',
  normal: { x: 0, y: 0, z: 1 },
  centroid: { x: 10, y: 5, z: 4 },
  point: { x: 12, y: 6, z: 4 }
};

describe('the in-place tool table', () => {
  it('names every converted tool and nothing else', () => {
    expect(isInPlaceTool('revolve')).toBe(true);
    expect(isInPlaceTool('grid-pattern')).toBe(true);
    expect(isInPlaceTool('box')).toBe(false);
    expect(isInPlaceTool('fillet')).toBe(false);
  });

  it('clamps a value to its range and falls back when not finite', () => {
    const spec = IN_PLACE_TOOL_SPECS.revolve.values[0]!;
    // Sub-degree turns are valid revolves (U09 review).
    expect(clampValue(spec, 0)).toBe(1e-3);
    expect(clampValue(spec, 0.5)).toBe(0.5);
    expect(clampValue(spec, Number.NaN)).toBe(360);
  });
});

describe('face tools build the card state', () => {
  it('hole: the click positions it, Options set depth and style', () => {
    const spec = IN_PLACE_TOOL_SPECS.hole;
    const slots = { ...EMPTY, faces: [TOP] };
    expect(spec.ready(slots)).toBe(true);
    const request = spec.request(
      slots,
      { diameter: 4, depth: 8 },
      { depthMode: 'blind', style: 'simple' },
      CTX
    );
    expect(request).toMatchObject({
      tool: 'modeling',
      state: {
        operation: 'hole',
        value: {
          targetBodyId: 'body_a',
          faceHash: 11,
          diameter: '4',
          depthMode: 'blind',
          depth: '8'
        }
      }
    });
    // A blind hole adds a depth handle beside the diameter's.
    expect(
      spec.handles(slots, {}, CTX, { depthMode: 'blind' }).map((h) => h.valueId)
    ).toEqual(['diameter', 'depth']);
    expect(
      spec
        .handles(slots, {}, CTX, { depthMode: 'through' })
        .map((h) => h.valueId)
    ).toEqual(['diameter']);
  });

  it('shell: every picked face opens, and the wall handle points inward', () => {
    const spec = IN_PLACE_TOOL_SPECS.shell;
    const slots = { ...EMPTY, faces: [TOP, { ...TOP, hash: 12 }] };
    expect(spec.request(slots, { thickness: 2 }, {}, CTX)).toMatchObject({
      state: { operation: 'shell', value: { openingFaceHashes: [11, 12] } }
    });
    const [handle] = spec.handles(slots, {}, CTX, {});
    expect(handle).toMatchObject({
      kind: 'linear',
      params: { direction: { x: -0, y: -0, z: -1 } }
    });
  });

  it('draft: the pull direction comes from Options', () => {
    const spec = IN_PLACE_TOOL_SPECS.draft;
    const request = spec.request(
      { ...EMPTY, faces: [TOP] },
      { angle: 5 },
      { pull: '-X' },
      CTX
    );
    expect(request).toMatchObject({
      state: {
        operation: 'draft',
        value: { pullDirection: { x: '-1', y: '0', z: '0' }, angleDeg: '5' }
      }
    });
  });
});

describe('body tools', () => {
  it('mirror: a plane slid along its normal moves the mirror plane', () => {
    const spec = IN_PLACE_TOOL_SPECS.mirror;
    const slots: InPlaceSlots = {
      ...EMPTY,
      bodies: [BODY],
      plane: {
        kind: 'principal',
        plane: 'YZ',
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 1, y: 0, z: 0 }
      }
    };
    expect(spec.request(slots, { offset: 5 }, {}, CTX)).toMatchObject({
      state: {
        operation: 'mirror',
        value: { origin: { x: '5', y: '0', z: '0' }, normal: { x: '1' } }
      }
    });
    // The handle stands on the plane level with the body's middle.
    expect(spec.handles(slots, {}, CTX, {})[0]).toMatchObject({
      valueId: 'offset',
      params: { origin: { x: 0, y: 5, z: 2 } }
    });
  });

  it('split: a datum plane is stored by id and has no slide', () => {
    const spec = IN_PLACE_TOOL_SPECS.split;
    const slots: InPlaceSlots = {
      ...EMPTY,
      bodies: [BODY],
      plane: { kind: 'datum', featureId: 'plane_1' as FeatureId }
    };
    expect(
      spec.request(slots, { offset: 3 }, { keepOriginal: 'yes' }, CTX)
    ).toMatchObject({
      state: {
        operation: 'split',
        value: { datumFeatureId: 'plane_1', keepOriginal: true }
      }
    });
    expect(spec.handles(slots, {}, CTX, {})).toEqual([]);
  });

  it('scale: about the body centre, the handle reaching its corner', () => {
    const spec = IN_PLACE_TOOL_SPECS.scale;
    const slots = { ...EMPTY, bodies: [BODY] };
    expect(spec.request(slots, { factor: 2 }, { copy: 'no' }, CTX)).toEqual({
      tool: 'transform',
      targetBodyId: 'body_a',
      translation: { x: 0, y: 0, z: 0 },
      scale: 2,
      pivot: { x: 10, y: 5, z: 2 }
    });
    const [handle] = spec.handles(slots, {}, CTX, {});
    expect(handle).toMatchObject({
      kind: 'linear',
      params: { scale: Math.hypot(10, 5, 2) }
    });
  });

  it('rotate about axis: only datum axes, stored by reference', () => {
    const spec = IN_PLACE_TOOL_SPECS['axis-rotate'];
    const [axis] = axisCandidatesFor(EMPTY, CTX, 'datum');
    expect(axis?.id).toBe('datum:axis_1');
    expect(
      spec.request(
        { ...EMPTY, bodies: [BODY], axis: axis! },
        { angle: 90 },
        { copy: 'yes' },
        CTX
      )
    ).toMatchObject({
      tool: 'transform',
      axisRotation: { axis: { datumFeatureId: 'axis_1' }, angleDeg: 90 },
      copy: true
    });
  });

  it('booleans: picks in order, the first the base; keep from Options', () => {
    const spec = IN_PLACE_TOOL_SPECS.subtract;
    expect(spec.ready({ ...EMPTY, bodies: [BODY] })).toBe(false);
    expect(
      spec.request(
        { ...EMPTY, bodies: [BODY, OTHER] },
        {},
        { keepOriginals: 'target' },
        CTX
      )
    ).toEqual({
      tool: 'boolean',
      operation: 'subtract',
      targetBodyIds: ['body_a', 'body_b'],
      keepOriginals: 'target'
    });
    expect(
      spec.request(
        { ...EMPTY, bodies: [BODY, OTHER] },
        {},
        { keepOriginals: 'none' },
        CTX
      )
    ).not.toHaveProperty('keepOriginals');
  });
});

describe('patterns', () => {
  it('linear: spacing along the Options axis, count on its chip', () => {
    const spec = IN_PLACE_TOOL_SPECS['linear-pattern'];
    const slots = { ...EMPTY, bodies: [BODY] };
    expect(
      spec.request(slots, { spacing: 30, count: 4 }, { axis: 'y' }, CTX)
    ).toEqual({
      tool: 'pattern',
      targetBodyId: 'body_a',
      patternKind: 'linear',
      count: 4,
      axis: 'y',
      spacing: 30
    });
    expect(
      spec.handles(slots, {}, CTX, { axis: 'y' }).map((h) => h.kind)
    ).toEqual(['linear', 'chip']);
  });

  it('circular: a world axis or a datum axis', () => {
    const spec = IN_PLACE_TOOL_SPECS['circular-pattern'];
    const candidates = axisCandidatesFor(EMPTY, CTX, 'world');
    expect(candidates.map((c) => c.id)).toEqual([
      'world-x',
      'world-y',
      'world-z',
      'datum:axis_1'
    ]);
    const z = candidates[2]!;
    expect(
      spec.request(
        { ...EMPTY, bodies: [BODY], axis: z },
        { count: 6, angle: 360 },
        {},
        CTX
      )
    ).toMatchObject({ axis: 'z', count: 6, angleDeg: 360 });
    const datum = candidates[3]!;
    expect(
      spec.request(
        { ...EMPTY, bodies: [BODY], axis: datum },
        { count: 4 },
        {},
        CTX
      )
    ).toMatchObject({ axisRef: { datumFeatureId: 'axis_1' } });
  });

  it('grid: two directions, two spacings, two counts', () => {
    const spec = IN_PLACE_TOOL_SPECS['grid-pattern'];
    expect(
      spec.request(
        { ...EMPTY, bodies: [BODY] },
        { spacing: 10, count: 2, spacing2: 15, count2: 3 },
        { axis: 'x', axis2: 'z' },
        CTX
      )
    ).toMatchObject({ axis: 'x', axis2: 'z', spacing2: 15, count2: 3 });
  });
});
