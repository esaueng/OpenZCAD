import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  deleteFeature,
  listFeaturesInOrder,
  findSketch,
  getParameterScope,
  resolveParamValue,
  normalizeDocument,
  resolvedSketchDocument
} from '@openzcad/document-core';
import {
  frameForPlaneRef,
  projectEdgeToSketch,
  projectableCurveFromTopology
} from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  toSketchId,
  toEntityId,
  type BodyId,
  type DerivedState,
  type EntityId,
  type FeatureData,
  type ParamValue,
  type ProjectDocument,
  type SketchConstraintData,
  type SketchObjectData,
  type SketchPlaneRef
} from '@openzcad/shared';
import { solvedSketchCommands } from '../apps/web/src/lib/sketch/applySolve';
import {
  projectionWriteBackCommand,
  unlinkedProjectionData
} from '../apps/web/src/lib/sketch/projection';
import { retainSketchGeometryCommands } from '../apps/web/src/lib/sketch/releaseGeometry';
import {
  assertFeatureSketchProjectionsValid,
  assertSketchProjectionsValid
} from '../packages/kernel-adapter/src/exact-sketch-projection-failures';
import { cloneBuildState } from '../packages/kernel-adapter/src/exact-history-cache';
import type { ExactBuildResult } from '../packages/kernel-adapter/src/exact-types';
import { sketchDataFromSolvedObject } from '../packages/kernel-adapter/src/gcs-sketch-document';

const plane: SketchPlaneRef = { type: 'canonical', plane: 'XY', offset: 8 };
const basis = frameForPlaneRef(plane, Number);
let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);
afterAll(() => {
  adapter.dispose();
});

const line = (
  x1: ParamValue,
  y1: ParamValue,
  x2: ParamValue,
  y2: ParamValue
): SketchObjectData => ({ objectKind: 'line', x1, y1, x2, y2 });
const volume = (derived: DerivedState, bodyId: BodyId) =>
  derived.bodyRepresentations[bodyId]!.volume;

