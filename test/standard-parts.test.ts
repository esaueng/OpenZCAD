import { beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  assertDocumentContentSchema,
  createProjectDocument,
  listFeaturesInOrder,
  standardPartBody,
  type StandardPartInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  STANDARD_PART_KINDS,
  STANDARD_SCREW_HEADS,
  standardPartDefaultLengthMm,
  standardPartDesignation,
  standardPartGeometry,
  standardPartLengthsMm,
  standardPartMinimumLengthMm,
  standardPartProblem,
  standardPartSizes,
  standardPartThread,
  toUserId,
  type DerivedState,
  type ProjectDocument,
  type StandardPartChoice,
  type StandardPartSize,
  type UnitSystem
} from '@openzcad/shared';

/**
 * M17 standard parts (schema v68): the catalogue's tables, the feature's
 * document contract, and the exact parts the generator builds on the
 * kernel, checked against closed forms and their tables' dimensions.
 */

const ORIGIN = { x: 0, y: 0, z: 0 };
const UP = { x: 0, y: 0, z: 1 };
const X = { x: 1, y: 0, z: 0 };

function part(
  units: UnitSystem,
  input: Omit<StandardPartInput, 'name' | 'origin' | 'axis'> &
    Partial<Pick<StandardPartInput, 'origin' | 'axis'>>
): ProjectDocument {
  return standardPartBody(
    createProjectDocument('Parts', toUserId('user_m17'), units),
    {
      name: 'Part',
      origin: ORIGIN,
      axis: UP,
      xDirection: X,
      ...input
    }
  ).document;
}

/**
 * Every catalogue row with its default length; for threaded parts only the
 * smallest and largest size of each table, where a thread is likeliest to
 * be refused (each threaded build takes seconds).
 */
function everyRow(): (StandardPartChoice & { lengthMm?: number })[] {
  return (['iso', 'ansi'] as const).flatMap((system) =>
    STANDARD_PART_KINDS.flatMap((partKind) =>
      (partKind === 'screw' ? STANDARD_SCREW_HEADS : [undefined]).flatMap(
        (head) =>
          standardPartSizes(partKind, system, head)
            .filter(
              (size, index, sizes) =>
                partKind === 'washer' ||
                partKind === 'dowel' ||
                partKind === 'bearing' ||
                index === 0 ||
                index === sizes.length - 1
            )
            .map((size) => {
              const choice: StandardPartChoice = {
                partKind,
                system,
                size,
                ...(head ? { head } : {})
              };
              const lengthMm = standardPartDefaultLengthMm(choice);
              return { ...choice, ...(lengthMm ? { lengthMm } : {}) };
            })
      )
    )
  );
}

