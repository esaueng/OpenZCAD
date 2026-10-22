import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  getParameterScope,
  resolveParamValue,
  resolvedSketchDocument
} from '@openzcad/document-core';
import {
  frameForPlaneRef,
  projectEdgeToSketch,
  projectableCurveFromTopology,
  computeSketchProfileAnalysis
} from '@openzcad/geometry';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type EntityId,
  type ParamValue,
  type SketchConstraintData,
  type SketchObjectData,
  type SketchPlaneRef
} from '@openzcad/shared';
const plane: SketchPlaneRef = { type: 'canonical', plane: 'XY', offset: 8 };
const basis = frameForPlaneRef(plane, Number);
const line = (
  x1: ParamValue,
  y1: ParamValue,
  x2: ParamValue,
  y2: ParamValue
): SketchObjectData => ({ objectKind: 'line', x1, y1, x2, y2 });
/** A real verified edge drives an ordinary, independently dimensioned closed loop. */
async function constrainedPlate(
  adapter: ExactKernelAdapter,
  locked = false,
  typed = false
) {
  const initial = createProjectDocument(
    'Projection constraints',
    toUserId('user_projection_constraints')
  );
  const manager = new CommandManager(initial);
  manager.execute(
    commandFactories.setParameter({
      name: 'w',
      expression: typed ? '2 cm' : '20',
      ...(typed ? { quantity: 'length' as const } : {})
    })
  );
  if (typed)
    manager.execute(
      commandFactories.setParameter({
        name: 'h',
        expression: '0.6 cm',
        quantity: 'length'
      })
    );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Source',
      primitiveKind: 'box',
      dimensions: { width: 'w', height: 10, depth: 5 }
    })
  );
  const sourceId = manager.document.bodyOrder[0]!;
  const built = await adapter.syncDocument(manager.document);
  const edge = built.bodyRepresentations[sourceId]!.topology!.edges.find(
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
  if (!edge) throw new Error('Expected a verified top-front source edge.');
  const projected = projectEdgeToSketch(
    projectableCurveFromTopology(edge),
    basis
  );
  if (projected.status !== 'projected' || projected.data.objectKind !== 'line')
    throw new Error('Expected an exact projected source line.');
  const shadow: SketchObjectData = {
    ...projected.data,
    // Give endpoint constraints the same names regardless of kernel edge orientation.
    x1: 0,
    y1: 0,
    x2: 20,
    y2: 0,
    construction: true,
    projection: {
      mode: 'linked',
      source: { bodyId: sourceId, edgeReference: edge.reference! }
    }
  };
  manager.execute(
    commandFactories.addSketch({
      name: 'Constrained linked plate',
      planeRef: plane,
      objects: [
        shadow,
        line(0, 0, typed ? '2 cm' : 20, 0),
        line(typed ? '2 cm' : 20, 0, typed ? '2 cm' : 20, typed ? 'h' : 6),
        line(typed ? '2 cm' : 20, typed ? 'h' : 6, 0, typed ? 'h' : 6),
        line(0, typed ? 'h' : 6, 0, 0),
        ...(typed
          ? [
              {
                ...line('2 cm', 0, '2 cm', '4 mm'),
                construction: true,
                projection: { mode: 'unlinked' as const }
              }
            ]
          : [])
      ]
    })
  );
  const sketchId = manager.document.sketchOrder[0]!;
  const ids = findSketch(manager.document, sketchId)!.objectIds;
  const [projectionId, bottom, right, top, left] = ids as [
    EntityId,
    EntityId,
    EntityId,
    EntityId,
    EntityId
  ];
  const constrain = (constraint: SketchConstraintData) =>
    manager.execute(
      commandFactories.addSketchConstraint({ sketchId, constraint })
    );
  const loop = [bottom, right, top, left];
  for (const [i, id] of loop.entries())
    constrain({
      constraintKind: 'coincident',
      a: { objectId: id, point: 'end' },
      b: { objectId: loop[(i + 1) % 4]!, point: 'start' }
    });
  constrain({
    constraintKind: 'coincident',
    a: { objectId: bottom, point: 'start' },
    b: { objectId: projectionId, point: 'start' }
  });
  constrain({
    constraintKind: 'coincident',
    a: { objectId: bottom, point: 'end' },
    b: { objectId: projectionId, point: 'end' }
  });
  constrain({ constraintKind: 'horizontal', objectId: top });
  constrain({ constraintKind: 'vertical', objectId: right });
  constrain({ constraintKind: 'vertical', objectId: left });
  constrain({
    constraintKind: 'distance',
    a: { objectId: right, point: 'start' },
    b: { objectId: right, point: 'end' },
    value: typed ? 'h + 0 mm' : 6
  });
  const constructionId = typed ? ids[5]! : undefined;
  if (constructionId) {
    constrain({
      constraintKind: 'coincident',
      a: { objectId: constructionId, point: 'start' },
      b: { objectId: projectionId, point: 'end' }
    });
    constrain({ constraintKind: 'vertical', objectId: constructionId });
    constrain({
      constraintKind: 'distance',
      a: { objectId: constructionId, point: 'start' },
      b: { objectId: constructionId, point: 'end' },
      value: '4 mm'
    });
  }
  if (locked)
    constrain({
      constraintKind: 'lock',
      point: { objectId: bottom, point: 'end' },
      x: 20,
      y: 0
    });
  const solved = await adapter.solveSketch(manager.document, sketchId);
  if (!solved.converged || solved.rolledBack)
    throw new Error('Expected a converged fixture solve.');
  return { initial, manager, sourceId, sketchId, projectionId, loop };
}

