import { describe, expect, it } from 'vitest';
import type { BodyId, FeatureId, SketchId } from '@openzcad/shared';
import {
  IN_PLACE_TOOL_SPECS,
  axisCandidatesFor,
  clampValue,
  displayedValue,
  isInPlaceTool,
  keypadText,
  valueInRange,
  type BodyPick,
  type FacePick,
  type InPlaceContext,
  type InPlaceSlots,
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
