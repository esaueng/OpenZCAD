import { describe, expect, it } from 'vitest';
import {
  inPlacePanelSections,
  inPlacePanelState,
  inPlaceValueStep,
  type InPlacePanelSectionView
} from './panel';
import {
  IN_PLACE_TOOL_SPECS,
  gearModuleOf,
  gearPitchValueId,
  type InPlaceContext,
  type InPlaceSlots
} from './tools';

const CTX: InPlaceContext = {
  sketchViews: [],
  datumAxes: {},
  datumLabel: () => '',
  linearSnap: null
};

const ON_XY: InPlaceSlots = {
  profiles: [],
  axis: null,
  path: [],
  guide: [],
  faces: [],
  bodies: [],
  plane: {
    kind: 'principal',
    plane: 'XY',
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 }
  },
  edges: [],
  refs: [],
  image: null
};

/** Every row's id (a point's fields each), section by section. */
function rowIds(sections: readonly InPlacePanelSectionView[]): string[][] {
  return sections.map((section) =>
    section.rows.flatMap((row) => (row.kind === 'vector' ? row.ids : [row.id]))
  );
}

/** The Gear command's panel rows for these choices and values. */
function gearPanel(
  options: Record<string, string>,
  values: Record<string, number> = {}
) {
  const spec = IN_PLACE_TOOL_SPECS.gear;
  const state = inPlacePanelState(spec, options, values);
  const handled = new Set(
    spec.handles(ON_XY, state.numbers, CTX, state.options).map((h) => h.valueId)
  );
  return inPlacePanelSections(spec, state, handled);
}