export async function currentHoledPlate(
  adapter: ExactKernelAdapter,
  typed = true,
  precise = true
) {
  const f = await constrainedPlate(adapter, false, typed);
  f.manager.execute(
    commandFactories.addSketchObjects({
      sketchId: f.sketchId,
      objects: [
        {
          objectKind: 'rectangle',
          width: '2 mm',
          height: '2 mm',
          centerX: 25,
          centerY: 3
        }
      ]
    })
  );
  const sourceObjectId = findSketch(
    f.manager.document,
    f.sketchId
  )!.objectIds.at(-1)!;
  f.manager.execute(
    commandFactories.setParameter({
      name: 'w',
      expression: typed ? '3.2 cm' : '32',
      ...(typed ? { quantity: 'length' as const } : {})
    })
  );
  f.manager.commitDerivedState(await adapter.syncDocument(f.manager.document));
  const read = resolvedSketchDocument(f.manager.document);
  const sketch = findSketch(read, f.sketchId)!;
  const scope = getParameterScope(read).scope;
  const profile = computeSketchProfileAnalysis(
    sketch.objectIds.map((id) => {
      const node = read.nodes[id]!;
      if (node.kind !== 'sketch-object')
        throw new Error('Expected sketch geometry.');
      return { id, data: node.data };
    }),
    (value) => resolveParamValue(value, scope, 'test', read.units)
  ).profiles.find((candidate) => candidate.holes.length === 1)!;
  if (!Number.isFinite(profile.area) || Math.abs(profile.area - 188) >= 0.5e-8)
    throw new Error('Expected fixture area188.');
  const { profileId, regionFingerprint, samplePoint, sourceEntityIds } =
    profile;
  const reference = {
    profileId,
    regionFingerprint,
    samplePoint,
    sourceEntityIds,
    sourceArea: profile.area,
    ...(precise ? { sourceBoundaryLoops: profile.sourceBoundaryLoops! } : {})
  };
  f.manager.execute(
    commandFactories.extrudeSketch({
      name: 'Holed plate',
      bodyName: 'Qualified plate',
      sketchId: f.sketchId,
      distance: 3,
      profile: reference
    })
  );
  const plateId = f.manager.document.bodyOrder.at(-1)!;
  const derived = await adapter.syncDocument(f.manager.document);
  if (derived.warnings.length)
    throw new Error('Expected no fixture build warnings.');
  if (
    !Number.isFinite(derived.bodyRepresentations[plateId]!.volume) ||
    Math.abs(derived.bodyRepresentations[plateId]!.volume - 564) >= 0.5e-6
  )
    throw new Error('Expected fixture volume564.');
  f.manager.commitDerivedState(derived);
  return { ...f, sourceObjectId, plateId, reference };
}
