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