describe('M17 catalogue', () => {
  it('lists sizes in increasing order and keeps every row self-consistent', () => {
    for (const system of ['iso', 'ansi'] as const) {
      for (const partKind of STANDARD_PART_KINDS) {
        for (const head of partKind === 'screw'
          ? STANDARD_SCREW_HEADS
          : [undefined]) {
          let previous = 0;
          for (const size of standardPartSizes(partKind, system, head)) {
            const choice = {
              partKind,
              system,
              size,
              ...(head ? { head } : {})
            };
            expect(standardPartProblem(choice)).toBeNull();
            const g = standardPartGeometry(choice);
            const label = `${system} ${partKind} ${head ?? ''} ${size}`;
            let nominal: number;
            switch (g.partKind) {
              case 'screw': {
                const d = g.thread.majorDiameterMm;
                nominal = d;
                // A head wider than the shank, and its key inside the head.
                expect(g.headDiameterMm, label).toBeGreaterThan(d);
                if (g.keyMm !== undefined) {
                  const corners = g.keyMm / Math.cos(Math.PI / 6);
                  expect(corners, label).toBeLessThan(0.92 * g.headDiameterMm);
                  expect(g.keyDepthMm!, label).toBeLessThan(g.headHeightMm);
                }
                if (g.head === 'countersunk') {
                  // The cone's height from its angle and diameters.
                  expect(g.headHeightMm, label).toBeCloseTo(
                    (g.headDiameterMm - d) /
                      2 /
                      Math.tan(((g.headAngleDeg! / 2) * Math.PI) / 180),
                    9
                  );
                }
                break;
              }
              case 'nut':
                nominal = g.thread.majorDiameterMm;
                expect(g.acrossFlatsMm, label).toBeGreaterThan(1.4 * nominal);
                expect(g.heightMm, label).toBeLessThan(nominal);
                break;
              case 'washer':
                nominal = g.insideMm;
                expect(g.outsideMm, label).toBeGreaterThan(1.7 * g.insideMm);
                expect(g.thicknessMm, label).toBeLessThan(g.insideMm);
                expect(
                  standardPartThread({ partKind: 'nut', system, size })
                    .majorDiameterMm,
                  label
                ).toBeLessThan(g.insideMm);
                break;
              case 'insert':
                nominal = g.thread.majorDiameterMm;
                // A wall of more than half a millimetre past the thread.
                expect(g.outsideMm - nominal, label).toBeGreaterThan(1.2);
                break;
              case 'dowel':
                nominal = g.diameterMm;
                break;
              case 'bearing':
                nominal = g.boreMm;
                // Both rings keep a wall outside their ball groove, the
                // groove fits the ring width, and the balls do not touch.
                expect(
                  g.outsideMm / 2 -
                    (g.pitchDiameterMm / 2 + 0.52 * g.ballDiameterMm),
                  label
                ).toBeGreaterThan(0);
                expect(
                  g.pitchDiameterMm / 2 -
                    0.52 * g.ballDiameterMm -
                    g.boreMm / 2,
                  label
                ).toBeGreaterThan(0);
                expect(1.04 * g.ballDiameterMm, label).toBeLessThan(g.widthMm);
                expect(
                  2 * (g.pitchDiameterMm / 2) * Math.sin(Math.PI / g.balls),
                  label
                ).toBeGreaterThan(g.ballDiameterMm);
                break;
            }
            // Bearings run by bore, then outside.
            if (partKind !== 'bearing') {
              expect(nominal, label).toBeGreaterThan(previous);
            } else {
              expect(g.boreMm, label).toBeGreaterThanOrEqual(previous);
            }
            previous = nominal;
          }
        }
      }
    }
  });

  it('designates parts as a bill of materials lists them', () => {
    expect(
      standardPartDesignation(
        { partKind: 'screw', system: 'iso', size: 'M6' },
        20
      )
    ).toBe('ISO 4762 M6×1 × 20 socket head cap screw');
    expect(
      standardPartDesignation(
        { partKind: 'screw', system: 'ansi', size: '1/4', head: 'hex' },
        19.05
      )
    ).toBe('ASME B18.2.1 1/4-20 UNC × 3/4" hex head screw');
    expect(
      standardPartDesignation({ partKind: 'nut', system: 'ansi', size: '#10' })
    ).toBe('ASME B18.6.3 #10-24 UNC hex nut');
    expect(
      standardPartDesignation({ partKind: 'washer', system: 'iso', size: 'M6' })
    ).toBe('ISO 7089 M6 plain washer');
    expect(
      standardPartDesignation(
        { partKind: 'dowel', system: 'iso', size: '6' },
        20
      )
    ).toBe('ISO 8734 Ø6 × 20 dowel pin');
    expect(
      standardPartDesignation({
        partKind: 'bearing',
        system: 'iso',
        size: '608'
      })
    ).toBe('ISO 15 608 ball bearing');
    expect(
      standardPartDesignation({ partKind: 'insert', system: 'iso', size: 'M3' })
    ).toBe('M3×0.5 heat-set insert (typical)');
  });

  it('offers preferred lengths from the shortest buildable', () => {
    const m6 = { partKind: 'screw', system: 'iso', size: 'M6' } as const;
    const lengths = standardPartLengthsMm(m6);
    expect(lengths[0]).toBeGreaterThanOrEqual(
      standardPartMinimumLengthMm(standardPartGeometry(m6))
    );
    expect(lengths).toContain(20);
    expect(lengths.at(-1)).toBeLessThanOrEqual(60);
    expect(standardPartDefaultLengthMm(m6)).toBe(16);
    expect(
      standardPartLengthsMm({ partKind: 'nut', system: 'iso', size: 'M6' })
    ).toEqual([]);
  });

  it.each([
    [{ partKind: 'rivet', system: 'iso', size: 'M6' }, /not a standard part/],
    [
      { partKind: 'screw', system: 'jis', size: 'M6' },
      /ISO metric or ANSI inch/
    ],
    [
      { partKind: 'nut', system: 'iso', size: 'M6', head: 'hex' },
      /Only a screw has a head/
    ],
    [
      { partKind: 'screw', system: 'iso', size: 'M2', head: 'countersunk' },
      /not an ISO countersunk socket screw size/
    ],
    [
      { partKind: 'washer', system: 'ansi', size: 'M6' },
      /not an ANSI plain washer size/
    ]
  ])('refuses %o', (choice, message) => {
    expect(standardPartProblem(choice)).toMatch(message);
  });
});

