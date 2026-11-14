import { describe, expect, it } from 'vitest';
import type { BodyId, FeatureData, ParamValue } from '@openzcad/shared';
import {
  threadAnchor,
  threadChamferedEnds,
  threadEndFinishes,
  threadEditOptions,
  threadFace,
  threadIsPartial,
  threadReach,
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

  it('chamfers the chosen ends at the chosen angle, and a band only where it starts', () => {
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
    expect(band.chamferStart).toBe(true);
    expect(band.chamferEnd).toBeUndefined();
    // Set off from the end it starts at, it reaches neither end.
    const island = threadRequestFields(
      initialValues({ offset: 2 }),
      defaults({ chamfer: 'both' }),
      'mm',
      { partial: true, offset: 2 }
    );
    expect(island.chamferStart).toBeUndefined();
    expect(island.chamferEnd).toBeUndefined();
    expect(island.chamferAngleDeg).toBeUndefined();
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
      'Left hand · 2 starts · Rotated 30° · Ends 30°'
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
    // Clicked near the top, it runs 8 down from there: chamfered at the
    // top it starts from, run out where it stops short of the bottom.
    expect(request).toEqual({
      tool: 'thread',
      thread: {
        targetBodyId: 'body_a',
        faceHash: 9,
        profile: 'printable',
        clearance: 0.1,
        length: 8,
        anchor: 'end',
        chamferEnd: true,
        runoutStart: true
      }
    });
    // Dragged back to the face's end, it is whole again, chamfers and all,
    // and still starts at the top it was picked at.
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
        anchor: 'end',
        chamferStart: true,
        chamferEnd: true
      }
    });
  });

  it('stores the far starting end of a new whole-face thread (review #3)', () => {
    const values = initialValues({ length: 12, offset: 0 });
    const request = (face: FacePick) =>
      (
        threadSpec.request(
          { ...SLOTS, faces: [face] },
          values,
          defaults(),
          CTX,
          numbersOf(values)
        ) as { thread: ThreadRequest }
      ).thread;
    // Picked near the top and never shortened: reopened, it still starts
    // there, so its arrow and any shortening do too.
    const top = request({ ...BOSS, point: { x: 3, y: 0, z: 10 } });
    expect(top.anchor).toBe('end');
    expect(top.length).toBeUndefined();
    // Near the bottom, the start is the default and is left unwritten.
    expect(
      request({ ...BOSS, point: { x: 3, y: 0, z: 2 } }).anchor
    ).toBeUndefined();
  });

  it('refuses a typed length or offset past the face end, and takes its end exactly (review #1)', () => {
    const faces = { faces: [{ ...BOSS, point: { x: 3, y: 0, z: 10 } }] };
    const refuse = threadSpec.refuseValue!;
    // A 20 on a 12 face is refused, never quietly made the whole face.
    expect(refuse('length', 20, { offset: 0 }, faces)).toMatch(
      /at most 12, to the face's far end/
    );
    expect(refuse('length', 12.001, { offset: 0 }, faces)).not.toBeNull();
    // Only the far end itself runs the whole face.
    expect(refuse('length', 12, { offset: 0 }, faces)).toBeNull();
    expect(refuse('length', 8, { offset: 0 }, faces)).toBeNull();
    // Past an offset, less of the face is left.
    expect(refuse('length', 10.5, { offset: 2 }, faces)).toMatch(/at most 10/);
    expect(refuse('length', 10, { offset: 2 }, faces)).toBeNull();
    expect(refuse('offset', 12, { length: 5 }, faces)).toMatch(/only 12 long/);
    expect(refuse('offset', 3, { length: 5 }, faces)).toBeNull();
    // Without a cylinder to measure, nothing is refused here.
    expect(refuse('length', 20, {}, { faces: [] })).toBeNull();
  });

  it('works the same on a hole in an inch document, at a length that is no tenth', () => {
    // A 1/4-20 tapped hole 0.53 in deep, its axis down from the plate's top.
    const hole: FacePick = {
      bodyId: 'body_p' as BodyId,
      hash: 4,
      topologyId: 'h',
      surfaceType: 'cylinder',
      cylinder: {
        axisStart: { x: 1, y: 1, z: 0.53 },
        axisEnd: { x: 1, y: 1, z: 0 },
        radius: 0.1015
      },
      // Clicked inside the bore, near the plate's top (the axis start).
      point: { x: 1, y: 1.1015, z: 0.5 }
    };
    expect(threadAnchor(hole)).toBe('start');
    const handle = threadSpec.handles(
      { ...SLOTS, faces: [hole] },
      { length: 0.53, offset: 0 },
      { ...CTX, units: 'inch' },
      defaults()
    )[0]!;
    expect(handle).toMatchObject({ kind: 'linear', max: 0.53 });
    if (handle.kind !== 'linear') throw new Error('expected an arrow');
    const { params } = handle;
    expect(params.origin.x).toBeCloseTo(1, 9);
    expect(params.origin.y).toBeCloseTo(1.1015, 9);
    expect(params.origin.z).toBeCloseTo(0.53, 9);
    expect(
      threadSummary(
        inPlacePanelState(threadSpec, {}, { length: 0.53 }),
        'inch',
        { faces: [hole] }
      )
    ).toBe('Sized from the Ø0.203 inch face · Threads the full 0.53 inch');
    // Its exact end is the whole face; a tenth short of it is partial.
    const dragged = { ...CTX, units: 'inch' as const, touched: ['length'] };
    const at = (length: number) => {
      const values = initialValues({ length, offset: 0 });
      return threadIsPartial(hole, values, numbersOf(values), dragged);
    };
    expect(at(0.53)).toBe(false);
    expect(at(0.5)).toBe(true);
    expect(
      threadSpec.refuseValue!('length', 0.6, { offset: 0 }, { faces: [hole] })
    ).toMatch(/at most 0.53/);
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
    expect(request.thread).toMatchObject({
      offset: 2,
      chamferEnd: true,
      runoutStart: true
    });
    expect(request.thread.chamferStart).toBeUndefined();
    expect(request.thread.length).toBeUndefined();
  });

  it('chamfers only the ends of the face a thread reaches', () => {
    const ends = (
      chamfer: string | undefined,
      from: 'start' | 'end',
      near: boolean,
      far: boolean
    ) => threadChamferedEnds(chamfer, from, { near, far });
    // The whole face: the ends asked for.
    expect(ends(undefined, 'start', true, true)).toEqual({
      start: true,
      end: true
    });
    expect(ends('end', 'end', true, true)).toEqual({ start: false, end: true });
    expect(ends('none', 'start', true, true)).toEqual({
      start: false,
      end: false
    });
    // Stopped short: only the end it starts from, where that one is asked.
    expect(ends('both', 'start', true, false)).toEqual({
      start: true,
      end: false
    });
    expect(ends('both', 'end', true, false)).toEqual({
      start: false,
      end: true
    });
    expect(ends('end', 'start', true, false)).toEqual({
      start: false,
      end: false
    });
    // Set off from its starting end: only the far one, where it reaches it.
    expect(ends('both', 'start', false, true)).toEqual({
      start: false,
      end: true
    });
    expect(ends('both', 'end', false, false)).toEqual({
      start: false,
      end: false
    });
  });

  it('reads where a span reaches from its resolved offset and length, not how the length is stored (review #1390)', () => {
    const face = { length: 8, radius: 3 };
    const reach = (
      held: boolean,
      offset: number | undefined,
      length: number | undefined
    ) => threadReach({ held, offset, length, face });
    // A length that follows the offset reaches the far end by construction.
    expect(reach(false, 0, 8)).toEqual({ near: true, far: true });
    expect(reach(false, 2, undefined)).toEqual({ near: false, far: true });
    // A held length reaches the far end where its span does, within the
    // kernel's snap (1e-9 of the larger of the face's length and radius).
    expect(reach(true, 0, 8)).toEqual({ near: true, far: true });
    expect(reach(true, 2, 6)).toEqual({ near: false, far: true });
    expect(reach(true, 0, 8 - 1e-12)).toEqual({ near: true, far: true });
    expect(reach(true, 1e-12, 8)).toEqual({ near: true, far: true });
    expect(reach(true, 0, 8 - 1e-6)).toEqual({ near: true, far: false });
    expect(reach(true, 1e-6, 5)).toEqual({ near: false, far: false });
    expect(reach(true, 0, 5)).toEqual({ near: true, far: false });
    // The radius sets the slack on a face shorter than it is wide.
    expect(
      threadReach({
        held: true,
        offset: 0,
        length: 1 - 5e-9,
        face: { length: 1, radius: 20 }
      }).far
    ).toBe(true);
    // What does not resolve reaches nothing it is not known to, and is not
    // known to stop short either, so it takes no runout (schema v57).
    expect(reach(true, undefined, 8)).toEqual({
      near: false,
      far: false,
      nearUnknown: true,
      farUnknown: true
    });
    expect(reach(true, 0, undefined)).toEqual({
      near: true,
      far: false,
      farUnknown: true
    });
    expect(
      threadReach({ held: true, offset: 0, length: 8, face: null })
    ).toEqual({ near: true, far: false, farUnknown: true });
    expect(
      threadEndFinishes('both', 'start', {
        near: false,
        far: false,
        nearUnknown: true,
        farUnknown: true
      })
    ).toEqual({});
    expect(
      threadEndFinishes('both', 'end', { near: true, far: false })
    ).toEqual({ start: 'runout', end: 'chamfer' });
    expect(
      threadReach({ held: false, offset: 0, length: 8, face: null })
    ).toEqual({ near: true, far: true });
  });

  // The boss, and the same one with its axis running down from the top.
  const FLIPPED: FacePick = {
    ...BOSS,
    cylinder: {
      axisStart: { x: 0, y: 0, z: 12 },
      axisEnd: { x: 0, y: 0, z: 0 },
      radius: 3
    }
  };
  // Clicked near the face's start, then near its end; z is the click.
  const PICKS = [
    { name: 'from the start', boss: BOSS, z: 2, from: 'start' as const },
    { name: 'from the end', boss: BOSS, z: 10, from: 'end' as const },
    {
      name: 'flipped, from the start',
      boss: FLIPPED,
      z: 10,
      from: 'start' as const
    },
    { name: 'flipped, from the end', boss: FLIPPED, z: 2, from: 'end' as const }
  ];

  it.each(PICKS)(
    'chamfers both ends of an expression length that runs the whole face: $name (review #1390)',
    ({ boss, z, from }) => {
      const values = initialValues({ length: 'face', offset: 0 });
      const numbers = {
        ...numbersOf(initialValues({ offset: 0 })),
        length: 12
      };
      const ctx = { ...CTX, touched: ['length'] };
      const face = { ...boss, point: { x: 3, y: 0, z } };
      expect(threadIsPartial(face, values, numbers, ctx)).toBe(true);
      const { thread } = threadSpec.request(
        { ...SLOTS, faces: [face] },
        values,
        defaults(),
        ctx,
        numbers
      ) as { thread: ThreadRequest };
      // Stored as written, and chamfered at both ends it reaches.
      expect(thread).toMatchObject({
        length: 'face',
        chamferStart: true,
        chamferEnd: true
      });
      expect(thread.anchor).toBe(from === 'end' ? 'end' : undefined);
      expect(
        threadSummary(
          {
            ...inPlacePanelState(threadSpec, {}, numbers),
            raws: { length: 'face' }
          },
          'mm',
          { faces: [face] },
          { touched: ['length'], raws: { length: 'face' } }
        )
      ).toBe('Sized from the Ø6 mm face · Threads the full 12 mm');
    }
  );

  it.each(PICKS)(
    'chamfers the far end an offset expression length reaches: $name (review #1390)',
    ({ boss, z, from }) => {
      const values = initialValues({ length: 'rest', offset: 2 });
      const numbers = {
        ...numbersOf(initialValues({ offset: 2 })),
        length: 10
      };
      const ctx = { ...CTX, touched: ['length', 'offset'] };
      const face = { ...boss, point: { x: 3, y: 0, z } };
      const { thread } = threadSpec.request(
        { ...SLOTS, faces: [face] },
        values,
        defaults(),
        ctx,
        numbers
      ) as { thread: ThreadRequest };
      expect(thread).toMatchObject({ length: 'rest', offset: 2 });
      // Set off from where it starts, it reaches only the other end.
      expect([thread.chamferStart, thread.chamferEnd]).toEqual(
        from === 'start' ? [undefined, true] : [true, undefined]
      );
      // One that stops 1 short of it reaches neither.
      const short = threadSpec.request(
        { ...SLOTS, faces: [face] },
        values,
        defaults(),
        ctx,
        { ...numbers, length: 9 }
      ) as { thread: ThreadRequest };
      expect(short.thread.chamferStart).toBeUndefined();
      expect(short.thread.chamferEnd).toBeUndefined();
      expect(
        threadSummary(
          {
            ...inPlacePanelState(threadSpec, {}, numbers),
            raws: { length: 'rest' }
          },
          'mm',
          { faces: [face] },
          { touched: ['length', 'offset'], raws: { length: 'rest' } }
        )
      ).toBe('Sized from the Ø6 mm face · To end · Threads 10 of 12 mm');
    }
  );

  it.each(
    [
      { name: 'a number', length: 12 as ParamValue },
      { name: 'an expression', length: 'face' as ParamValue }
    ].flatMap((stored) =>
      [BOSS, FLIPPED].flatMap((boss) =>
        ([undefined, 'start', 'end'] as const).map((anchor) => ({
          ...stored,
          boss,
          anchor,
          label: [
            stored.name,
            boss === BOSS ? 'axis up' : 'axis down',
            'anchor ' + (anchor ?? 'absent')
          ].join(', ')
        }))
      )
    )
  )(
    'writes back both chamfers of a stored length that runs the whole face, edited untouched: $label (review #1390)',
    ({ length, boss, anchor }) => {
      const saved = {
        featureKind: 'thread' as const,
        targetBodyId: 'body_a' as BodyId,
        faceHash: 9,
        profile: 'printable' as const,
        clearance: 0.1,
        length,
        ...(anchor ? { anchor } : {}),
        chamferStart: true,
        chamferEnd: true
      };
      const values = initialValues({ length });
      const numbers = { ...numbersOf(initialValues()), length: 12 };
      const ctx = { ...CTX, saved, touched: ['length'] };
      expect(threadIsPartial(boss, values, numbers, ctx)).toBe(true);
      const { featureKind: _kind, ...fields } = saved;
      expect(
        threadSpec.request(
          { ...SLOTS, faces: [boss] },
          values,
          threadEditOptions(saved, evaluate, 'mm'),
          ctx,
          numbers
        )
      ).toEqual({ tool: 'thread', thread: fields });
    }
  );

  it('writes back the far chamfer of a stored offset span that reaches the far end (review #1390)', () => {
    for (const anchor of ['start', 'end'] as const) {
      const saved = {
        featureKind: 'thread' as const,
        targetBodyId: 'body_a' as BodyId,
        faceHash: 9,
        profile: 'printable' as const,
        clearance: 0.1,
        length: 10,
        offset: 2,
        anchor,
        ...(anchor === 'start' ? { chamferEnd: true } : { chamferStart: true })
      };
      const values = initialValues({ length: 10, offset: 2 });
      const ctx = { ...CTX, saved, touched: ['length', 'offset'] };
      const { featureKind: _kind, ...fields } = saved;
      expect(
        threadSpec.request(
          { ...SLOTS, faces: [BOSS] },
          values,
          threadEditOptions(saved, evaluate, 'mm'),
          ctx,
          numbersOf(values)
        )
      ).toEqual({ tool: 'thread', thread: fields });
    }
  });

  it('keeps a partial thread’s chamfer where it starts, from either end', () => {
    const dragged = { ...CTX, touched: ['length'] };
    const short = initialValues({ length: 8, offset: 0, chamferAngleDeg: 30 });
    const request = (z: number, chamfer: string) =>
      (
        threadSpec.request(
          { ...SLOTS, faces: [{ ...BOSS, point: { x: 3, y: 0, z } }] },
          short,
          defaults({ chamfer }),
          dragged,
          numbersOf(short)
        ) as { thread: ThreadRequest }
      ).thread;
    // Picked near the bottom: the face's start.
    expect(request(2, 'both')).toMatchObject({
      length: 8,
      chamferStart: true,
      chamferAngleDeg: 30
    });
    expect(request(2, 'both').chamferEnd).toBeUndefined();
    expect(request(2, 'both').runoutEnd).toBe(true);
    expect(request(2, 'both').anchor).toBeUndefined();
    // Picked near the top: the face's end.
    expect(request(10, 'both')).toMatchObject({
      length: 8,
      anchor: 'end',
      chamferEnd: true,
      chamferAngleDeg: 30
    });
    expect(request(10, 'both').chamferStart).toBeUndefined();
    expect(request(10, 'both').runoutStart).toBe(true);
    // Asked only for the end it stops short of, it runs out there alone.
    const runout = request(2, 'end');
    expect(runout.chamferStart).toBeUndefined();
    expect(runout.chamferEnd).toBeUndefined();
    expect(runout.runoutStart).toBeUndefined();
    expect(runout).toMatchObject({ runoutEnd: true, chamferAngleDeg: 30 });
    // Asked for none, it has none, nor an angle.
    const plain = request(2, 'none');
    expect(plain.runoutEnd).toBeUndefined();
    expect(plain.chamferAngleDeg).toBeUndefined();
  });

  it('reads a partial thread’s kept chamfer back and writes it unchanged', () => {
    const saved = {
      featureKind: 'thread' as const,
      targetBodyId: 'body_a' as BodyId,
      faceHash: 9,
      profile: 'printable' as const,
      clearance: 0.1,
      length: 8,
      anchor: 'end' as const,
      chamferEnd: true
    };
    const options = threadEditOptions(saved, evaluate, 'mm');
    expect(options.chamfer).toBe('end');
    const values = initialValues({ length: 8 });
    const ctx = { ...CTX, saved, touched: ['length'] };
    const { featureKind: _kind, ...fields } = saved;
    expect(
      threadSpec.request(
        { ...SLOTS, faces: [BOSS] },
        values,
        options,
        ctx,
        numbersOf(values)
      )
    ).toEqual({ tool: 'thread', thread: fields });
    expect(
      threadSummary(
        inPlacePanelState(threadSpec, options, { length: 8 }),
        'mm',
        { faces: [BOSS] },
        { touched: ['length'], saved }
      )
    ).toBe(
      'Sized from the Ø6 mm face · Threads 8 of 12 mm, plain where it stops'
    );
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
    ).toBe('Threads 8 of 12 mm, runs out where it stops · Ends 30°');
    // Finished only where it starts, it stops plain; finished nowhere, both
    // ends are plain.
    expect(
      threadSummary(
        inPlacePanelState(
          threadSpec,
          { size: 'M8', chamfer: 'end' },
          { length: 8, chamferAngleDeg: 30 }
        ),
        'mm',
        slots
      )
    ).toBe('Threads 8 of 12 mm, plain where it stops · Ends 30°');
    expect(
      threadSummary(
        inPlacePanelState(
          threadSpec,
          { size: 'M8', chamfer: 'none' },
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
    ).toBe('Sized from the Ø6 mm face · To end · Threads 10 of 12 mm');
    expect(
      threadSummary(
        inPlacePanelState(threadSpec, {}, { length: 10, offset: 2 }),
        'mm',
        slots,
        {
          touched: ['length', 'offset'],
          saved: {
            featureKind: 'thread',
            targetBodyId: BOSS.bodyId,
            faceHash: BOSS.hash,
            profile: 'printable',
            length: 10,
            offset: 2
          }
        }
      )
    ).toBe('Sized from the Ø6 mm face · To end · Threads 10 of 12 mm');
    // The same stored span one short of the far end runs out there.
    expect(
      threadSummary(
        inPlacePanelState(threadSpec, {}, { length: 9, offset: 2 }),
        'mm',
        slots,
        {
          touched: ['length', 'offset'],
          saved: {
            featureKind: 'thread',
            targetBodyId: BOSS.bodyId,
            faceHash: BOSS.hash,
            profile: 'printable',
            length: 9,
            offset: 2
          }
        }
      )
    ).toBe(
      'Sized from the Ø6 mm face · Threads 9 of 12 mm, runs out where it stops'
    );
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

  it('writes a stored starting end back as stored, and none where none was', () => {
    const base = {
      featureKind: 'thread' as const,
      targetBodyId: 'body_a' as BodyId,
      faceHash: 9,
      profile: 'printable' as const,
      clearance: 0.1,
      chamferStart: true,
      chamferEnd: true
    };
    const values = initialValues({ length: 12 });
    const cases: ThreadRequest[] = [
      base,
      { ...base, anchor: 'start' as const },
      { ...base, anchor: 'end' as const }
    ].map(({ featureKind: _kind, ...fields }) => fields);
    for (const fields of cases) {
      const saved = { featureKind: 'thread' as const, ...fields };
      expect(
        threadSpec.request(
          { ...SLOTS, faces: [BOSS] },
          values,
          threadEditOptions(saved, evaluate, 'mm'),
          { ...CTX, saved, touched: [] },
          numbersOf(values)
        )
      ).toEqual({ tool: 'thread', thread: fields });
    }
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

describe('in-place pipe threads (schema v57)', () => {
  // A 1/4 NPT pipe, 30 long up +Z, clicked near its top.
  const radius = (0.54 * 25.4) / 2;
  const pipe: FacePick = {
    ...BOSS,
    point: { x: radius, y: 0, z: 28 },
    cylinder: {
      axisStart: { x: 0, y: 0, z: 0 },
      axisEnd: { x: 0, y: 0, z: 30 },
      radius,
      boss: true
    }
  };
  const slots = { ...SLOTS, faces: [pipe] };
  // On its nominal pipe the crest meets the boss short of L2.
  const reach = (0.2278 + 16 * (0.54 - 0.49163 - 0.8 / 18)) * 25.4;

  it('runs the standard length, stopping where the crest meets the boss', () => {
    const numbers = numbersOf(initialValues());
    const pipeDefaults = threadSpec.defaults!(slots, CTX, numbers, {
      ...defaults(),
      profile: 'npt'
    });
    expect(pipeDefaults.length).toBeCloseTo(reach, 9);
    // A bore 30 long of Ø10.5 takes Rc 1/4 and its useful 9.7.
    const bore: FacePick = {
      ...pipe,
      point: { x: 5.25, y: 0, z: 28 },
      cylinder: { ...pipe.cylinder!, radius: 5.25, boss: false }
    };
    expect(
      threadSpec.defaults!({ ...SLOTS, faces: [bore] }, CTX, numbers, {
        ...defaults(),
        profile: 'bspt'
      }).length
    ).toBeCloseTo(9.7, 9);
    // Not a pipe thread: the rest of the face.
    expect(threadSpec.defaults!(slots, CTX, numbers, defaults()).length).toBe(
      30
    );
  });

  it('keeps an untouched pipe length to the pipe rule as the offset moves (review #1458)', () => {
    const values = { ...numbersOf(initialValues()), length: reach, offset: 0 };
    const context = {
      touched: ['offset'],
      options: { ...defaults(), profile: 'npt' },
      units: 'mm' as const
    };
    // Set off 1 from the fitting end, the band still ends where the crest
    // meets the boss: 1 shorter, not the rest of the 30 mm face.
    const carried = threadSpec.carries!('offset', 1, values, slots, context);
    expect(carried?.length).toBeCloseTo(reach - 1, 9);
    expect(
      threadSpec.defaults!(
        slots,
        CTX,
        { ...values, offset: 1 },
        context.options
      ).length
    ).toBeCloseTo(reach - 1, 9);
    // A length the user set stays as set.
    expect(
      threadSpec.carries!('offset', 1, values, slots, {
        ...context,
        touched: ['offset', 'length']
      })
    ).toBeNull();
    // Any other profile still runs to the face's far end.
    expect(
      threadSpec.carries!('offset', 1, values, slots, {
        ...context,
        options: defaults()
      })
    ).toEqual({ length: 29 });
  });

  it('keeps a length the user set to the face end when the offset moves (review #1458 re-check)', () => {
    // NPT 1/4 on a Ø15.4 × 30 boss, Exact fit: Length typed to 30, then
    // Offset 1. The typed length follows the face's end (29), as any span's
    // does; it does not snap back to the standard's 9.206.
    const boss: FacePick = {
      ...pipe,
      point: { x: 7.7, y: 0, z: 28 },
      cylinder: { ...pipe.cylinder!, radius: 7.7 }
    };
    const bossSlots = { ...SLOTS, faces: [boss] };
    const options = { ...defaults(), profile: 'npt', pipeSize: '1/4' };
    const values = { ...numbersOf(initialValues()), length: 30, offset: 0 };
    expect(
      threadSpec.carries!('offset', 1, values, bossSlots, {
        touched: ['length', 'offset'],
        options,
        units: 'mm'
      })
    ).toEqual({ length: 29 });
    // Untouched, it still follows the pipe rule.
    const standard = 0.4018 * 25.4;
    expect(
      threadSpec.carries!(
        'offset',
        1,
        { ...values, length: standard },
        bossSlots,
        { touched: ['offset'], options, units: 'mm' }
      )?.length
    ).toBeCloseTo(standard - 1, 9);
  });

  it('stores the profile, its length and no clearance, and runs out where it stops', () => {
    const values = initialValues({ length: reach, offset: 0 });
    const request = threadSpec.request(
      slots,
      values,
      defaults({ profile: 'npt' }),
      CTX,
      numbersOf(values)
    ) as { thread: ThreadRequest };
    expect(request.thread).toEqual({
      targetBodyId: 'body_a',
      faceHash: 9,
      profile: 'npt',
      length: reach,
      anchor: 'end',
      chamferEnd: true,
      runoutStart: true
    });
    // A chosen size and a printed fit are stored, and read back as chosen.
    const sized = threadSpec.request(
      slots,
      values,
      defaults({ profile: 'bspt', pipeSize: '1/4', pipeFit: 'print' }),
      CTX,
      numbersOf(values)
    ) as { thread: ThreadRequest };
    expect(sized.thread).toMatchObject({
      profile: 'bspt',
      pipeSize: '1/4',
      clearance: 0.1
    });
    expect(sized.thread.majorDiameter).toBeUndefined();
    const read = threadEditOptions(sized.thread, evaluate, 'mm');
    expect(read).toMatchObject({
      profile: 'bspt',
      pipeSize: '1/4',
      pipeFit: 'print',
      chamfer: 'both'
    });
    expect(read.size).toBeUndefined();
  });

  it('shows the pipe rows in place of the ISO ones and names the size', () => {
    const state = inPlacePanelState(threadSpec, { profile: 'npt' }, {});
    const shown = (id: string) =>
      (threadSpec.options ?? []).find((option) => option.id === id)!.when!(
        state
      );
    expect([shown('size'), shown('fit')]).toEqual([false, false]);
    expect([shown('pipeSize'), shown('pipeFit')]).toEqual([true, true]);
    expect(
      threadSpec.values.find((value) => value.id === 'majorDiameter')!.when!({
        ...state,
        options: { ...state.options, size: 'custom' }
      })
    ).toBe(false);
    expect(
      threadSummary(
        inPlacePanelState(threadSpec, { profile: 'npt' }, { length: reach }),
        'mm',
        { faces: [pipe] }
      )
    ).toBe(
      `1/4-18 NPT from the Ø13.716 mm face · Threads ${Math.round(reach * 1000) / 1000} of 30 mm, runs out where it stops`
    );
    // An edit not clicked again reads its side from the mesh too.
    const { point: _point, ...unclicked } = pipe;
    expect(
      threadSummary(
        inPlacePanelState(threadSpec, { profile: 'bspt' }, { length: 9 }),
        'mm',
        { faces: [unclicked] }
      )
    ).toMatch(/^R 1\/4 from the Ø13.716 mm face · /);
    // Where the mesh could not say, the build sizes it and the summary does
    // not guess.
    const { boss: _boss, ...unknown } = pipe.cylinder!;
    expect(
      threadSummary(
        inPlacePanelState(threadSpec, { profile: 'bspt' }, { length: 9 }),
        'mm',
        { faces: [{ ...pipe, cylinder: unknown }] }
      )
    ).toMatch(/^Sized from the Ø13.716 mm face · /);
  });
});

describe('in-place thread edits keep a stored end kind (review #1458)', () => {
  // A runout stored at the face's start, where the span begins (a thread
  // against a shoulder), on the Ø6 × 12 boss. The panel's reach rule would
  // chamfer that end; an edit that leaves the extent as stored keeps it.
  const stored = (
    fields: Partial<ThreadRequest> = {}
  ): Extract<FeatureData, { featureKind: 'thread' }> => ({
    featureKind: 'thread',
    targetBodyId: 'body_a' as BodyId,
    faceHash: 9,
    profile: 'iso-metric',
    length: 5,
    runoutStart: true,
    ...fields
  });
  const finish = (
    saved: Extract<FeatureData, { featureKind: 'thread' }>,
    changes: {
      options?: Record<string, string>;
      values?: Record<string, ParamValue>;
      units?: 'mm' | 'inch';
    } = {}
  ) => {
    const units = changes.units ?? 'mm';
    const values = {
      ...initialValues({
        length: saved.length ?? 12,
        offset: saved.offset ?? 0
      }),
      ...(changes.values ?? {})
    };
    const options = {
      ...defaults(),
      ...threadEditOptions(saved, evaluate, units),
      ...(changes.options ?? {})
    };
    const ctx = {
      ...CTX,
      saved,
      units,
      touched: ['length', 'offset', ...Object.keys(changes.values ?? {})]
    };
    return (
      threadSpec.request(
        { ...SLOTS, faces: [BOSS] },
        values,
        options,
        ctx,
        numbersOf(values)
      ) as { thread: ThreadRequest }
    ).thread;
  };

  it('keeps the runout with an explicit zero offset, which the request leaves out', () => {
    const thread = finish(stored({ offset: 0 }));
    expect(thread.runoutStart).toBe(true);
    expect(thread.chamferStart).toBeUndefined();
    expect(thread.offset).toBeUndefined();
  });

  it('keeps it through a profile-, pitch- or fit-only edit', () => {
    const edits: Record<string, string>[] = [
      { profile: 'printable' },
      { profile: 'custom' },
      { size: 'M8' },
      { fit: 'loose' }
    ];
    for (const options of edits) {
      const thread = finish(stored({ offset: 0 }), { options });
      expect(thread.runoutStart, JSON.stringify(options)).toBe(true);
      expect(thread.chamferStart, JSON.stringify(options)).toBeUndefined();
    }
  });

  it('keeps it in an inch document with a typed length equal to the stored one', () => {
    const inch = stored({ length: 5 / 25.4, offset: 0 });
    // Typed again, the same length comes back off by a rounding step from
    // its unit conversion.
    const typed = 5 / 25.4 + 1e-15;
    expect(typed).not.toBe(5 / 25.4);
    const thread = finish(inch, { units: 'inch', values: { length: typed } });
    expect(thread.runoutStart).toBe(true);
    expect(thread.chamferStart).toBeUndefined();
  });

  it('keeps it on a stored whole-face span whose length is written out', () => {
    const thread = finish(stored({ length: 12 }));
    expect(thread.runoutStart).toBe(true);
    expect(thread.chamferStart).toBeUndefined();
  });

  it('lets the reach decide again once the extent is edited', () => {
    const shorter = finish(stored({ offset: 0 }), { values: { length: 4 } });
    expect(shorter.chamferStart).toBe(true);
    expect(shorter.runoutStart).toBeUndefined();
    const setOff = finish(stored(), { values: { offset: 1 } });
    // Set off from the start, that end stops short: a runout by the reach.
    expect(setOff.runoutStart).toBe(true);
  });
});
