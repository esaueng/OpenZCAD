import { describe, expect, it } from 'vitest';
import type {
  BodyId,
  FeatureData,
  FeatureId,
  FeatureNode
} from '@openzcad/shared';
import {
  inPlaceEditSeed,
  inPlaceFeatureUpdate,
  inPlaceToolForFeature,
  type InPlaceEditContext
} from './edit';
import {
  standardPartChoice,
  standardPartHoleInsertion,
  standardPartSizeOptionId,
  standardPartSpec
} from './standardPart';
import type {
  InPlaceContext,
  InPlaceSlots,
  PlanePick,
  ResolvedInPlaceRequest
} from './tools';

type StandardPartUpdateRequest = Extract<
  ResolvedInPlaceRequest,
  { tool: 'standard-part' }
>;

/**
 * M17: the Standard part command — where a picked face puts the part and
 * which way it goes, what it stores, its length handle, and a History edit
 * that reopens the part as stored and writes it back.
 */

const SLOTS: InPlaceSlots = {
  profiles: [],
  axis: null,
  path: [],
  guide: [],
  faces: [],
  bodies: [],
  plane: null,
  edges: [],
  placement: null,
  refs: [],
  image: null
};

const TOP: PlanePick = {
  kind: 'face',
  origin: { x: 20, y: 15, z: 20 },
  normal: { x: 0, y: 0, z: 1 }
};

const CTX: InPlaceContext = {
  sketchViews: [],
  datumAxes: undefined,
  datumLabel: () => 'Axis',
  units: 'mm'
};

const SCREW = { partKind: 'screw', head: 'socket', system: 'iso' };

