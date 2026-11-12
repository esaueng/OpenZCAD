import { describe, expect, it } from 'vitest';
import type { BodyId, ParamValue } from '@openzcad/shared';
import {
  threadAnchor,
  threadEditOptions,
  threadFace,
  threadIsPartial,
  threadRequestFields,
  threadSpec,
  threadSummary,
  type ThreadRequest
} from './thread';
import { inPlacePanelSections, inPlacePanelState } from './panel';
import type { FacePick, InPlaceContext, InPlaceSlots } from './tools';

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
      defaults({ chamfer: 'both' }),
      'mm',
      { partial: true }
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
        hand: 'left'
      }),
      'mm',
      { partial: true, from: 'end' }
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
          chamfer: 'none',
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
      for (const id of ['profile', 'size', 'fit', 'chamfer', 'hand']) {
        expect(read[id], id).toBe(options[id]);
      }
      // How much of the face it runs is no option: the face and the dragged
      // end say it.
      expect(read.span).toBeUndefined();
      expect(read.anchor).toBeUndefined();
    }
  });

  it('summarizes only the folded rows that leave their defaults', () => {
    const state = inPlacePanelState(
      threadSpec,
      { size: 'M10', hand: 'left' },
      { starts: 2, phaseDeg: 30, chamferAngleDeg: 30 }
    );
    expect(threadSummary(state)).toBe(
      'Left hand · 2 starts · Rotated 30° · Chamfer 30°'
    );
    expect(
      threadSummary(
        inPlacePanelState(
          threadSpec,
          { chamfer: 'none' },
          { chamferAngleDeg: 30 }
        )
      )
    ).toBeNull();
    expect(threadSummary(inPlacePanelState(threadSpec, {}, {}))).toBeNull();
  });

  it('lists every custom number in the panel, though none has a handle', () => {
    const rows = (options: Record<string, string>) =>
      inPlacePanelSections(
        threadSpec,
        inPlacePanelState(threadSpec, options, {}),
        new Set()
      ).flatMap((section) =>
        section.rows.flatMap((row) => (row.kind === 'value' ? [row.id] : []))
      );
    expect(
      rows({ profile: 'custom', size: 'custom', fit: 'custom' }).sort()
    ).toEqual(
      [
        'chamferAngleDeg',
        'clearance',
        'crestWidth',
        'depth',
        'lowerFlankAngleDeg',
        'majorDiameter',
        'offset',
        'phaseDeg',
        'pitch',
        'starts',
        'upperFlankAngleDeg'
      ].sort()
    );
    expect(rows({}).sort()).toEqual(
      ['chamferAngleDeg', 'offset', 'phaseDeg', 'starts'].sort()
    );
  });

  it('groups its rows in tinted boxes, numbers paired, More folded', () => {
    const sections = inPlacePanelSections(
      threadSpec,
      inPlacePanelState(threadSpec, { profile: 'custom' }, {}),
      new Set()
    );
    expect(
      sections.map((s) => [s.label, !!s.compact, !!s.boxed, !!s.collapsed])
    ).toEqual([
      ['Thread', true, true, false],
      ['Length', true, true, false],
      ['Form', true, true, false],
      ['More', true, false, true]
    ]);
  });

  it('keeps every choice to a short label, explained only by its tooltip', () => {
    for (const option of threadSpec.options ?? []) {
      for (const choice of option.choices) {
        expect(choice.note, `${option.id}:${choice.value}`).toBeUndefined();
        if (option.id !== 'size') {
          expect(choice.label.length, choice.label).toBeLessThanOrEqual(9);
        }
      }
    }
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
    expect(threadSpec.hint({ ...empty, faces: [{} as never] })).toBe(
      'Enter to finish'
    );
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

/** An M6 boss 12 tall standing on the XY plane, its axis up +Z. */
const BOSS: FacePick = {
  bodyId: 'body_a' as BodyId,
  hash: 9,
  topologyId: 't',
  surfaceType: 'cylinder',
  cylinder: {
    axisStart: { x: 0, y: 0, z: 0 },
    axisEnd: { x: 0, y: 0, z: 12 },
    radius: 3
  }
};
const SLOTS: InPlaceSlots = {
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
const CTX: InPlaceContext = {
  sketchViews: [],
  datumAxes: undefined,
  datumLabel: () => ''
};
const numbersOf = (values: Record<string, ParamValue>) =>
  Object.fromEntries(
    Object.entries(values).map(([id, value]) => [id, evaluate(value)])
  ) as Record<string, number>;

describe('in-place thread: picks and the dragged end (U11)', () => {
  it('reads the picked cylinder: its ends, axis, length and the side clicked', () => {
    const near = threadFace({ ...BOSS, point: { x: 0, y: -3, z: 10 } });
    expect(near).toMatchObject({
      start: { x: 0, y: 0, z: 0 },
      end: { x: 0, y: 0, z: 12 },
      axis: { x: 0, y: 0, z: 1 },
      length: 12,
      radius: 3,
      radial: { x: 0, y: -1, z: 0 }
    });
    const { cylinder: _cylinder, ...plain } = BOSS;
    expect(threadFace(plain)).toBeNull();
  });

  it('starts the thread at the end of the face nearer the click', () => {
    expect(threadAnchor({ ...BOSS, point: { x: 3, y: 0, z: 10 } })).toBe('end');
    expect(threadAnchor({ ...BOSS, point: { x: 3, y: 0, z: 2 } })).toBe(
      'start'
    );
    // An edit not clicked again keeps the end it stores.
    const saved = {
      featureKind: 'thread' as const,
      targetBodyId: 'body_a' as BodyId,
      faceHash: 9,
      profile: 'printable' as const,
      length: 4,
      anchor: 'end' as const
    };
    expect(threadAnchor(BOSS, { ...CTX, saved })).toBe('end');
    expect(threadAnchor(BOSS)).toBe('start');
  });

  it('asks only for the face, then offers one arrow on the free end', () => {
    expect(threadSpec.hint(SLOTS)).toMatch(/near the end the thread starts/);
    const clicked = { ...BOSS, point: { x: 3, y: 0, z: 10 } };
    const picked = { ...SLOTS, faces: [clicked] };
    expect(threadSpec.hint(picked)).toMatch(/Drag the arrow/);
    // Unset, the thread runs the whole face.
    expect(threadSpec.defaults?.(picked, CTX, { offset: 0 })).toEqual({
      length: 12
    });
    expect(threadSpec.defaults?.(picked, CTX, { offset: 2 })).toEqual({
      length: 10
    });
    const handles = threadSpec.handles(
      picked,
      { length: 12, offset: 0 },
      CTX,
      defaults()
    );
    // Clicked near the top: the arrow stands on the face at the top and
    // points down it, reaching no further than the bottom.
    expect(handles[0]?.key).toContain(':length:end:');
    expect(handles).toEqual([
      {
        valueId: 'length',
        kind: 'linear',
        key: handles[0]?.key,
        params: {
          origin: { x: 3, y: 0, z: 12 },
          direction: { x: -0, y: -0, z: -1 }
        },
        max: 12
      }
    ]);
    // An offset moves where the arrow starts and shortens its reach.
    const offset = threadSpec.handles(
      picked,
      { length: 10, offset: 2 },
      CTX,
      defaults()
    )[0]!;
    expect(offset).toMatchObject({
      params: { origin: { x: 3, y: 0, z: 10 } },
      max: 10
    });
    expect(offset.key).not.toBe(handles[0]!.key);
  });

  it('stops short of the face only once its end is dragged short', () => {
    const face = { ...BOSS, point: { x: 3, y: 0, z: 10 } };
    const values = initialValues({ length: 12, offset: 0 });
    // Untouched, it runs the whole face whatever the value says.
    expect(threadIsPartial(face, values, numbersOf(values), CTX)).toBe(false);
    const dragged = { ...CTX, touched: ['length'] };
    expect(threadIsPartial(face, values, numbersOf(values), dragged)).toBe(
      false
    );
    const short = initialValues({ length: 8, offset: 0 });
    expect(threadIsPartial(face, short, numbersOf(short), dragged)).toBe(true);
    const request = threadSpec.request(
      { ...SLOTS, faces: [face] },
      short,
      defaults(),
      dragged,
      numbersOf(short)
    );
    // Clicked near the top, it runs 8 down from there, its ends plain.
    expect(request).toEqual({
      tool: 'thread',
      thread: {
        targetBodyId: 'body_a',
        faceHash: 9,
        profile: 'printable',
        clearance: 0.1,
        length: 8,
        anchor: 'end'
      }
    });
    // Dragged back to the face's end, it is whole again, chamfers and all.
    expect(
      threadSpec.request(
        { ...SLOTS, faces: [face] },
        values,
        defaults(),
        dragged,
        numbersOf(values)
      )
    ).toEqual({
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

  it('keeps no chamfer where an offset sets the thread off the face end', () => {
    const face = { ...BOSS, point: { x: 3, y: 0, z: 2 } };
    const values = initialValues({ length: 10, offset: 2 });
    const request = threadSpec.request(
      { ...SLOTS, faces: [face] },
      values,
      defaults(),
      CTX,
      numbersOf(values)
    ) as { thread: ThreadRequest };
    expect(request.thread).toMatchObject({ offset: 2, chamferEnd: true });
    expect(request.thread.chamferStart).toBeUndefined();
    expect(request.thread.length).toBeUndefined();
  });

  it('reads out what the face and the dragged end decide', () => {
    const slots = { faces: [{ ...BOSS, point: { x: 3, y: 0, z: 10 } }] };
    expect(
      threadSummary(
        inPlacePanelState(threadSpec, {}, { length: 12 }),
        'mm',
        slots
      )
    ).toBe('Sized from the Ø6 mm face · Threads the full 12 mm');
    expect(
      threadSummary(
        inPlacePanelState(
          threadSpec,
          { size: 'M8' },
          { length: 8, chamferAngleDeg: 30 }
        ),
        'mm',
        slots
      )
    ).toBe('Threads 8 of 12 mm, ends plain');
    expect(
      threadSummary(
        inPlacePanelState(threadSpec, {}, { length: 10, offset: 2 }),
        'mm',
        slots
      )
    ).toBe('Sized from the Ø6 mm face · Threads 10 of 12 mm');
  });
});

describe('in-place thread edits', () => {
  it('writes an untouched partial thread back exactly, even one reaching the face end', () => {
    const saved = {
      featureKind: 'thread' as const,
      targetBodyId: 'body_a' as BodyId,
      faceHash: 9,
      profile: 'printable' as const,
      clearance: 0.1,
      length: 'len',
      offset: 2,
      anchor: 'end' as const
    };
    // Its stored length resolves to the rest of the face: still partial.
    const values = initialValues({ length: 'len', offset: 2 });
    const numbers = { ...numbersOf(initialValues({ offset: 2 })), length: 10 };
    const ctx = { ...CTX, saved, touched: ['length', 'offset'] };
    expect(threadIsPartial(BOSS, values, numbers, ctx)).toBe(true);
    const request = threadSpec.request(
      { ...SLOTS, faces: [BOSS] },
      values,
      threadEditOptions(saved, evaluate, 'mm'),
      ctx,
      numbers
    );
    const { featureKind: _kind, ...fields } = saved;
    expect(request).toEqual({ tool: 'thread', thread: fields });
  });

  it('writes an untouched whole-face thread back exactly', () => {
    const saved = {
      featureKind: 'thread' as const,
      targetBodyId: 'body_a' as BodyId,
      faceHash: 9,
      profile: 'iso-metric' as const,
      majorDiameter: 6,
      pitch: 1,
      chamferStart: true
    };
    const values = initialValues({ length: 12 });
    const request = threadSpec.request(
      { ...SLOTS, faces: [BOSS] },
      values,
      threadEditOptions(saved, evaluate, 'mm'),
      { ...CTX, saved, touched: ['majorDiameter', 'pitch'] },
      numbersOf(values)
    );
    const { featureKind: _kind, ...fields } = saved;
    expect(request).toEqual({ tool: 'thread', thread: fields });
  });

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
