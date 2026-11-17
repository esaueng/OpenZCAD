import { describe, expect, it } from 'vitest';
import type {
  BodyId,
  DatumAxisEdgeSource,
  DatumAxisFaceSource,
  FeatureId
} from '@openzcad/shared';
import {
  datumAxisShape,
  datumPlaneShape,
  edgeClickIsEnd,
  takeDatumAxisRef,
  takeDatumPlaneRef,
  type RefPick
} from './datums';
import { IN_PLACE_TOOL_SPECS, isInPlaceTool, type InPlaceSlots } from './tools';

const ORIGIN = { x: 0, y: 0, z: 0 };
const UP = { x: 0, y: 0, z: 1 };

function plane(key: string, z = 0): RefPick {
  return {
    kind: 'plane',
    key,
    source: { type: 'datum', datumFeatureId: key as FeatureId },
    origin: { x: 0, y: 0, z },
    normal: UP
  };
}

function point(key: string): RefPick {
  return {
    kind: 'point',
    key,
    source: {
      type: 'edge-vertex',
      bodyId: 'body' as BodyId,
      edgeReference: { lineageName: key } as never,
      end: 0
    },
    at: ORIGIN
  };
}

const EDGE: RefPick = {
  kind: 'edge',
  key: 'edge',
  source: { type: 'edge', bodyId: 'body' } as DatumAxisEdgeSource,
  ends: [ORIGIN, { x: 0, y: 0, z: 10 }]
};
const BORE: RefPick = {
  kind: 'revolution',
  key: 'bore',
  source: { type: 'face', bodyId: 'body' } as DatumAxisFaceSource
};

function take(
  rule: (refs: readonly RefPick[], ref: RefPick) => RefPick[],
  ...picks: RefPick[]
): string[] {
  return picks.reduce<RefPick[]>(rule, []).map((ref) => ref.key);
}

const SLOTS: InPlaceSlots = {
  profiles: [],
  axis: null,
  path: [],
  guide: [],
  faces: [],
  bodies: [],
  plane: null,
  refs: [],
  image: null,
  edges: []
};

describe('datum Plane picks', () => {
  it('reads one plane as an offset, two as a midplane', () => {
    expect(datumPlaneShape([plane('a')])?.mode).toBe('offset');
    expect(datumPlaneShape([plane('a'), plane('b')])?.mode).toBe('midplane');
  });

  it('reads a plane and a point as parallel, three points as through them', () => {
    expect(datumPlaneShape([plane('a'), point('p')])?.mode).toBe(
      'parallel-point'
    );
    expect(datumPlaneShape([point('p'), point('q'), point('r')])?.mode).toBe(
      'three-point'
    );
    expect(datumPlaneShape([point('p'), point('q')])).toBeNull();
  });

  it('toggles a repeated pick back out', () => {
    expect(take(takeDatumPlaneRef, plane('a'), plane('a'))).toEqual([]);
    expect(take(takeDatumPlaneRef, point('p'), point('q'), point('p'))).toEqual(
      ['q']
    );
  });

  it('replaces the newest when a kind is full', () => {
    expect(take(takeDatumPlaneRef, plane('a'), plane('b'), plane('c'))).toEqual(
      ['a', 'c']
    );
    expect(
      take(takeDatumPlaneRef, point('p'), point('q'), point('r'), point('s'))
    ).toEqual(['p', 'q', 's']);
  });

  it('a point with planes keeps the first plane only; a plane after points starts over', () => {
    expect(take(takeDatumPlaneRef, plane('a'), plane('b'), point('p'))).toEqual(
      ['a', 'p']
    );
    expect(take(takeDatumPlaneRef, plane('a'), point('p'), point('q'))).toEqual(
      ['a', 'q']
    );
    expect(take(takeDatumPlaneRef, point('p'), point('q'), plane('a'))).toEqual(
      ['a']
    );
  });

  it('builds each definition the card could, flip included', () => {
    const spec = IN_PLACE_TOOL_SPECS['datum-plane'];
    expect(isInPlaceTool('datum-plane')).toBe(true);
    const offset = spec.request(
      { ...SLOTS, refs: [plane('a')] },
      { offset: 'depth / 2' },
      { normal: 'flipped' },
      { sketchViews: [], datumAxes: undefined, datumLabel: () => '' }
    );
    expect(offset).toEqual({
      tool: 'datum-plane',
      definition: {
        kind: 'offset',
        source: { type: 'datum', datumFeatureId: 'a' },
        offset: 'depth / 2',
        reverseNormal: true
      }
    });
    const three = spec.request(
      { ...SLOTS, refs: [point('p'), point('q'), point('r')] },
      {},
      { normal: 'as-picked' },
      { sketchViews: [], datumAxes: undefined, datumLabel: () => '' }
    );
    expect(three).toMatchObject({
      definition: { kind: 'three-point', points: [{}, {}, {}] }
    });
    expect(
      three && 'definition' in three && three.definition
    ).not.toHaveProperty('reverseNormal');
  });

  it('puts an offset handle on the source, along its normal, only for an offset', () => {
    const spec = IN_PLACE_TOOL_SPECS['datum-plane'];
    const ctx = { sketchViews: [], datumAxes: undefined, datumLabel: () => '' };
    const [handle] = spec.handles(
      { ...SLOTS, refs: [plane('a', 5)] },
      {},
      ctx,
      {}
    );
    expect(handle).toMatchObject({
      valueId: 'offset',
      kind: 'linear',
      params: { origin: { x: 0, y: 0, z: 5 }, direction: UP }
    });
    expect(
      spec.handles({ ...SLOTS, refs: [plane('a'), plane('b')] }, {}, ctx, {})
    ).toEqual([]);
  });
});

