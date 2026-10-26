import { describe, expect, it } from 'vitest';
import {
  CURRENT_CANONICAL_BASIS_REVISION,
  canonicalPlaneBasis,
  planeIntersectionDatumAxis
} from '@openzcad/geometry';
import type {
  BodyId,
  DatumAxisDefinition,
  FeatureId,
  SketchId
} from '@openzcad/shared';
import { TOOL_META } from '../tools';
import { placementFrame } from './primitives';
import {
  IN_PLACE_TOOL_SPECS,
  axisCandidatesFor,
  clampValue,
  displayedValue,
  isInPlaceTool,
  keypadText,
  principalAxisDefinition,
  requestNewAxis,
  resolveNewAxis,
  stepTotal,
  valueInRange,
  type BodyPick,
  type EdgePick,
  type FacePick,
  type InPlaceContext,
  type InPlaceSlots,
  type ProfilePick,
  profileOutline
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
  guide: [],
  faces: [],
  bodies: [],
  plane: null,
  edges: [],
  refs: [],
  image: null
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
    expect(isInPlaceTool('box')).toBe(true);
    expect(isInPlaceTool('torus')).toBe(true);
    expect(isInPlaceTool('fillet')).toBe(true);
    expect(isInPlaceTool('chamfer')).toBe(true);
  });

  it('takes a typed value inside its range, strictly for an open one', () => {
    const angle = IN_PLACE_TOOL_SPECS.hole.values.find(
      (value) => value.id === 'countersinkAngleDeg'
    )!;
    expect(valueInRange(angle, 0)).toBe(false);
    expect(valueInRange(angle, 0.0000005)).toBe(true);
    expect(valueInRange(angle, 180)).toBe(false);
    const depth = IN_PLACE_TOOL_SPECS.hole.values.find(
      (value) => value.id === 'counterboreDepth'
    )!;
    expect(valueInRange(depth, 0.005)).toBe(true);
    expect(valueInRange(depth, 0)).toBe(false);
    const count = IN_PLACE_TOOL_SPECS['linear-pattern'].values.find(
      (value) => value.id === 'count'
    )!;
    expect(valueInRange(count, 3.5)).toBe(false);
    expect(valueInRange(count, Number.NaN)).toBe(false);
  });

  it('shows a value to two places unless that would show a refused one', () => {
    const angle = IN_PLACE_TOOL_SPECS.hole.values.find(
      (value) => value.id === 'countersinkAngleDeg'
    )!;
    expect(displayedValue(angle, 82.3456)).toBe(82.35);
    expect(displayedValue(angle, 179.9999995)).toBe(179.9999995);
    // Past ten places too: what ten would round onto the refused end is
    // shown as it is.
    expect(displayedValue(angle, 179.9999999999)).toBe(179.9999999999);
    expect(displayedValue(angle, 0.0000005)).toBe(0.0000005);
    // A small value keeps its digits: 0.005 mm is not shown as 0.01.
    const depth = IN_PLACE_TOOL_SPECS.hole.values.find(
      (value) => value.id === 'counterboreDepth'
    )!;
    expect(displayedValue(depth, 0.005)).toBe(0.005);
    expect(displayedValue(depth, 12.3456)).toBe(12.35);
    // The keypad opens on the value exactly.
    expect(keypadText(0.005)).toBe('0.005');
    expect(keypadText(12.3456)).toBe('12.3456');
    expect(Number(keypadText(1.0000000000004))).toBe(1.0000000000004);
    expect(Number(keypadText(179.9999999999))).toBe(179.9999999999);
  });

  it('clamps a value to its range and falls back when not finite', () => {
    const spec = IN_PLACE_TOOL_SPECS.revolve.values[0]!;
    // Every positive turn up to a full one is a valid revolve: 0 is kept
    // just above, 360 itself is taken.
    expect(clampValue(spec, 0)).toBeGreaterThan(0);
    expect(clampValue(spec, 0)).toBeLessThan(1e-3);
    expect(clampValue(spec, 0.5)).toBe(0.5);
    expect(clampValue(spec, 400)).toBe(360);
    expect(valueInRange(spec, 0.0005)).toBe(true);
    expect(valueInRange(spec, 0)).toBe(false);
    expect(valueInRange(spec, 360)).toBe(true);
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

describe('profileOutline', () => {
  it("an implicit revolve profile is the sketch's first object only", () => {
    const square = (x: number) => [
      { x, y: 0 },
      { x: x + 1, y: 0 },
      { x: x + 1, y: 1 },
      { x, y: 1 }
    ];
    const ctx: InPlaceContext = {
      ...CTX,
      sketchViews: [
        {
          sketchId: 's1' as SketchId,
          basis: {
            origin: { x: 0, y: 0, z: 0 },
            u: { x: 1, y: 0, z: 0 },
            v: { x: 0, y: 1, z: 0 },
            normal: { x: 0, y: 0, z: 1 }
          },
          regions: [
            { regionFingerprint: 1, outer: square(0) },
            { regionFingerprint: 2, outer: square(50) }
          ]
        }
      ]
    };
    const implicit = {
      sketchId: 's1' as SketchId,
      reference: { all: true as const, sourceEntityIds: [] },
      regionFingerprint: 1,
      implicit: true as const
    };
    expect(profileOutline(ctx, implicit).every((p) => p.x <= 1)).toBe(true);
    // An explicit whole-sketch pick still spans every region.
    const { implicit: _implicit, ...whole } = implicit;
    expect(profileOutline(ctx, whole).some((p) => p.x >= 50)).toBe(true);
  });
});

describe('a revolve about its profile middle', () => {
  it('still has its angle rig, square to the axis', () => {
    const square = (x: number) => [
      { x, y: 0 },
      { x: x + 2, y: 0 },
      { x: x + 2, y: 2 },
      { x, y: 2 }
    ];
    const ctx: InPlaceContext = {
      ...CTX,
      sketchViews: [
        {
          sketchId: 's1' as SketchId,
          basis: {
            origin: { x: 0, y: 0, z: 0 },
            u: { x: 1, y: 0, z: 0 },
            v: { x: 0, y: 1, z: 0 },
            normal: { x: 0, y: 0, z: 1 }
          },
          // Two regions either side of the vertical axis: their middle is on it.
          regions: [
            { regionFingerprint: 1, outer: square(-6) },
            { regionFingerprint: 2, outer: square(4) }
          ]
        }
      ]
    };
    const pick = {
      sketchId: 's1' as SketchId,
      reference: { all: true as const, sourceEntityIds: [] },
      regionFingerprint: 1
    };
    const axis = {
      id: 'sketch-vertical',
      label: 'Sketch vertical axis',
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 1, z: 0 },
      choice: { axis: 'vertical' as const }
    };
    const [handle] = IN_PLACE_TOOL_SPECS.revolve.handles(
      { ...EMPTY, profiles: [pick], axis },
      {},
      ctx,
      {}
    );
    expect(handle).toMatchObject({ valueId: 'angle', kind: 'angle' });
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

  it('draft: a clicked hinge waits for a click', () => {
    const spec = IN_PLACE_TOOL_SPECS.draft;
    // An edited draft's faces carry no clicked point.
    const face: FacePick = {
      bodyId: 'body_a' as BodyId,
      hash: 3,
      topologyId: 'f3',
      surfaceType: 'plane',
      centroid: { x: 0, y: 0, z: 5 }
    };
    const slots = { ...EMPTY, faces: [face] };
    expect(spec.ready(slots, { neutral: 'point' })).toBe(false);
    expect(spec.request(slots, {}, { neutral: 'point' }, CTX)).toBeNull();
    expect(spec.hint(slots, { neutral: 'point' })).toMatch(/hinge goes/);
    const clicked = { ...face, hash: 4, point: { x: 1, y: 2, z: 3 } };
    const both = { ...EMPTY, faces: [face, clicked] };
    expect(spec.ready(both, { neutral: 'point' })).toBe(true);
    expect(spec.request(both, {}, { neutral: 'point' }, CTX)).toMatchObject({
      state: { value: { neutralPoint: { x: '1', y: '2', z: '3' } } }
    });
  });

  it('mirror: a typed plane needs no pick and goes out as typed', () => {
    const spec = IN_PLACE_TOOL_SPECS.mirror;
    const slots: InPlaceSlots = { ...EMPTY, bodies: [BODY] };
    expect(spec.ready(slots, {})).toBe(false);
    expect(spec.ready(slots, { planeMode: 'typed' })).toBe(true);
    expect(
      spec.request(
        slots,
        {
          planeOX: 'wall',
          planeOY: 0,
          planeOZ: 1,
          planeNX: 0,
          planeNY: 1,
          planeNZ: 0
        },
        { planeMode: 'typed' },
        CTX,
        {
          planeOX: 4,
          planeOY: 0,
          planeOZ: 1,
          planeNX: 0,
          planeNY: 1,
          planeNZ: 0
        }
      )
    ).toMatchObject({
      state: {
        operation: 'mirror',
        value: {
          origin: { x: 'wall', y: '0', z: '1' },
          normal: { x: '0', y: '1', z: '0' }
        }
      }
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

  it('takes every value the stored feature takes, no narrower', () => {
    const spec = (tool: keyof typeof IN_PLACE_TOOL_SPECS, id: string) =>
      IN_PLACE_TOOL_SPECS[tool].values.find((value) => value.id === id)!;
    // Any positive size: a small inch hole, a thin wall, a fine helix.
    for (const [tool, id] of [
      ['hole', 'diameter'],
      ['hole', 'depth'],
      ['shell', 'thickness'],
      ['solid-offset', 'distance'],
      ['helical-sweep', 'radius'],
      ['helical-sweep', 'turns']
    ] as const) {
      expect(valueInRange(spec(tool, id), 0.05)).toBe(true);
      expect(valueInRange(spec(tool, id), 0)).toBe(false);
    }
    // More than a turn, either way.
    expect(valueInRange(spec('axis-rotate', 'angle'), 450)).toBe(true);
    expect(valueInRange(spec('circular-pattern', 'angle'), -540)).toBe(true);
  });

  it('draft: an angle either way, up to a right angle', () => {
    const angle = IN_PLACE_TOOL_SPECS.draft.values.find(
      (value) => value.id === 'angle'
    )!;
    expect(valueInRange(angle, -12)).toBe(true);
    expect(valueInRange(angle, 60)).toBe(true);
    expect(valueInRange(angle, 90)).toBe(false);
  });

  it('scale: any positive factor, a unit conversion included', () => {
    const factor = IN_PLACE_TOOL_SPECS.scale.values.find(
      (value) => value.id === 'factor'
    )!;
    expect(valueInRange(factor, 1000)).toBe(true);
    expect(valueInRange(factor, 0.001)).toBe(true);
    expect(valueInRange(factor, 0)).toBe(false);
  });

  it('scale: its handle measures from the pivot chosen, and that pivot goes out', () => {
    const spec = IN_PLACE_TOOL_SPECS.scale;
    const slots = { ...EMPTY, bodies: [BODY] };
    // About the origin (an old scale's absent pivot): the handle runs from
    // there to the corner that factor carries, and no pivot is written.
    const [fromOrigin] = spec.handles(slots, {}, CTX, { pivot: 'origin' });
    expect(fromOrigin).toMatchObject({
      params: { origin: { x: 0, y: 0, z: 0 }, scale: Math.hypot(20, 10, 4) }
    });
    expect(
      spec.request(slots, { factor: 2 }, { pivot: 'origin' }, CTX)
    ).not.toHaveProperty('pivot');
    // About a typed point: its chips, and the point as typed.
    const handles = spec.handles(
      slots,
      { pivotX: 20, pivotY: 10, pivotZ: 4 },
      CTX,
      { pivot: 'typed' }
    );
    expect(handles.map((handle) => handle.valueId)).toEqual([
      'pivotX',
      'pivotY',
      'pivotZ',
      'factor'
    ]);
    expect(handles.at(-1)).toMatchObject({
      params: { origin: { x: 20, y: 10, z: 4 }, scale: Math.hypot(20, 10, 4) }
    });
    expect(
      spec.request(
        slots,
        { factor: 2, pivotX: 'px', pivotY: 10, pivotZ: 4 },
        { pivot: 'typed' },
        CTX
      )
    ).toMatchObject({ pivot: { x: 'px', y: 10, z: 4 } });
    // A new scale grows about the body's centre.
    expect(spec.request(slots, { factor: 2 }, {}, CTX)).toMatchObject({
      pivot: { x: 10, y: 5, z: 2 }
    });
  });

  it('scale: a body a later edit reshapes is scaled on a typed chip', () => {
    const spec = IN_PLACE_TOOL_SPECS.scale;
    const slots = { ...EMPTY, bodies: [BODY] };
    expect(
      spec.handles(slots, {}, { ...CTX, reshapedLater: true }, {})
    ).toEqual([expect.objectContaining({ valueId: 'factor', kind: 'chip' })]);
    // A body retargeted to that a later edit reshapes, likewise.
    expect(
      spec.handles(
        { ...EMPTY, bodies: [{ ...BODY, reshapedLater: true }] },
        {},
        CTX,
        {}
      )
    ).toEqual([expect.objectContaining({ valueId: 'factor', kind: 'chip' })]);
  });

  it('solid offset: a curved-only body still gets its offset handle', () => {
    const spec = IN_PLACE_TOOL_SPECS['solid-offset'];
    // A sphere's face publishes no normal.
    const round: FacePick = {
      bodyId: 'body_a' as BodyId,
      hash: 5,
      topologyId: 'f5',
      surfaceType: 'sphere',
      center: { x: 0, y: 0, z: 10 }
    };
    const slots = { ...EMPTY, faces: [round] };
    expect(spec.handles(slots, {}, CTX, {})).toEqual([]);
    const [handle] = spec.handles(
      slots,
      {},
      {
        ...CTX,
        bodyBounds: () => ({
          min: { x: -5, y: -5, z: -5 },
          max: { x: 5, y: 5, z: 5 }
        })
      },
      {}
    );
    expect(handle).toMatchObject({
      valueId: 'distance',
      params: { origin: { x: 0, y: 0, z: 5 }, direction: { x: 0, y: 0, z: 1 } }
    });
  });

  it('rotate about axis: a datum axis is stored by reference', () => {
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

  it('rotate about axis: an axis through the body middle still has its rig', () => {
    const spec = IN_PLACE_TOOL_SPECS['axis-rotate'];
    // BODY's middle is (10, 5, 2): a vertical axis through it.
    const axis = {
      id: 'datum:centre',
      label: 'Centre',
      origin: { x: 10, y: 5, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      choice: { datumFeatureId: 'centre' as FeatureId }
    };
    const [handle] = spec.handles(
      { ...EMPTY, bodies: [BODY], axis },
      {},
      CTX,
      {}
    );
    expect(handle).toMatchObject({ valueId: 'angle', kind: 'angle' });
    expect(handle?.kind === 'angle' && handle.params.radius).toBeCloseTo(
      Math.hypot(10, 5) * 1.15
    );
    // A body with no extent has no rig: its angle is typed.
    const point = {
      ...BODY,
      min: { x: 10, y: 5, z: 0 },
      max: { x: 10, y: 5, z: 4 }
    };
    expect(
      spec.handles({ ...EMPTY, bodies: [point], axis }, {}, CTX, {})
    ).toEqual([expect.objectContaining({ valueId: 'angle', kind: 'chip' })]);
  });

  it('circular pattern: an axis through the body middle keeps its angle rig and count', () => {
    const spec = IN_PLACE_TOOL_SPECS['circular-pattern'];
    const axis = {
      id: 'world-z',
      label: 'Z axis',
      origin: { x: 10, y: 5, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      choice: { world: 'z' as const }
    };
    expect(
      spec
        .handles({ ...EMPTY, bodies: [BODY], axis }, {}, CTX, {})
        .map((handle) => [handle.valueId, handle.kind])
    ).toEqual([
      ['angle', 'angle'],
      ['count', 'chip']
    ]);
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

describe('review: values the cards accepted stay expressible', () => {
  it('patterns keep a signed spacing and total, and the kernel count range', () => {
    const linear = IN_PLACE_TOOL_SPECS['linear-pattern'];
    const spacing = linear.values.find((value) => value.id === 'spacing')!;
    const count = linear.values.find((value) => value.id === 'count')!;
    expect(clampValue(spacing, -20)).toBe(-20);
    expect(clampValue(count, 500)).toBe(100);
    const circular = IN_PLACE_TOOL_SPECS['circular-pattern'];
    expect(
      clampValue(
        circular.values.find((value) => value.id === 'angle')!,
        -90
      )
    ).toBe(-90);
    const grid = IN_PLACE_TOOL_SPECS['grid-pattern'];
    for (const id of ['count', 'count2']) {
      expect(
        clampValue(
          grid.values.find((value) => value.id === id)!,
          1
        )
      ).toBe(2);
    }
  });

  it("a slid stored plane keeps each coordinate's text, adding to the one it moves", () => {
    const plane = {
      kind: 'saved' as const,
      origin: { x: 20, y: 0, z: 3 },
      normal: { x: 0, y: 0, z: 1 },
      fields: {
        origin: { x: 'width', y: '0', z: 'h' },
        normal: { x: '0', y: '0', z: '1' }
      }
    };
    const slots = { ...EMPTY, bodies: [BODY], plane };
    const origin = (offset: number | string) =>
      (
        IN_PLACE_TOOL_SPECS.mirror.request(slots, { offset }, {}, CTX, {
          offset: typeof offset === 'number' ? offset : 5
        }) as { state: { value: { origin: unknown } } }
      ).state.value.origin;
    expect(origin(5)).toEqual({ x: 'width', y: '0', z: 'h + 5' });
    expect(origin('gap')).toEqual({ x: 'width', y: '0', z: 'h + (gap)' });
    // Untouched, it is as stored.
    expect(origin(0)).toEqual({ x: 'width', y: '0', z: 'h' });
  });

  it('a typed mirror offset stays an expression in the coordinate it moves', () => {
    const request = IN_PLACE_TOOL_SPECS.mirror.request(
      {
        ...EMPTY,
        bodies: [BODY],
        plane: {
          kind: 'principal',
          plane: 'YZ',
          origin: { x: 0, y: 0, z: 0 },
          normal: { x: 1, y: 0, z: 0 }
        }
      },
      { offset: 'width / 2' },
      {},
      CTX,
      { offset: 10 }
    );
    expect(request).toMatchObject({
      state: { value: { origin: { x: '(width / 2)', y: '0', z: '0' } } }
    });
  });

  it("a parametric hole diameter sizes the counterbore from the bore's value", () => {
    const request = IN_PLACE_TOOL_SPECS.hole.request(
      { ...EMPTY, faces: [TOP] },
      { diameter: 'bore', depth: 8 },
      { style: 'counterbore' },
      CTX,
      { diameter: 4, depth: 8 }
    );
    expect(request).toMatchObject({
      state: {
        value: {
          diameter: 'bore',
          counterboreDiameter: '7.2',
          counterboreDepth: '2'
        }
      }
    });
  });

  it('a hole step follows the bore until a chip sets it', () => {
    const spec = IN_PLACE_TOOL_SPECS.hole;
    expect(
      spec.defaults?.({ ...EMPTY, faces: [TOP] }, CTX, { diameter: 4 })
    ).toEqual({
      counterboreDiameter: 7.2,
      counterboreDepth: 2,
      countersinkDiameter: 8
    });
    const request = spec.request(
      { ...EMPTY, faces: [TOP] },
      {
        diameter: 4,
        countersinkDiameter: 'sink',
        countersinkAngleDeg: 82
      },
      { style: 'countersink' },
      CTX,
      { diameter: 4 }
    );
    expect(request).toMatchObject({
      state: {
        value: {
          style: 'countersink',
          countersinkDiameter: 'sink',
          countersinkAngleDeg: '82'
        }
      }
    });
  });

  it('a hole step puts its two chips across its rim', () => {
    const handles = IN_PLACE_TOOL_SPECS.hole.handles(
      { ...EMPTY, faces: [TOP] },
      { diameter: 4, counterboreDiameter: 8, counterboreDepth: 2 },
      CTX,
      { style: 'counterbore' }
    );
    expect(handles.map((handle) => [handle.valueId, handle.kind])).toEqual([
      ['diameter', 'linear'],
      ['counterboreDiameter', 'chip'],
      ['counterboreDepth', 'chip']
    ]);
    const anchors = handles
      .slice(1)
      .map((handle) => (handle.kind === 'chip' ? handle.params.anchor : null));
    // Four either side of the click, across the face's v direction.
    const spread = Math.hypot(
      anchors[0]!.x - anchors[1]!.x,
      anchors[0]!.y - anchors[1]!.y,
      anchors[0]!.z - anchors[1]!.z
    );
    expect(spread).toBeCloseTo(8);
  });

  it('draft hinges on the body base by default, or the top, the click, the origin', () => {
    const ctx: InPlaceContext = {
      ...CTX,
      bodyBounds: () => ({
        min: { x: 5, y: 5, z: 2 },
        max: { x: 25, y: 15, z: 6 }
      })
    };
    const neutral = (hinge: string, pull = '+Z') =>
      (
        IN_PLACE_TOOL_SPECS.draft.request(
          { ...EMPTY, faces: [TOP] },
          { angle: 3 },
          { pull, neutral: hinge },
          ctx
        ) as { state: { value: { neutralPoint: unknown } } }
      ).state.value.neutralPoint;
    expect(neutral('base')).toEqual({ x: '15', y: '10', z: '2' });
    expect(neutral('top')).toEqual({ x: '15', y: '10', z: '6' });
    expect(neutral('base', '-Z')).toEqual({ x: '15', y: '10', z: '6' });
    expect(neutral('point')).toEqual({ x: '12', y: '6', z: '4' });
    expect(neutral('origin')).toEqual({ x: '0', y: '0', z: '0' });
  });
});

describe('review: rotate about axis', () => {
  it('keeps a signed angle', () => {
    const angle = IN_PLACE_TOOL_SPECS['axis-rotate'].values[0]!;
    expect(clampValue(angle, -90)).toBe(-90);
  });
});

describe('review: loft, sweep and counts', () => {
  const section = (sketchId: string, fingerprint: number) => ({
    sketchId: sketchId as SketchId,
    reference: { all: true as const, sourceEntityIds: ['a'] },
    regionFingerprint: fingerprint
  });

  it('a new loft is ruled unless Options say smooth', () => {
    const slots = {
      ...EMPTY,
      profiles: [section('s1', 1), section('s2', 2)]
    };
    const loft = IN_PLACE_TOOL_SPECS.loft;
    expect(loft.request(slots, {}, {}, CTX)).toMatchObject({ mode: 'ruled' });
    expect(loft.request(slots, {}, { shape: 'smooth' }, CTX)).toMatchObject({
      mode: 'smooth'
    });
  });

  it('a sweep carries its mode, and a guide rail', () => {
    const curve = (entityId: string) => ({
      sketchId: 's2' as SketchId,
      entityId
    });
    const sweep = IN_PLACE_TOOL_SPECS.sweep;
    const base = {
      ...EMPTY,
      profiles: [section('s1', 1)],
      path: [curve('p1')]
    };
    expect(sweep.request(base, {}, { mode: 'smooth' }, CTX)).toMatchObject({
      mode: 'smooth'
    });
    expect(
      sweep.request({ ...base, guide: [curve('g1'), curve('g2')] }, {}, {}, CTX)
    ).toMatchObject({
      mode: 'standard',
      guide: { sketchId: 's2', entityIds: ['g1', 'g2'] }
    });
  });

  it('pattern counts are whole numbers', () => {
    const count = IN_PLACE_TOOL_SPECS['linear-pattern'].values.find(
      (value) => value.id === 'count'
    )!;
    expect(clampValue(count, 4.5)).toBe(5);
    expect(clampValue(count, 4.4)).toBe(4);
  });
});

describe('review: loft apex and guided sweeps', () => {
  const FLAT = {
    origin: { x: 0, y: 0, z: 0 },
    u: { x: 1, y: 0, z: 0 },
    v: { x: 0, y: 1, z: 0 },
    normal: { x: 0, y: 0, z: 1 }
  };
  const SQUARE = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 }
  ];
  const ctx: InPlaceContext = {
    ...CTX,
    sketchViews: [
      {
        sketchId: 's1' as SketchId,
        basis: FLAT,
        regions: [{ regionFingerprint: 1, outer: SQUARE }]
      },
      {
        sketchId: 's2' as SketchId,
        basis: { ...FLAT, origin: { x: 0, y: 0, z: 10 } },
        regions: [{ regionFingerprint: 2, outer: SQUARE }]
      }
    ]
  };
  const pick = (sketchId: string, regionFingerprint: number) => ({
    sketchId: sketchId as SketchId,
    reference: { all: true as const, sourceEntityIds: ['a'] },
    regionFingerprint
  });

  it('a loft can end at an apex off its last section', () => {
    const slots = { ...EMPTY, profiles: [pick('s1', 1), pick('s2', 2)] };
    const loft = IN_PLACE_TOOL_SPECS.loft;
    expect(
      loft.request(slots, { apex: 5 }, { end: 'apex' }, ctx, { apex: 5 })
    ).toMatchObject({ endPoint: { x: '2', y: '2', z: '15' } });
    expect(loft.request(slots, {}, {}, ctx)).not.toHaveProperty('endPoint');
    expect(
      loft.handles(slots, {}, ctx, { end: 'apex' }).map((h) => h.valueId)
    ).toEqual(['apex']);
  });

  it('a helix can coil about a typed axis, stored as typed', () => {
    const slots = { ...EMPTY, profiles: [pick('s1', 1)] };
    const helix = IN_PLACE_TOOL_SPECS['helical-sweep'];
    expect(helix.ready(slots, {})).toBe(false);
    expect(helix.ready(slots, { axisMode: 'typed' })).toBe(true);
    const numbers = {
      axisOX: 2,
      axisOY: 0,
      axisOZ: 0,
      axisDX: 0,
      axisDY: 0,
      axisDZ: 1
    };
    expect(
      helix.request(
        slots,
        { ...numbers, axisOX: 'wall' },
        { axisMode: 'typed' },
        ctx,
        numbers
      )
    ).toMatchObject({
      tool: 'helical-sweep',
      axisOrigin: { x: 'wall', y: 0, z: 0 },
      axisDirection: { x: 0, y: 0, z: 1 }
    });
    // A zero direction is no axis.
    expect(
      helix.request(slots, {}, { axisMode: 'typed' }, ctx, {
        axisDX: 0,
        axisDY: 0,
        axisDZ: 0
      })
    ).toBeNull();
    const ids = helix
      .handles(slots, numbers, ctx, { axisMode: 'typed' })
      .map((h) => h.valueId);
    expect(ids).toEqual(
      expect.arrayContaining(['axisOX', 'axisDZ', 'radius', 'pitch', 'turns'])
    );
  });

  it('a guided sweep is always Standard', () => {
    const curve = (entityId: string) => ({
      sketchId: 's2' as SketchId,
      entityId
    });
    expect(
      IN_PLACE_TOOL_SPECS.sweep.request(
        {
          ...EMPTY,
          profiles: [pick('s1', 1)],
          path: [curve('p1')],
          guide: [curve('g1')]
        },
        {},
        { mode: 'smooth' },
        ctx
      )
    ).toMatchObject({ mode: 'standard' });
  });
});

describe('fillet and chamfer run in place', () => {
  const EDGE: EdgePick = {
    bodyId: 'body_a' as BodyId,
    hash: 21,
    topologyId: 'e21',
    reference: { kind: 'edge', currentHash: 21 } as never,
    middle: { x: 10, y: 0, z: 4 },
    outward: { x: 0, y: -1, z: 0 },
    end: { x: 20, y: 0, z: 4 }
  };
  const SECOND: EdgePick = { ...EDGE, hash: 22, topologyId: 'e22' };

  it('a constant fillet stores its radius and the named edge set', () => {
    const spec = IN_PLACE_TOOL_SPECS.fillet;
    const slots = { ...EMPTY, edges: [EDGE, SECOND] };
    expect(spec.ready(slots)).toBe(true);
    expect(spec.hint(slots, {})).toMatch(/^2 edges/);
    expect(
      spec.request(
        slots,
        { radius: 'r', endRadius: 3 },
        { law: 'constant' },
        CTX
      )
    ).toEqual({
      tool: 'edge-modifier',
      kind: 'fillet',
      targetBodyId: 'body_a',
      edgeHashes: [21, 22],
      edgeReferences: [EDGE.reference, SECOND.reference],
      size: 'r'
    });
    // The radius arrow points into the body from the first edge.
    const [handle] = spec.handles(slots, {}, CTX, { law: 'constant' });
    expect(handle).toMatchObject({
      valueId: 'radius',
      kind: 'linear',
      params: { origin: EDGE.middle }
    });
    const direction =
      handle?.kind === 'linear' ? handle.params.direction : undefined;
    expect(direction?.y).toBeCloseTo(1);
  });

  it('a variable fillet adds its end radius and law, with a chip', () => {
    const spec = IN_PLACE_TOOL_SPECS.fillet;
    const slots = { ...EMPTY, edges: [EDGE] };
    expect(
      spec.request(slots, { radius: 2, endRadius: 4 }, { law: 'scurve' }, CTX)
    ).toMatchObject({ size: 2, endRadius: 4, radiusLaw: 'scurve' });
    expect(
      spec.handles(slots, {}, CTX, { law: 'linear' }).map((h) => h.valueId)
    ).toEqual(['radius', 'endRadius']);
    expect(spec.defaults?.(slots, CTX, { radius: 5 })).toEqual({
      endRadius: 5
    });
  });

  it('an edge set with an unnamed pick goes hash-only', () => {
    const { reference: _named, ...unnamed } = SECOND;
    expect(
      IN_PLACE_TOOL_SPECS.fillet.request(
        { ...EMPTY, edges: [EDGE, unnamed] },
        { radius: 1 },
        {},
        CTX
      )
    ).not.toHaveProperty('edgeReferences');
  });

  it('a chamfer stores only its chosen shape: an angle or a second distance', () => {
    const spec = IN_PLACE_TOOL_SPECS.chamfer;
    const slots = { ...EMPTY, edges: [EDGE] };
    const values = { distance: 2, angle: 30, distance2: 3 };
    expect(
      spec.request(slots, values, { shape: 'equal' }, CTX)
    ).not.toHaveProperty('angleDeg');
    const angled = spec.request(slots, values, { shape: 'angle' }, CTX);
    expect(angled).toMatchObject({ angleDeg: 30 });
    expect(angled).not.toHaveProperty('distance2');
    const two = spec.request(slots, values, { shape: 'two' }, CTX);
    expect(two).toMatchObject({ distance2: 3 });
    expect(two).not.toHaveProperty('angleDeg');
  });
});

describe('primitives run in place', () => {
  const kinds = ['box', 'cylinder', 'cone', 'sphere', 'torus'] as const;

  it('are named as their tools, ready at once, with the card sizes', () => {
    const initials = Object.fromEntries(
      kinds.map((kind) => [
        kind,
        Object.fromEntries(
          IN_PLACE_TOOL_SPECS[kind].values.map((value) => [
            value.id,
            value.initial
          ])
        )
      ])
    );
    for (const kind of kinds) {
      expect(IN_PLACE_TOOL_SPECS[kind].title).toBe(TOOL_META[kind].label);
      expect(IN_PLACE_TOOL_SPECS[kind].ready(EMPTY)).toBe(true);
    }
    expect(initials).toEqual({
      box: { width: 30, depth: 18, height: 24, x: 0, y: 0, z: 0 },
      cylinder: { radius: 6, height: 28, x: 0, y: 0, z: 0 },
      cone: { bottomRadius: 6, topRadius: 2, height: 28, x: 0, y: 0, z: 0 },
      sphere: { radius: 6, x: 0, y: 0, z: 0 },
      torus: { majorRadius: 6, minorRadius: 2, x: 0, y: 0, z: 0 }
    });
  });

  it('keep the position behind Options, named for the point it places', () => {
    const positions = (kind: (typeof kinds)[number]) =>
      IN_PLACE_TOOL_SPECS[kind].values
        .filter((value) => value.inOptions)
        .map((value) => value.label);
    expect(positions('box')).toEqual(['Corner X', 'Corner Y', 'Corner Z']);
    expect(positions('cone')[0]).toBe('Base center X');
    expect(positions('torus')[2]).toBe('Center Z');
    // A cone may come to a point at one end, as the card allowed.
    const cone = IN_PLACE_TOOL_SPECS.cone.values;
    expect(cone.find((value) => value.id === 'topRadius')?.min).toBe(0);
    expect(cone.find((value) => value.id === 'height')?.min).toBeGreaterThan(0);
  });

  it('build the card default before any drag', () => {
    expect(
      IN_PLACE_TOOL_SPECS.sphere.request(
        EMPTY,
        { radius: 6, x: 0, y: 0, z: 0 },
        {},
        CTX
      )
    ).toEqual({
      tool: 'primitive',
      kind: 'sphere',
      dimensions: { radius: 6 },
      position: { x: 0, y: 0, z: 0 }
    });
  });

  it('turn onto a side face in the same request', () => {
    const request = IN_PLACE_TOOL_SPECS.cylinder.request(
      {
        ...EMPTY,
        placement: {
          frame: placementFrame({ x: 1, y: 0, z: 0 }),
          signU: 1,
          signV: 1
        }
      },
      { radius: 3, height: 10, x: 20, y: 0, z: 5 },
      {},
      CTX
    );
    expect(request).toMatchObject({
      tool: 'primitive',
      kind: 'cylinder',
      position: { x: 20, y: 0, z: 5 },
      rotationDeg: { x: 90, y: 0, z: 90 }
    });
  });

  it('stand each arrow on the side it sizes, rebuilt only when that moves', () => {
    const spec = IN_PLACE_TOOL_SPECS.box;
    const values = { width: 30, depth: 18, height: 24, x: 0, y: 0, z: 0 };
    const handles = spec.handles(EMPTY, values, CTX, {});
    expect(handles.map((handle) => [handle.valueId, handle.params])).toEqual([
      [
        'width',
        { origin: { x: 0, y: 9, z: 0 }, direction: { x: 1, y: 0, z: 0 } }
      ],
      [
        'depth',
        { origin: { x: 15, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }
      ],
      [
        'height',
        { origin: { x: 15, y: 9, z: 0 }, direction: { x: 0, y: 0, z: 1 } }
      ]
    ]);
    // Dragging the height moves nothing the other arrows stand on.
    const taller = spec.handles(EMPTY, { ...values, height: 40 }, CTX, {});
    expect(taller.map((handle) => handle.key)).toEqual(
      handles.map((handle) => handle.key)
    );
    // A new position rebuilds them all.
    const moved = spec.handles(EMPTY, { ...values, x: 5 }, CTX, {});
    moved.forEach((handle, index) =>
      expect(handle.key).not.toBe(handles[index]!.key)
    );
  });

  it('put a cone top arrow on its top, and a ring tube arrow on the ring', () => {
    const cone = IN_PLACE_TOOL_SPECS.cone.handles(
      EMPTY,
      { bottomRadius: 6, topRadius: 2, height: 28, x: 0, y: 0, z: 0 },
      CTX,
      {}
    );
    expect(
      cone.find((handle) => handle.valueId === 'topRadius')?.params
    ).toEqual({
      origin: { x: 0, y: 0, z: 28 },
      direction: { x: 1, y: 0, z: 0 }
    });
    const torus = IN_PLACE_TOOL_SPECS.torus.handles(
      EMPTY,
      { majorRadius: 6, minorRadius: 2, x: 0, y: 0, z: 0 },
      CTX,
      {}
    );
    expect(
      torus.find((handle) => handle.valueId === 'minorRadius')?.params
    ).toEqual({
      origin: { x: 6, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 }
    });
  });

  it('keep a box hung under a face on the face when its height changes', () => {
    const spec = IN_PLACE_TOOL_SPECS.box;
    // Hung under a face at Z = 20: lowest corner at Z = -4 for height 24.
    const slots = {
      ...EMPTY,
      placement: {
        frame: placementFrame({ x: 0, y: 0, z: 1 }),
        signU: 1 as const,
        signV: 1 as const,
        hangs: 'z' as const
      }
    };
    const values = { width: 10, depth: 6, height: 24, x: 0, y: 0, z: -4 };
    expect(spec.carries?.('height', 10, values, slots)).toEqual({ z: 10 });
    expect(spec.carries?.('width', 12, values, slots)).toBeNull();
    // Its arrows stand on the face; the height arrow points away from it,
    // and a new height rebuilds none of them.
    const handles = spec.handles(slots, values, CTX, {});
    expect(
      handles.find((handle) => handle.valueId === 'height')?.params
    ).toEqual({
      origin: { x: 5, y: 3, z: 20 },
      direction: { x: 0, y: 0, z: -1 }
    });
    const shorter = spec.handles(
      slots,
      { ...values, height: 10, z: 10 },
      CTX,
      {}
    );
    expect(shorter.map((handle) => handle.key)).toEqual(
      handles.map((handle) => handle.key)
    );
  });
});

describe('axes and directions picked in the model', () => {
  const EDGE_AXIS: DatumAxisDefinition = {
    kind: 'edge',
    source: {
      type: 'edge',
      bodyId: 'body_a' as BodyId,
      edgeReference: {} as never
    }
  };
  const picked = (origin = { x: 0, y: 0, z: 0 }) => ({
    id: 'edge:body_a:7',
    label: 'The picked edge',
    origin,
    direction: { x: 0, y: 1, z: 0 },
    choice: { define: EDGE_AXIS }
  });

  it('a world axis is the line two principal planes meet in, along it', () => {
    for (const world of ['x', 'y', 'z'] as const) {
      const definition = principalAxisDefinition(world);
      if (definition.kind !== 'plane-intersection') throw new Error(world);
      const [a, b] = definition.sources.map((source) => {
        if (source.type !== 'canonical') throw new Error(world);
        return canonicalPlaneBasis(
          source.plane,
          source.basisRevision ?? CURRENT_CANONICAL_BASIS_REVISION
        );
      });
      const line = planeIntersectionDatumAxis(
        a!,
        b!,
        definition.reverseDirection
      );
      expect(line.origin).toEqual({ x: 0, y: 0, z: 0 });
      expect(line.direction[world]).toBeCloseTo(1);
    }
  });

  it('revolve: a picked edge in the profile plane is a new datum axis', () => {
    const spec = IN_PLACE_TOOL_SPECS.revolve;
    const profile: ProfilePick = {
      sketchId: 'sketch_1' as SketchId,
      reference: { all: true, sourceEntityIds: ['a'] },
      regionFingerprint: 1
    };
    const ctx: InPlaceContext = {
      ...CTX,
      sketchViews: [
        {
          sketchId: 'sketch_1' as SketchId,
          basis: {
            origin: { x: 0, y: 0, z: 0 },
            u: { x: 1, y: 0, z: 0 },
            v: { x: 0, y: 1, z: 0 },
            normal: { x: 0, y: 0, z: 1 }
          },
          regions: []
        }
      ]
    };
    const slots = { ...EMPTY, profiles: [profile] };
    expect(spec.axisPicks).toBe(true);
    expect(spec.refuseAxis?.(slots, picked(), ctx)).toBeNull();
    // A line off the sketch plane is refused before the build would be.
    expect(spec.refuseAxis?.(slots, picked({ x: 0, y: 0, z: 3 }), ctx)).toMatch(
      /leaves the profile's sketch plane/
    );
    const request = spec.request(
      { ...slots, axis: picked() },
      { angle: 180 },
      {},
      ctx
    )!;
    expect(request).toMatchObject({
      tool: 'revolve',
      axis: { newAxis: EDGE_AXIS },
      angleDeg: 180
    });
    expect(requestNewAxis(request)).toBe(EDGE_AXIS);
    expect(resolveNewAxis(request, 'axis_9' as FeatureId)).toMatchObject({
      axis: { datumFeatureId: 'axis_9' }
    });
    // Unresolved, it has no axis to turn about.
    expect(resolveNewAxis(request, null)).toBeNull();
  });

  it('revolve: offers a world axis in the sketch plane that is not its own', () => {
    const view = {
      sketchId: 'sketch_1' as SketchId,
      // On the XZ plane, lifted 3 along Z: the X axis is in the plane but
      // is not the sketch's horizontal, which runs at z = 3.
      basis: {
        origin: { x: 5, y: 0, z: 3 },
        u: { x: 1, y: 0, z: 0 },
        v: { x: 0, y: 0, z: 1 },
        normal: { x: 0, y: -1, z: 0 }
      },
      regions: []
    };
    const ids = axisCandidatesFor(
      {
        ...EMPTY,
        profiles: [
          {
            sketchId: 'sketch_1' as SketchId,
            reference: { all: true, sourceEntityIds: ['a'] },
            regionFingerprint: 1
          }
        ]
      },
      { ...CTX, datumAxes: {}, sketchViews: [view] }
    ).map((candidate) => candidate.id);
    expect(ids).toEqual([
      'sketch-horizontal',
      'sketch-vertical',
      'world-x',
      'world-z'
    ]);
  });

  it('rotate about axis: an edge, a cylinder or a world axis, added as a datum', () => {
    const spec = IN_PLACE_TOOL_SPECS['axis-rotate'];
    expect(spec.axisSource).toBe('world');
    expect(spec.axisPicks).toBe(true);
    const [x] = axisCandidatesFor(EMPTY, CTX, 'world');
    expect(
      spec.request(
        { ...EMPTY, bodies: [BODY], axis: x! },
        { angle: 45 },
        {},
        CTX
      )
    ).toMatchObject({
      axisRotation: {
        axis: { type: 'new-axis', definition: principalAxisDefinition('x') },
        angleDeg: 45
      }
    });
    const turn = spec.request(
      { ...EMPTY, bodies: [BODY], axis: picked() },
      { angle: 30 },
      {},
      CTX
    )!;
    expect(requestNewAxis(turn)).toBe(EDGE_AXIS);
    expect(resolveNewAxis(turn, 'axis_9' as FeatureId)).toMatchObject({
      axisRotation: {
        axis: { type: 'datum-axis', datumFeatureId: 'axis_9' },
        angleDeg: 30
      }
    });
  });

  it('circular pattern: a picked edge rings the copies about a new datum', () => {
    const spec = IN_PLACE_TOOL_SPECS['circular-pattern'];
    const request = spec.request(
      { ...EMPTY, bodies: [BODY], axis: picked() },
      { count: 4, angle: 360 },
      {},
      CTX
    )!;
    expect(request).toMatchObject({
      axis: 'z',
      axisRef: { type: 'new-axis', definition: EDGE_AXIS }
    });
    expect(resolveNewAxis(request, 'axis_9' as FeatureId)).toMatchObject({
      axisRef: { type: 'datum-axis', datumFeatureId: 'axis_9' }
    });
    // A world axis stays the pattern's own axis, with no datum.
    const [, y] = axisCandidatesFor(EMPTY, CTX, 'world');
    const world = spec.request(
      { ...EMPTY, bodies: [BODY], axis: y! },
      { count: 4 },
      {},
      CTX
    )!;
    expect(world).toMatchObject({ axis: 'y' });
    expect(world).not.toHaveProperty('axisRef');
    expect(requestNewAxis(world)).toBeNull();
  });

  it('circular pattern: a fixed step stores the total its copies span', () => {
    const spec = IN_PLACE_TOOL_SPECS['circular-pattern'];
    const [, , z] = axisCandidatesFor(EMPTY, CTX, 'world');
    const slots = { ...EMPTY, bodies: [BODY], axis: z! };
    expect(
      spec.request(slots, { count: 4, step: 30 }, { spacing: 'step' }, CTX)
    ).toMatchObject({ angleDeg: 90, count: 4 });
    // A step that closes the ring is the whole turn.
    expect(
      spec.request(slots, { count: 6, step: 60 }, { spacing: 'step' }, CTX)
    ).toMatchObject({ angleDeg: 360 });
    expect(stepTotal(-45, 8)).toBe(-360);
    expect(stepTotal('s', 4)).toBe('(s) * ((4) - 1)');
    expect(stepTotal(15, 'n')).toBe('(15) * ((n) - 1)');
    // The angle rig drags the step, not the total.
    expect(
      spec
        .handles(slots, {}, CTX, { spacing: 'step' })
        .map((handle) => handle.valueId)
    ).toEqual(['step', 'count']);
    expect(spec.hint(slots, { spacing: 'step' })).toMatch(/Drag the step/);
  });

  it('linear pattern: a picked direction is an axis, or a custom vector', () => {
    const spec = IN_PLACE_TOOL_SPECS['linear-pattern'];
    expect(spec.takeDirection?.({ x: 0, y: 0, z: 2 })).toEqual({
      options: { axis: 'z' },
      values: {}
    });
    // Against an axis is a vector: the stored axis has no sign.
    expect(spec.takeDirection?.({ x: -3, y: 0, z: 0 })).toEqual({
      options: { axis: 'custom' },
      values: { dirX: -1, dirY: 0, dirZ: 0 }
    });
    const tilted = spec.takeDirection?.({ x: 1, y: 1, z: 1e-12 });
    expect(tilted?.options).toEqual({ axis: 'custom' });
    expect(tilted?.values.dirX).toBeCloseTo(Math.SQRT1_2);
    expect(tilted?.values.dirZ).toBe(0);
    expect(
      spec.request(
        { ...EMPTY, bodies: [BODY] },
        { spacing: 10, count: 3, ...tilted!.values },
        tilted!.options,
        CTX
      )
    ).toMatchObject({ direction: { x: tilted!.values.dirX, z: 0 } });
  });
});