describe('M17 Standard part command', () => {
  it('sends a screw into the face it was clicked on', () => {
    const slots = { ...SLOTS, plane: TOP };
    expect(standardPartSpec.ready(slots, SCREW)).toBe(true);
    const defaults = standardPartSpec.defaults!(slots, CTX, {}, SCREW);
    expect(defaults.length).toBe(16);
    const request = standardPartSpec.request(
      slots,
      { length: 25 },
      { ...SCREW, [standardPartSizeOptionId('screw', 'iso', 'socket')]: 'M8' },
      CTX
    );
    expect(request).toEqual({
      tool: 'standard-part',
      part: {
        partKind: 'screw',
        system: 'iso',
        size: 'M8',
        head: 'socket',
        length: 25,
        origin: { x: 20, y: 15, z: 20 },
        axis: { x: 0, y: 0, z: -1 }
      }
    });
    // The length arrow runs from the click down the screw.
    expect(standardPartSpec.handles(slots, { length: 25 }, CTX, SCREW)).toEqual(
      [
        expect.objectContaining({
          valueId: 'length',
          kind: 'linear',
          params: { origin: TOP.origin, direction: { x: 0, y: 0, z: -1 } }
        })
      ]
    );
  });

  it('stands a nut on the face, with no length', () => {
    const options = { partKind: 'nut', system: 'ansi' };
    const request = standardPartSpec.request(
      { ...SLOTS, plane: TOP },
      { length: 25 },
      options,
      CTX
    );
    expect(request).toMatchObject({
      tool: 'standard-part',
      part: { partKind: 'nut', system: 'ansi', size: '1/4', axis: { z: 1 } }
    });
    expect(request && 'part' in request && 'length' in request.part).toBe(
      false
    );
    expect(
      standardPartSpec.handles({ ...SLOTS, plane: TOP }, {}, CTX, options)
    ).toEqual([]);
  });

  it('keeps a size the chosen table lists, else its default', () => {
    expect(
      standardPartChoice({
        partKind: 'screw',
        head: 'countersunk',
        system: 'iso',
        [standardPartSizeOptionId('screw', 'iso', 'countersunk')]: 'M2'
      }).size
    ).toBe('M6');
    expect(
      standardPartChoice({ partKind: 'bearing', system: 'iso' }).size
    ).toBe('608');
  });

  it('designates a length in the document units (review)', () => {
    const options = { partKind: 'screw', system: 'ansi' };
    expect(
      standardPartSpec.summary!({ options, numbers: { length: 0.75 } }, 'inch')
    ).toBe('ASME B18.3 1/4-20 UNC × 3/4" socket head cap screw');
    expect(
      standardPartSpec.summary!(
        { options: SCREW, numbers: { length: 20 } },
        'mm'
      )
    ).toBe('ISO 4762 M6×1 × 20 socket head cap screw');
  });

  it('refuses a screw too short to thread', () => {
    expect(
      standardPartSpec.refuseValue!('length', 4, {}, undefined, {
        options: SCREW,
        units: 'mm'
      })
    ).toMatch(/longer than 5 mm/);
    expect(
      standardPartSpec.refuseValue!('length', 6, {}, undefined, {
        options: SCREW,
        units: 'mm'
      })
    ).toBeNull();
  });

  it('reopens a stored part from History and writes it back', () => {
    const data: Extract<FeatureData, { featureKind: 'standard-part' }> = {
      featureKind: 'standard-part',
      partKind: 'screw',
      system: 'iso',
      size: 'M5',
      head: 'hex',
      length: 'bolt',
      origin: { x: 1, y: 2, z: 'top' },
      axis: { x: 0, y: 0, z: -1 }
    };
    const feature: FeatureNode = {
      id: 'node_part',
      kind: 'feature',
      featureId: 'feat_part' as FeatureId,
      name: 'Screw 1',
      bodyId: 'body_part' as BodyId,
      data
    } as FeatureNode;
    expect(inPlaceToolForFeature(data)).toBe('standard-part');
    const ctx: InPlaceEditContext = {
      evaluate: (value) =>
        typeof value === 'number'
          ? value
          : value === 'top'
            ? 20
            : value === 'bolt'
              ? 30
              : null,
      profile: () => null,
      firstRegion: () => null,
      face: () => null,
      anyFace: () => null,
      edge: () => null,
      curve: () => true,
      body: () => null
    };
    const armed = inPlaceEditSeed(feature, ctx)!;
    expect(armed.tool).toBe('standard-part');
    expect(armed.seed.options).toMatchObject({
      partKind: 'screw',
      head: 'hex',
      system: 'iso',
      [standardPartSizeOptionId('screw', 'iso', 'hex')]: 'M5'
    });
    // The face's normal: the screw went into it.
    expect(armed.seed.slots.plane).toMatchObject({
      kind: 'saved',
      origin: { x: 1, y: 2, z: 20 },
      normal: { x: 0, y: 0, z: 1 }
    });
    const request = standardPartSpec.request(
      { ...SLOTS, plane: armed.seed.slots.plane },
      { length: 'bolt' },
      armed.seed.options,
      { ...CTX, saved: data }
    )!;
    // Untouched, it writes back exactly as stored, expressions and all.
    const update = inPlaceFeatureUpdate(
      { featureId: feature.featureId, name: feature.name, data },
      request as StandardPartUpdateRequest
    );
    expect(update).toEqual({
      featureId: 'feat_part',
      name: 'Screw 1',
      data
    });
    // A washer in its place drops the head and the length.
    const washer = standardPartSpec.request(
      { ...SLOTS, plane: TOP },
      {},
      { partKind: 'washer', system: 'iso' },
      { ...CTX, saved: data }
    )!;
    expect(
      inPlaceFeatureUpdate(
        { featureId: feature.featureId, name: feature.name, data },
        washer as StandardPartUpdateRequest
      )
    ).toMatchObject({
      data: { partKind: 'washer', size: 'M6' },
      clearData: ['head', 'length']
    });
  });
});

