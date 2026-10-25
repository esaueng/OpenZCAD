import { describe, expect, it } from 'vitest';
import type { BodyId, FeatureId, SketchId } from '@openzcad/shared';
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