describe('in-place Options panel', () => {
  it('shows a spur gear only what a spur gear has', () => {
    const ids = rowIds(gearPanel({})).flat();
    expect(ids).toEqual([
      'gearType',
      'teeth',
      'sizing',
      'module',
      'faceWidth',
      'boreDiameter',
      'helixAngleDeg',
      'pressureAngleDeg',
      'profileShift',
      'backlash',
      'phaseDeg'
    ]);
    // No hand or herringbone until the teeth twist, and no other type's rows.
    for (const absent of [
      'hand',
      'helix',
      'circularPitch',
      'diametralPitch',
      'rimDiameter',
      'mateTeeth',
      'starts'
    ]) {
      expect(ids).not.toContain(absent);
    }
  });

  it('offers the hand and herringbone once a helix angle is set', () => {
    const ids = rowIds(gearPanel({}, { helixAngleDeg: 15 })).flat();
    expect(ids).toEqual(
      expect.arrayContaining(['helixAngleDeg', 'hand', 'helix'])
    );
  });

  it('shows each gear type its own rows', () => {
    const bevel = rowIds(gearPanel({ gearType: 'bevel' })).flat();
    expect(bevel).toEqual(
      expect.arrayContaining(['mateTeeth', 'shaftAngleDeg', 'boreDiameter'])
    );
    // A straight bevel has no helix and no shift.
    expect(bevel).not.toContain('helixAngleDeg');
    expect(bevel).not.toContain('profileShift');

    const ring = rowIds(gearPanel({ gearType: 'internal' })).flat();
    expect(ring).toContain('rimDiameter');
    expect(ring).not.toContain('boreDiameter');

    // A worm counts starts, not teeth, and its thread sets its hand.
    const worm = rowIds(gearPanel({ gearType: 'worm' })).flat();
    expect(worm).toEqual(
      expect.arrayContaining(['starts', 'diameterFactor', 'hand'])
    );
    expect(worm).not.toContain('teeth');
    expect(worm).not.toContain('helixAngleDeg');
    expect(worm).not.toContain('helix');
  });

  it('shows the pitch the sizing reads, and only that one', () => {
    for (const [sizing, id] of [
      ['module', 'module'],
      ['circular-pitch', 'circularPitch'],
      ['diametral-pitch', 'diametralPitch']
    ] as const) {
      const ids = rowIds(gearPanel({ sizing })).flat();
      expect(ids).toContain(id);
      expect(
        ['module', 'circularPitch', 'diametralPitch'].filter((pitch) =>
          ids.includes(pitch)
        )
      ).toEqual([id]);
    }
  });

  it('folds the tooth form away and drops empty groups', () => {
    const sections = gearPanel({});
    expect(sections.map((section) => section.label)).toEqual([
      undefined,
      'Hub',
      'Helix',
      'Tooth form'
    ]);
    expect(sections.find((s) => s.label === 'Tooth form')?.collapsed).toBe(
      true
    );
  });

  it('gives gear teeth kept to the face no sizing to choose', () => {
    const spec = IN_PLACE_TOOL_SPECS['gear-teeth'];
    const keep = inPlacePanelState(spec, {}, {});
    const kept = rowIds(
      inPlacePanelSections(spec, keep, new Set(['teeth']))
    ).flat();
    expect(kept).toContain('teeth');
    expect(kept).not.toContain('sizing');
    expect(kept).not.toContain('module');
    // Set by module, the sizing and its pitch chip come back.
    const byModule = inPlacePanelState(spec, { fit: 'module' }, {});
    const set = rowIds(
      inPlacePanelSections(spec, byModule, new Set(['teeth', 'module']))
    ).flat();
    expect(set).toEqual(expect.arrayContaining(['sizing', 'module']));
  });

  it('lists every gear option and value in its layout', () => {
    for (const tool of ['gear', 'gear-teeth'] as const) {
      const spec = IN_PLACE_TOOL_SPECS[tool];
      const placed = new Set(spec.layout!.flatMap((s) => s.items));
      for (const option of spec.options ?? []) {
        expect(placed.has(option.id), `${tool} ${option.id}`).toBe(true);
      }
      for (const value of spec.values) {
        expect(placed.has(value.id), `${tool} ${value.id}`).toBe(true);
      }
    }
  });

  it('puts a point’s coordinates on one row', () => {
    const spec = IN_PLACE_TOOL_SPECS.box;
    const state = inPlacePanelState(spec, {}, {});
    const sections = inPlacePanelSections(
      spec,
      state,
      new Set(['width', 'depth', 'height'])
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]!.rows).toEqual([
      { kind: 'value', id: 'width' },
      { kind: 'value', id: 'depth' },
      { kind: 'value', id: 'height' },
      {
        kind: 'vector',
        label: 'Corner',
        ids: ['x', 'y', 'z'],
        axes: ['X', 'Y', 'Z']
      }
    ]);
  });

  it('lists a handle’s value only while its handle stands', () => {
    const spec = IN_PLACE_TOOL_SPECS.fillet;
    const state = inPlacePanelState(spec, {}, {});
    expect(rowIds(inPlacePanelSections(spec, state, new Set())).flat()).toEqual(
      ['law']
    );
    expect(
      rowIds(inPlacePanelSections(spec, state, new Set(['radius']))).flat()
    ).toEqual(['law', 'radius']);
  });

  it('leaves out the options an edit has locked', () => {
    const spec = IN_PLACE_TOOL_SPECS.gear;
    const state = inPlacePanelState(spec, {}, {});
    const ids = rowIds(
      inPlacePanelSections(spec, state, new Set(), ['sizing'])
    ).flat();
    expect(ids).not.toContain('gearType');
    expect(ids).toContain('sizing');
  });

  it('steps fine values finely and counts by one', () => {
    const values = IN_PLACE_TOOL_SPECS.gear.values;
    const of = (id: string) => values.find((value) => value.id === id)!;
    expect(inPlaceValueStep(of('teeth'), 20)).toBe(1);
    expect(inPlaceValueStep(of('module'), 2)).toBe(0.1);
    expect(inPlaceValueStep(of('faceWidth'), 12)).toBe(1);
    expect(inPlaceValueStep(of('pressureAngleDeg'), 20)).toBe(1);
    expect(inPlaceValueStep(of('profileShift'), 0)).toBe(0.05);
  });
});

