import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  gearBody,
  type GearInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { commandFactories } from '@openzcad/command-system';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';
import {
  defaultGearXDirection,
  gearModule
} from '../packages/kernel-adapter/src/exact-gear';

function newGear(
  overrides: Partial<GearInput> = {},
  units: UnitSystem = 'mm'
): { document: ProjectDocument; bodyId: BodyId } {
  return gearBody(createProjectDocument('Gear', toUserId('user_gear'), units), {
    name: 'Gear 1',
    gearType: 'external',
    sizing: 'module',
    pitch: 2,
    teeth: 20,
    faceWidth: 5,
    origin: { x: 0, y: 0, z: 0 },
    axis: { x: 0, y: 0, z: 1 },
    ...overrides
  });
}

describe('gear sizing helpers', () => {
  it('reads every sizing as a module in document units', () => {
    expect(gearModule('module', 2, 'mm')).toBe(2);
    expect(gearModule('circular-pitch', 2 * Math.PI, 'mm')).toBeCloseTo(2, 12);
    // A diametral pitch is per inch in every unit system.
    expect(gearModule('diametral-pitch', 10, 'inch')).toBeCloseTo(0.1, 12);
    expect(gearModule('diametral-pitch', 10, 'mm')).toBeCloseTo(2.54, 12);
    expect(gearModule('diametral-pitch', 10, 'cm')).toBeCloseTo(0.254, 12);
  });

  it('picks a reference direction perpendicular to any axis', () => {
    expect(defaultGearXDirection({ x: 0, y: 0, z: 3 })).toEqual({
      x: 1,
      y: 0,
      z: 0
    });
    for (const axis of [
      { x: 1, y: 0, z: 0 },
      { x: 1, y: 2, z: -0.5 },
      { x: -0.95, y: 0.1, z: 0.2 }
    ]) {
      const x = defaultGearXDirection(axis);
      expect(Math.hypot(x.x, x.y, x.z)).toBeCloseTo(1, 12);
      expect(x.x * axis.x + x.y * axis.y + x.z * axis.z).toBeCloseTo(0, 12);
    }
  });
});