describe('M17 Standard part into a hole (schema v71)', () => {
  const HOLE_ID = 'feat_hole' as FeatureId;
  const hole = {
    featureKind: 'hole',
    targetBodyId: 'body_block' as BodyId,
    faceHash: 7,
    style: 'simple',
    diameter: 6.6,
    depthMode: 'through',
    position: { u: 0, v: 0 },
    standard: { system: 'iso', size: 'M6', kind: 'clearance' }
  } as Extract<FeatureData, { featureKind: 'hole' }>;
  const ctx: InPlaceContext = {
    ...CTX,
    evaluate: (value) => (typeof value === 'number' ? value : null),
    holeFeature: (featureId) =>
      featureId === HOLE_ID
        ? { name: 'Hole 1', data: hole, entryNormal: { x: 0, y: 0, z: 1 } }
        : null
  };
  // The bore of a 20 mm block, picked.
  const bore = {
    bodyId: 'body_holed' as BodyId,
    hash: 11,
    topologyId: 'f11',
    feature: { featureId: HOLE_ID, name: 'Hole 1' },
    cylinder: {
      axisStart: { x: 20, y: 15, z: 0 },
      axisEnd: { x: 20, y: 15, z: 20 },
      radius: 3.3,
      axialLength: 20
    }
  };
  const slots = { ...SLOTS, faces: [bore] };
  const options = { partKind: 'screw', place: 'hole', head: 'hex' };

  it('sizes the screw by the hole and matches its length', () => {
    const inserted = standardPartHoleInsertion(slots, options, ctx);
    expect(inserted).toMatchObject({
      featureId: HOLE_ID,
      choice: { partKind: 'screw', system: 'iso', size: 'M6', head: 'hex' },
      // The bore's end on the entry face, going in.
      origin: { x: 20, y: 15, z: 20 },
      axis: { x: 0, y: 0, z: -1 },
      // 20 through, a 5.2 nut and two pitches: the preferred 30.
      matchedLength: 30
    });
    expect(standardPartSpec.ready(slots, options, ctx)).toBe(true);
    expect(standardPartSpec.defaults!(slots, ctx, {}, options).length).toBe(30);
  });

  it('stores the hole, and a length only once it is set', () => {
    const matched = standardPartSpec.request(
      slots,
      { length: 30 },
      options,
      ctx
    );
    expect(matched).toMatchObject({
      tool: 'standard-part',
      part: { size: 'M6', head: 'hex', hole: { featureId: HOLE_ID } }
    });
    expect(matched && 'part' in matched && 'length' in matched.part).toBe(
      false
    );
    const dragged = standardPartSpec.request(slots, { length: 35 }, options, {
      ...ctx,
      touched: ['length']
    });
    expect(dragged).toMatchObject({ part: { length: 35 } });
  });

  it('refuses a part the hole does not take', () => {
    expect(
      standardPartHoleInsertion(
        slots,
        { partKind: 'dowel', place: 'hole' },
        ctx
      )
    ).toMatch(/No ISO dowel pin is 6.6 mm/);
    expect(
      standardPartSpec.hint(slots, { partKind: 'dowel', place: 'hole' }, ctx)
    ).toMatch(/No ISO dowel pin/);
    expect(standardPartSpec.ready(SLOTS, options, ctx)).toBe(false);
  });

  it('takes a part out of its hole when the edit places it on a face (regression)', () => {
    const saved = {
      featureKind: 'standard-part',
      partKind: 'screw',
      system: 'iso',
      size: 'M6',
      origin: { x: 20, y: 15, z: 20 },
      axis: { x: 0, y: 0, z: -1 },
      hole: { featureId: HOLE_ID }
    } as Extract<FeatureData, { featureKind: 'standard-part' }>;
    const onFace = standardPartSpec.request(
      { ...SLOTS, plane: TOP },
      { length: 20 },
      { partKind: 'screw', place: 'face' },
      { ...ctx, saved }
    )!;
    expect(
      inPlaceFeatureUpdate(
        { featureId: 'feat_part' as FeatureId, name: 'Screw', data: saved },
        onFace as StandardPartUpdateRequest
      )
    ).toMatchObject({ clearData: ['hole'] });
  });
});
