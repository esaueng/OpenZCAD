import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  isModelPmiCommandKind,
  replayCommands
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  normalizeDocument,
  setParameter
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  modelPmiSetError,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type ModelPmiAnnotation,
  type ModelPmiId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  draftModelPmi,
  modelPmiName,
  modelPmiSvg,
  pmiFaceRef,
  pmiViewportLabels,
  resolveModelPmi
} from '../apps/web/src/lib/pmi/modelPmi';
import {
  datumFeatureLayout,
  featureControlFrameLayout
} from '../apps/web/src/lib/drawing/toleranceFrames';

const layouts = { datumFeatureLayout, featureControlFrameLayout };

/**
 * D07 slice C (schema v106): model-based definition. Datum features and
 * feature control frames stored on the model's faces, edited by undoable
 * commands that never rebuild, resolved by lineage through model edits and
 * broken by name when their face is gone.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const id = (name: string) => `pmi_${name}` as ModelPmiId;

/** A w × 10 × 6 box: its bottom (z min) and its +x side. */
async function box(width = 20, from?: ProjectDocument) {
  let document =
    from ??
    addPrimitiveFeature(
      setParameter(createProjectDocument('Block', toUserId('test')), {
        name: 'w',
        expression: String(width)
      }),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 'w', height: 10, depth: 6 }
      }
    );
  if (from)
    document = setParameter(from, { name: 'w', expression: String(width) });
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  const bodyId = document.bodyOrder[0] as BodyId;
  const faces = bodies[bodyId]!.topology!.faces;
  const plane = (axis: 'x' | 'z', sign: 1 | -1) =>
    faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs((face.geometry.normal?.[axis] ?? 0) - sign) < 1e-9
    )!;
  return {
    document,
    bodies,
    bodyId,
    bottom: plane('z', -1),
    side: plane('x', 1)
  };
}

function bracket(m: Awaited<ReturnType<typeof box>>): ModelPmiAnnotation[] {
  return [
    {
      pmiId: id('a'),
      kind: 'datum-feature',
      face: pmiFaceRef(m.bodies, m.bodyId, m.bottom.hash)!,
      anchor: { x: 5, y: 3, z: 0 },
      letter: 'A'
    },
    {
      pmiId: id('perp'),
      kind: 'feature-control-frame',
      face: pmiFaceRef(m.bodies, m.bodyId, m.side.hash)!,
      anchor: { x: 20, y: 3, z: 5 },
      characteristic: 'perpendicularity',
      amount: 0.05,
      datums: [{ letter: 'A' }]
    }
  ];
}

