import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createObjectFolder,
  createProjectDocument,
  listNodesByKind,
  normalizeDocument,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  modelPmiSurfaceError,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type FaceTopology,
  type ModelPmiAnnotation,
  type ModelPmiId,
  type ProjectDocument
} from '@openzcad/shared';
import { planStepPmi } from '../packages/kernel-adapter/src/step-pmi';
import {
  draftModelPmi,
  pmiFaceRef,
  resolveModelPmi
} from '../apps/web/src/lib/pmi/modelPmi';
import {
  stepPmiOmissionClause,
  stepPmiOmissionNote
} from '../apps/web/src/lib/pmi/stepPmiDisclosure';
import { subtractFixture } from './support/subtract-curved';

/**
 * Model PMI integrity: a form tolerance only on a face it can control
 * (#2321), datum renames that carry their frames (#2375), repair guidance
 * that names an undeclared datum's slot (#2260), and an AP242 export that
 * says which PMI it left out (#2258).
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const id = (name: string) => `pmi_${name}` as ModelPmiId;
type Frame = Extract<ModelPmiAnnotation, { kind: 'feature-control-frame' }>;
type Bodies = ProjectDocument['derived']['bodyRepresentations'];

/** A 30 × 20 × 10 box and a radius-5, 16-tall pin 40 along x. */
async function plateAndPin() {
  let document = createProjectDocument('Plate', toUserId('test'));
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 30, height: 10, depth: 20 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Pin',
    primitiveKind: 'cylinder',
    dimensions: { radius: 5, height: 16 }
  });
  document = transformBody(document, {
    name: 'Move',
    targetBodyId: document.bodyOrder[1]!,
    translation: { x: 40, y: 0, z: 0 }
  }).document;
  const bodies: Bodies = (await adapter.syncDocument(document))
    .bodyRepresentations;
  const [plateId, pinId] = document.bodyOrder as [BodyId, BodyId];
  const find = (bodyId: BodyId, test: (face: FaceTopology) => boolean) =>
    bodies[bodyId]!.topology!.faces.find(test)!;
  const planar = (bodyId: BodyId, axis: 'x' | 'y' | 'z', sign: 1 | -1) =>
    find(
      bodyId,
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs((face.geometry.normal?.[axis] ?? 0) - sign) < 1e-9
    );
  const faces = {
    plateBottom: planar(plateId, 'z', -1),
    plateTop: planar(plateId, 'z', 1),
    plateSide: planar(plateId, 'x', 1),
    plateFront: planar(plateId, 'y', -1),
    barrel: find(pinId, (face) => face.geometry?.surfaceType === 'cylinder'),
    cap: find(
      pinId,
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.z ?? 0) > 0.999
    )
  };
  const ref = (face: FaceTopology) =>
    pmiFaceRef(
      bodies,
      bodies[pinId]!.topology!.faces.includes(face) ? pinId : plateId,
      face.hash
    )!;
  return { document, bodies, plateId, pinId, faces, ref };
}

function datum(
  name: string,
  letter: string,
  face: ModelPmiAnnotation['face']
): ModelPmiAnnotation {
  return {
    pmiId: id(name),
    kind: 'datum-feature',
    face,
    anchor: { x: 0, y: 0, z: 0 },
    letter
  };
}

function frame(
  name: string,
  face: ModelPmiAnnotation['face'],
  fields: Partial<Frame> & Pick<Frame, 'characteristic'>
): Frame {
  return {
    pmiId: id(name),
    kind: 'feature-control-frame',
    face,
    anchor: { x: 0, y: 0, z: 0 },
    amount: 0.1,
    ...fields
  };
}

const AP242 = { protocol: 'ap242', timestamp: '2026-11-28T00:00:00' } as const;