describe('gear command validation', () => {
  const document = createProjectDocument('Gear', toUserId('user_gear'));
  const valid: GearInput = {
    name: 'Gear 1',
    gearType: 'external',
    sizing: 'module',
    pitch: 2,
    teeth: 20,
    faceWidth: 5,
    origin: { x: 0, y: 0, z: 0 },
    axis: { x: 0, y: 0, z: 1 }
  };

  it('accepts a complete new gear as one feature and one body', () => {
    const command = commandFactories.gearBody(valid);
    expect(() => command.validate(document)).not.toThrow();
    const next = command.apply(document);
    expect(next.bodyOrder).toHaveLength(1);
    const feature = Object.values(next.nodes).find(
      (node) => node.kind === 'feature'
    );
    expect(feature?.kind === 'feature' && feature.featureKind).toBe('gear');
    // A gear needs the v40 schema; an older client must refuse it.
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(40);
  });

  it('accepts a helical gear of either hand', () => {
    for (const hand of ['right', 'left'] as const) {
      expect(() =>
        commandFactories
          .gearBody({ ...valid, helixAngleDeg: 45, hand })
          .validate(document)
      ).not.toThrow();
    }
  });

  it('accepts a herringbone gear', () => {
    expect(() =>
      commandFactories
        .gearBody({ ...valid, helixAngleDeg: 30, herringbone: true })
        .validate(document)
    ).not.toThrow();
  });

  it('accepts a bevel gear, which needs the v41 schema', () => {
    const bevel: GearInput = {
      ...valid,
      gearType: 'bevel',
      mateTeeth: 40,
      shaftAngleDeg: 70,
      boreDiameter: 8
    };
    expect(() =>
      commandFactories.gearBody(bevel).validate(document)
    ).not.toThrow();
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(41);
  });

  it.each([
    ['bevel without a mate', {}],
    ['bevel with 3 teeth', { teeth: 3 }],
    ['bevel mate with 3 teeth', { mateTeeth: 3 }],
    ['fractional mate teeth', { mateTeeth: 40.5 }],
    ['shaft angle of 0°', { shaftAngleDeg: 0 }],
    ['shaft angle of 180°', { shaftAngleDeg: 180 }],
    ['bevel profile shift', { profileShift: 0.2 }],
    ['bevel root fillet', { rootFillet: 0.3 }],
    ['helical bevel', { helixAngleDeg: 10 }],
    ['bevel rim', { rimDiameter: 60 }],
    ['bevel fit', { fit: 'module' as const }]
  ])('refuses a %s', (label, overrides) => {
    const bevel: GearInput = {
      ...valid,
      gearType: 'bevel',
      ...(label === 'bevel without a mate' ? {} : { mateTeeth: 40 }),
      ...overrides
    };
    expect(() => commandFactories.gearBody(bevel).validate(document)).toThrow();
  });

  it('accepts a worm and its worm wheel, which need the v42 schema', () => {
    const worm: GearInput = {
      ...valid,
      gearType: 'worm',
      teeth: 2,
      diameterFactor: 10,
      faceWidth: 30,
      hand: 'left',
      rootFillet: 0.3,
      boreDiameter: 6
    };
    const wheel: GearInput = {
      ...valid,
      gearType: 'worm-wheel',
      teeth: 30,
      mateTeeth: 2,
      diameterFactor: 10,
      hand: 'left',
      boreDiameter: 12
    };
    for (const input of [worm, wheel]) {
      expect(() =>
        commandFactories.gearBody(input).validate(document)
      ).not.toThrow();
    }
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(42);
  });

  it.each([
    ['worm of 0 starts', { teeth: 0 }],
    ['worm of 11 starts', { teeth: 11 }],
    ['worm of 1.5 starts', { teeth: 1.5 }],
    ['worm without a diameter factor', { diameterFactor: undefined }],
    ['worm steeper than 45°', { teeth: 4, diameterFactor: 3.9 }],
    ['worm with a mate', { mateTeeth: 30 }],
    ['worm profile shift', { profileShift: 0.2 }],
    ['worm helix angle', { helixAngleDeg: 10 }],
    ['worm shaft angle', { shaftAngleDeg: 90 }],
    ['worm rim', { rimDiameter: 60 }],
    ['worm fit', { fit: 'module' as const }]
  ])('refuses a %s', (_label, overrides) => {
    const worm: GearInput = {
      ...valid,
      gearType: 'worm',
      teeth: 1,
      diameterFactor: 10,
      ...overrides
    };
    expect(() => commandFactories.gearBody(worm).validate(document)).toThrow();
  });

  it('accepts an enveloping worm, which needs the v44 schema', () => {
    const enveloping: GearInput = {
      ...valid,
      gearType: 'enveloping-worm',
      teeth: 2,
      mateTeeth: 40,
      diameterFactor: 10,
      faceWidth: 30,
      hand: 'left',
      backlash: 0.1,
      boreDiameter: 8
    };
    expect(() =>
      commandFactories.gearBody(enveloping).validate(document)
    ).not.toThrow();
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(44);
  });

  it.each([
    ['enveloping worm without its wheel', { mateTeeth: undefined }],
    ['enveloping worm of 11 starts', { teeth: 11 }],
    ['enveloping worm for a 9-tooth wheel', { mateTeeth: 9 }],
    ['enveloping worm of 6 starts on 11 teeth', { teeth: 6, mateTeeth: 11 }],
    [
      'enveloping worm without a diameter factor',
      { diameterFactor: undefined }
    ],
    ['enveloping worm profile shift', { profileShift: 0.2 }],
    ['enveloping worm root fillet', { rootFillet: 0.3 }],
    ['enveloping worm helix angle', { helixAngleDeg: 10 }],
    ['enveloping worm shaft angle', { shaftAngleDeg: 90 }],
    ['enveloping worm on a body', { fit: 'module' as const }],
    ['throated enveloping worm', { throated: true }]
  ])('refuses an %s', (_label, overrides) => {
    const enveloping: GearInput = {
      ...valid,
      gearType: 'enveloping-worm',
      teeth: 1,
      mateTeeth: 30,
      diameterFactor: 10,
      ...overrides
    };
    expect(() =>
      commandFactories.gearBody(enveloping).validate(document)
    ).toThrow();
  });

  it('accepts a throated worm wheel, which needs the v43 schema', () => {
    const wheel: GearInput = {
      ...valid,
      gearType: 'worm-wheel',
      teeth: 30,
      mateTeeth: 2,
      diameterFactor: 10,
      throated: true,
      outsideDiameter: 66
    };
    expect(() =>
      commandFactories.gearBody(wheel).validate(document)
    ).not.toThrow();
    expect(() =>
      commandFactories
        .gearBody({ ...wheel, outsideDiameter: undefined })
        .validate(document)
    ).not.toThrow();
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(43);
  });

  it.each([
    ['worm wheel without its worm', { mateTeeth: undefined }],
    ['worm wheel for 11 starts', { mateTeeth: 11 }],
    ['worm wheel of 2 teeth', { teeth: 2 }],
    ['worm wheel steeper than 45°', { mateTeeth: 4, diameterFactor: 3 }],
    ['worm wheel helix angle', { helixAngleDeg: 10 }],
    ['worm wheel on a body', { fit: 'module' as const }],
    ['worm wheel outside diameter unthroated', { outsideDiameter: 66 }],
    [
      'throated worm wheel of zero outside diameter',
      { throated: true, outsideDiameter: 0 }
    ],
    ['worm wheel throated by a string', { throated: 'yes' as never }]
  ])('refuses a %s', (_label, overrides) => {
    const wheel: GearInput = {
      ...valid,
      gearType: 'worm-wheel',
      mateTeeth: 1,
      diameterFactor: 10,
      ...overrides
    };
    expect(() => commandFactories.gearBody(wheel).validate(document)).toThrow();
  });

  it.each([
    ['fractional teeth', { teeth: 20.5 }],
    ['too few teeth', { teeth: 2 }],
    ['no pitch', { pitch: undefined }],
    ['zero face width', { faceWidth: 0 }],
    ['zero axis', { axis: { x: 0, y: 0, z: 0 } }],
    ['pressure angle out of range', { pressureAngleDeg: 50 }],
    ['negative backlash', { backlash: -0.1 }],
    ['internal without rim', { gearType: 'internal' as const }],
    ['bore on a rack', { gearType: 'rack' as const, boreDiameter: 3 }],
    ['rack phase', { gearType: 'rack' as const, phaseDeg: 5 }],
    ['helix above 45°', { helixAngleDeg: 46 }],
    ['negative helix', { helixAngleDeg: -5 }],
    ['helical rack', { gearType: 'rack' as const, helixAngleDeg: 10 }],
    ['unknown hand', { helixAngleDeg: 10, hand: 'up' as never }],
    ['herringbone spur', { herringbone: true }],
    ['herringbone at 0°', { helixAngleDeg: 0, herringbone: true }],
    [
      'herringbone rack',
      { gearType: 'rack' as const, helixAngleDeg: 10, herringbone: true }
    ],
    ['fit on a new body', { fit: 'module' as const }],
    ['mate teeth off a bevel gear', { mateTeeth: 40 }],
    ['shaft angle off a bevel gear', { shaftAngleDeg: 90 }],
    ['diameter factor off a worm gear', { diameterFactor: 10 }],
    ['throated spur gear', { throated: true }],
    ['outside diameter off a worm wheel', { outsideDiameter: 50 }]
  ])('refuses %s', (_label, overrides) => {
    expect(() =>
      commandFactories.gearBody({ ...valid, ...overrides }).validate(document)
    ).toThrow();
  });
});

