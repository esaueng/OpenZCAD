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
 * [3,7] × [3,7] × [0,10] = 160.
 */
function fixtureB(core?: 'corner' | 'bore'): Fixture {
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
      dimensions: { width: side, height: side, depth: 30 }
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
      translation: { x: at, y: at, z: 0 }
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
      cornerWall: [] as string[]
    },
    {
      // K05: a multi-operand Subtract names every face by operand (verified
      // below) but publishes no edge lineage.
      label: 'three operands (Core cuts Block’s corner)',
      core: 'corner' as const,
      operandVolume: 250,
      // Core's x-max face cuts the corner wall at x = 5 (−X), so no new +X wall.
      cornerWall: [] as string[]
    }
  ];

  for (const { label, core, operandVolume, cornerWall } of CASES) {
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

  /**
   * FAILS — class Untyped refusal (K10 adapter / kernel), Remus 2026.1.171
   * (`f210583`). Smallest failing prefix: Block, Post and a 4 × 4 × 30 Core
   * moved (3,3,0) to bore Block through; Subtract [Block, Post, Core];
   * Chamfer 1 mm on the rim edge (15,5,10)–(15,10,10). The chamfer refuses
   * with category `internal` (code `fillet-failed`), at 0.5 and 0.1 mm too,
   * where the same rim on the two-operand cut (no bore) builds. Two
   * sequential two-operand Subtracts name the rim and still refuse, so the
   * bore beside the notch, not the operand count, is the trigger. Expected:
   * the chamfer builds (1590 − 2.5 = 1587.5) or refuses with a typed,
   * non-internal category.
   */
  it.fails(
    'a body with a through bore chamfers the generated rim edge',
    async () => {
      const fixture = fixtureB('bore');
      const cut = booleanBodies(fixture.document, {
        name: 'Subtract',
        operation: 'subtract',
        targetBodyIds: [fixture.block, fixture.post, fixture.core!]
      });
      const built = expectBuilt(
        await outcome(cut.document, [cut.bodyId]),
        'cut'
      );
      near(
        built.bodyRepresentations[cut.bodyId]?.volume,
        BLOCK - SHARED - 160,
        'cut'
      );
      const rim = rimEdge(built.bodyRepresentations[cut.bodyId]!, 15);
      const chamfered = chamferEdges(cut.document, {
        name: 'Chamfer',
        targetBodyId: cut.bodyId,
        edgeHashes: [rim.hash],
        size: 1
      });
      const derived = expectBuilt(
        await outcome(chamfered.document, [chamfered.bodyId]),
        'chamfer'
      );
      near(
        derived.bodyRepresentations[chamfered.bodyId]?.volume,
        BLOCK - SHARED - 160 - 2.5,
        'chamfer'
      );
    }
  );
});
