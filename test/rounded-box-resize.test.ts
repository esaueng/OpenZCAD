import { boxPreviewProfile } from '../apps/web/src/lib/interaction/boxPreviewProfile';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  chamferEdges,
  listFeaturesInOrder,
  transformBody,
  setParameter,
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { CommandManager, replayCommands } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type ParamValue,
  type ProjectDocument
} from '@openzcad/shared';
import {
  faceOffsetBaseline,
  planFaceOffset
} from '../apps/web/src/lib/interaction/faceOffsetPlan';

const dimensions = { width: 40, height: 24, depth: 10 };
const dimensionByAxis = { x: 'width', y: 'height', z: 'depth' } as const;
type Axis = keyof typeof dimensionByAxis;
type Side = 'min' | 'max';
let adapter: ExactKernelAdapter;

function sideFace(body: BodyRepresentation, axis: Axis, side: Side) {
  const face = body.topology!.faces.find(
    (f) => f.reference?.lineageName === `modifier.box.face.${axis}-${side}`
  );
  expect(face, `${axis}-${side} keeps its exact role`).toBeDefined();
  return face!;
}

async function roundedBox(
  values: Record<string, ParamValue> = dimensions,
  kind: 'fillet' | 'chamfer' = 'fillet'
) {
  const initial = addPrimitiveFeature(
    setParameter(
      createProjectDocument('Rounded box', toUserId('user_rounded_box')),
      { name: 'w', expression: '40' }
    ),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: values
    }
  );
  const sourceBodyId = initial.bodyOrder[0]!;
  const base = await adapter.syncDocument(initial);
  expect(base.warnings).toEqual([]);
  const edges = base.bodyRepresentations[sourceBodyId]!.topology!.edges.filter(
    (e) => e.displayRole !== 'seam'
  );
  const modified = (kind === 'fillet' ? filletEdges : chamferEdges)(initial, {
    name: 'Round edges',
    targetBodyId: sourceBodyId,
    edgeHashes: edges.map((e) => e.hash),
    edgeReferences: edges.map((e) => e.reference!),
    size: 1.5
  });
  const result = await adapter.syncDocument(modified.document);
  expect(result.warnings).toEqual([]);
  return {
    document: modified.document,
    bodyId: modified.bodyId,
    body: result.bodyRepresentations[modified.bodyId]!
  };
}

function resize(
  document: ProjectDocument,
  model: Awaited<ReturnType<typeof roundedBox>>,
  body: BodyRepresentation,
  axis: Axis,
  side: Side,
  offset: number,
  exact?: ParamValue
) {
  const face = sideFace(body, axis, side);
  const plan = planFaceOffset({
    document,
    bodyId: model.bodyId,
    face,
    faceHash: face.hash,
    offset,
    exact
  });
  expect(plan?.kind).toBe('primitive-dimension');
  if (plan?.kind !== 'primitive-dimension')
    throw new Error('Expected source box resize');
  return plan;
}