/** A real verified edge drives an ordinary, independently dimensioned closed loop. */
async function constrainedPlate(locked = false, typed = false) {
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
  expect(edge, 'verified top-front source edge').toBeDefined();
  const projected = projectEdgeToSketch(
    projectableCurveFromTopology(edge!),
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
      source: { bodyId: sourceId, edgeReference: edge!.reference! }
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
  expect(solved.converged).toBe(true);
  expect(solved.rolledBack).toBe(false);
  manager.execute(
    commandFactories.extrudeSketch({
      name: 'Constrained plate',
      sketchId,
      distance: 3,
      profiles: [{ all: true, sourceEntityIds: loop }]
    })
  );
  const plateId = manager.document.bodyOrder.at(-1)!;
  return {
    initial,
    manager,
    sourceId,
    plateId,
    sketchId,
    projectionId,
    loop,
    constructionId
  };
}

/** Independent closed-form geometry; no build/solver output supplies these coordinates. */
function expectedPlate(
  f: Awaited<ReturnType<typeof constrainedPlate>>,
  document: ProjectDocument,
  width: number
) {
  const expected = structuredClone(document);
  const coordinates = [
    line(0, 0, width, 0),
    line(0, 0, width, 0),
    line(width, 0, width, 6),
    line(width, 6, 0, 6),
    line(0, 6, 0, 0)
  ];
  for (const [i, objectId] of [f.projectionId, ...f.loop].entries()) {
    const node = expected.nodes[objectId]!;
    if (node.kind !== 'sketch-object')
      throw new Error('Expected a sketch line.');
    node.data = { ...node.data, ...coordinates[i]! };
  }
  return expected;
}

function expectFreshProjection(
  f: Awaited<ReturnType<typeof constrainedPlate>>,
  built: DerivedState
) {
  expect(built.warnings).toEqual([]);
  const state = built.sketchProjections?.[f.projectionId];
  expect(state?.status).toBe('moved');
  if (state?.status !== 'moved' || state.data.objectKind !== 'line')
    throw new Error('Expected a fresh linked line.');
  expect(state.data.x1).toBeCloseTo(0, 9);
  expect(state.data.y1).toBeCloseTo(0, 9);
  expect(state.data.x2).toBeCloseTo(32, 9);
  expect(state.data.y2).toBeCloseTo(0, 9);
}

describe('linked projection constraint propagation before writeback', () => {
  it.each([false, true])(
    'keeps the solved shape when the last link is released (typed=%s)',
    async (typed) => {
      const f = await constrainedPlate(false, typed);
      f.manager.execute(
        commandFactories.setParameter({
          name: 'w',
          expression: typed ? '3.2 cm' : '32',
          ...(typed ? { quantity: 'length' as const } : {})
        })
      );
      const moved = await adapter.syncDocument(f.manager.document);
      const writeback = projectionWriteBackCommand(f.manager.document, moved);
      expect(writeback).not.toBeNull();
      f.manager.normalize(writeback!);
      f.manager.commitDerivedState(
        await adapter.syncDocument(f.manager.document)
      );
      const before = f.manager.document;
      const seeds = retainSketchGeometryCommands(before, f.sketchId, [
        f.projectionId
      ]);
      expect(seeds.length).toBeGreaterThan(0);
      // Failure after staging seed commands must leave history and authored data intact.
      expect(() =>
        f.manager.runTransaction('Invalid release', [
          ...seeds,
          commandFactories.updateSketchObject({
            sketchId: f.sketchId,
            objectId: toEntityId('missing_release_target'),
            data: line(0, 0, 1, 0)
          })
        ])
      ).toThrow();
      expect(f.manager.document).toBe(before);
      const view = resolvedSketchDocument(before);
      const target = view.nodes[f.projectionId];
      if (target?.kind !== 'sketch-object')
        throw new Error('Expected projected line.');
      const cursor = before.editHistory!.cursor;
      f.manager.runTransaction('Unlink projection', [
        ...seeds,
        commandFactories.updateSketchObject({
          sketchId: f.sketchId,
          objectId: f.projectionId,
          data: unlinkedProjectionData(target.data)
        })
      ]);
      expect(f.manager.document.editHistory!.cursor).toBe(cursor + 1);
      expect(
        volume(await adapter.syncDocument(f.manager.document), f.plateId)
      ).toBeCloseTo(576, 6);
      expect(f.manager.document.nodes[f.loop[1]!]).toMatchObject({
        data: { x1: expect.closeTo(32, 8) }
      });
      if (typed) {
        expect(f.manager.document.nodes[f.loop[1]!]).toMatchObject({
          data: { y2: 'h' }
        });
        expect(f.manager.document.nodes[f.constructionId!]).toMatchObject({
          data: { y2: '4 mm' }
        });
      }
      f.manager.undo();
      expect(f.manager.document.nodes[f.loop[1]!]).toEqual(
        before.nodes[f.loop[1]!]
      );
      expect(
        volume(await adapter.syncDocument(f.manager.document), f.plateId)
      ).toBeCloseTo(576, 6);
      f.manager.redo();
      expect(
        volume(await adapter.syncDocument(f.manager.document), f.plateId)
      ).toBeCloseTo(576, 6);
      if (typed) {
        f.manager.execute(
          commandFactories.setParameter({
            name: 'h',
            expression: '0.7 cm',
            quantity: 'length'
          })
        );
        expect(
          volume(await adapter.syncDocument(f.manager.document), f.plateId)
        ).toBeCloseTo(672, 6);
      }
      const released = f.manager.document;
      for (const reopened of [
        replayCommands(f.initial, released.commandLog),
        normalizeDocument(
          JSON.parse(JSON.stringify(released)) as ProjectDocument
        )
      ]) {
        const cold = await createExactKernelAdapter();
        try {
          expect(
            volume(await cold.syncDocument(reopened), f.plateId)
          ).toBeCloseTo(typed ? 672 : 576, 6);
          expect(await cold.exportSketchSvg(reopened, f.sketchId)).toBe(
            await adapter.exportSketchSvg(released, f.sketchId)
          );
        } finally {
          cold.dispose();
        }
      }
    }
  );

  it('re-solves the ordinary closed loop in the same exact build and all exports', async () => {
    const f = await constrainedPlate();
    expect(
      volume(await adapter.syncDocument(f.manager.document), f.plateId)
    ).toBeCloseTo(20 * 6 * 3, 6);
    f.manager.execute(
      commandFactories.setParameter({ name: 'w', expression: '32' })
    );
    const resized = f.manager.document;
    const before = structuredClone(resized);
    const built = await adapter.syncDocument(resized);
    expectFreshProjection(f, built);
    expect(built.sketchGeometry).toMatchObject({
      projectId: resized.projectId,
      documentVersion: resized.version
    });
    expect(built.sketchGeometry?.objects[f.loop[1]!]).toMatchObject({
      objectKind: 'line',
      x1: expect.closeTo(32, 8),
      x2: expect.closeTo(32, 8)
    });
    // The construction shadow contributes no area: this is the constrained ordinary loop.
    expect(volume(built, f.plateId)).toBeCloseTo(32 * 6 * 3, 6);
    const expected = expectedPlate(f, resized, 32);
    expect(await adapter.exportSketchSvg(resized, f.sketchId)).toBe(
      await adapter.exportSketchSvg(expected, f.sketchId)
    );
    expect(await adapter.exportSketchDxf(resized, f.sketchId)).toBe(
      await adapter.exportSketchDxf(expected, f.sketchId)
    );
    const exported = await adapter.inspectStep(
      await adapter.exportStep(resized, [f.plateId])
    );
    expect(exported).toMatchObject({ solid: true, valid: true });
    expect(exported.volume).toBeCloseTo(32 * 6 * 3, 6);
    expect(resized).toEqual(before);
    const original = resized.nodes[f.loop[1]!]!;
    expect(original.kind === 'sketch-object' && original.data).toMatchObject({
      x1: 20,
      x2: 20
    });
  });

  it('keeps typed length expressions and construction/unlinked metadata while ordinary geometry follows', async () => {
    const f = await constrainedPlate(false, true);
    f.manager.execute(
      commandFactories.setParameter({
        name: 'w',
        expression: '3.2 cm',
        quantity: 'length'
      })
    );
    const resized = f.manager.document;
    const before = structuredClone(resized);
    const built = await adapter.syncDocument(resized);
    expectFreshProjection(f, built);
    expect(volume(built, f.plateId)).toBeCloseTo(32 * 6 * 3, 6);
    expect(Object.keys(built.sketchProjections ?? {})).toEqual([
      f.projectionId
    ]);
    expect(built.sketchGeometry?.objects[f.constructionId!]).toMatchObject({
      objectKind: 'line',
      construction: true,
      projection: { mode: 'unlinked' },
      x1: expect.closeTo(32, 8),
      x2: expect.closeTo(32, 8),
      y2: expect.closeTo(4, 8)
    });
    const expected = expectedPlate(f, resized, 32);
    const ordinaryOnly = findSketch(expected, f.sketchId)!;
    ordinaryOnly.objectIds = [...f.loop];
    delete ordinaryOnly.constraints;
    // The oracle contains only the four manufacturing lines. A construction
    // flag lost during a moved-neighbor override would add a fifth exported line.
    expect(await adapter.exportSketchSvg(resized, f.sketchId)).toBe(
      await adapter.exportSketchSvg(expected, f.sketchId)
    );
    expect(await adapter.exportSketchDxf(resized, f.sketchId)).toBe(
      await adapter.exportSketchDxf(expected, f.sketchId)
    );
    const fresh = structuredClone(resized);
    const state = built.sketchProjections![f.projectionId]!;
    if (state.status !== 'moved')
      throw new Error('Expected the verified edge to move.');
    const projected = fresh.nodes[f.projectionId]!;
    if (projected.kind !== 'sketch-object')
      throw new Error('Expected a linked line.');
    projected.data = state.data;
    const solved = await adapter.solveSketch(fresh, f.sketchId);
    expect(solved.converged).toBe(true);
    const construction = fresh.nodes[f.constructionId!]!;
    if (construction.kind !== 'sketch-object')
      throw new Error('Expected a construction neighbor.');
    const solvedNeighbor = solved.objects.find(
      (object) => object.objectId === f.constructionId
    )!;
    const { scope } = getParameterScope(fresh);
    const mapped = sketchDataFromSolvedObject(
      construction.data,
      solvedNeighbor,
      (value, label) => resolveParamValue(value, scope, label, fresh.units)
    );
    expect(mapped).toMatchObject({
      objectKind: 'line',
      construction: true,
      projection: { mode: 'unlinked' }
    });
    if (mapped.objectKind !== 'line')
      throw new Error('Expected a solved line.');
    expect(Number(mapped.x1)).toBeCloseTo(32, 9);
    expect(Number(mapped.x2)).toBeCloseTo(32, 9);
    expect(
      resolveParamValue(mapped.y2, scope, undefined, fresh.units)
    ).toBeCloseTo(4, 9);
    expect(construction.data).toMatchObject({
      x1: '2 cm',
      x2: '2 cm',
      y2: '4 mm'
    });
    expect(resized).toEqual(before);
  });

  it('re-solves on a cold current or broken link after browser linked-only writeback', async () => {
    const f = await constrainedPlate();
    f.manager.execute(
      commandFactories.setParameter({ name: 'w', expression: '32' })
    );
    const resized = f.manager.document;
    const built = await adapter.syncDocument(resized);
    const writeback = projectionWriteBackCommand(resized, built);
    expect(writeback).not.toBeNull();
    const browser = new CommandManager(resized);
    browser.normalize(writeback!);
    const settled = browser.document;
    const ordinary = settled.nodes[f.loop[1]!]!;
    expect(ordinary.kind === 'sketch-object' && ordinary.data).toMatchObject({
      x1: 20,
      x2: 20
    });
    const source = listFeaturesInOrder(settled).find(
      (feature) => feature.name === 'Source'
    )!;
    const broken = deleteFeature(settled, { featureId: source.featureId });
    // Separate adapters rule out an ordinary override retained in a warm cache.
    for (const [document, status] of [
      [settled, 'current'],
      [broken, 'broken']
    ] as const) {
      const before = structuredClone(document);
      const cold = await createExactKernelAdapter();
      try {
        const rebuilt = await cold.syncDocument(document);
        expect(rebuilt.sketchProjections?.[f.projectionId]?.status).toBe(
          status
        );
        expect(volume(rebuilt, f.plateId)).toBeCloseTo(32 * 6 * 3, 6);
        expect(rebuilt.sketchGeometry).toMatchObject({
          projectId: document.projectId,
          documentVersion: document.version
        });
        expect(rebuilt.sketchGeometry?.objects[f.loop[1]!]).toMatchObject({
          x1: expect.closeTo(32, 8),
          x2: expect.closeTo(32, 8)
        });
        expect(
          (rebuilt.featureWarnings ?? []).every(
            (warning) => warning.kind === 'advisory'
          )
        ).toBe(true);
        const expected = expectedPlate(f, document, 32);
        expect(await cold.exportSketchSvg(document, f.sketchId)).toBe(
          await cold.exportSketchSvg(expected, f.sketchId)
        );
        expect(await cold.exportSketchDxf(document, f.sketchId)).toBe(
          await cold.exportSketchDxf(expected, f.sketchId)
        );
      } finally {
        cold.dispose();
      }
      expect(document).toEqual(before);
    }
  });

  it('keeps the same constrained solid through undo, redo, replay and native JSON reopen', async () => {
    const f = await constrainedPlate();
    f.manager.execute(
      commandFactories.setParameter({ name: 'w', expression: '32' })
    );
    const resized = structuredClone(f.manager.document);
    f.manager.undo();
    expect(
      volume(await adapter.syncDocument(f.manager.document), f.plateId)
    ).toBeCloseTo(20 * 6 * 3, 6);
    f.manager.redo();
    expect(
      volume(await adapter.syncDocument(f.manager.document), f.plateId)
    ).toBeCloseTo(32 * 6 * 3, 6);
    const replayed = replayCommands(f.initial, resized.commandLog);
    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(resized)) as ProjectDocument
    );
    for (const candidate of [replayed, reopened]) {
      const before = structuredClone(candidate);
      const built = await adapter.syncDocument(candidate);
      expectFreshProjection(f, built);
      expect(volume(built, f.plateId)).toBeCloseTo(32 * 6 * 3, 6);
      expect(candidate).toEqual(before);
    }
    expect(f.manager.document.nodes).toEqual(resized.nodes);
  });

  it('refuses an incompatible ordinary lock and linked edge without publishing false geometry', async () => {
    const f = await constrainedPlate(true);
    expect(
      volume(await adapter.syncDocument(f.manager.document), f.plateId)
    ).toBeCloseTo(20 * 6 * 3, 6);
    f.manager.execute(
      commandFactories.setParameter({ name: 'w', expression: '32' })
    );
    const resized = f.manager.document;
    const before = structuredClone(resized);
    // Exercise the same contradiction directly with the exact fresh edge held.
    const freshLinked = structuredClone(resized);
    freshLinked.nodes[f.projectionId] = expectedPlate(f, resized, 32).nodes[
      f.projectionId
    ]!;
    const freshBefore = structuredClone(freshLinked);
    const solve = await adapter.solveSketch(freshLinked, f.sketchId);
    expect(solve.converged).toBe(false);
    expect(solve.rolledBack).toBe(true);
    expect(solvedSketchCommands(freshLinked, f.sketchId, solve)).toEqual([]);
    expect(freshLinked).toEqual(freshBefore);
    let published = false;
    const built = await adapter.syncDocument(
      resized,
      undefined,
      undefined,
      undefined,
      {
        onGeometryReady: () => {
          published = true;
        }
      }
    );
    expect(built.featureWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureName: 'Constrained linked plate',
          kind: 'build-failed'
        })
      ])
    );
    expect(published).toBe(false);
    expect(
      Object.values(built.sketchProjections ?? {}).some(
        (state) => state.status === 'moved'
      )
    ).toBe(false);
    expect(projectionWriteBackCommand(resized, built)).toBeNull();
    for (const objectId of [f.projectionId, ...f.loop])
      expect(built.sketchGeometry?.objects[objectId]).toBeUndefined();
    expect(built.exportableBodyIds).not.toContain(f.plateId);
    expect(built.bodyRepresentations[f.plateId]).toBeUndefined();
    await expect(adapter.exportStep(resized, [f.plateId])).rejects.toThrow();
    await expect(
      adapter.exportSketchSvg(resized, f.sketchId)
    ).rejects.toThrow();
    await expect(
      adapter.exportSketchDxf(resized, f.sketchId)
    ).rejects.toThrow();
    expect(resized).toEqual(before);
    // The same retained-history adapter must discard the failed fork when
    // undo restores its previously valid width, and exports recover too.
    f.manager.undo();
    const recoveredBefore = structuredClone(f.manager.document);
    const recovered = await adapter.syncDocument(f.manager.document);
    expect(recovered.warnings).toEqual([]);
    expect(recovered.sketchProjections?.[f.projectionId]).toEqual({
      status: 'current'
    });
    expect(volume(recovered, f.plateId)).toBeCloseTo(20 * 6 * 3, 6);
    expect(
      await adapter.inspectStep(
        await adapter.exportStep(f.manager.document, [f.plateId])
      )
    ).toMatchObject({ solid: true, valid: true });
    await expect(
      adapter.exportSketchSvg(f.manager.document, f.sketchId)
    ).resolves.toContain('<svg');
    expect(f.manager.document).toEqual(recoveredBefore);
  });
});