describe('gear features on the exact kernel', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => adapter.dispose());

  it('builds a new spur gear and names every face from its roles', async () => {
    const gear = newGear();
    const derived = await adapter.syncDocument(gear.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[gear.bodyId]!;
    // Between the root and tip discs: r_f = 17.5, r_a = 22, width 5.
    expect(body.volume).toBeGreaterThan(Math.PI * 17.5 ** 2 * 5);
    expect(body.volume).toBeLessThan(Math.PI * 22 ** 2 * 5);
    const names = new Set(
      body.topology!.faces.map((face) => face.reference?.lineageName)
    );
    expect(names.has('gear.face.tooth[0].tip')).toBe(true);
    expect(names.has('gear.face.tooth[19].flank.plus')).toBe(true);
    expect(names.has('gear.face.root[7]')).toBe(true);
    expect(names.has('gear.face.cap.start')).toBe(true);
    expect(names.has(undefined)).toBe(false);
  });

  it('builds a helical gear on its transverse pitch circle', async () => {
    const beta = (20 * Math.PI) / 180;
    const right = newGear({ helixAngleDeg: 20 });
    const derived = await adapter.syncDocument(right.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[right.bodyId]!;
    // A normal module of 2: tip diameter 20·2/cos β + 2·2.
    const tip = (20 * 2) / Math.cos(beta) + 4;
    // The kernel's box over swept NURBS flanks is conservative, so this only
    // separates the transverse tip (46.57) from a normal-module one (44).
    const box = body.bbox;
    expect(Math.abs(box.max.x - box.min.x - tip)).toBeLessThan(0.05);
    const names = body.topology!.faces.map(
      (face) => face.reference?.lineageName
    );
    expect(names.filter((name) => name?.includes('.flank.'))).toHaveLength(40);
    // Mirrored hands sweep the same section: the same volume.
    const left = newGear({ helixAngleDeg: 20, hand: 'left' });
    const mirrored = (await adapter.syncDocument(left.document))
      .bodyRepresentations[left.bodyId]!;
    expect(mirrored.volume).toBeCloseTo(body.volume, 6);
  });

  it('builds a herringbone gear with both halves named', async () => {
    const herringbone = newGear({ helixAngleDeg: 20, herringbone: true });
    const derived = await adapter.syncDocument(herringbone.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[herringbone.bodyId]!;
    const names = body.topology!.faces.map(
      (face) => face.reference?.lineageName
    );
    expect(names).toContain('gear.face.tooth[0].flank.plus.start-half');
    expect(names).toContain('gear.face.tooth[0].flank.plus.end-half');
    expect(names.filter((name) => name?.includes('.flank.'))).toHaveLength(80);
    expect(new Set(names).size).toBe(names.length);
    // Every transverse section is the single helical gear's: same volume.
    const single = newGear({ helixAngleDeg: 20 });
    const helical = (await adapter.syncDocument(single.document))
      .bodyRepresentations[single.bodyId]!;
    expect(Math.abs(body.volume / helical.volume - 1)).toBeLessThan(1e-6);
  });

  it('builds a worm whose thread fills about half the annulus over its length', async () => {
    const worm = newGear({
      gearType: 'worm',
      teeth: 1,
      diameterFactor: 10,
      faceWidth: 24,
      hand: 'left',
      boreDiameter: 6
    });
    const derived = await adapter.syncDocument(worm.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.featureWarnings ?? []).toEqual([]);
    const body = derived.bodyRepresentations[worm.bodyId]!;
    // Reference diameter q·m = 20, tip 24, root 15; flat end caps.
    const box = body.bbox;
    expect(box.min.z).toBeCloseTo(0, 9);
    expect(box.max.z).toBeCloseTo(24, 9);
    // The kernel's box over swept NURBS lands is conservative.
    expect(Math.abs(box.max.x - box.min.x - 24)).toBeLessThan(0.1);
    // A solid core to the root circle (less the bore), and a thread whose
    // axial thickness is half the pitch at the reference cylinder: between
    // two fifths and three fifths of the annulus out to the tip.
    const core = Math.PI * (7.5 ** 2 - 3 ** 2) * 24;
    const annulus = Math.PI * (12 ** 2 - 7.5 ** 2) * 24;
    expect(body.volume).toBeGreaterThan(core + 0.4 * annulus);
    expect(body.volume).toBeLessThan(core + 0.6 * annulus);
    const names = body.topology!.faces.map(
      (face) => face.reference?.lineageName
    );
    for (const name of [
      'gear.face.cap.start',
      'gear.face.cap.end',
      'gear.face.bore',
      'gear.face.tooth[0].flank.plus',
      'gear.face.tooth[0].flank.minus',
      'gear.face.tooth[0].tip',
      'gear.face.root[0]'
    ]) {
      expect(names).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('builds the worm wheel at the worm’s axial module', async () => {
    const wheel = newGear({
      gearType: 'worm-wheel',
      teeth: 30,
      mateTeeth: 2,
      diameterFactor: 10,
      faceWidth: 12,
      hand: 'left',
      boreDiameter: 12
    });
    const derived = await adapter.syncDocument(wheel.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.featureWarnings ?? []).toEqual([]);
    const body = derived.bodyRepresentations[wheel.bodyId]!;
    // Transverse module m_x = 2: pitch diameter 60, tip 64, root 55.
    const box = body.bbox;
    expect(box.min.z).toBeCloseTo(0, 9);
    expect(box.max.z).toBeCloseTo(12, 9);
    expect(Math.abs(box.max.x - box.min.x - 64)).toBeLessThan(0.1);
    const bore = Math.PI * 36 * 12;
    expect(body.volume).toBeGreaterThan(Math.PI * 27.5 ** 2 * 12 - bore);
    expect(body.volume).toBeLessThan(Math.PI * 32 ** 2 * 12 - bore);
    const names = body.topology!.faces.map(
      (face) => face.reference?.lineageName
    );
    for (const name of [
      'gear.face.bore',
      'gear.face.tooth[29].flank.minus',
      'gear.face.root[0]'
    ]) {
      expect(names).toContain(name);
    }
  });

  it('builds a throated worm wheel whose tips wrap the worm', async () => {
    const throated = newGear({
      gearType: 'worm-wheel',
      teeth: 30,
      mateTeeth: 2,
      diameterFactor: 10,
      faceWidth: 12,
      hand: 'left',
      boreDiameter: 12,
      throated: true,
      outsideDiameter: 65
    });
    const derived = await adapter.syncDocument(throated.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.featureWarnings ?? []).toEqual([]);
    const body = derived.bodyRepresentations[throated.bodyId]!;
    // m_x 2, q 10: centre distance 40 and tip diameter 64. Half a module
    // past the tips keeps them wide enough; the kernel's default of a whole
    // module thins them to an advisory on this wheel.
    const box = body.bbox;
    expect(box.min.z).toBeCloseTo(0, 9);
    expect(box.max.z).toBeCloseTo(12, 9);
    expect(Math.abs(box.max.x - box.min.x - 65)).toBeLessThan(0.1);
    // Tips past the plain wheel's beside the throat, short of them across
    // it: between the root cylinder and the outside cylinder, less the bore.
    const bore = Math.PI * 36 * 12;
    expect(body.volume).toBeGreaterThan(Math.PI * 27.5 ** 2 * 12 - bore);
    expect(body.volume).toBeLessThan(Math.PI * 32.5 ** 2 * 12 - bore);
    const names = body.topology!.faces.map(
      (face) => face.reference?.lineageName
    );
    for (const name of [
      'gear.face.tooth[0].throat',
      'gear.face.tooth[0].tip.start-half',
      'gear.face.tooth[0].tip.end-half',
      'gear.face.tooth[29].throat'
    ]) {
      expect(names).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
    const plain = newGear({
      gearType: 'worm-wheel',
      teeth: 30,
      mateTeeth: 2,
      diameterFactor: 10,
      faceWidth: 12,
      hand: 'left',
      boreDiameter: 12
    });
    const plainNames = (
      await adapter.syncDocument(plain.document)
    ).bodyRepresentations[plain.bodyId]!.topology!.faces.map(
      (face) => face.reference?.lineageName
    );
    expect(plainNames.some((name) => name?.endsWith('.throat'))).toBe(false);
  });

  it('refuses a throated worm wheel whose outside diameter is below its tips', async () => {
    const derived = await adapter.syncDocument(
      newGear({
        gearType: 'worm-wheel',
        teeth: 30,
        mateTeeth: 2,
        diameterFactor: 10,
        faceWidth: 12,
        throated: true,
        outsideDiameter: 63
      }).document
    );
    const refusal = derived.featureWarnings!.find(
      (warning) => warning.kind === 'build-failed'
    );
    expect(refusal?.kernelRefusal).toMatchObject({ family: 'gear' });
    expect(refusal?.message).toMatch(/Throated worm wheel/);
  });

  it('builds an enveloping worm whose hourglass wraps its wheel', async () => {
    const enveloping = newGear({
      gearType: 'enveloping-worm',
      teeth: 1,
      mateTeeth: 30,
      diameterFactor: 10,
      faceWidth: 24,
      hand: 'left',
      boreDiameter: 6
    });
    const derived = await adapter.syncDocument(enveloping.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.featureWarnings ?? []).toEqual([]);
    const body = derived.bodyRepresentations[enveloping.bodyId]!;
    // m 2, q 10, 30 teeth: center distance 40, throat tip diameter 24, tip
    // hourglass tube radius 28; the caps (±12 from the throat) are its
    // widest sections, 2·(40 − √(28² − 12²)).
    const endTip = 2 * (40 - Math.sqrt(28 ** 2 - 12 ** 2));
    const box = body.bbox;
    expect(box.min.z).toBeLessThanOrEqual(1e-6);
    expect(box.max.z).toBeGreaterThanOrEqual(24 - 1e-6);
    expect(box.max.x - box.min.x).toBeGreaterThanOrEqual(endTip - 0.05);
    // Between the root hourglass at the throat and the tip cylinder at the
    // caps, less the bore.
    const bore = Math.PI * 9 * 24;
    expect(body.volume).toBeGreaterThan(Math.PI * 7.5 ** 2 * 24 - bore);
    expect(body.volume).toBeLessThan(Math.PI * (endTip / 2) ** 2 * 24 - bore);
    const names = body.topology!.faces.map(
      (face) => face.reference?.lineageName
    );
    for (const name of [
      'gear.face.cap.start',
      'gear.face.cap.end',
      'gear.face.bore',
      'gear.face.tooth[0].flank.plus[0]',
      'gear.face.tooth[0].flank.minus[0]',
      'gear.face.tooth[0].tip[0]',
      'gear.face.root[0][0]'
    ]) {
      expect(names).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('refuses an enveloping worm whose bore reaches its throat root', async () => {
    const bored = await adapter.syncDocument(
      newGear({
        gearType: 'enveloping-worm',
        teeth: 1,
        mateTeeth: 30,
        diameterFactor: 10,
        faceWidth: 16,
        boreDiameter: 15
      }).document
    );
    const refusal = bored.featureWarnings!.find(
      (warning) => warning.kind === 'build-failed'
    );
    expect(refusal?.kernelRefusal).toMatchObject({
      family: 'gear',
      code: 'gear:bore-too-large'
    });
    expect(refusal?.message).toMatch(/Enveloping worm/);
  });

  it('refuses a worm whose bore reaches its root', async () => {
    const bored = await adapter.syncDocument(
      newGear({
        gearType: 'worm',
        teeth: 1,
        diameterFactor: 10,
        faceWidth: 10,
        boreDiameter: 16
      }).document
    );
    const refusal = bored.featureWarnings!.find(
      (warning) => warning.kind === 'build-failed'
    );
    expect(refusal?.kernelRefusal).toMatchObject({
      family: 'gear',
      code: 'gear:bore-too-large'
    });
    expect(refusal?.message).toMatch(/Worm/);
  });

  it('builds a bevel gear tapering from its heel toward the cone apex', async () => {
    const bevel = newGear({
      gearType: 'bevel',
      mateTeeth: 40,
      faceWidth: 8,
      boreDiameter: 10
    });
    const derived = await adapter.syncDocument(bevel.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.featureWarnings ?? []).toEqual([]);
    const body = derived.bodyRepresentations[bevel.bodyId]!;
    // tan δ = 1/2 for a right-angle 20:40 pair; outer cone distance
    // A = 20 / sin δ, heel-plane tip radius A·cos δ·tan(δ + atan(2/A)).
    const delta = Math.atan(0.5);
    const outer = 20 / Math.sin(delta);
    const tip =
      outer * Math.cos(delta) * Math.tan(delta + Math.atan(2 / outer));
    const box = body.bbox;
    // Flat heel and toe caps: the axial extent is the face width's
    // projection onto the axis, exactly.
    expect(box.min.z).toBeCloseTo(0, 9);
    expect(box.max.z).toBeCloseTo(8 * Math.cos(delta), 9);
    // The kernel's box over NURBS flanks is conservative.
    expect(Math.abs(box.max.x - box.min.x - 2 * tip)).toBeLessThan(0.05);
    // Every section is the heel outline scaled toward the apex, so the
    // volume lies between the tapered root and tip cones' frusta, less the
    // bore.
    const apex = outer * Math.cos(delta);
    const scale = 1 - 8 / outer;
    const frustum = (radius: number) =>
      ((Math.PI * radius ** 2 * apex) / 3) * (1 - scale ** 3);
    const root = apex * Math.tan(delta - Math.atan(2.5 / outer));
    const bore = Math.PI * 25 * 8 * Math.cos(delta);
    expect(body.volume).toBeGreaterThan(frustum(root) - bore);
    expect(body.volume).toBeLessThan(frustum(tip) - bore);
    const names = body.topology!.faces.map(
      (face) => face.reference?.lineageName
    );
    for (const name of [
      'gear.face.cap.start',
      'gear.face.cap.end',
      'gear.face.bore',
      'gear.face.tooth[0].flank.plus',
      'gear.face.tooth[19].tip',
      'gear.face.root[0]'
    ]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain(undefined);
    expect(new Set(names).size).toBe(names.length);
  });

  it('refuses a bevel gear whose face width reaches the apex', async () => {
    const long = await adapter.syncDocument(
      newGear({ gearType: 'bevel', mateTeeth: 40, faceWidth: 60 }).document
    );
    const refusal = long.featureWarnings!.find(
      (warning) => warning.kind === 'build-failed'
    );
    expect(refusal?.kernelRefusal).toMatchObject({
      family: 'gear',
      code: 'gear:invalid-parameter'
    });
    expect(refusal?.message).toMatch(/apex/);
  });

  it('reads a diametral pitch per inch in an inch document', async () => {
    const gear = newGear(
      { sizing: 'diametral-pitch', pitch: 10, faceWidth: 0.25 },
      'inch'
    );
    const derived = await adapter.syncDocument(gear.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[gear.bodyId]!;
    // Tip diameter (z + 2)/P = 2.2 in.
    const box = body.bbox;
    expect(box.max.x - box.min.x).toBeLessThanOrEqual(2.2 + 1e-9);
    expect(box.max.x - box.min.x).toBeGreaterThan(2.1);
  });

  it('reports undercut as an advisory and a pointed tip as a refusal', async () => {
    const undercut = await adapter.syncDocument(
      newGear({ teeth: 10 }).document
    );
    const advisory = undercut.featureWarnings!.find(
      (warning) => warning.kind === 'advisory'
    );
    expect(advisory?.message).toMatch(/undercut/);

    const pointed = await adapter.syncDocument(
      newGear({ teeth: 8, profileShift: 1.2 }).document
    );
    const refusal = pointed.featureWarnings!.find(
      (warning) => warning.kind === 'build-failed'
    );
    expect(refusal?.message).toMatch(/come to a point/);
    expect(refusal?.kernelRefusal).toMatchObject({
      family: 'gear',
      code: 'gear:pointed-tip'
    });
  });

  it('cuts teeth along a cylinder, keeping its diameter', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Shaft', toUserId('user_gear')),
      {
        name: 'Blank',
        primitiveKind: 'cylinder',
        dimensions: { radius: 11, height: 6 }
      }
    );
    const blankId = base.bodyOrder[0]!;
    const blank = (await adapter.syncDocument(base)).bodyRepresentations[
      blankId
    ]!;
    const side = blank.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    const cut = gearBody(base, {
      name: 'Teeth',
      gearType: 'external',
      sizing: 'module',
      teeth: 20,
      targetBodyId: blankId,
      faceHash: side.hash,
      ...(side.reference ? { faceReference: side.reference } : {})
    });
    const derived = await adapter.syncDocument(cut.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[blankId]?.consumed).toBe(true);
    const body = derived.bodyRepresentations[cut.bodyId]!;
    // Keeping Ø22 with 20 teeth solves m = 1: the same gear as a new body.
    const reference = newGear({ pitch: 1, faceWidth: 6 });
    const standalone = (await adapter.syncDocument(reference.document))
      .bodyRepresentations[reference.bodyId]!;
    expect(body.volume).toBeCloseTo(standalone.volume, 6);
    const names = body.topology!.faces.map(
      (face) => face.reference?.lineageName
    );
    expect(names.filter((name) => name?.includes('.flank.'))).toHaveLength(40);
  });

  it('cuts herringbone teeth along a cylinder with both halves named', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Shaft', toUserId('user_gear')),
      {
        name: 'Blank',
        primitiveKind: 'cylinder',
        dimensions: { radius: 11, height: 6 }
      }
    );
    const blankId = base.bodyOrder[0]!;
    const blank = (await adapter.syncDocument(base)).bodyRepresentations[
      blankId
    ]!;
    const side = blank.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    const cut = gearBody(base, {
      name: 'Teeth',
      gearType: 'external',
      sizing: 'module',
      teeth: 20,
      helixAngleDeg: 15,
      hand: 'left',
      herringbone: true,
      targetBodyId: blankId,
      faceHash: side.hash,
      ...(side.reference ? { faceReference: side.reference } : {})
    });
    const derived = await adapter.syncDocument(cut.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[cut.bodyId]!;
    // Keeping the diameter turns no material outside the Ø22 tip circle.
    expect(body.bbox.max.x - body.bbox.min.x).toBeLessThan(22 + 0.05);
    const names = body.topology!.faces.map(
      (face) => face.reference?.lineageName
    );
    const flanks = names.filter((name) => name?.includes('.flank.'));
    expect(flanks).toHaveLength(80);
    expect(flanks.filter((name) => name?.endsWith('.end-half'))).toHaveLength(
      40
    );
  });

  it('refuses teeth that would not fit the picked cylinder', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Shaft', toUserId('user_gear')),
      {
        name: 'Blank',
        primitiveKind: 'cylinder',
        dimensions: { radius: 11, height: 6 }
      }
    );
    const blankId = base.bodyOrder[0]!;
    const blank = (await adapter.syncDocument(base)).bodyRepresentations[
      blankId
    ]!;
    const side = blank.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    const cut = gearBody(base, {
      name: 'Teeth',
      gearType: 'external',
      sizing: 'module',
      pitch: 1.2,
      fit: 'module',
      teeth: 20,
      targetBodyId: blankId,
      faceHash: side.hash
    });
    const derived = await adapter.syncDocument(cut.document);
    const refusal = derived.featureWarnings!.find(
      (warning) => warning.kind === 'build-failed'
    );
    expect(refusal?.kernelRefusal?.code).toBe('gear:cylinder-too-small');
  });
});