describe('datum Axis picks', () => {
  it('reads an edge, a cylinder, two points or two planes', () => {
    expect(datumAxisShape([EDGE])?.mode).toBe('edge');
    expect(datumAxisShape([BORE])?.mode).toBe('cylinder');
    expect(datumAxisShape([point('p'), point('q')])?.mode).toBe('two-point');
    expect(datumAxisShape([plane('a'), plane('b')])?.mode).toBe(
      'plane-intersection'
    );
    expect(datumAxisShape([point('p')])).toBeNull();
  });

  it('starts over when the kind changes', () => {
    expect(take(takeDatumAxisRef, point('p'), EDGE)).toEqual(['edge']);
    expect(take(takeDatumAxisRef, EDGE, point('p'))).toEqual(['p']);
    expect(take(takeDatumAxisRef, plane('a'), point('p'))).toEqual(['p']);
    expect(take(takeDatumAxisRef, EDGE, EDGE)).toEqual([]);
  });

  it('builds the definition, reversed from Options', () => {
    const spec = IN_PLACE_TOOL_SPECS['datum-axis'];
    const request = spec.request(
      { ...SLOTS, refs: [plane('a'), plane('b')] },
      {},
      { direction: 'reversed' },
      { sketchViews: [], datumAxes: undefined, datumLabel: () => '' }
    );
    expect(request).toMatchObject({
      tool: 'datum-axis',
      definition: { kind: 'plane-intersection', reverseDirection: true }
    });
  });
});

describe('an edge click', () => {
  const ends = [ORIGIN, { x: 0, y: 0, z: 20 }] as const;

  it('is an end within a quarter of a straight edge from it', () => {
    expect(edgeClickIsEnd(ends, { x: 0, y: 0, z: 4 }, true)).toBe(true);
    expect(edgeClickIsEnd(ends, { x: 0, y: 0, z: 17 }, true)).toBe(true);
    expect(edgeClickIsEnd(ends, { x: 0, y: 0, z: 10 }, true)).toBe(false);
  });

  it('is always an end on a curved edge, and the edge without a point', () => {
    expect(edgeClickIsEnd(ends, { x: 0, y: 0, z: 10 }, false)).toBe(true);
    expect(edgeClickIsEnd(ends, null, true)).toBe(false);
  });
});