const failedSketch = toSketchId('sketch_failed_projection');
const otherSketch = toSketchId('sketch_independent');
const failureReason = 'Linked projection constraints could not be satisfied.';
const section = (sketchId: typeof failedSketch) => ({
  sketchId,
  profile: { all: true as const, sourceEntityIds: [toEntityId('ent_profile')] }
});
const path = (sketchId: typeof failedSketch) => ({
  sketchId,
  entityIds: [toEntityId('ent_path')]
});
const featureCarriers: [string, FeatureData][] = [
  [
    'extrude sketch',
    { featureKind: 'extrude', sketchId: failedSketch, distance: 3 }
  ],
  [
    'revolve sketch',
    { featureKind: 'revolve', sketchId: failedSketch, axis: 'vertical' }
  ],
  [
    'first loft section',
    {
      featureKind: 'loft',
      mode: 'ruled',
      sections: [section(failedSketch), section(otherSketch)]
    }
  ],
  [
    'later loft section',
    {
      featureKind: 'loft',
      mode: 'ruled',
      sections: [section(otherSketch), section(failedSketch)]
    }
  ],
  [
    'sweep profile',
    {
      featureKind: 'sweep',
      mode: 'standard',
      profile: section(failedSketch),
      path: path(otherSketch)
    }
  ],
  [
    'sweep path',
    {
      featureKind: 'sweep',
      mode: 'standard',
      profile: section(otherSketch),
      path: path(failedSketch)
    }
  ],
  [
    'sweep guide',
    {
      featureKind: 'sweep',
      mode: 'standard',
      profile: section(otherSketch),
      path: path(otherSketch),
      guide: path(failedSketch)
    }
  ],
  [
    'helical profile',
    {
      featureKind: 'helical-sweep',
      profile: section(failedSketch),
      axisOrigin: { x: 0, y: 0, z: 0 },
      axisDirection: { x: 0, y: 0, z: 1 },
      radius: 10,
      pitch: 5,
      turns: 2
    }
  ]
];