describe('M17 standard parts: document contract', () => {
  const screw = {
    partKind: 'screw',
    system: 'iso',
    size: 'M6',
    length: 20
  } as const;

  it('stores the part at schema v68', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(68);
    const document = part('mm', screw);
    expect(listFeaturesInOrder(document).at(-1)!.data).toMatchObject({
      featureKind: 'standard-part',
      ...screw
    });
    expect(document.bodyOrder).toHaveLength(1);
    expect(() => assertDocumentContentSchema(document)).not.toThrow();
  });

  it('refuses a part on a document that declares schema v67', () => {
    const old = {
      ...createProjectDocument('Parts', toUserId('user_m17'), 'mm'),
      schemaVersion: 67
    } as unknown as ProjectDocument;
    expect(() =>
      standardPartBody(old, {
        name: 'Part',
        ...screw,
        origin: ORIGIN,
        axis: UP
      })
    ).toThrow(/Standard parts require project schema v68/);
  });

  const blank = () =>
    createProjectDocument('Parts', toUserId('user_m17'), 'mm');
  it.each([
    [
      'a screw without a length',
      { ...screw, length: undefined },
      /needs a length/
    ],
    [
      'a nut with a length',
      { partKind: 'nut', system: 'iso', size: 'M6', length: 5 },
      /takes its height from its table/
    ],
    [
      'a screw too short to thread',
      { ...screw, length: 4 },
      /must be longer than 5 mm/
    ],
    [
      'a zero axis',
      { ...screw, axis: { x: 0, y: 0, z: 0 } },
      /axis must be non-zero/
    ],
    ['an unknown size', { ...screw, size: 'M7' }, /M7 is not an ISO/]
  ] as const)('refuses %s', (_label, patch, message) => {
    expect(() =>
      commandFactories
        .standardPartBody({
          name: 'Part',
          origin: ORIGIN,
          axis: UP,
          ...(patch as Partial<StandardPartInput>)
        } as StandardPartInput)
        .validate(blank())
    ).toThrow(message);
  });

  it('undoes, redoes, edits and replays a part', () => {
    const base = blank();
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.standardPartBody({
        name: 'Part',
        ...screw,
        origin: ORIGIN,
        axis: UP
      })
    );
    const feature = listFeaturesInOrder(manager.document).at(-1)!;
    manager.execute(
      commandFactories.updateFeature({
        featureId: feature.featureId,
        data: { featureKind: 'standard-part', size: 'M8', length: 30 }
      })
    );
    const data = () => listFeaturesInOrder(manager.document).at(-1)!.data;
    expect(data()).toMatchObject({ size: 'M8', length: 30 });
    // An edit the catalogue refuses is refused like a create.
    expect(() =>
      commandFactories
        .updateFeature({
          featureId: feature.featureId,
          data: {
            featureKind: 'standard-part',
            size: 'M9' as StandardPartSize
          }
        })
        .validate(manager.document)
    ).toThrow(/M9 is not an ISO/);
    manager.undo();
    expect(data()).toMatchObject({ size: 'M6', length: 20 });
    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(0);
    manager.redo();
    manager.redo();
    const replayed = replayCommands(base, manager.document.commandLog);
    expect(listFeaturesInOrder(replayed).at(-1)!.data).toEqual(data());
  });
});