describe('schema v108 picks: a plane on an edge, an axis square to a face', () => {
  const curve = (straight: boolean, key = 'curve'): RefPick => ({
    kind: 'curve',
    key,
    source: { type: 'edge', bodyId: 'body' } as DatumAxisEdgeSource,
    ends: [ORIGIN, { x: 10, y: 0, z: 0 }],
    straight
  });
  const face: RefPick = {
    kind: 'plane',
    key: 'top',
    source: {
      type: 'face',
      bodyId: 'body' as BodyId,
      faceReference: { lineageName: 'top' } as never,
      sourceCentroid: ORIGIN
    } as never,
    origin: ORIGIN,
    normal: UP
  };

  it('reads an edge as a plane square to it, with a point through it, with a plane at an angle', () => {
    expect(datumPlaneShape([curve(false)])?.mode).toBe('normal-to-edge');
    expect(datumPlaneShape([curve(true), point('p')])?.mode).toBe(
      'normal-through-point'
    );
    expect(datumPlaneShape([curve(true), plane('a')])?.mode).toBe('edge-angle');
    // A curved edge has no single direction for a point or an angle.
    expect(datumPlaneShape([curve(false), plane('a')])).toBeNull();
    expect(datumPlaneShape([curve(false), point('p')])).toBeNull();
  });

  it('keeps one edge, pairs it with the latest plane or point, and toggles it off', () => {
    const rule = takeDatumPlaneRef;
    expect(take(rule, plane('a'), curve(true))).toEqual(['curve', 'a']);
    expect(take(rule, curve(true), point('p'), plane('a'))).toEqual([
      'curve',
      'a'
    ]);
    expect(take(rule, curve(true), curve(true, 'other'))).toEqual(['other']);
    expect(take(rule, curve(true), curve(true))).toEqual([]);
  });

  it('builds the definitions, with a position and an angle handle', () => {
    const spec = IN_PLACE_TOOL_SPECS['datum-plane'];
    const ctx = { sketchViews: [], datumAxes: undefined, datumLabel: () => '' };
    const along = { ...SLOTS, refs: [curve(true)] };
    expect(spec.request(along, { position: 0.3 }, {}, ctx)).toMatchObject({
      definition: { kind: 'normal-to-edge', at: { fraction: 0.3 } }
    });
    const handle = spec.handles(along, {}, ctx, {})[0];
    expect(handle).toMatchObject({ valueId: 'position', kind: 'linear' });
    expect(handle?.kind === 'linear' && handle.params.scale).toBe(10);
    const tilted = { ...SLOTS, refs: [curve(true), plane('a')] };
    expect(spec.request(tilted, { angle: 30 }, {}, ctx)).toMatchObject({
      definition: { kind: 'edge-angle', angleDeg: 30 }
    });
    expect(spec.handles(tilted, {}, ctx, {})[0]).toMatchObject({
      valueId: 'angle',
      kind: 'angle',
      params: { axis: { x: 1, y: 0, z: 0 } }
    });
  });

  it('reads a face then a point, or a curved face alone, as an axis square to the face', () => {
    expect(take(takeDatumAxisRef, face, point('p'))).toEqual(['top', 'p']);
    expect(datumAxisShape([face, point('p')])?.mode).toBe('face-normal');
    expect(datumAxisShape([BORE, point('p')])?.mode).toBe('face-normal');
    const dome: RefPick = {
      kind: 'surface',
      key: 'dome',
      source: { type: 'face', bodyId: 'body' } as DatumAxisFaceSource,
      at: { x: 1, y: 2, z: 3 }
    };
    expect(datumAxisShape([dome])).toMatchObject({
      mode: 'face-normal',
      point: { type: 'point', point: { x: 1, y: 2, z: 3 } }
    });
    // A plane that is not a face still pairs only with a second plane.
    expect(take(takeDatumAxisRef, plane('a'), point('p'))).toEqual(['p']);
  });
});
