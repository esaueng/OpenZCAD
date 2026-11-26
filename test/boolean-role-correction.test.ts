import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  booleanBodies,
  chamferEdges,
  createProjectDocument,
  listFeaturesInOrder,
  normalizeDocument,
  staleDirectEditFaceRepair,
  transformBody,
  updateFeature,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type BooleanOperation,
  type DerivedState,
  type EdgeTopology,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import { refusal } from './support/combination-matrix';

/**
 * M11 / U06 / K05, CAD-workflow slice 3: Boolean role correction and edits
 * of walls a Boolean generated. Coverage only. Whether a one-step "swap
 * roles" action should exist is an open owner decision (D1); these record
 * the facts it rests on. The browser half is
 * `test/e2e/boolean-role-correction.spec.ts`.
 *
 * Fixture B, synthetic, mm. A box's width, height and depth run along X, Y
 * and Z from its corner at the origin.
 *   Block = 20 × 10 × 10 at the origin:   [0,20] × [0,10] × [0,10] = 2000
 *   Post  = 10 × 10 × 30 moved (15,5,0):  [15,25] × [5,15] × [0,30] = 3000
 *   shared column [15,20] × [5,10] × [0,10]                          = 250
 *   Block − Post 1750, Post − Block 2750, union 4750, intersect 250.
 * Every expected value is that closed form, never a recorded kernel value.
 */
const BLOCK = 2000;
const POST = 3000;
const SHARED = 5 * 5 * 10;
const ORACLE = {
  'subtract:block,post': BLOCK - SHARED,
  'subtract:post,block': POST - SHARED,
  union: BLOCK + POST - SHARED,
  intersect: SHARED
} as const;

const user = toUserId('user_boolean_roles');

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

interface Fixture {
  document: ProjectDocument;
  block: BodyId;
  post: BodyId;
  /** Present with `core`. */
  core?: BodyId;
}

/**
 * Fixture B, optionally with a third operand. `corner`: Core = 10 × 10 × 30
 * moved (−5,−5,0), cutting Block's corner [0,5] × [0,5] × [0,10] = 250.
 * `bore`: Core = 4 × 4 × 30 moved (3,3,0), a through bore
 * [3,7] × [3,7] × [0,10] = 160. `pocket`: the same Core moved (3,3,5), a
 * blind pocket [3,7] × [3,7] × [5,10] = 80. `boss`: Core = 4 × 4 × 3 moved
 * (3,3,10), a boss [3,7] × [3,7] × [10,13] = 48 to unite onto the top.
 */
function fixtureB(core?: 'corner' | 'bore' | 'pocket' | 'boss'): Fixture {
  let document = createProjectDocument('Boolean roles', user);
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 10 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Post',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 30 }
  });
  if (core) {
    const side = core === 'corner' ? 10 : 4;
    document = addPrimitiveFeature(document, {
      name: 'Core',
      primitiveKind: 'box',
      dimensions: { width: side, height: side, depth: core === 'boss' ? 3 : 30 }
    });
  }
  const [block, post, coreId] = document.bodyOrder;
  document = transformBody(document, {
    name: 'Place Post',
    targetBodyId: post!,
    translation: { x: 15, y: 5, z: 0 }
  }).document;
  if (core) {
    const at = core === 'corner' ? -5 : 3;
    document = transformBody(document, {
      name: 'Place Core',
      targetBodyId: coreId!,
      translation: {
        x: at,
        y: at,
        z: core === 'pocket' ? 5 : core === 'boss' ? 10 : 0
      }
    }).document;
  }
  return {
    document,
    block: block!,
    post: post!,
    ...(coreId ? { core: coreId } : {})
  };
}