describe('failed projected constraint consumers and retained history', () => {
  const failures = {
    sketchProjectionFailures: new Map([[failedSketch, failureReason]])
  };
  it.each(featureCarriers)(
    'refuses a failed %s before consuming stored geometry',
    (_label, data) => {
      expect(() => assertFeatureSketchProjectionsValid(failures, data)).toThrow(
        failureReason
      );
      expect(() => assertFeatureSketchProjectionsValid({}, data)).not.toThrow();
    }
  );
  it('keeps unrelated sketches and non-sketch features available', () => {
    expect(() => assertSketchProjectionsValid(failures, failedSketch)).toThrow(
      failureReason
    );
    expect(() =>
      assertSketchProjectionsValid(failures, otherSketch)
    ).not.toThrow();
    expect(() =>
      assertFeatureSketchProjectionsValid(failures, {
        featureKind: 'extrude',
        sketchId: otherSketch,
        distance: 3
      })
    ).not.toThrow();
    expect(() =>
      assertFeatureSketchProjectionsValid(failures, {
        featureKind: 'primitive',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    ).not.toThrow();
  });
  it('isolates a failed-solve marker across retained checkpoint forks', () => {
    const source: ExactBuildResult = {
      shapes: new Map(),
      sketchBases: new Map(),
      datumFrames: new Map(),
      datumAxes: new Map(),
      consumed: new Set(),
      importedStepDiagnostics: new Map(),
      meshBodies: new Set(),
      partialRevolveBodies: new Set(),
      warnings: [],
      featureWarnings: [],
      referenceRepairs: [],
      sketchProjectionFailures: new Map([[failedSketch, failureReason]])
    };
    const recovered = cloneBuildState(source);
    const stillFailed = cloneBuildState(source);
    recovered.sketchProjectionFailures!.delete(failedSketch);
    expect(() =>
      assertSketchProjectionsValid(recovered, failedSketch)
    ).not.toThrow();
    expect(() => assertSketchProjectionsValid(source, failedSketch)).toThrow(
      failureReason
    );
    expect(() =>
      assertSketchProjectionsValid(stillFailed, failedSketch)
    ).toThrow(failureReason);
    source.sketchProjectionFailures!.set(
      otherSketch,
      'New independent failure.'
    );
    expect(() =>
      assertSketchProjectionsValid(stillFailed, otherSketch)
    ).not.toThrow();
    stillFailed.sketchProjectionFailures!.set(
      failedSketch,
      'Fork-specific failure.'
    );
    expect(source.sketchProjectionFailures!.get(failedSketch)).toBe(
      failureReason
    );
  });
});