describe('D07 model PMI (schema v106)', () => {
  it('claims v106 and validates the section by name', async () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(106);
    const m = await box();
    const [datum, frame] = bracket(m) as unknown as [
      Record<string, unknown>,
      Record<string, unknown>
    ];
    expect(modelPmiSetError({ annotations: [datum, frame] })).toBeNull();
    const bad: [unknown, RegExp][] = [
      [{ annotations: [] }, /stored as absent/],
      [{ annotations: [datum], extra: 1 }, /only its annotations/],
      [{ annotations: [{ ...datum, pmiId: 'x' }] }, /invalid id/],
      [{ annotations: [{ ...datum, viewId: 'v' }] }, /has no viewId/],
      [{ annotations: [{ ...datum, anchor: { x: 1, y: 2 } }] }, /anchor/],
      [{ annotations: [{ ...datum, face: null }] }, /names no face/],
      [{ annotations: [{ ...datum, letter: 'O' }] }, /other than I, O and Q/],
      [
        { annotations: [datum, { ...datum, pmiId: id('a2') }] },
        /Datum A is declared twice/
      ],
      [{ annotations: [datum, datum] }, /listed twice/],
      [
        { annotations: [{ ...frame, datums: undefined }] },
        /needs at least one datum/
      ],
      [
        { annotations: [{ ...frame, characteristic: 'flatness' }] },
        /takes no datum/
      ],
      [{ annotations: [{ ...frame, amount: 0 }] }, /positive amount/]
    ];
    for (const [value, message] of bad)
      expect(modelPmiSetError(value)).toMatch(message);
  });

  it('stores PMI by undoable commands that edit nothing else, and replays them', async () => {
    const m = await box();
    const manager = new CommandManager(m.document);
    const [datum, frame] = bracket(m) as [
      ModelPmiAnnotation,
      ModelPmiAnnotation
    ];
    manager.execute(commandFactories.addModelPmi({ annotation: datum }));
    manager.execute(commandFactories.addModelPmi({ annotation: frame }));
    expect(manager.undoIsModelPmiOnly).toBe(true);
    manager.execute(
      commandFactories.updateModelPmi({
        annotation: { ...frame, amount: 0.02 } as ModelPmiAnnotation
      })
    );
    expect(manager.document.pmi!.annotations[1]).toMatchObject({
      amount: 0.02
    });
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    const saved = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(saved.pmi).toEqual(manager.document.pmi);
    // The model's nodes and features are untouched: no rebuild is needed.
    expect(manager.document.nodes).toEqual(m.document.nodes);
    expect(
      manager.document.commandLog
        .slice(m.document.commandLog.length)
        .every((command) => isModelPmiCommandKind(command.kind))
    ).toBe(true);
    const replayed = replayCommands(
      { ...m.document, commandLog: [] },
      manager.document.commandLog
    );
    expect(replayed.pmi).toEqual(manager.document.pmi);
    manager.execute(commandFactories.deleteModelPmi({ pmiId: id('perp') }));
    expect(manager.document.pmi!.annotations).toHaveLength(1);
    manager.undo();
    manager.undo();
    expect(manager.document.pmi!.annotations[1]).toMatchObject({
      amount: 0.05
    });
    manager.undo();
    manager.undo();
    expect(manager.document.pmi).toBeUndefined();
    // Gated below v106.
    expect(() =>
      assertStorableDocument({
        ...saved,
        schemaVersion: 105
      })
    ).toThrow(/Model PMI require project schema v106/);
  });

  it('follows its face by lineage through a model edit, and breaks by name', async () => {
    const narrow = await box(20);
    const pmi = { annotations: bracket(narrow) };
    const wide = await box(30, narrow.document);
    expect(wide.side.hash).not.toBe(narrow.side.hash);
    const resolutions = resolveModelPmi(pmi, wide.bodies);
    const perp = resolutions.get(id('perp'))!;
    expect(perp.ok && perp.face).toBe(wide.side);
    // Its label follows the face: the stored point (x = 20) lands on the
    // widened side (x = 30), not where the side used to be.
    const moved = pmiViewportLabels(pmi, wide.bodies, null, layouts).find(
      (label) => label.pmiId === id('perp')
    )!;
    expect(moved.anchor.x).toBeCloseTo(30, 6);
    expect(moved.anchor.z).toBeCloseTo(5, 6);
    expect(moved.broken).toBe(false);
    expect(resolutions.get(id('a'))!.ok).toBe(true);
    // A frame naming an undeclared datum, and a face on a gone body.
    const orphan = resolveModelPmi(
      { annotations: [bracket(narrow)[1]!] },
      wide.bodies
    );
    expect(orphan.get(id('perp'))).toMatchObject({
      ok: false,
      reason: 'datum-undefined'
    });
    const gone = resolveModelPmi(pmi, {});
    expect(gone.get(id('a'))).toMatchObject({
      ok: false,
      reason: 'body-missing'
    });
    // The viewport says so.
    const labels = pmiViewportLabels(pmi, {}, id('a'), layouts);
    expect(
      labels.map((label) => [label.name, label.broken, label.selected])
    ).toEqual([
      ['Datum A', true, true],
      ['Perpendicularity | 0.05 | A', true, false]
    ]);
  });

  it('drafts new entries and draws them as a drawing does', async () => {
    const m = await box();
    const face = pmiFaceRef(m.bodies, m.bodyId, m.bottom.hash)!;
    expect(face.reference?.lineageName).toBeTruthy();
    const pmi = { annotations: bracket(m) };
    const datum = draftModelPmi(
      'datum-feature',
      face,
      { x: 1, y: 2, z: 0 },
      pmi,
      'mm'
    );
    expect(datum).toMatchObject({ kind: 'datum-feature', letter: 'B' });
    expect(datum.pmiId.startsWith('pmi_')).toBe(true);
    const frame = draftModelPmi(
      'feature-control-frame',
      face,
      { x: 1, y: 2, z: 0 },
      pmi,
      'inch',
      m.bottom.geometry
    );
    // The flat bottom takes flatness (#2321).
    expect(frame).toMatchObject({ characteristic: 'flatness', amount: 0.004 });
    expect(
      modelPmiSetError({ annotations: [...pmi.annotations, datum, frame] })
    ).toBeNull();
    const svg = modelPmiSvg(
      {
        ...(bracket(m)[1] as Extract<
          ModelPmiAnnotation,
          { kind: 'feature-control-frame' }
        >),
        characteristic: 'position',
        diameterZone: true,
        material: 'mmc'
      },
      layouts
    );
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('>Ø0.05</text>');
    expect(svg).toContain('>M</text>');
    expect(svg).toContain('>A</text>');
    expect(svg).toContain('class="pmi-stroke"');
    expect(modelPmiName(datum)).toBe('Datum B');
  });
});