/** Moves Post along X in History: the upstream operand edit. */
function movePost(document: ProjectDocument, x: number): ProjectDocument {
  const place = listFeaturesInOrder(document).find(
    (feature) => feature.name === 'Place Post'
  )!;
  return updateFeature(document, {
    featureId: place.featureId,
    data: {
      featureKind: 'transform',
      transform: {
        translation: { x, y: 5, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      }
    }
  });
}

type Outcome =
  { kind: 'built'; derived: DerivedState } | { kind: 'typed'; code: string };

/**
 * Builds `document` and classifies it as in `qa-2026-11-14-p1.test.ts`: a
 * typed refusal, or a build whose named bodies are exact and closed. A
 * prose refusal fails the test.
 */
async function outcome(
  document: ProjectDocument,
  bodyIds: BodyId[]
): Promise<Outcome> {
  const derived = await adapter.syncDocument(document);
  const refused = refusal(derived, 'step');
  if (refused) {
    expect(refused.state, refused.evidence).toBe('typed-refusal');
    return {
      kind: 'typed',
      code: refused.evidence.split(' — ')[0]!.replace(/^step:\s*/, '')
    };
  }
  for (const id of bodyIds) {
    const body = derived.bodyRepresentations[id];
    expect(body, `body ${id}`).toBeDefined();
    expect(body!.exportableStep, `body ${id} exact`).toBe(true);
    expect(
      isClosedConsistentlyOrientedMesh(
        inspectTriangleMeshClosure(body!.mesh.vertices, body!.mesh.indices)
      ),
      `body ${id} closed`
    ).toBe(true);
  }
  return { kind: 'built', derived };
}

function expectBuilt(result: Outcome, label: string): DerivedState {
  expect(
    result.kind,
    `${label}: expected built, got ${result.kind === 'typed' ? result.code : result.kind}`
  ).toBe('built');
  return (result as Extract<Outcome, { kind: 'built' }>).derived;
}

function near(actual: number | undefined, expected: number, label: string) {
  expect(actual, label).toBeDefined();
  expect(Math.abs(actual! - expected), label).toBeLessThan(
    Math.max(1, expected) * 1e-6
  );
}

/** The live (unconsumed) bodies, sorted. */
function liveBodies(derived: DerivedState): BodyId[] {
  return (
    Object.entries(derived.bodyRepresentations) as [
      BodyId,
      BodyRepresentation
    ][]
  )
    .filter(([, body]) => !body.consumed)
    .map(([id]) => id)
    .sort();
}

/** The +X planar faces of a body as `x:area`, rounded to 1e-6. */
function plusXWalls(body: BodyRepresentation): string[] {
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return (body.topology?.faces ?? [])
    .flatMap((face) => {
      const g = face.geometry;
      return g?.surfaceType === 'plane' &&
        g.normal &&
        Math.abs(g.normal.x - 1) < 1e-9
        ? [`${round(g.center.x)}:${round(g.area)}`]
        : [];
    })
    .sort();
}

/** The +X wall whose centre is (x, 7.5, 5): the one Post's x-min face cut. */
function postWall(body: BodyRepresentation, x: number): FaceTopology {
  const match = (body.topology?.faces ?? []).filter((face) => {
    const g = face.geometry;
    return (
      g?.surfaceType === 'plane' &&
      g.normal !== undefined &&
      Math.abs(g.normal.x - 1) < 1e-9 &&
      Math.abs(g.center.x - x) < 1e-6 &&
      Math.abs(g.center.y - 7.5) < 1e-6
    );
  });
  expect(match, `one +X wall at x = ${x}`).toHaveLength(1);
  return match[0]!;
}

/** The straight edge from (x,5,10) to (x,10,10): Post's wall meets Block's top. */
function rimEdge(body: BodyRepresentation, x: number): EdgeTopology {
  const match = (body.topology?.edges ?? []).filter((edge) => {
    const p = edge.points;
    const n = p.length;
    if (edge.curve?.type !== 'LINE' || n < 6) return false;
    const ends = [
      [p[0]!, p[1]!, p[2]!],
      [p[n - 3]!, p[n - 2]!, p[n - 1]!]
    ];
    return (
      ends.every(
        ([ex, , ez]) => Math.abs(ex! - x) < 1e-6 && Math.abs(ez! - 10) < 1e-6
      ) &&
      ends.some(([, ey]) => Math.abs(ey! - 5) < 1e-6) &&
      ends.some(([, ey]) => Math.abs(ey! - 10) < 1e-6)
    );
  });
  expect(match, `one rim edge at x = ${x}`).toHaveLength(1);
  return match[0]!;
}

/** Planar faces whose normal leans (+X, +Z) at 45°: a chamfer on a +X/+Z rim. */
function chamferFaces(body: BodyRepresentation): string[] {
  return (body.topology?.faces ?? []).flatMap((face) => {
    const g = face.geometry;
    return g?.surfaceType === 'plane' &&
      g.normal &&
      Math.abs(g.normal.x - Math.SQRT1_2) < 1e-6 &&
      Math.abs(g.normal.z - Math.SQRT1_2) < 1e-6
      ? [`${Math.round(g.center.x * 1e6) / 1e6}`]
      : [];
  });
}

/** A planar face as `±axis@(centre)`, for naming the faces lineage skips. */
function faceLabel(face: FaceTopology): string {
  const g = face.geometry!;
  const n = g.normal!;
  const axis = (['x', 'y', 'z'] as const).find(
    (key) => Math.abs(Math.abs(n[key]) - 1) < 1e-9
  )!;
  const r = (value: number) => Math.round(value * 1e6) / 1e6;
  return `${n[axis] > 0 ? '+' : '-'}${axis}@(${r(g.center.x)},${r(g.center.y)},${r(g.center.z)})`;
}

/** Rebuilds `document` on a fresh adapter, as a reopen does. */
async function reopened(document: ProjectDocument): Promise<DerivedState> {
  const fresh = await createExactKernelAdapter();
  try {
    return await fresh.syncDocument(
      normalizeDocument(
        JSON.parse(
          JSON.stringify(withoutDerivedProjection(document))
        ) as ProjectDocument
      )
    );
  } finally {
    fresh.dispose();
  }
}

describe('Cell 2: every Keep originals choice under each role assignment', () => {
  const KEEPS = ['none', 'all', 'target', 'tools'] as const;
  type Keep = (typeof KEEPS)[number];
  /** Which operand positions a keep choice leaves live: [base, tool]. */
  const KEPT: Record<Keep, [boolean, boolean]> = {
    none: [false, false],
    all: [true, true],
    target: [true, false],
    tools: [false, true]
  };
  const CASES: {
    operation: BooleanOperation;
    order: 'block,post' | 'post,block';
    volume: number;
  }[] = [
    {
      operation: 'subtract',
      order: 'block,post',
      volume: ORACLE['subtract:block,post']
    },
    {
      operation: 'subtract',
      order: 'post,block',
      volume: ORACLE['subtract:post,block']
    },
    { operation: 'union', order: 'block,post', volume: ORACLE.union },
    { operation: 'union', order: 'post,block', volume: ORACLE.union },
    { operation: 'intersect', order: 'block,post', volume: ORACLE.intersect },
    { operation: 'intersect', order: 'post,block', volume: ORACLE.intersect }
  ];

  for (const { operation, order, volume } of CASES) {
    for (const keep of KEEPS) {
      it(`${operation} [${order}] keep ${keep}: ${volume}`, async () => {
        const fixture = fixtureB();
        const operands =
          order === 'block,post'
            ? [fixture.block, fixture.post]
            : [fixture.post, fixture.block];
        const ownVolume = (id: BodyId) => (id === fixture.block ? BLOCK : POST);
        const result = booleanBodies(fixture.document, {
          name: operation,
          operation,
          targetBodyIds: operands,
          ...(keep === 'none' ? {} : { keepOriginals: keep })
        });
        // Stored as picked: the first id is the base; `none` stores nothing.
        const stored = listFeaturesInOrder(result.document).at(-1)!.data;
        expect(stored).toMatchObject({
          featureKind: 'boolean',
          operation,
          targetBodyIds: operands
        });
        if (keep === 'none') expect(stored).not.toHaveProperty('keepOriginals');
        else expect(stored).toMatchObject({ keepOriginals: keep });

        const kept = operands.filter((_, index) => KEPT[keep][index]);
        const derived = expectBuilt(
          await outcome(result.document, [result.bodyId, ...kept]),
          `${operation} ${order} ${keep}`
        );
        near(
          derived.bodyRepresentations[result.bodyId]?.volume,
          volume,
          'result'
        );
        // The result stands with the kept operands, each whole.
        expect(liveBodies(derived)).toEqual([result.bodyId, ...kept].sort());
        for (const [index, id] of operands.entries()) {
          expect(derived.bodyRepresentations[id]?.consumed, id).toBe(
            !KEPT[keep][index]
          );
        }
        for (const id of kept) {
          near(derived.bodyRepresentations[id]?.volume, ownVolume(id), id);
        }
      });
    }
  }
});

describe('D1 facts: reversing a committed Subtract in the document', () => {
  it('one undoable edit of targetBodyIds turns Block − Post into Post − Block under the same result id', async () => {
    const fixture = fixtureB();
    const committed = booleanBodies(fixture.document, {
      name: 'Subtract',
      operation: 'subtract',
      targetBodyIds: [fixture.block, fixture.post]
    });
    const manager = new CommandManager(committed.document);
    const feature = listFeaturesInOrder(manager.document).at(-1)!;
    const features = listFeaturesInOrder(manager.document).length;
    manager.execute(
      commandFactories.updateFeature({
        featureId: feature.featureId,
        data: {
          featureKind: 'boolean',
          targetBodyIds: [fixture.post, fixture.block]
        }
      })
    );
    // No new step: the same feature, its roles swapped.
    expect(listFeaturesInOrder(manager.document)).toHaveLength(features);
    expect(listFeaturesInOrder(manager.document).at(-1)!.data).toMatchObject({
      targetBodyIds: [fixture.post, fixture.block]
    });
    const swapped = expectBuilt(
      await outcome(manager.document, [committed.bodyId]),
      'swapped'
    );
    near(
      swapped.bodyRepresentations[committed.bodyId]?.volume,
      ORACLE['subtract:post,block'],
      'Post − Block'
    );
    manager.undo();
    const undone = expectBuilt(
      await outcome(manager.document, [committed.bodyId]),
      'undone'
    );
    near(
      undone.bodyRepresentations[committed.bodyId]?.volume,
      ORACLE['subtract:block,post'],
      'Block − Post'
    );
  });
});

describe('Cells 3–4: an offset of a wall a Subtract generated, then an upstream operand edit', () => {
  /*
   * The wall Post's x-min face cuts sits at x = 15, area 5 × 10 = 50, beside
   * Block's own end at x = 20 (y 0…5, 50). Offset 2 mm outward, it moves to
   * 17 and gives back 2 × 5 × 10 = 100. Moving Post to x = 13 widens the
   * notch to 7 mm (−100 more) and, if the offset follows the wall, puts it
   * at 15. A retarget onto Block's end would leave a wall at 13 and one at
   * 22; a dropped offset would leave the wall at 13.
   */
  const CASES = [
    {
      label: 'two operands',
      core: undefined,
      operandVolume: 0,
      cornerWall: [] as string[],
      unnamed: [] as string[]
    },
    {
      // K05: a multi-operand Subtract names most faces by operand, but not
      // all (below), and publishes no edge lineage.
      label: 'three operands (Core cuts Block’s corner)',
      core: 'corner' as const,
      operandVolume: 250,
      // Core's x-max face cuts the corner wall at x = 5 (−X), so no new +X wall.
      cornerWall: [] as string[],
      // Observed on this pin: Block's bottom, and the two walls that lie on
      // the shared plane y = 5 (Post's y-min, facing +Y, and Core's y-max,
      // facing −Y), carry no lineage name.
      unnamed: ['+y@(17.5,5,5)', '-y@(2.5,5,5)', '-z@(10,5,0)']
    }
  ];

  for (const { label, core, operandVolume, cornerWall, unnamed } of CASES) {
    it(`${label}: the offset follows the wall, with no repair and no retarget`, async () => {
      const fixture = fixtureB(core);
      const operands = [
        fixture.block,
        fixture.post,
        ...(fixture.core ? [fixture.core] : [])
      ];
      const cut = booleanBodies(fixture.document, {
        name: 'Subtract',
        operation: 'subtract',
        targetBodyIds: operands
      });
      const built = expectBuilt(
        await outcome(cut.document, [cut.bodyId]),
        'cut'
      );
      const body = built.bodyRepresentations[cut.bodyId]!;
      near(body.volume, BLOCK - SHARED - operandVolume, 'cut');
      expect(plusXWalls(body)).toEqual(['15:50', '20:50', ...cornerWall]);
      // Each named face is named for the operand it came from, and exactly
      // the faces listed in `unnamed` carry no name.
      const faces = body.topology!.faces;
      const named = faces.flatMap((face) =>
        face.reference?.lineageName ? [face.reference.lineageName] : []
      );
      for (const name of named) {
        expect(name).toMatch(
          /^boolean\.face\.operand\.\d+\.primitive\.box\.face\./
        );
      }
      expect(
        new Set(named.map((name) => name.split('.')[3])),
        'operands named'
      ).toEqual(new Set(operands.map((_, index) => String(index))));
      expect(
        faces
          .filter((face) => !face.reference?.lineageName)
          .map(faceLabel)
          .sort()
      ).toEqual(unnamed);
      const wall = postWall(body, 15);
      // The wall is named for the operand that generated it, not by hash.
      expect(wall.reference?.lineageName).toBe(
        'boolean.face.operand.1.primitive.box.face.x-min'
      );

      // The app's own face-offset planner: a generated wall is a local
      // offset (direct edit) carrying that name, not an edit of Post.
      const plan = planFaceOffset({
        document: { ...cut.document, derived: built },
        bodyId: cut.bodyId,
        face: wall,
        faceHash: wall.hash,
        offset: 2
      });
      expect(plan?.kind).toBe('direct-edit');
      const manager = new CommandManager(cut.document);
      manager.execute(plan!.command);
      const resultId = manager.document.bodyOrder.at(-1)!;
      const offsetFeature = listFeaturesInOrder(manager.document).at(-1)!;
      expect(offsetFeature.data).toMatchObject({
        featureKind: 'direct-edit',
        operation: {
          kind: 'offset-face',
          faceReference: {
            lineageName: 'boolean.face.operand.1.primitive.box.face.x-min'
          }
        }
      });
      const offset = expectBuilt(
        await outcome(manager.document, [resultId]),
        'offset'
      );
      near(
        offset.bodyRepresentations[resultId]?.volume,
        BLOCK - SHARED - operandVolume + 100,
        'offset'
      );
      expect(plusXWalls(offset.bodyRepresentations[resultId]!)).toEqual([
        '17:50',
        '20:50',
        ...cornerWall
      ]);

      // Upstream: Post moves 2 mm toward Block.
      manager.execute(
        commandFactories.updateFeature({
          featureId: listFeaturesInOrder(manager.document).find(
            (feature) => feature.name === 'Place Post'
          )!.featureId,
          data: {
            featureKind: 'transform',
            transform: {
              translation: { x: 13, y: 5, z: 0 },
              rotationDeg: { x: 0, y: 0, z: 0 }
            }
          }
        })
      );
      const moved = expectBuilt(
        await outcome(manager.document, [resultId]),
        'moved'
      );
      // No repair is needed: nothing refused, no stale-face prompt.
      expect(
        staleDirectEditFaceRepair(
          listFeaturesInOrder(manager.document).at(-1)!,
          moved.warnings
        )
      ).toBeNull();
      near(
        moved.bodyRepresentations[resultId]?.volume,
        BLOCK - 7 * 5 * 10 - operandVolume + 100,
        'moved'
      );
      expect(plusXWalls(moved.bodyRepresentations[resultId]!)).toEqual([
        '15:50',
        '20:50',
        ...cornerWall
      ]);
      // Replay: the same from a cold reopen.
      const cold = await reopened(manager.document);
      expect(refusal(cold, 'reopen')).toBeNull();
      near(
        cold.bodyRepresentations[resultId]?.volume,
        BLOCK - 7 * 5 * 10 - operandVolume + 100,
        'reopen'
      );
      expect(plusXWalls(cold.bodyRepresentations[resultId]!)).toEqual([
        '15:50',
        '20:50',
        ...cornerWall
      ]);
    });
  }

  it('three operands: an offset of an unnamed generated wall asks for a repair after the upstream edit, and keeps the cut', async () => {
    // Post's y-min wall (y = 5, facing +Y, x 15…20) is one the three-operand
    // cut leaves unnamed, so its offset holds a hash only. Offset 2: the
    // notch narrows in Y, +2 × 5 × 10 = 100 (1600).
    const fixture = fixtureB('corner');
    const cut = booleanBodies(fixture.document, {
      name: 'Subtract',
      operation: 'subtract',
      targetBodyIds: [fixture.block, fixture.post, fixture.core!]
    });
    const built = expectBuilt(await outcome(cut.document, [cut.bodyId]), 'cut');
    const wall = built.bodyRepresentations[cut.bodyId]!.topology!.faces.find(
      (face) => faceLabel(face) === '+y@(17.5,5,5)'
    )!;
    expect(wall.reference?.lineageName).toBeUndefined();
    const plan = planFaceOffset({
      document: { ...cut.document, derived: built },
      bodyId: cut.bodyId,
      face: wall,
      faceHash: wall.hash,
      offset: 2
    });
    expect(plan?.kind).toBe('direct-edit');
    const manager = new CommandManager(cut.document);
    manager.execute(plan!.command);
    const resultId = manager.document.bodyOrder.at(-1)!;
    const plusY = (derived: DerivedState) =>
      derived.bodyRepresentations[resultId]!.topology!.faces.flatMap((face) =>
        faceLabel(face).startsWith('+y') ? [faceLabel(face)] : []
      ).sort();
    const offset = expectBuilt(
      await outcome(manager.document, [resultId]),
      'offset'
    );
    near(
      offset.bodyRepresentations[resultId]?.volume,
      BLOCK - SHARED - 250 + 100,
      'offset'
    );
    expect(plusY(offset)).toEqual(['+y@(17.5,7,5)', '+y@(7.5,10,5)']);

    // Post moves to x = 13. The hash no longer resolves: a typed refusal
    // and the app's repair prompt for this offset, never a silent move to
    // another wall. The cut stands without the offset: 2000 − 350 − 250.
    const moved = movePost(manager.document, 13);
    const after = await adapter.syncDocument(moved);
    const stopped = refusal(after, 'moved');
    expect(stopped?.state, stopped?.evidence).toBe('typed-refusal');
    const warning = (after.featureWarnings ?? []).find(
      (entry) => entry.featureName === 'Offset face'
    );
    expect(warning?.kind).toBe('build-failed');
    expect(warning?.kernelRefusal?.category).toBe('invalid_input');
    expect(
      staleDirectEditFaceRepair(
        listFeaturesInOrder(moved).at(-1)!,
        after.warnings
      )
    ).toMatchObject({
      featureName: 'Offset face',
      operationKind: 'offset-face'
    });
    near(
      after.bodyRepresentations[resultId]?.volume,
      BLOCK - 7 * 5 * 10 - 250,
      'moved'
    );
    // Post's wall is back at y = 5 (now x 13…20); nothing moved to y = 7.
    expect(plusY(after)).toEqual(['+y@(16.5,5,5)', '+y@(6.5,10,5)']);
  });

  it('edge lineage: two operands name every result edge, three name none (K05 limit)', async () => {
    for (const [core, named] of [
      [undefined, true],
      ['corner', false]
    ] as const) {
      const fixture = fixtureB(core);
      const cut = booleanBodies(fixture.document, {
        name: 'Subtract',
        operation: 'subtract',
        targetBodyIds: [
          fixture.block,
          fixture.post,
          ...(fixture.core ? [fixture.core] : [])
        ]
      });
      const built = expectBuilt(
        await outcome(cut.document, [cut.bodyId]),
        'cut'
      );
      const edges = built.bodyRepresentations[cut.bodyId]!.topology!.edges;
      expect(edges.length).toBeGreaterThan(0);
      expect(
        edges.filter((edge) => edge.reference?.lineageName !== undefined)
          .length,
        `${core ?? 'two operands'}`
      ).toBe(named ? edges.length : 0);
    }
  });

  it('three operands: a chamfer on a generated rim edge stops with a typed refusal after the upstream edit, never on another edge', async () => {
    // Recorded as the multi-operand limit, not a bug: with no edge lineage
    // the chamfer holds a hash only, and Post's move changes that hash.
    const fixture = fixtureB('corner');
    const cut = booleanBodies(fixture.document, {
      name: 'Subtract',
      operation: 'subtract',
      targetBodyIds: [fixture.block, fixture.post, fixture.core!]
    });
    const built = expectBuilt(await outcome(cut.document, [cut.bodyId]), 'cut');
    const rim = rimEdge(built.bodyRepresentations[cut.bodyId]!, 15);
    expect(rim.reference).toBeUndefined();
    const chamfered = chamferEdges(cut.document, {
      name: 'Chamfer',
      targetBodyId: cut.bodyId,
      edgeHashes: [rim.hash],
      size: 1
    });
    // 1 mm × 1 mm / 2 along the 5 mm rim: −2.5.
    const before = expectBuilt(
      await outcome(chamfered.document, [chamfered.bodyId]),
      'chamfer'
    );
    near(
      before.bodyRepresentations[chamfered.bodyId]?.volume,
      BLOCK - SHARED - 250 - 2.5,
      'chamfer'
    );
    expect(chamferFaces(before.bodyRepresentations[chamfered.bodyId]!)).toEqual(
      ['14.5']
    );

    const moved = movePost(chamfered.document, 13);
    const after = await adapter.syncDocument(moved);
    const stopped = refusal(after, 'moved');
    expect(stopped?.state, stopped?.evidence).toBe('typed-refusal');
    const warning = (after.featureWarnings ?? []).find(
      (entry) => entry.featureName === 'Chamfer'
    );
    expect(warning?.kind).toBe('build-failed');
    expect(warning?.kernelRefusal?.category).toBe('invalid_input');
    // Geometry kept: the cut stands unchamfered (2000 − 350 − 250), and no
    // chamfer appears on any other edge.
    near(
      after.bodyRepresentations[chamfered.bodyId]?.volume,
      BLOCK - 7 * 5 * 10 - 250,
      'moved'
    );
    expect(chamferFaces(after.bodyRepresentations[chamfered.bodyId]!)).toEqual(
      []
    );
  });

  it('two operands: the same chamfer follows the rim to x = 13', async () => {
    const fixture = fixtureB();
    const cut = booleanBodies(fixture.document, {
      name: 'Subtract',
      operation: 'subtract',
      targetBodyIds: [fixture.block, fixture.post]
    });
    const built = expectBuilt(await outcome(cut.document, [cut.bodyId]), 'cut');
    const rim = rimEdge(built.bodyRepresentations[cut.bodyId]!, 15);
    expect(rim.reference?.kind).toBe('edge');
    const chamfered = chamferEdges(cut.document, {
      name: 'Chamfer',
      targetBodyId: cut.bodyId,
      edgeHashes: [rim.hash],
      edgeReferences: [rim.reference as never],
      size: 1
    });
    const moved = movePost(chamfered.document, 13);
    const after = expectBuilt(
      await outcome(moved, [chamfered.bodyId]),
      'moved'
    );
    near(
      after.bodyRepresentations[chamfered.bodyId]?.volume,
      BLOCK - 7 * 5 * 10 - 2.5,
      'moved'
    );
    expect(chamferFaces(after.bodyRepresentations[chamfered.bodyId]!)).toEqual([
      '12.5'
    ]);
  });
});

/**
 * A rim chamfer beside a through bore, on Remus 2026.1.171 (`f210583`).
 * Block, Post and a 4 × 4 × 30 Core moved (3,3,0) to bore Block through;
 * Subtract [Block, Post, Core]; Chamfer 1 mm on the rim edge
 * (15,5,10)–(15,10,10). The kernel cannot build it: its chamfer rebuilds the
 * top face's outer loop around the bore, then rejects the shell it assembled
 * (shared edges with inconsistent face orientations), at 0.5 and 0.1 mm too,
 * while the same rim without the bore builds. A blind pocket or a boss in
 * the same top face (one inner loop to the kernel) refuses the same way.
 * The kernel files that under its catch-all `fillet-failed` code as
 * `internal`, which was the Untyped refusal gap. The adapter now files it as
 * a typed `unsupported` refusal with its own code and a sentence naming the
 * remedy, and the remedy is proved for all three: chamfer the rim before
 * the feature that makes the bore, pocket or boss.
 *
 * The setup is built once and asserted by a passing test, so the refusal
 * is asserted on its own.
 */
describe('Cell 4b: a rim chamfer beside a through bore', () => {
  let cutVolume: number | undefined;
  let rimFound = false;
  let cutWarnings: readonly string[] = [];
  let chamfer: DerivedState | undefined;
  let chamferBodyId: BodyId | undefined;
  beforeAll(async () => {
    const fixture = fixtureB('bore');
    const cut = booleanBodies(fixture.document, {
      name: 'Subtract',
      operation: 'subtract',
      targetBodyIds: [fixture.block, fixture.post, fixture.core!]
    });
    const built = await adapter.syncDocument(cut.document);
    cutWarnings = built.warnings;
    const body = built.bodyRepresentations[cut.bodyId];
    cutVolume = body?.volume;
    const rim = body ? rimEdge(body, 15) : undefined;
    rimFound = rim !== undefined;
    if (!rim) return;
    const chamfered = chamferEdges(cut.document, {
      name: 'Chamfer',
      targetBodyId: cut.bodyId,
      edgeHashes: [rim.hash],
      size: 1
    });
    chamferBodyId = chamfered.bodyId;
    chamfer = await adapter.syncDocument(chamfered.document);
  }, 120_000);

  it('builds the bored cut and finds its rim edge', () => {
    expect(cutWarnings).toEqual([]);
    near(cutVolume, BLOCK - SHARED - 160, 'cut');
    expect(rimFound).toBe(true);
    expect(chamfer, 'chamfer build ran').toBeDefined();
    // Whatever the chamfer does, nothing else in the history refused.
    expect(
      (chamfer!.featureWarnings ?? []).filter(
        (warning) =>
          warning.featureName !== 'Chamfer' &&
          (warning.kind === 'build-failed' || warning.kind === 'refusal')
      )
    ).toEqual([]);
    expect(chamfer!.bodyRepresentations[chamferBodyId!]).toBeDefined();
  });

  it('refuses with a typed `unsupported` record and says what to do, keeping the cut', () => {
    expectInnerLoopRefusal(chamfer!, chamferBodyId!, BLOCK - SHARED - 160);
  });

  it('the advice holds: chamfered before the bore is cut, the same rim builds exactly', async () => {
    await expectChamferFirstBuilds('bore', BLOCK - SHARED - 160 - 2.5);
  });
});

const INNER_LOOP_ADVICE =
  "A flat face beside this edge has a hole, pocket or boss inside it, which the modeling engine can't chamfer next to yet. Smaller distances failed too. If a feature made that shape, add the chamfer before it.";

/** The Chamfer feature's warning in `derived`. */
function chamferWarning(derived: DerivedState) {
  return (derived.featureWarnings ?? []).find(
    (entry) => entry.featureName === 'Chamfer'
  );
}

/**
 * The typed inner-loop refusal, with the body kept at `kept` and no bevel:
 * not a silent no-op.
 */
function expectInnerLoopRefusal(
  derived: DerivedState,
  bodyId: BodyId,
  kept: number
) {
  const refused = refusal(derived, 'chamfer');
  expect(refused?.state, refused?.evidence).toBe('typed-refusal');
  const warning = chamferWarning(derived);
  expect(warning?.kind).toBe('build-failed');
  expect(warning?.kernelRefusal).toEqual({
    family: 'blend',
    operation: 'chamfer',
    category: 'unsupported',
    code: 'chamfer_face_inner_loop',
    reason: 'fillet-failed'
  });
  expect(warning?.blendAdvice).toEqual({
    operation: 'chamfer',
    edges: 1,
    reason: INNER_LOOP_ADVICE,
    kind: 'structural',
    cause: 'face-inner-loop'
  });
  near(derived.bodyRepresentations[bodyId]?.volume, kept, 'kept');
  expect(chamferFaces(derived.bodyRepresentations[bodyId]!)).toEqual([]);
}

type InnerFeature = 'bore' | 'pocket' | 'boss';
const INNER_OPERATION: Record<InnerFeature, BooleanOperation> = {
  bore: 'subtract',
  pocket: 'subtract',
  boss: 'union'
};

/** Subtract [Block, Post], then the inner feature as its own Boolean. */
function notchThen(inner: InnerFeature) {
  const fixture = fixtureB(inner);
  const notch = booleanBodies(fixture.document, {
    name: 'Subtract',
    operation: 'subtract',
    targetBodyIds: [fixture.block, fixture.post]
  });
  const shaped = booleanBodies(notch.document, {
    name: 'Inner',
    operation: INNER_OPERATION[inner],
    targetBodyIds: [notch.bodyId, fixture.core!]
  });
  return { fixture, notch, shaped };
}

/** The sentence's remedy: chamfer the rim, then apply the inner feature. */
async function expectChamferFirstBuilds(inner: InnerFeature, volume: number) {
  const { fixture, notch } = notchThen(inner);
  const built = expectBuilt(
    await outcome(notch.document, [notch.bodyId]),
    'notch'
  );
  const rim = rimEdge(built.bodyRepresentations[notch.bodyId]!, 15);
  const chamfered = chamferEdges(notch.document, {
    name: 'Chamfer',
    targetBodyId: notch.bodyId,
    edgeHashes: [rim.hash],
    ...(rim.reference ? { edgeReferences: [rim.reference] } : {}),
    size: 1
  });
  const shaped = booleanBodies(chamfered.document, {
    name: 'Inner',
    operation: INNER_OPERATION[inner],
    targetBodyIds: [chamfered.bodyId, fixture.core!]
  });
  const after = expectBuilt(
    await outcome(shaped.document, [shaped.bodyId]),
    inner
  );
  near(after.bodyRepresentations[shaped.bodyId]?.volume, volume, inner);
  expect(chamferFaces(after.bodyRepresentations[shaped.bodyId]!)).toEqual([
    '14.5'
  ]);
}

/** A straight edge of `body` from `a` to `b`, either way round. */
function lineEdge(
  body: BodyRepresentation,
  a: readonly number[],
  b: readonly number[]
): EdgeTopology {
  const at = (p: readonly number[], q: readonly number[]) =>
    p.every((value, index) => Math.abs(value - q[index]!) < 1e-6);
  const match = (body.topology?.edges ?? []).filter((edge) => {
    const p = edge.points;
    const n = p.length;
    if (edge.curve?.type !== 'LINE' || n < 6) return false;
    const start = [p[0]!, p[1]!, p[2]!];
    const end = [p[n - 3]!, p[n - 2]!, p[n - 1]!];
    return (at(start, a) && at(end, b)) || (at(start, b) && at(end, a));
  });
  expect(match, `one edge ${a.join(',')}–${b.join(',')}`).toHaveLength(1);
  return match[0]!;
}

/**
 * The same refusal is typed only for what its sentence says. Pocket and
 * boss: the face has something inside it that is not a hole through, and
 * the sentence and remedy hold for both. Mixed: the bore's own corner edge
 * exists only because of the bore, so "chamfer before it" cannot hold for
 * the selection, and the kernel's record is kept. Tiny: no smaller distance
 * can be tried below 1.5e-9 mm, so "smaller distances failed too" would be
 * unproved, and the kernel's record is kept.
 */
describe('Cell 4b: the inner-loop refusal is typed only where its sentence holds', () => {
  for (const [inner, before] of [
    ['pocket', BLOCK - SHARED - 80],
    ['boss', BLOCK - SHARED + 48]
  ] as const) {
    it(`${inner}: refuses the rim chamfer with the same typed record and sentence`, async () => {
      const { shaped } = notchThen(inner);
      const built = expectBuilt(
        await outcome(shaped.document, [shaped.bodyId]),
        inner
      );
      near(built.bodyRepresentations[shaped.bodyId]?.volume, before, inner);
      const rim = rimEdge(built.bodyRepresentations[shaped.bodyId]!, 15);
      const chamfered = chamferEdges(shaped.document, {
        name: 'Chamfer',
        targetBodyId: shaped.bodyId,
        edgeHashes: [rim.hash],
        size: 1
      });
      expectInnerLoopRefusal(
        await adapter.syncDocument(chamfered.document),
        chamfered.bodyId,
        before
      );
    });

    it(`${inner}: the advice holds, chamfered before the ${inner} the rim builds exactly`, async () => {
      await expectChamferFirstBuilds(inner, before - 2.5);
    });
  }

  it("keeps the kernel's record when one selected edge is the bore's own", async () => {
    const { shaped } = notchThen('bore');
    const built = expectBuilt(
      await outcome(shaped.document, [shaped.bodyId]),
      'bore'
    );
    const body = built.bodyRepresentations[shaped.bodyId]!;
    const chamfered = chamferEdges(shaped.document, {
      name: 'Chamfer',
      targetBodyId: shaped.bodyId,
      edgeHashes: [
        rimEdge(body, 15).hash,
        lineEdge(body, [3, 3, 0], [3, 3, 10]).hash
      ],
      size: 1
    });
    const warning = chamferWarning(
      await adapter.syncDocument(chamfered.document)
    );
    expect(warning?.kind).toBe('build-failed');
    expect(warning?.kernelRefusal).toEqual({
      family: 'blend',
      operation: 'chamfer',
      category: 'internal',
      code: 'fillet-failed'
    });
    expect(warning?.blendAdvice).toMatchObject({
      kind: 'structural',
      cause: 'unknown',
      edges: 2
    });
  });

  it("keeps the kernel's record when no smaller distance could be tried", async () => {
    const { shaped } = notchThen('bore');
    const built = expectBuilt(
      await outcome(shaped.document, [shaped.bodyId]),
      'bore'
    );
    const chamfered = chamferEdges(shaped.document, {
      name: 'Chamfer',
      targetBodyId: shaped.bodyId,
      edgeHashes: [rimEdge(built.bodyRepresentations[shaped.bodyId]!, 15).hash],
      size: 1.5e-9
    });
    const warning = chamferWarning(
      await adapter.syncDocument(chamfered.document)
    );
    expect(warning?.kind).toBe('build-failed');
    expect(warning?.kernelRefusal).toEqual({
      family: 'blend',
      operation: 'chamfer',
      category: 'internal',
      code: 'fillet-failed'
    });
    expect(warning?.blendAdvice).not.toMatchObject({
      cause: 'face-inner-loop'
    });
  });
});

/** Planar faces whose normal is on no axis, as `nx,ny,nz@cx`, rounded. */
function obliqueFaces(body: BodyRepresentation): string[] {
  const r = (value: number) => Math.round(value * 1e6) / 1e6 + 0;
  return (body.topology?.faces ?? []).flatMap((face) => {
    const g = face.geometry;
    const n = g?.normal;
    if (g?.surfaceType !== 'plane' || !n) return [];
    const onAxis = [n.x, n.y, n.z].some(
      (value) => Math.abs(Math.abs(value) - 1) < 1e-9
    );
    return onAxis ? [] : [`${r(n.x)},${r(n.y)},${r(n.z)}@${r(g.center.x)}`];
  });
}

/**
 * Class Wrong result (K10 kernel), Remus 2026.1.171 (`f210583`), found while
 * fixing Cell 4b. Smallest failing prefix: Block and Post only; Subtract
 * [Block, Post]; Chamfer 1 mm on the notch's BOTTOM rim (15,5,0)–(15,10,0).
 * The body is symmetric top to bottom and the top rim removes 2.5, but the
 * bottom one builds with a bevel face whose normal leans in Y
 * (≈ 0.68, 0.27, −0.68) and removes 0.8333. Counts as fixed: 1747.5 with one
 * 45° (+X, −Z) bevel at x = 14.5 and no other oblique face, or a typed
 * refusal. The setup is asserted by a passing test, and a missing setup
 * makes the pin itself pass, which `it.fails` reports, so neither can stand
 * in for the bug.
 */
describe('Cell 4c: the same rim chamfer on the notch floor', () => {
  let cut: DerivedState | undefined;
  let cutBodyId: BodyId | undefined;
  let floorRimFound = false;
  let floor: DerivedState | undefined;
  let floorBodyId: BodyId | undefined;
  beforeAll(async () => {
    const fixture = fixtureB();
    const notch = booleanBodies(fixture.document, {
      name: 'Subtract',
      operation: 'subtract',
      targetBodyIds: [fixture.block, fixture.post]
    });
    cutBodyId = notch.bodyId;
    cut = await adapter.syncDocument(notch.document);
    const body = cut.bodyRepresentations[notch.bodyId];
    const floorRim = (body?.topology?.edges ?? []).find((edge) => {
      const p = edge.points;
      const n = p.length;
      if (edge.curve?.type !== 'LINE' || n < 6) return false;
      const ends = [
        [p[0]!, p[1]!, p[2]!],
        [p[n - 3]!, p[n - 2]!, p[n - 1]!]
      ];
      return (
        ends.every(
          ([ex, , ez]) => Math.abs(ex! - 15) < 1e-6 && Math.abs(ez!) < 1e-6
        ) &&
        ends.some(([, ey]) => Math.abs(ey! - 5) < 1e-6) &&
        ends.some(([, ey]) => Math.abs(ey! - 10) < 1e-6)
      );
    });
    floorRimFound = floorRim !== undefined;
    if (!floorRim) return;
    const chamfered = chamferEdges(notch.document, {
      name: 'Chamfer',
      targetBodyId: notch.bodyId,
      edgeHashes: [floorRim.hash],
      size: 1
    });
    floorBodyId = chamfered.bodyId;
    floor = await adapter.syncDocument(chamfered.document);
  }, 120_000);

  it('builds the notch, finds its floor rim, and the chamfer builds closed and exact', () => {
    expect(cut?.warnings).toEqual([]);
    near(cut?.bodyRepresentations[cutBodyId!]?.volume, BLOCK - SHARED, 'cut');
    expect(floorRimFound).toBe(true);
    expect(floor, 'chamfer build ran').toBeDefined();
    const refused = refusal(floor!, 'floor');
    if (refused) {
      expect(refused.state, refused.evidence).toBe('typed-refusal');
      return;
    }
    const body = floor!.bodyRepresentations[floorBodyId!];
    expect(body?.exportableStep).toBe(true);
    expect(
      isClosedConsistentlyOrientedMesh(
        inspectTriangleMeshClosure(body!.mesh.vertices, body!.mesh.indices)
      )
    ).toBe(true);
  });

  it.fails('removes 2.5 with one 45° bevel, like the top rim', () => {
    const body = floor?.bodyRepresentations[floorBodyId!];
    // Missing setup passes here, which fails this pin loudly.
    if (!body) return;
    if (refusal(floor!, 'floor')) return;
    near(body.volume, BLOCK - SHARED - 2.5, 'floor');
    expect(obliqueFaces(body)).toEqual(['0.707107,0,-0.707107@14.5']);
  });
});
