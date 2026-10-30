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
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(40);
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
    ['fit on a new body', { fit: 'module' as const }]
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