describe('model PMI on compatible faces (#2321)', () => {
  it('states which surfaces each form tolerance controls', () => {
    expect(modelPmiSurfaceError('cylindricity', 'cylinder')).toBeNull();
    expect(modelPmiSurfaceError('cylindricity', 'plane')).toBe(
      'Cylindricity applies to a cylindrical face, and this face is planar.'
    );
    expect(modelPmiSurfaceError('flatness', 'plane')).toBeNull();
    expect(modelPmiSurfaceError('flatness', 'cylinder')).toMatch(
      /^Flatness applies to a planar face/
    );
    expect(modelPmiSurfaceError('circularity', 'cone')).toBeNull();
    expect(modelPmiSurfaceError('circularity', 'plane')).toBe(
      'Circularity applies to a cylindrical, conical, spherical or toroidal face, and this face is planar.'
    );
    expect(modelPmiSurfaceError('straightness', 'sphere')).toMatch(
      /this face is spherical/
    );
    // Orientation, location, profile and runout take any face.
    expect(modelPmiSurfaceError('position', 'plane')).toBeNull();
    expect(modelPmiSurfaceError('position', 'bspline')).toBeNull();
    // A B-spline face is judged by the analytic surface it was shown to lie
    // on, and refused when none was established.
    expect(
      modelPmiSurfaceError('cylindricity', 'bspline', 'cylinder')
    ).toBeNull();
    expect(modelPmiSurfaceError('flatness', 'bspline', 'cylinder')).toBe(
      'Flatness applies to a planar face, and this face is cylindrical.'
    );
    expect(modelPmiSurfaceError('cylindricity', 'bspline')).toBe(
      'Cylindricity applies to a cylindrical face, and this B-spline face could not be shown to be one.'
    );
    expect(modelPmiSurfaceError('flatness', undefined)).toBe(
      "Flatness applies to a planar face, and this face's surface is not known."
    );
  });

  it('judges an imported B-spline face by the surface it lies on, in the workspace and in AP242', async () => {
    const manager = new CommandManager(
      createProjectDocument('Imported', toUserId('test'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Target',
        artifactId: 'artifact_target',
        sourceName: 'trimmed-nurbs-target.step',
        stepText: subtractFixture('trimmed-nurbs-target.step')
      })
    );
    const document = manager.document;
    const bodyId = document.bodyOrder[0] as BodyId;
    const bodies: Bodies = (await adapter.syncDocument(document))
      .bodyRepresentations;
    const faces = bodies[bodyId]!.topology!.faces;
    // Every face of the file is a B-spline; the kernel calls the flat ones
    // planes, and the rational side stays a B-spline until it is analysed.
    const side = faces.find(
      (face) => face.geometry?.surfaceType === 'bspline'
    )!;
    expect(side.geometry).toMatchObject({ supportSurface: 'cylinder' });
    const ref = pmiFaceRef(bodies, bodyId, side.hash)!;
    expect(
      draftModelPmi(
        'feature-control-frame',
        ref,
        { x: 0, y: 0, z: 0 },
        undefined,
        'mm',
        side.geometry
      )
    ).toMatchObject({ characteristic: 'cylindricity' });
    const cylindricity = frame('cyl', ref, {
      characteristic: 'cylindricity',
      amount: 0.004
    });
    const flatness = frame('flat', ref, { characteristic: 'flatness' });
    const resolved = resolveModelPmi(
      { annotations: [cylindricity, flatness] },
      bodies
    );
    expect(resolved.get(id('cyl'))).toMatchObject({ ok: true });
    expect(resolved.get(id('flat'))).toMatchObject({
      ok: false,
      reason: 'surface-incompatible',
      message:
        'Flatness applies to a planar face, and this face is cylindrical.'
    });
    const good = await adapter.exportStepReport(
      { ...document, pmi: { annotations: [cylindricity] } },
      [bodyId],
      AP242
    );
    expect(good.warnings).toEqual([]);
    expect(good.text).toMatch(/CYLINDRICITY_TOLERANCE\('cylindricity'/);
    const bad = await adapter.exportStepReport(
      { ...document, pmi: { annotations: [flatness] } },
      [bodyId],
      AP242
    );
    expect(bad.text).not.toMatch(/FLATNESS_TOLERANCE/);
    expect(bad.warnings).toEqual([
      'Flatness | 0.1 — Flatness applies to a planar face, and this face is cylindrical'
    ]);
  }, 120_000);

  it('shows a cylindricity frame moved to a flat cap broken, and drafts a fitting one', async () => {
    const m = await plateAndPin();
    const onBarrel = frame('cyl', m.ref(m.faces.barrel), {
      characteristic: 'cylindricity',
      amount: 0.004
    });
    const onCap = { ...onBarrel, face: m.ref(m.faces.cap) };
    expect(
      resolveModelPmi({ annotations: [onBarrel] }, m.bodies).get(id('cyl'))
    ).toMatchObject({ ok: true });
    expect(
      resolveModelPmi({ annotations: [onCap] }, m.bodies).get(id('cyl'))
    ).toEqual({
      ok: false,
      reason: 'surface-incompatible',
      message:
        'Cylindricity applies to a cylindrical face, and this face is planar.',
      // The face itself is fine, so the editor still judges by it.
      face: m.faces.cap
    });
    // A new frame starts as a form tolerance its face can take.
    const draft = (face: FaceTopology) =>
      draftModelPmi(
        'feature-control-frame',
        m.ref(face),
        { x: 0, y: 0, z: 0 },
        undefined,
        'mm',
        face.geometry
      );
    expect(draft(m.faces.barrel)).toMatchObject({
      characteristic: 'cylindricity'
    });
    expect(draft(m.faces.cap)).toMatchObject({ characteristic: 'flatness' });
  }, 120_000);

  it('writes cylindricity on the bore, and leaves it out of AP242 with a warning on a flat cap', async () => {
    const m = await plateAndPin();
    const onBarrel = frame('cyl', m.ref(m.faces.barrel), {
      characteristic: 'cylindricity',
      amount: 0.004
    });
    const bodies = [m.pinId];
    const good = await adapter.exportStepReport(
      { ...m.document, pmi: { annotations: [onBarrel] } },
      bodies,
      AP242
    );
    expect(good.warnings).toEqual([]);
    expect(good.text).toMatch(/CYLINDRICITY_TOLERANCE\('cylindricity'/);
    const moved = await adapter.exportStepReport(
      {
        ...m.document,
        pmi: { annotations: [{ ...onBarrel, face: m.ref(m.faces.cap) }] }
      },
      bodies,
      AP242
    );
    expect(moved.text).not.toMatch(/CYLINDRICITY_TOLERANCE/);
    expect(moved.text).not.toMatch(/GEOMETRIC_ITEM_SPECIFIC_USAGE/);
    expect(moved.warnings).toEqual([
      'Cylindricity | 0.004 — Cylindricity applies to a cylindrical face, and this face is planar'
    ]);
  }, 120_000);
});

describe('datum renames carry their frames (#2375)', () => {
  /** Datums A, B, C on the plate and two frames naming A, C, B. */
  async function referenced() {
    const m = await plateAndPin();
    const annotations: ModelPmiAnnotation[] = [
      datum('a', 'A', m.ref(m.faces.plateBottom)),
      datum('b', 'B', m.ref(m.faces.plateSide)),
      datum('c', 'C', m.ref(m.faces.plateFront)),
      frame('pos', m.ref(m.faces.barrel), {
        characteristic: 'position',
        diameterZone: true,
        material: 'mmc',
        datums: [
          { letter: 'A' },
          { letter: 'C', material: 'mmc' },
          { letter: 'B' }
        ]
      }),
      frame('perp', m.ref(m.faces.barrel), {
        characteristic: 'perpendicularity',
        amount: 0.05,
        datums: [{ letter: 'A' }, { letter: 'C' }, { letter: 'B' }]
      })
    ];
    const manager = new CommandManager(m.document);
    for (const annotation of annotations)
      manager.execute(commandFactories.addModelPmi({ annotation }));
    return { m, manager, annotations };
  }

  it('renames every reference in the same undoable command, keeping slot and modifier', async () => {
    const { m, manager } = await referenced();
    const c = manager.document.pmi!.annotations.find(
      (entry) => entry.pmiId === id('c')
    )!;
    const before = manager.document.pmi;
    manager.execute(
      commandFactories.updateModelPmi(
        {
          annotation: { ...c, letter: 'F' } as ModelPmiAnnotation,
          followReferences: true
        },
        'Change datum letter'
      )
    );
    const after = manager.document.pmi!.annotations;
    const datums = (name: string) =>
      (after.find((entry) => entry.pmiId === id(name)) as Frame).datums;
    expect(datums('pos')).toEqual([
      { letter: 'A' },
      { letter: 'F', material: 'mmc' },
      { letter: 'B' }
    ]);
    expect(datums('perp')).toEqual([
      { letter: 'A' },
      { letter: 'F' },
      { letter: 'B' }
    ]);
    const resolutions = resolveModelPmi(manager.document.pmi, m.bodies);
    expect([...resolutions.values()].every((entry) => entry.ok)).toBe(true);
    // The tolerances survive into AP242 with their ordered references.
    const step = await adapter.exportStepReport(
      manager.document,
      [m.plateId, m.pinId],
      AP242
    );
    expect(step.warnings).toEqual([]);
    expect(step.text).toMatch(/DATUM_SYSTEM\('A\|F\(M\)\|B'/);
    expect(step.text).toMatch(/DATUM_SYSTEM\('A\|F\|B'/);
    expect(step.text).toMatch(/POSITION_TOLERANCE\(\)/);
    expect(step.text).toMatch(/PERPENDICULARITY_TOLERANCE\(/);
    // One undo step restores the datum and both frames.
    manager.undo();
    expect(manager.document.pmi).toEqual(before);
    manager.redo();
    expect(manager.document.pmi!.annotations).toEqual(after);
    // Replay reproduces the rename from the log alone.
    const replayed = replayCommands(
      { ...m.document, commandLog: [] },
      manager.document.commandLog
    );
    expect(replayed.pmi).toEqual(manager.document.pmi);
  }, 120_000);

  it('replays a pre-v157 rename as recorded, and refuses the follow flag below v157', async () => {
    const { m, manager } = await referenced();
    const c = manager.document.pmi!.annotations.find(
      (entry) => entry.pmiId === id('c')
    )!;
    // An older log's rename named only the datum: its frames stay as written.
    manager.execute(
      commandFactories.updateModelPmi({
        annotation: { ...c, letter: 'F' } as ModelPmiAnnotation
      })
    );
    expect(
      (
        manager.document.pmi!.annotations.find(
          (entry) => entry.pmiId === id('perp')
        ) as Frame
      ).datums![1]
    ).toEqual({ letter: 'C' });
    // An old (v155) document opens as current, and renaming then carries
    // its frames.
    const old = normalizeDocument({
      ...(JSON.parse(JSON.stringify(m.document)) as ProjectDocument),
      schemaVersion: 155,
      pmi: {
        annotations: (await referenced()).manager.document.pmi!.annotations
      }
    } as unknown as ProjectDocument);
    expect(old.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    const reopened = new CommandManager(old);
    const oldC = old.pmi!.annotations.find((entry) => entry.pmiId === id('c'))!;
    reopened.execute(
      commandFactories.updateModelPmi({
        annotation: { ...oldC, letter: 'G' } as ModelPmiAnnotation,
        followReferences: true
      })
    );
    expect(
      reopened.document.pmi!.annotations.flatMap((entry) =>
        entry.kind === 'feature-control-frame'
          ? (entry.datums ?? []).map((reference) => reference.letter)
          : []
      )
    ).toEqual(['A', 'G', 'B', 'A', 'G', 'B']);
    // A document below v157 cannot carry a following rename.
    const stored = JSON.parse(
      JSON.stringify(reopened.document)
    ) as ProjectDocument;
    expect(() => normalizeDocument(stored)).not.toThrow();
    expect(() =>
      normalizeDocument({
        ...stored,
        schemaVersion: 156
      } as unknown as ProjectDocument)
    ).toThrow(/Datum renames that update frames require project schema v157/);
  }, 120_000);
});

describe('broken-frame guidance (#2260)', () => {
  it('names an undeclared datum and its slot instead of asking for the face', async () => {
    const m = await plateAndPin();
    const resolution = resolveModelPmi(
      {
        annotations: [
          datum('a', 'A', m.ref(m.faces.plateBottom)),
          datum('b', 'B', m.ref(m.faces.plateSide)),
          frame('pos', m.ref(m.faces.barrel), {
            characteristic: 'position',
            datums: [{ letter: 'A' }, { letter: 'C' }, { letter: 'B' }]
          })
        ]
      },
      m.bodies
    ).get(id('pos'));
    expect(resolution).toEqual({
      ok: false,
      reason: 'datum-undefined',
      message:
        "This frame's secondary datum C is not declared on the model. Add a datum feature C to a face, or choose a declared datum in that slot.",
      face: m.faces.barrel
    });
  }, 120_000);
});

describe('AP242 export reports omitted PMI (#2258)', () => {
  it('names a frame left out for an undeclared datum and keeps the rest', async () => {
    const m = await plateAndPin();
    const document: ProjectDocument = {
      ...m.document,
      pmi: {
        annotations: [
          datum('a', 'A', m.ref(m.faces.plateBottom)),
          datum('b', 'B', m.ref(m.faces.plateSide)),
          frame('pos', m.ref(m.faces.barrel), {
            characteristic: 'position',
            datums: [{ letter: 'A' }, { letter: 'C' }, { letter: 'B' }]
          }),
          frame('flat', m.ref(m.faces.plateTop), { characteristic: 'flatness' })
        ]
      }
    };
    const step = await adapter.exportStepReport(
      document,
      [m.plateId, m.pinId],
      AP242
    );
    expect(step.text).toMatch(/DATUM\('datum A'/);
    expect(step.text).toMatch(/DATUM\('datum B'/);
    expect(step.text).toMatch(/FLATNESS_TOLERANCE\(/);
    expect(step.text).not.toMatch(/POSITION_TOLERANCE/);
    expect(step.warnings).toEqual([
      'Position | 0.1 | A | C | B — its secondary datum C is not declared on the model'
    ]);
    // The workspace's completion note names it.
    expect(stepPmiOmissionNote(step.warnings)).toBe(
      'AP242 left out 1 PMI entry: Position | 0.1 | A | C | B — its secondary datum C is not declared on the model.'
    );
    expect(stepPmiOmissionClause('2 bodies', step.warnings)).toBe(
      '2 bodies; 1 PMI entry left out'
    );
    expect(stepPmiOmissionNote([])).toBeNull();
    // AP214 writes no PMI and so omits none.
    const ap214 = await adapter.exportStepReport(
      document,
      [m.plateId, m.pinId],
      {
        timestamp: AP242.timestamp
      }
    );
    expect(ap214.warnings).toEqual([]);
  }, 120_000);

  it('names a frame whose datum Objects folders put on another part, and a broken face', async () => {
    const m = await plateAndPin();
    const foldered = createObjectFolder(
      createObjectFolder(m.document, {
        folderId: 'fold_plate',
        name: 'Fixture',
        parentId: null,
        bodyIds: [m.plateId]
      }),
      {
        folderId: 'fold_pin',
        name: 'Gauge',
        parentId: null,
        bodyIds: [m.pinId]
      }
    );
    const document: ProjectDocument = {
      ...foldered,
      pmi: {
        annotations: [
          datum('a', 'A', m.ref(m.faces.plateBottom)),
          frame('par', m.ref(m.faces.cap), {
            characteristic: 'parallelism',
            datums: [{ letter: 'A' }]
          }),
          frame(
            'stale',
            { bodyId: m.plateId, hash: 12345 },
            {
              characteristic: 'flatness'
            }
          )
        ]
      }
    };
    const step = await adapter.exportStepReport(
      document,
      [m.plateId, m.pinId],
      AP242
    );
    expect(step.text).toMatch(/DATUM\('datum A'/);
    expect(step.text).not.toMatch(/PARALLELISM_TOLERANCE/);
    expect(step.warnings).toEqual([
      'Flatness | 0.1 — its face no longer resolves on the model',
      'Parallelism | 0.1 | A — its primary datum A is on Plate Body, which this file writes as a separate part'
    ]);
    // Ungrouped, both bodies share one product and the frame is written.
    const plain = await adapter.exportStepReport(
      { ...m.document, pmi: document.pmi },
      [m.plateId, m.pinId],
      AP242
    );
    expect(plain.text).toMatch(/PARALLELISM_TOLERANCE\(/);
    expect(plain.warnings).toEqual([
      'Flatness | 0.1 — its face no longer resolves on the model'
    ]);
    // Exporting the pin alone leaves its datum unwritten, and says so.
    const alone = await adapter.exportStepReport(
      { ...m.document, pmi: document.pmi },
      [m.pinId],
      AP242
    );
    expect(alone.warnings).toEqual([
      'Parallelism | 0.1 | A — its primary datum A is on a face or body this file does not write'
    ]);
  }, 120_000);

  it('names PMI whose body no longer exists on a whole-model export, and not on a selected body', async () => {
    const m = await plateAndPin();
    const plateFeature = listNodesByKind(m.document, 'feature').find(
      (node) => node.name === 'Plate'
    )!;
    const manager = new CommandManager({
      ...m.document,
      pmi: {
        annotations: [
          datum('a', 'A', m.ref(m.faces.plateBottom)),
          frame('cyl', m.ref(m.faces.barrel), {
            characteristic: 'cylindricity',
            amount: 0.004
          })
        ]
      }
    });
    manager.execute(
      commandFactories.deleteFeature({
        featureId: plateFeature.featureId
      })
    );
    const document = manager.document;
    expect(document.bodyOrder).toEqual([m.pinId]);
    // Objects shows the datum broken: its body is gone.
    const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
    expect(resolveModelPmi(document.pmi, bodies).get(id('a'))).toMatchObject({
      ok: false,
      reason: 'body-missing'
    });
    const whole = await adapter.exportStepReport(document, [m.pinId], AP242);
    expect(whole.text).toMatch(/CYLINDRICITY_TOLERANCE\(/);
    expect(whole.warnings).toEqual([
      'Datum A — its body is no longer on the model'
    ]);
    // A body the user chose leaves the rest of the model out of scope.
    const chosen = await adapter.exportStepReport(document, [m.pinId], {
      ...AP242,
      bodySelection: true
    });
    expect(chosen.warnings).toEqual([]);
  }, 120_000);

  it('plans entries against the file’s parts without the kernel', () => {
    const face = (solid: number, surface = 'plane') => ({
      solid,
      face: 0,
      surface
    });
    const planned = planStepPmi(
      [
        { kind: 'datum', letter: 'A', face: face(0), name: 'Datum A' },
        {
          kind: 'frame',
          name: 'Parallelism | 0.1 | A',
          characteristic: 'parallelism',
          amount: 0.1,
          diameterZone: false,
          datums: [{ letter: 'A' }],
          face: face(0)
        },
        {
          kind: 'frame',
          name: 'Cylindricity | 0.1',
          characteristic: 'cylindricity',
          amount: 0.1,
          diameterZone: false,
          datums: [],
          face: face(1, 'cylinder')
        }
      ],
      [0, 1],
      ['Plate', 'Pin'],
      new Set(['A'])
    );
    expect(planned.omitted).toEqual([]);
    expect(planned.entries).toHaveLength(3);
  });
});