describe('gear sizing', () => {
  it('reads the module from whichever pitch it is sized by', () => {
    expect(gearModuleOf({}, { module: 2 })).toBe(2);
    expect(
      gearModuleOf({ sizing: 'circular-pitch' }, { circularPitch: 3 * Math.PI })
    ).toBeCloseTo(3);
    // Teeth per inch in every unit system.
    expect(
      gearModuleOf({ sizing: 'diametral-pitch' }, { diametralPitch: 12.7 })
    ).toBeCloseTo(2);
    expect(
      gearModuleOf(
        { sizing: 'diametral-pitch' },
        { diametralPitch: 10 },
        'inch'
      )
    ).toBeCloseTo(0.1);
  });

  it('keeps the tooth size when the sizing changes', () => {
    const spec = IN_PLACE_TOOL_SPECS.gear;
    const state = inPlacePanelState(spec, {}, { module: 2.5 });
    expect(spec.optionCarries!('sizing', 'circular-pitch', state, CTX)).toEqual(
      {
        circularPitch: { value: 2.5 * Math.PI, from: 'module' }
      }
    );
    const diametral = spec.optionCarries!(
      'sizing',
      'diametral-pitch',
      state,
      CTX
    );
    expect(diametral?.diametralPitch?.value).toBeCloseTo(25.4 / 2.5);
    // Another option, or the same sizing, carries nothing.
    expect(spec.optionCarries!('gearType', 'rack', state, CTX)).toBeNull();
    expect(spec.optionCarries!('sizing', 'module', state, CTX)).toBeNull();
  });

  it('defaults every pitch to the same tooth', () => {
    const values = IN_PLACE_TOOL_SPECS.gear.values;
    const initial = (id: string) =>
      values.find((value) => value.id === id)!.initial;
    expect(initial('circularPitch') / Math.PI).toBeCloseTo(initial('module'));
    expect(25.4 / initial('diametralPitch')).toBeCloseTo(initial('module'));
  });

  it('puts the chip on the pitch the sizing reads', () => {
    expect(gearPitchValueId({})).toBe('module');
    const spec = IN_PLACE_TOOL_SPECS.gear;
    for (const [sizing, id] of [
      ['circular-pitch', 'circularPitch'],
      ['diametral-pitch', 'diametralPitch']
    ] as const) {
      const ids = spec
        .handles(ON_XY, {}, CTX, { sizing })
        .map((handle) => handle.valueId);
      expect(ids).toContain(id);
      expect(ids).not.toContain('module');
    }
    // Gear teeth set by module: its pitch chip follows the sizing too.
    const teeth = IN_PLACE_TOOL_SPECS['gear-teeth'];
    const face = {
      bodyId: 'body_a',
      hash: 1,
      topologyId: 'f1',
      surfaceType: 'cylinder',
      point: { x: 0, y: 0, z: 0 }
    } as InPlaceSlots['faces'][number];
    const chips = teeth
      .handles({ ...ON_XY, faces: [face] }, {}, CTX, {
        fit: 'module',
        sizing: 'circular-pitch'
      })
      .map((handle) => handle.valueId);
    expect(chips).toEqual(['teeth', 'circularPitch']);
  });

  it('sizes the chips’ circle by the module the sizing gives', () => {
    const spec = IN_PLACE_TOOL_SPECS.gear;
    const reach = (
      options: Record<string, string>,
      values: Record<string, number>
    ) => {
      const chip = spec
        .handles(ON_XY, values, CTX, options)
        .find((handle) => handle.kind === 'chip' && handle.valueId === 'teeth');
      return chip?.kind === 'chip'
        ? Math.hypot(chip.params.anchor.x, chip.params.anchor.y)
        : NaN;
    };
    expect(
      reach({ sizing: 'diametral-pitch' }, { teeth: 20, diametralPitch: 12.7 })
    ).toBeCloseTo(reach({}, { teeth: 20, module: 2 }));
  });

  it('sums up what the sizing comes to', () => {
    const spec = IN_PLACE_TOOL_SPECS.gear;
    const summary = (
      options: Record<string, string>,
      values: Record<string, number> = {}
    ) => spec.summary!(inPlacePanelState(spec, options, values), 'mm');
    expect(summary({}, { teeth: 20, module: 2 })).toBe(
      'Module 2 mm · Pitch Ø 40 mm'
    );
    expect(
      summary(
        { sizing: 'diametral-pitch' },
        { teeth: 24, diametralPitch: 12.7 }
      )
    ).toBe('Module 2 mm · Pitch Ø 48 mm');
    expect(summary({ gearType: 'rack' }, { module: 1 })).toBe(
      'Module 1 mm · Pitch 3.142 mm'
    );
    expect(
      summary(
        { gearType: 'worm' },
        { module: 2, diameterFactor: 10, starts: 2 }
      )
    ).toBe('Module 2 mm · Pitch Ø 20 mm · Lead 12.566 mm');
    // How a helical gear's module reads is the kernel's, so no diameter.
    expect(summary({}, { module: 2, helixAngleDeg: 20 })).toBe('Module 2 mm');
    expect(
      IN_PLACE_TOOL_SPECS['gear-teeth'].summary!(
        inPlacePanelState(IN_PLACE_TOOL_SPECS['gear-teeth'], {}, {}),
        'mm'
      )
    ).toBeNull();
  });
});