describe('M17 standard parts: exact build', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function built(document: ProjectDocument) {
    const derived: DerivedState = await adapter.syncDocument(document);
    expect(
      [
        ...derived.warnings,
        ...(derived.featureWarnings ?? []).map((w) => w.message)
      ].join('\n')
    ).toBe('');
    const body = derived.bodyRepresentations[document.bodyOrder.at(-1)!]!;
    const extent = {
      x: body.bbox.max.x - body.bbox.min.x,
      y: body.bbox.max.y - body.bbox.min.y,
      z: body.bbox.max.z - body.bbox.min.z
    };
    const names = new Set(
      body.topology!.faces.map((face) => face.reference?.lineageName)
    );
    return { body, extent, names };
  }

  it('builds a washer and a dowel pin to their closed-form volumes', async () => {
    const washer = await built(
      part('mm', { partKind: 'washer', system: 'iso', size: 'M6' })
    );
    expect(washer.body.volume).toBeCloseTo(
      Math.PI * (6 ** 2 - 3.2 ** 2) * 1.6,
      6
    );
    expect(washer.extent.z).toBeCloseTo(1.6, 9);
    for (const role of ['seat', 'top', 'bore', 'outside']) {
      expect(washer.names.has(`standard-part.face.${role}`)).toBe(true);
    }
    // Ø6 × 16: a 45° chamfer of a quarter radius at each end (Pappus).
    const dowel = await built(
      part('mm', { partKind: 'dowel', system: 'iso', size: '6', length: 16 })
    );
    const c = 0.75;
    expect(dowel.body.volume).toBeCloseTo(
      Math.PI * 9 * 16 - 2 * Math.PI * (3 - c / 3) * c * c,
      6
    );
    expect(dowel.extent.z).toBeCloseTo(16, 9);
  }, 900_000);

  it('threads an ISO 4762 M6 × 20 socket head screw under its head', async () => {
    const screw = await built(
      part('mm', { partKind: 'screw', system: 'iso', size: 'M6', length: 20 })
    );
    expect(screw.extent.x).toBeCloseTo(10, 6);
    expect(screw.extent.z).toBeCloseTo(26, 6);
    // The blank: the head less its top chamfer and socket, the shank less
    // its tip chamfer.
    const e = 0.4;
    const c = 0.65;
    const blank =
      Math.PI * 25 * 6 -
      Math.PI * (5 - e / 3) * e * e -
      (Math.sqrt(3) / 2) * 25 * 3 +
      Math.PI * 9 * 20 -
      Math.PI * (3 - c / 3) * c * c;
    // The thread takes material from at most the band between the major
    // and minor diameters over its length.
    const minor = 3 - (5 / 8) * (Math.sqrt(3) / 2);
    const band = Math.PI * (9 - minor * minor) * (20 - c - 2);
    expect(screw.body.volume).toBeLessThan(blank - 0.2 * band);
    expect(screw.body.volume).toBeGreaterThan(blank - band);
    for (const role of ['seat', 'head.top', 'tip']) {
      expect(screw.names.has(`standard-part.face.${role}`)).toBe(true);
    }
    // The thread: the shank's helical faces, many more than a blank's ten.
    expect(screw.body.topology!.faces.length).toBeGreaterThan(100);
  }, 900_000);

  it('places a part at its origin along its axis', async () => {
    const down = await built(
      part('mm', {
        partKind: 'screw',
        system: 'iso',
        size: 'M6',
        length: 20,
        origin: { x: 5, y: 5, z: 10 },
        axis: { x: 0, y: 0, z: -1 }
      })
    );
    expect(down.body.bbox.min.z).toBeCloseTo(-10, 6);
    expect(down.body.bbox.max.z).toBeCloseTo(16, 6);
    expect((down.body.bbox.min.x + down.body.bbox.max.x) / 2).toBeCloseTo(5, 6);
  }, 900_000);

  it('builds hex and countersunk heads and a hex nut to their tables', async () => {
    // ISO 4017 M8: a corner on +X, so the head spans its corners in X.
    const hex = await built(
      part('mm', {
        partKind: 'screw',
        system: 'iso',
        size: 'M8',
        head: 'hex',
        length: 30
      })
    );
    expect(hex.extent.x).toBeCloseTo((2 * 13) / Math.sqrt(3), 6);
    expect(hex.extent.y).toBeCloseTo(13, 6);
    expect(hex.extent.z).toBeCloseTo(30 + 5.3, 6);
    // ISO 10642 M5 × 16: the head is inside the length.
    const flat = await built(
      part('mm', {
        partKind: 'screw',
        system: 'iso',
        size: 'M5',
        head: 'countersunk',
        length: 16
      })
    );
    expect(flat.extent.z).toBeCloseTo(16, 6);
    expect(flat.extent.x).toBeCloseTo(11.2, 6);
    expect(flat.names.has('standard-part.face.head.cone')).toBe(true);
    // ISO 4032 M6: 10 across flats, 5.2 high, tapped through.
    const nut = await built(
      part('mm', { partKind: 'nut', system: 'iso', size: 'M6' })
    );
    expect(nut.extent.y).toBeCloseTo(10, 6);
    expect(nut.extent.z).toBeCloseTo(5.2, 6);
    expect(nut.body.volume).toBeLessThan(
      (Math.sqrt(3) / 2) * 100 * 5.2 - Math.PI * 2.5 ** 2 * 5.2
    );
    expect(nut.names.has('standard-part.face.seat')).toBe(true);
  }, 900_000);

  it('knurls and taps a heat-set insert, and rings and balls a bearing', async () => {
    const insert = await built(
      part('mm', { partKind: 'insert', system: 'iso', size: 'M3' })
    );
    // The knurl keeps the outside diameter.
    expect(insert.extent.z).toBeCloseTo(5.7, 6);
    // Within the gear generator's certified fit of the knurl flanks.
    expect(Math.max(insert.extent.x, insert.extent.y)).toBeCloseTo(4.6, 2);
    expect(insert.body.volume).toBeLessThan(
      Math.PI * (2.3 ** 2 - 1.25 ** 2) * 5.7
    );
    // 608: 8 × 22 × 7, seven balls of 4.2 on the 15 pitch circle.
    const bearing = await built(
      part('mm', { partKind: 'bearing', system: 'iso', size: '608' })
    );
    expect(bearing.extent.x).toBeCloseTo(22, 6);
    expect(bearing.extent.z).toBeCloseTo(7, 6);
    const ball = 4.2;
    const rings =
      Math.PI * (11 ** 2 - (7.5 + 0.35 * ball) ** 2) * 7 +
      Math.PI * ((7.5 - 0.35 * ball) ** 2 - 4 ** 2) * 7;
    const balls = 7 * (Math.PI / 6) * ball ** 3;
    const torus = 2 * Math.PI ** 2 * 7.5 * (0.52 * ball) ** 2;
    expect(bearing.body.volume).toBeLessThan(rings + balls);
    expect(bearing.body.volume).toBeGreaterThan(rings + balls - torus);
    expect(bearing.names.has('standard-part.face.bore')).toBe(true);
    expect(bearing.names.has('standard-part.face.outside')).toBe(true);
  }, 900_000);

  it('builds ANSI parts in an inch document', async () => {
    // 1/4-20 × 3/4 socket head: a 0.375 head, 0.25 high.
    const screw = await built(
      part('inch', {
        partKind: 'screw',
        system: 'ansi',
        size: '1/4',
        length: 0.75
      })
    );
    expect(screw.extent.x).toBeCloseTo(0.375, 6);
    expect(screw.extent.z).toBeCloseTo(1, 6);
    const washer = await built(
      part('inch', { partKind: 'washer', system: 'ansi', size: '1/4' })
    );
    expect(washer.body.volume).toBeCloseTo(
      Math.PI * (0.3125 ** 2 - 0.1405 ** 2) * 0.065,
      9
    );
  }, 900_000);

  it('builds every catalogue row', async () => {
    const failures: string[] = [];
    for (const row of everyRow()) {
      const { lengthMm, ...choice } = row;
      const document = part('mm', {
        ...choice,
        ...(lengthMm ? { length: lengthMm } : {})
      } as StandardPartInput);
      const derived = await adapter.syncDocument(document);
      const problems = [
        ...derived.warnings,
        ...(derived.featureWarnings ?? []).map((w) => w.message)
      ];
      if (
        problems.length > 0 ||
        !derived.bodyRepresentations[document.bodyOrder[0]!]
      ) {
        failures.push(
          `${standardPartDesignation(choice, lengthMm)}: ${problems.join('; ')}`
        );
      }
    }
    expect(failures).toEqual([]);
  }, 900_000);
});
