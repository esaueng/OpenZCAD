import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchReferenceDimension,
  createProjectDocument,
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  normalizeDocument,
  resolvedSketchDocument,
  resolveParamValue
} from '@openzcad/document-core';
import {
  frameForPlaneRef,
  projectableCurveFromTopology,
  projectEdgeToSketch
} from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  createSketchCompositeCornerTarget,
  resolveSketchReferenceDimension,
  toProjectId,
  toSketchReferenceAnnotationId,
  toUserId,
  type EntityId,
  type ParamValue,
  type ProjectDocument,
  type SketchConstraintData,
  type SketchId,
  type SketchObjectData,
  type SketchPlaneRef,
  type SketchReferenceDimension
} from '@openzcad/shared';
import { historyFeatureDigest } from '../packages/kernel-adapter/src/exact-history-cache';

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);
afterAll(() => adapter.dispose());

const line = (
  x1: ParamValue,
  y1: ParamValue,
  x2: ParamValue,
  y2: ParamValue
): SketchObjectData => ({ objectKind: 'line', x1, y1, x2, y2 });

async function fixture() {
  const initial = createProjectDocument(
    'Resolved named reference',
    toUserId('user_resolved_reference')
  );
  const manager = new CommandManager(initial);
  manager.execute(
    commandFactories.setParameter({ name: 'w', expression: '20' })
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Source',
      primitiveKind: 'box',
      dimensions: { width: 'w', height: 10, depth: 5 }
    })
  );
  const sourceId = manager.document.bodyOrder[0]!;
  const source = await adapter.syncDocument(manager.document);
  const edge = source.bodyRepresentations[sourceId]!.topology!.edges.find(
    (candidate) => {
      const p = candidate.points;
      const end = p.length - 3;
      return (
        candidate.reference &&
        candidate.curve?.type === 'LINE' &&
        p[1] === 0 &&
        p[end + 1] === 0 &&
        p[2] === 5 &&
        p[end + 2] === 5 &&
        p[0] !== p[end]
      );
    }
  );
  if (!edge?.reference)
    throw new Error('Expected a verified top-front source edge.');
  const plane: SketchPlaneRef = { type: 'canonical', plane: 'XY', offset: 8 };
  const projected = projectEdgeToSketch(
    projectableCurveFromTopology(edge),
    frameForPlaneRef(plane, Number)
  );
  if (projected.status !== 'projected' || projected.data.objectKind !== 'line')
    throw new Error('Expected an exact projected line.');
  manager.execute(
    commandFactories.addSketch({
      name: 'Held plate',
      planeRef: plane,
      objects: [
        {
          ...projected.data,
          x1: 0,
          y1: 0,
          x2: 20,
          y2: 0,
          construction: true,
          projection: {
            mode: 'linked',
            source: { bodyId: sourceId, edgeReference: edge.reference }
          }
        },
        line(0, 0, 20, 0),
        line(20, 0, 20, 6),
        line(20, 6, 0, 6),
        line(0, 6, 0, 0)
      ]
    })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  const [projectionId, ...loop] = findSketch(
    manager.document,
    sketchId
  )!.objectIds;
  const [bottom, right, top, left] = loop as [
    EntityId,
    EntityId,
    EntityId,
    EntityId
  ];
  const constraints: SketchConstraintData[] = loop.map((id, i) => ({
    constraintKind: 'coincident',
    a: { objectId: id, point: 'end' },
    b: { objectId: loop[(i + 1) % 4]!, point: 'start' }
  }));
  constraints.push(
    {
      constraintKind: 'coincident',
      a: { objectId: bottom, point: 'start' },
      b: { objectId: projectionId!, point: 'start' }
    },
    {
      constraintKind: 'coincident',
      a: { objectId: bottom, point: 'end' },
      b: { objectId: projectionId!, point: 'end' }
    },
    { constraintKind: 'horizontal', objectId: top },
    { constraintKind: 'vertical', objectId: right },
    { constraintKind: 'vertical', objectId: left },
    {
      constraintKind: 'distance',
      a: { objectId: right, point: 'start' },
      b: { objectId: right, point: 'end' },
      value: 6
    }
  );
  manager.runTransaction(
    'Hold closed outline',
    constraints.map((constraint) =>
      commandFactories.addSketchConstraint({ sketchId, constraint })
    )
  );
  manager.execute(
    commandFactories.addSketchComposite({
      sketchId,
      composite: { compositeKind: 'rectangle', method: 'corner', edgeIds: loop }
    })
  );
  const bottomNode = manager.document.nodes[bottom];
  const rightNode = manager.document.nodes[right];
  if (
    bottomNode?.kind !== 'sketch-object' ||
    bottomNode.data.objectKind !== 'line' ||
    rightNode?.kind !== 'sketch-object' ||
    rightNode.data.objectKind !== 'line'
  )
    throw new Error('Expected ordinary outline lines.');
  manager.runTransaction('Keep authored expressions', [
    commandFactories.updateSketchObject({
      sketchId,
      objectId: bottom,
      data: { ...bottomNode.data, x2: 'w' }
    }),
    commandFactories.updateSketchObject({
      sketchId,
      objectId: right,
      data: { ...rightNode.data, x1: '2 cm', y2: '6 mm' }
    })
  ]);
  manager.execute(
    commandFactories.extrudeSketch({
      name: 'Plate',
      sketchId,
      distance: 3,
      profiles: [{ all: true, sourceEntityIds: loop }]
    })
  );
  const plateId = manager.document.bodyOrder.at(-1)!;
  manager.execute(
    commandFactories.setParameter({ name: 'w', expression: '32' })
  );
  const built = await adapter.syncDocument(manager.document);
  expect(built.warnings).toEqual([]);
  expect(built.bodyRepresentations[plateId]!.volume).toBeCloseTo(576, 6);
  manager.commitDerivedState(built);
  const composite = findSketch(manager.document, sketchId)!.composites![0]!;
  const annotation: SketchReferenceDimension = {
    annotationId: toSketchReferenceAnnotationId('sref_exact_resolved'),
    data: {
      dimensionKind: 'distance',
      distanceMode: 'horizontal',
      a: createSketchCompositeCornerTarget(composite, 0),
      b: createSketchCompositeCornerTarget(composite, 1)
    }
  };
  return {
    initial,
    manager,
    sketchId,
    loop,
    bottom,
    right,
    plateId,
    annotation
  };
}

