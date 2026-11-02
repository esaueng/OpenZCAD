import { describe, expect, it } from 'vitest';
import type { BodyId, ParamValue } from '@openzcad/shared';
import {
  threadEditOptions,
  threadRequestFields,
  threadSpec,
  threadSummary,
  type ThreadRequest
} from './thread';
import { inPlacePanelState } from './panel';
import type { InPlaceSlots } from './tools';

const evaluate = (value: ParamValue) =>
  typeof value === 'number' ? value : Number(value);

const defaults = (
  overrides: Record<string, string> = {}
): Record<string, string> =>
  Object.fromEntries(
    (threadSpec.options ?? []).map((option) => [
      option.id,
      overrides[option.id] ?? option.initial
    ])
  );

const initialValues = (
  overrides: Record<string, ParamValue> = {}
): Record<string, ParamValue> => ({
  ...Object.fromEntries(threadSpec.values.map((v) => [v.id, v.initial])),
  ...overrides
});

describe('in-place thread', () => {
  it('defaults to a printable thread fitted to the face, a printed fit and chamfered ends', () => {
    expect(threadRequestFields(initialValues(), defaults(), 'mm')).toEqual({
      profile: 'printable',
      clearance: 0.1,
      chamferStart: true,
      chamferEnd: true
    });
  });

  it('chamfers the chosen ends at the chosen angle, and never a band', () => {
    expect(
      threadRequestFields(
        initialValues({ chamferAngleDeg: 30 }),
        defaults({ chamfer: 'end' }),
        'mm'
      )
    ).toEqual({
      profile: 'printable',
      clearance: 0.1,
      chamferEnd: true,
      chamferAngleDeg: 30
    });
    const band = threadRequestFields(
      initialValues(),
      defaults({ span: 'band', chamfer: 'both' }),
      'mm'
    );
    expect(band.chamferStart).toBeUndefined();
    expect(band.chamferEnd).toBeUndefined();
  });

  it('stores an ISO size in document units and an exact fit as no clearance', () => {
    expect(
      threadRequestFields(
        initialValues(),
        defaults({
          profile: 'iso-metric',
          size: 'M8',
          fit: 'exact',
          chamfer: 'none'
        }),
        'inch'
      )
    ).toEqual({
      profile: 'iso-metric',
      majorDiameter: 8 / 25.4,
      pitch: 1.25 / 25.4
    });
  });

  it('stores a custom form, a band from the far end and the extras', () => {
    const fields = threadRequestFields(
      initialValues({
        pitch: 2,
        depth: 0.8,
        crestWidth: 0.6,
        upperFlankAngleDeg: 0,
        lowerFlankAngleDeg: 45,
        clearance: 0.15,
        length: 6,
        offset: 'gap',
        starts: 2,
        phaseDeg: 30
      }),
      defaults({
        profile: 'custom',
        fit: 'custom',
        span: 'band',
        anchor: 'end',
        hand: 'left'
      }),
      'mm'
    );
    expect(fields).toEqual({
      profile: 'custom',
      pitch: 2,
      depth: 0.8,
      crestWidth: 0.6,
      upperFlankAngleDeg: 0,
      lowerFlankAngleDeg: 45,
      clearance: 0.15,
      starts: 2,
      hand: 'left',
      length: 6,
      offset: 'gap',
      anchor: 'end',
      phaseDeg: 30
    });
  });

  it('reads a stored thread back as the options that wrote it', () => {
    const cases: [Record<string, string>, Record<string, ParamValue>][] = [
      [defaults(), {}],
      [
        defaults({
          profile: 'iso-metric',
          size: 'M6',
          fit: 'loose',
          chamfer: 'start'
        }),
        {}
      ],
      [
        defaults({
          profile: 'custom',
          size: 'custom',
          fit: 'custom',
          span: 'band',
          anchor: 'end',
          hand: 'left'
        }),
        { majorDiameter: 7, pitch: 1.1, clearance: 0.05 }
      ]
    ];
    for (const [options, values] of cases) {
      const stored: ThreadRequest = {
        targetBodyId: 'body_a' as BodyId,
        faceHash: 3,
        ...threadRequestFields(initialValues(values), options, 'mm')
      };
      const read = threadEditOptions(stored, evaluate, 'mm');
      for (const id of ['profile', 'size', 'fit', 'span', 'hand']) {
        expect(read[id], id).toBe(options[id]);
      }
      if (options.span !== 'band') expect(read.chamfer).toBe(options.chamfer);
      if (options.span === 'band') expect(read.anchor).toBe(options.anchor);
    }
  });

  it('summarizes the callout, starts, hand and clearance', () => {
    const state = inPlacePanelState(
      threadSpec,
      { size: 'M10', hand: 'left' },
      { starts: 2 }
    );
    expect(threadSummary(state, 'mm')).toBe(
      'M10×1.5 · 2 starts · Left hand · Chamfered 45° · Clearance 0.1 mm'
    );
    expect(
      threadSummary(
        inPlacePanelState(threadSpec, { fit: 'exact', chamfer: 'none' }, {}),
        'mm'
      )
    ).toBeNull();
  });

  it('asks for a cylinder and builds once one is picked', () => {
    const empty: InPlaceSlots = {
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
    expect(threadSpec.ready(empty)).toBe(false);
    expect(threadSpec.hint(empty)).toMatch(/cylindrical face/);
    const face = {
      bodyId: 'body_a' as BodyId,
      hash: 9,
      topologyId: 't',
      surfaceType: 'cylinder'
    };
    const picked = { ...empty, faces: [face] };
    expect(threadSpec.ready(picked)).toBe(true);
    const request = threadSpec.request(picked, initialValues(), defaults(), {
      sketchViews: [],
      datumAxes: undefined,
      datumLabel: () => ''
    });
    expect(request).toEqual({
      tool: 'thread',
      thread: {
        targetBodyId: 'body_a',
        faceHash: 9,
        profile: 'printable',
        clearance: 0.1,
        chamferStart: true,
        chamferEnd: true
      }
    });
  });
});

describe('in-place thread edits', () => {
  it('clears what the edit no longer sets, the old face reference included', async () => {
    const { inPlaceFeatureUpdate } = await import('./edit');
    const saved = {
      featureKind: 'thread' as const,
      targetBodyId: 'body_a' as BodyId,
      faceHash: 3,
      faceReference: {
        version: 5,
        kind: 'face',
        producingFeatureId: 'feat_a',
        lineageName: 'x',
        currentHash: 3
      } as never,
      profile: 'custom' as const,
      pitch: 2,
      depth: 0.8,
      crestWidth: 0.6,
      upperFlankAngleDeg: 0,
      lowerFlankAngleDeg: 45,
      length: 4
    };
    const update = inPlaceFeatureUpdate(
      { featureId: 'feat_t' as never, name: 'Thread', data: saved },
      {
        tool: 'thread',
        thread: {
          targetBodyId: 'body_a' as BodyId,
          faceHash: 9,
          profile: 'printable',
          clearance: 0.1
        }
      }
    );
    expect(update?.data).toEqual({
      featureKind: 'thread',
      targetBodyId: 'body_a',
      faceHash: 9,
      profile: 'printable',
      clearance: 0.1
    });
    expect([...(update?.clearData ?? [])].sort()).toEqual(
      [
        'crestWidth',
        'depth',
        'faceReference',
        'length',
        'lowerFlankAngleDeg',
        'pitch',
        'upperFlankAngleDeg'
      ].sort()
    );
  });
});