describe('rounded box body resizing', { timeout: 120000 }, () => {
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 60000);
  afterAll(() => adapter.dispose());

  it('recognizes the straight span between end fillets on all six sides', async () => {
    const { body } = await roundedBox();
    for (const axis of ['x', 'y', 'z'] as const) {
      for (const sign of [-1, 1]) {
        const direction = { x: 0, y: 0, z: 0, [axis]: sign };
        const profile = boxPreviewProfile(body, direction);
        expect(profile, `${axis} ${sign}`).not.toBeNull();
        const start =
          sign > 0 ? body.bbox.min[axis] + 1.5 : body.bbox.max[axis] - 1.5;
        const end =
          sign > 0 ? body.bbox.max[axis] - 1.5 : body.bbox.min[axis] + 1.5;
        expect(profile!.axisStart[axis]).toBeCloseTo(start, 4);
        expect(profile!.axisEnd[axis]).toBeCloseTo(end, 4);
      }
    }
    expect(boxPreviewProfile(body, { x: 1, y: 1, z: 0 })).toBeNull();
    expect(boxPreviewProfile(body, { x: NaN, y: 0, z: 0 })).toBeNull();
    const extraFace = {
      ...body,
      topology: {
        ...body.topology!,
        faces: [
          ...body.topology!.faces,
          body.topology!.faces.find(
            (face) => face.geometry?.surfaceType === 'plane'
          )!
        ]
      }
    };
    expect(boxPreviewProfile(extraFace, { x: 1, y: 0, z: 0 })).toBeNull();
  });

  for (const kind of ['fillet', 'chamfer'] as const)
    for (const axis of ['x', 'y', 'z'] as const)
      for (const side of ['min', 'max'] as const)
        for (const offset of [4, -2]) {
          it(`${kind}: ${axis}-${side} at ${offset} keeps the opposite side and rebuilds the whole boundary`, async () => {
            const model = await roundedBox(dimensions, kind);
            const plan = resize(
              model.document,
              model,
              model.body,
              axis,
              side,
              offset
            );
            expect(plan.preflightRejection).toBeUndefined();
            const derived = await adapter.syncDocument(
              plan.command.apply(model.document)
            );
            expect(derived.warnings).toEqual([]);
            const body = derived.bodyRepresentations[model.bodyId]!;
            const key = dimensionByAxis[axis];
            const oracle = await roundedBox(
              { ...dimensions, [key]: dimensions[key] + offset },
              kind
            );
            expect(body.volume).toBeCloseTo(oracle.body.volume, 6);
            expect(body.topology!.faces).toHaveLength(26);
            const opposite = side === 'min' ? 'max' : 'min';
            expect(
              sideFace(body, axis, opposite).geometry!.center[axis]
            ).toBeCloseTo(
              sideFace(model.body, axis, opposite).geometry!.center[axis],
              7
            );
            expect(
              sideFace(body, axis, side).geometry!.center[axis]
            ).toBeCloseTo(
              sideFace(model.body, axis, side).geometry!.center[axis] +
                (side === 'min' ? -offset : offset),
              7
            );
            for (const face of body.topology!.faces.filter(
              (f) => f.geometry!.surfaceType === 'cylinder'
            )) {
              expect(face.geometry!.radius).toBeCloseTo(1.5, 7);
            }
          });
        }

  it('keeps parameter expressions, repeated exact entry, replay, reopen and undo associative', async () => {
    const model = await roundedBox({ width: 'w', height: '24', depth: '10' });
    const manager = new CommandManager(model.document);
    for (const [side, delta, exact] of [
      ['min', 4, '2 * 2'],
      ['max', 3, undefined],
      ['min', -2, '-2']
    ] as const) {
      const before = await adapter.syncDocument(manager.document);
      const body = before.bodyRepresentations[model.bodyId]!;
      const plan = resize(
        manager.document,
        model,
        body,
        'x',
        side,
        delta,
        exact
      );
      manager.execute(plan.command);
      const after = await adapter.syncDocument(manager.document);
      expect(after.warnings).toEqual([]);
      const changed = after.bodyRepresentations[model.bodyId]!;
      manager.undo();
      expect(
        (await adapter.syncDocument(manager.document)).bodyRepresentations[
          model.bodyId
        ]!.volume
      ).toBeCloseTo(body.volume, 7);
      manager.redo();
      expect(
        (await adapter.syncDocument(manager.document)).bodyRepresentations[
          model.bodyId
        ]!.volume
      ).toBeCloseTo(changed.volume, 7);
    }
    const features = listFeaturesInOrder(manager.document);
    expect(
      features.filter((f) => f.data.featureKind === 'transform')
    ).toHaveLength(1);
    expect(
      features.filter((f) => f.data.featureKind === 'direct-edit')
    ).toHaveLength(0);
    const box = features[0]!;
    expect(box.data.featureKind).toBe('primitive');
    if (box.data.featureKind !== 'primitive') throw new Error('Missing box');
    expect(box.data.dimensions.width).toContain('w');
    const updated = setParameter(manager.document, {
      name: 'w',
      expression: '50'
    });
    const body = (await adapter.syncDocument(updated)).bodyRepresentations[
      model.bodyId
    ]!;
    expect(sideFace(body, 'x', 'min').geometry!.center.x).toBeCloseTo(-2, 7);
    expect(sideFace(body, 'x', 'max').geometry!.center.x).toBeCloseTo(53, 7);
    const face = sideFace(body, 'x', 'min');
    expect(
      faceOffsetBaseline(updated, model.bodyId, face, face.hash)?.total
    ).toBeCloseTo(55, 7);
    const final = (await adapter.syncDocument(manager.document))
      .bodyRepresentations[model.bodyId]!;
    const replayed = replayCommands(
      model.document,
      manager.document.commandLog.slice(model.document.commandLog.length)
    );
    const reopened = normalizeDocument(
      JSON.parse(
        JSON.stringify(withoutDerivedProjection(manager.document))
      ) as ProjectDocument
    );
    for (const document of [replayed, reopened]) {
      const result = await adapter.syncDocument(document);
      expect(result.warnings).toEqual([]);
      expect(result.bodyRepresentations[model.bodyId]!.volume).toBeCloseTo(
        final.volume,
        7
      );
    }
    const step = await adapter.exportStep(manager.document, [model.bodyId]);
    expect(step).toContain('CYLINDRICAL_SURFACE');
    expect(step).toContain('SPHERICAL_SURFACE');
    const imported = await adapter.inspectStep(step);
    expect(imported.solid).toBe(true);
    expect(imported.volume).toBeCloseTo(final.volume, 3);
  });

  it('moves either side the requested world distance after rotation and scale', async () => {
    const model = await roundedBox();
    let document = transformBody(model.document, {
      name: 'Place',
      targetBodyId: model.bodyId,
      translation: { x: 13, y: -9, z: 4 },
      rotationDeg: { x: 35, y: 20, z: 60 },
      scale: 3
    }).document;
    for (const side of ['min', 'max'] as const) {
      const before = (await adapter.syncDocument(document)).bodyRepresentations[
        model.bodyId
      ]!;
      const selected = sideFace(before, 'z', side);
      const opposite = side === 'min' ? 'max' : 'min';
      const plan = resize(
        document,
        model,
        before,
        'z',
        side,
        8,
        side === 'min' ? 8 : '8'
      );
      const baseline = faceOffsetBaseline(
        document,
        model.bodyId,
        selected,
        selected.hash
      )!;
      expect(plan.value - baseline.total).toBeCloseTo(8, 7);
      document = plan.command.apply(document);
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[model.bodyId]!;
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(sideFace(body, 'z', side).geometry!.center[axis]).toBeCloseTo(
          selected.geometry!.center[axis] +
            8 * selected.geometry!.normal![axis],
          6
        );
        expect(
          sideFace(body, 'z', opposite).geometry!.center[axis]
        ).toBeCloseTo(
          sideFace(before, 'z', opposite).geometry!.center[axis],
          6
        );
      }
      expect(body.topology!.faces).toHaveLength(26);
    }
  });

  it('rejects an empty dimension before adding a placement and rejects a fillet that no longer fits', async () => {
    const model = await roundedBox();
    const empty = resize(model.document, model, model.body, 'z', 'min', -10);
    expect(empty.preflightRejection).toBeDefined();
    expect(empty.command.commands).toBeUndefined();
    const tooSmall = resize(model.document, model, model.body, 'z', 'min', -9);
    const derived = await adapter.syncDocument(
      tooSmall.command.apply(model.document)
    );
    expect(derived.warnings.length).toBeGreaterThan(0);
  });
});