function expectMeasured(
  document: ProjectDocument,
  sketchId: SketchId,
  reference: SketchReferenceDimension
) {
  const sketch = findSketch(document, sketchId)!;
  const view = resolvedSketchDocument(document);
  const objects = new Map(
    sketch.objectIds.flatMap((id) => {
      const node = view.nodes[id];
      return node?.kind === 'sketch-object' ? [[id, node.data] as const] : [];
    })
  );
  const outcome = resolveSketchReferenceDimension(
    objects,
    reference,
    (value) =>
      resolveParamValue(
        value,
        getParameterScope(document).scope,
        undefined,
        document.units
      ),
    sketch.composites
  );
  expect(outcome.status).toBe('current');
  if (outcome.status !== 'current' || outcome.dimensionKind !== 'distance')
    throw new Error('Expected a current named distance.');
  expect(outcome.value).toBeCloseTo(32, 8);
}

it('adds and replays a real solved named reference without rewriting mixed authored seeds or geometry digests', async () => {
  const f = await fixture();
  const base = f.manager.document;
  expectMeasured(base, f.sketchId, f.annotation);
  expect(base.nodes[f.bottom]).toMatchObject({ data: { x2: 'w' } });
  expect(base.nodes[f.right]).toMatchObject({
    data: { x1: '2 cm', x2: 20, y2: '6 mm' }
  });
  const input = {
    sketchId: f.sketchId,
    data: f.annotation.data,
    ids: { annotationId: f.annotation.annotationId }
  };
  const command = commandFactories.addSketchReferenceDimension(input);
  const before = JSON.stringify(base);
  for (const mismatch of ['missing', 'old', 'future', 'foreign'] as const) {
    const document = { ...base, derived: { ...base.derived } };
    if (mismatch !== 'missing')
      document.derived.sketchGeometry = {
        ...base.derived.sketchGeometry!,
        ...(mismatch === 'foreign'
          ? { projectId: toProjectId('proj_foreign') }
          : { documentVersion: base.version + (mismatch === 'old' ? -1 : 1) })
      };
    const frozen = JSON.stringify(document);
    const manager = new CommandManager(document);
    expect(() => manager.execute(command)).toThrow(/no longer meet/);
    expect(() => addSketchReferenceDimension(document, input)).toThrow(
      /no longer meet/
    );
    expect(manager.document).toBe(document);
    expect(JSON.stringify(document)).toBe(frozen);
  }
  const manager = new CommandManager(base);
  expect(manager.document).toBe(base);
  expect(manager.document.derived.sketchGeometry).toBe(
    base.derived.sketchGeometry
  );
  const digests = (document: ProjectDocument) =>
    listFeaturesInOrder(document).map((feature, index) =>
      historyFeatureDigest(document, feature, index)
    );
  const beforeDigests = digests(base);
  const cursor = base.editHistory!.cursor;
  manager.execute(command);
  const added = manager.document;
  expect(JSON.stringify(base)).toBe(before);
  expect(
    added.commandLog.slice(base.commandLog.length).map((entry) => entry.kind)
  ).toEqual(['reference-dimension.add']);
  expect(added.editHistory!.cursor).toBe(cursor + 1);
  expect(findSketch(added, f.sketchId)!.referenceDimensions).toEqual([
    f.annotation
  ]);
  for (const [id, node] of Object.entries(base.nodes)) {
    if (node.kind === 'sketch')
      expect({ ...added.nodes[id], referenceDimensions: undefined }).toEqual({
        ...node,
        referenceDimensions: undefined
      });
    else expect(added.nodes[id]).toEqual(node);
  }
  expect(digests(added)).toEqual(beforeDigests);
  manager.undo();
  expect(manager.document.nodes).toEqual(base.nodes);
  manager.redo();
  expect(manager.document.nodes).toEqual(added.nodes);
  const replayed = replayCommands(
    f.initial,
    JSON.parse(
      JSON.stringify(added.commandLog)
    ) as ProjectDocument['commandLog']
  );
  expect(replayed.derived.sketchGeometry).toBeUndefined();
  const reopened = normalizeDocument(
    JSON.parse(JSON.stringify(added)) as ProjectDocument
  );
  expect(reopened.derived.sketchGeometry).toBeUndefined();
  for (const restored of [manager.document, replayed, reopened]) {
    expect(restored.nodes).toEqual(added.nodes);
    expect(digests(restored)).toEqual(beforeDigests);
    const cold = await createExactKernelAdapter();
    try {
      const built = await cold.syncDocument(restored);
      expect(built.warnings).toEqual([]);
      expect(built.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(576, 6);
      const live = new CommandManager(restored);
      live.commitDerivedState(built);
      expectMeasured(live.document, f.sketchId, f.annotation);
    } finally {
      cold.dispose();
    }
  }
});
