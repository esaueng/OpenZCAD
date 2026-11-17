import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSplitFeature,
  booleanBodies,
  createProjectDocument,
  draftBody,
  filletEdges,
  patternBody,
  shellBody,
  transformBody
} from '@openzcad/document-core';
import { CommandManager } from '@openzcad/command-system';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type EdgeTopology,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import { refusal } from './support/combination-matrix';

/**
 * Production QA 2026-11-14 (docs/qa/2026-11-14/complex-cad-kernel-limits.md):
 * every P1 operation must build a correct exact body or refuse with a typed
 * reason, never refuse in prose and never ship a wrong body. Each case below
 * is the report's scenario reduced to primitives, and holds on any kernel
 * pin: a case that builds is held to exactness, a closed consistently
 * oriented mesh and, where one exists, a closed-form volume; a case that
 * refuses must carry `kernelRefusal`. When a kernel fix lands, a refusal here
 * turns into a checked build without the test changing.
 *
 * Findings 1 and 2 have their own regressions
 * (`test/touching-cylinder-union.test.ts`); finding 8 is covered by #1500's
 * Shell and Draft naming tests.
 */

const user = toUserId('user_qa_p1');
const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

type Outcome =
  | { kind: 'built'; derived: DerivedState; volumes: number[] }
  | { kind: 'typed'; code: string };

/**
 * Build `document` and classify it: a typed refusal, or a build whose every
 * named body is exact with a closed, consistently oriented mesh. A prose
 * refusal or a bad body fails the test.
 */
async function outcome(
  document: ProjectDocument,
  bodyIds: BodyId[] = [last(document)]
): Promise<Outcome> {
  const derived = await adapter.syncDocument(document);
  const refused = refusal(derived, 'step');
  if (refused) {
    expect(refused.state, refused.evidence).toBe('typed-refusal');
    return { kind: 'typed', code: refused.evidence.split(' — ')[0]! };
  }
  const volumes = bodyIds.map((id) => {
    const body = derived.bodyRepresentations[id];
    expect(body, `body ${id}`).toBeDefined();
    expect(body!.exportableStep, `body ${id} exact`).toBe(true);
    expect(
      isClosedConsistentlyOrientedMesh(
        inspectTriangleMeshClosure(body!.mesh.vertices, body!.mesh.indices)
      ),
      `body ${id} closed`
    ).toBe(true);
    return body!.volume;
  });
  return { kind: 'built', derived, volumes };
}

const topology = (derived: DerivedState, id: BodyId) =>
  derived.bodyRepresentations[id]!.topology!;
const normal = (face: FaceTopology) =>
  face.geometry?.normal ?? { x: 0, y: 0, z: 0 };
const adjacent = (derived: DerivedState, id: BodyId, edge: EdgeTopology) =>
  topology(derived, id).faces.filter((face) =>
    (edge.adjacentFaceHashes ?? []).includes(face.hash)
  );
/** Edges between two near-vertical planar faces. */
const verticalEdges = (derived: DerivedState, id: BodyId) =>
  topology(derived, id).edges.filter((edge) => {
    const faces = adjacent(derived, id, edge);
    return (
      edge.displayRole !== 'seam' &&
      edge.curve?.type === 'LINE' &&
      faces.length === 2 &&
      faces.every(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          Math.abs(normal(face).z) < 0.1
      )
    );
  });
/** The upward planar face at height `z`. */
const upFace = (derived: DerivedState, id: BodyId, z: number) =>
  topology(derived, id).faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      normal(face).z > 0.99 &&
      Math.abs(face.geometry.center.z - z) < 1e-6
  );
/** Every edge of the upward planar face at height `z`. */
const loopAt = (derived: DerivedState, id: BodyId, z: number) => {
  const face = upFace(derived, id, z)!;
  return topology(derived, id).edges.filter(
    (edge) =>
      edge.displayRole !== 'seam' &&
      (edge.adjacentFaceHashes ?? []).includes(face.hash)
  );
};
const sideFaces = (derived: DerivedState, id: BodyId) =>
  topology(derived, id).faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'plane' && Math.abs(normal(face).z) < 1e-6
  );
const pickEdges = (edges: EdgeTopology[]) => ({
  edgeHashes: edges.map((edge) => edge.hash),
  ...(edges.every((edge) => edge.reference)
    ? { edgeReferences: edges.map((edge) => edge.reference!) }
    : {})
});
const pickFaces = (faces: FaceTopology[]) => ({
  faceHashes: faces.map((face) => face.hash),
  ...(faces.every((face) => face.reference)
    ? { faceReferences: faces.map((face) => face.reference!) }
    : {})
});
const box = (width: number, height: number, depth: number) =>
  addPrimitiveFeature(createProjectDocument('QA P1', user), {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width, height, depth }
  });
const draftSides = (
  document: ProjectDocument,
  derived: DerivedState,
  id: BodyId
) =>
  draftBody(document, {
    name: 'Draft',
    targetBodyId: id,
    ...pickFaces(sideFaces(derived, id)),
    pullDirection: { x: 0, y: 0, z: 1 },
    neutralPoint: { x: 0, y: 0, z: 0 },
    angleDeg: 2
  });
const built = async (document: ProjectDocument, id = last(document)) => {
  const result = await outcome(document, [id]);
  expect(result.kind, 'setup step builds').toBe('built');
  return (result as Extract<Outcome, { kind: 'built' }>).derived;
};

describe('QA 2026-11-14 P1 #3: draft and blends, in either order', () => {
  it('draft first, then fillet the drafted walls', async () => {
    const document = box(40, 40, 20);
    const base = await built(document);
    const drafted = draftSides(document, base, last(document));
    const derived = await built(drafted.document, drafted.bodyId);
    const verticals = verticalEdges(derived, drafted.bodyId);
    expect(verticals).toHaveLength(4);
    const draftedVolume = derived.bodyRepresentations[drafted.bodyId]!.volume;
    // A convex round removes material: a result no smaller than the drafted
    // body is a blend that did nothing.
    const roundRemoves = (result: Outcome) => {
      if (result.kind === 'built') {
        expect(result.volumes[0]!).toBeLessThan(draftedVolume - 1e-3);
      }
    };
    for (const edges of [verticals.slice(0, 1), verticals]) {
      for (const size of [1, 5]) {
        roundRemoves(
          await outcome(
            filletEdges(drafted.document, {
              name: 'Round',
              targetBodyId: drafted.bodyId,
              ...pickEdges(edges),
              size
            }).document
          )
        );
      }
    }
    roundRemoves(
      await outcome(
        filletEdges(drafted.document, {
          name: 'Round',
          targetBodyId: drafted.bodyId,
          ...pickEdges(loopAt(derived, drafted.bodyId, 20)),
          size: 2
        }).document
      )
    );
  }, 300_000);

  it('fillet first, then draft the rounded walls', async () => {
    const document = box(40, 40, 20);
    const id = last(document);
    const base = await built(document);
    // Drafting the sides 2° about z = 0 grows every horizontal section
    // outward by δ = z·tan 2°: the plain box gains ∫(160δ + 4δ²)dz, and a
    // box whose vertical corners stay R5 gains the same, because each
    // straight wall moves out by δ while the corner arcs keep their radius.
    const t = Math.tan((2 * Math.PI) / 180);
    const plainGain = (160 * t * 20 ** 2) / 2 + (4 * t ** 2 * 20 ** 3) / 3;
    const plain = await outcome(draftSides(document, base, id).document);
    expect(plain.kind).toBe('built');
    expect(
      (plain as Extract<Outcome, { kind: 'built' }>).volumes[0]!
    ).toBeCloseTo(40 * 40 * 20 + plainGain, 6);
    for (const [edges, size, tolerance] of [
      [verticalEdges(base, id), 5, 1],
      // The top-loop rounds shrink the top band's sections, so the gain
      // stays within a few percent of the plain box's.
      [loopAt(base, id, 20), 2, 0.05 * plainGain]
    ] as const) {
      const rounded = filletEdges(document, {
        name: 'Round',
        targetBodyId: id,
        ...pickEdges(edges),
        size
      });
      const derived = await built(rounded.document, rounded.bodyId);
      const before = derived.bodyRepresentations[rounded.bodyId]!.volume;
      const result = await outcome(
        draftSides(rounded.document, derived, rounded.bodyId).document
      );
      if (result.kind === 'built') {
        // A draft returned unchanged would gain nothing.
        expect(Math.abs(result.volumes[0]! - before - plainGain)).toBeLessThan(
          tolerance
        );
      }
    }
  }, 300_000);
});

describe('QA 2026-11-14 P1 #4: split by plane through blends and shells', () => {
  it('splits a 2 mm shell with R5 rounds, or refuses by type', async () => {
    const document = box(60, 40, 30);
    const base = await built(document);
    const rounded = filletEdges(document, {
      name: 'Round',
      targetBodyId: last(document),
      ...pickEdges(verticalEdges(base, last(document))),
      size: 5
    });
    const roundedDerived = await built(rounded.document, rounded.bodyId);
    const opening = upFace(roundedDerived, rounded.bodyId, 30)!;
    const shelled = shellBody(rounded.document, {
      name: 'Shell',
      targetBodyId: rounded.bodyId,
      openingFaceHashes: [opening.hash],
      ...(opening.reference
        ? { openingFaceReferences: [opening.reference] }
        : {}),
      thickness: 2
    });
    const shellVolume = (await outcome(shelled.document, [
      shelled.bodyId
    ])) as Extract<Outcome, { kind: 'built' }>;
    expect(shellVolume.kind).toBe('built');
    const planes = [
      { origin: { x: 0, y: 0, z: 15 }, normal: { x: 0, y: 0, z: 1 } },
      { origin: { x: 30, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } },
      { origin: { x: 2, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } },
      {
        origin: { x: 3, y: 3, z: 0 },
        normal: { x: Math.SQRT1_2, y: -Math.SQRT1_2, z: 0 }
      }
    ];
    for (const plane of planes) {
      const split = addSplitFeature(shelled.document, {
        name: 'Split',
        targetBodyId: shelled.bodyId,
        plane: plane
      });
      const result = await outcome(split.document, [
        split.bodyId,
        split.secondBodyId
      ]);
      if (result.kind === 'built') {
        // The halves partition the shell.
        expect(result.volumes[0]! + result.volumes[1]!).toBeCloseTo(
          shellVolume.volumes[0]!,
          3
        );
      }
    }
  }, 300_000);
});

describe('QA 2026-11-14 P1 #5: patterned pins through a flat flange', () => {
  it.each([5, 6, 8, 24])(
    'cuts %i disjoint pins exactly',
    async (count) => {
      let document = addPrimitiveFeature(
        createProjectDocument('Flange', user),
        {
          name: 'Flange',
          primitiveKind: 'cylinder',
          dimensions: { radius: 40, height: 10 }
        }
      );
      const flange = last(document);
      document = addPrimitiveFeature(document, {
        name: 'Pin',
        primitiveKind: 'cylinder',
        dimensions: { radius: 3, height: 20 }
      });
      document = transformBody(document, {
        name: 'Place pin',
        targetBodyId: last(document),
        translation: { x: 0, y: 31, z: -5 }
      }).document;
      document = patternBody(document, {
        name: 'Pins',
        patternKind: 'circular',
        targetBodyId: last(document),
        axis: 'z',
        count,
        angleDeg: 360
      }).document;
      document = booleanBodies(document, {
        name: 'Holes',
        operation: 'subtract',
        targetBodyIds: [flange, last(document)]
      }).document;
      const result = await outcome(document);
      if (result.kind === 'built') {
        expect(result.volumes[0]).toBeCloseTo(
          Math.PI * 40 ** 2 * 10 - count * Math.PI * 3 ** 2 * 10,
          6
        );
      }
    },
    300_000
  );
});

describe('QA 2026-11-14 P1 #6: face offset beside blends', () => {
  async function offsetTop(
    document: ProjectDocument,
    id: BodyId,
    z: number,
    by: number
  ): Promise<{ result: Outcome; before: number }> {
    const derived = await built(document, id);
    const face = upFace(derived, id, z)!;
    expect(face).toBeDefined();
    // `localOnly`: move the face itself, beside the blend, rather than
    // re-dimensioning the primitive the face came from and replaying the
    // fillet, which would never exercise a blend-aware face move.
    const plan = planFaceOffset({
      document: { ...document, derived },
      bodyId: id,
      face,
      faceHash: face.hash,
      offset: by,
      localOnly: true
    });
    expect(plan).not.toBeNull();
    // These are valid ±1 and −2 moves: the planner must not decline them.
    expect(
      'preflightRejection' in plan! ? plan.preflightRejection : undefined
    ).toBeUndefined();
    expect(plan!.kind).toBe('direct-edit');
    const before = derived.bodyRepresentations[id]!.volume;
    const manager = new CommandManager(document);
    manager.execute(plan!.command);
    return { result: await outcome(manager.document), before };
  }

  it.each([
    ['ringed by a top-loop fillet', 'loop', 1],
    ['ringed by a top-loop fillet', 'loop', 5],
    ['beside one top-edge fillet', 'one', 1],
    ['beside one top-edge fillet', 'one', 5]
  ] as const)(
    'moves a top face %s (%s, R%s) by ±1 and adds the face area times the move',
    async (_label, which, size) => {
      const document = box(60, 40, 20);
      const base = await built(document);
      const loop = loopAt(base, last(document), 20);
      const rounded = filletEdges(document, {
        name: 'Round',
        targetBodyId: last(document),
        ...pickEdges(which === 'loop' ? loop : loop.slice(0, 1)),
        size
      });
      for (const by of [1, -1]) {
        const { result, before } = await offsetTop(
          rounded.document,
          rounded.bodyId,
          20,
          by
        );
        if (result.kind === 'built') {
          // The walls extend by `by`: the whole 60 × 40 cross-section.
          expect(result.volumes[0]! - before).toBeCloseTo(60 * 40 * by, 3);
        }
      }
    },
    300_000
  );

  it('moves a flange top beside a hub-foot fillet', async () => {
    let document = addPrimitiveFeature(createProjectDocument('Hub', user), {
      name: 'Flange',
      primitiveKind: 'cylinder',
      dimensions: { radius: 40, height: 10 }
    });
    const flange = last(document);
    document = addPrimitiveFeature(document, {
      name: 'Hub',
      primitiveKind: 'cylinder',
      dimensions: { radius: 20, height: 35 }
    });
    document = transformBody(document, {
      name: 'Place hub',
      targetBodyId: last(document),
      translation: { x: 0, y: 0, z: 5 }
    }).document;
    document = booleanBodies(document, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [flange, last(document)]
    }).document;
    const united = await built(document);
    const foot = topology(united, last(document)).edges.find(
      (edge) =>
        edge.curve?.circle !== undefined &&
        Math.abs(edge.curve.circle.radius - 20) < 1e-6 &&
        Math.abs(edge.curve.circle.center.z - 10) < 1e-6
    )!;
    expect(foot).toBeDefined();
    const filleted = filletEdges(document, {
      name: 'Foot',
      targetBodyId: last(document),
      ...pickEdges([foot]),
      size: 3
    });
    const { result, before } = await offsetTop(
      filleted.document,
      filleted.bodyId,
      10,
      -2
    );
    if (result.kind === 'built') {
      // The flange annulus outside the fillet's foot drops by 2 mm.
      expect(result.volumes[0]!).toBeLessThan(before);
    }
  }, 300_000);
});

describe('QA 2026-11-14 P1 #7: pocket-floor fillet loops', () => {
  it.each([3, 1, 0.3])(
    'rounds the closed floor loop at R%s or refuses by type',
    async (size) => {
      let document = box(60, 40, 20);
      const block = last(document);
      document = addPrimitiveFeature(document, {
        name: 'Pocket',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      });
      document = transformBody(document, {
        name: 'Place pocket',
        targetBodyId: last(document),
        translation: { x: 20, y: 10, z: 17 }
      }).document;
      document = booleanBodies(document, {
        name: 'Pocket cut',
        operation: 'subtract',
        targetBodyIds: [block, last(document)]
      }).document;
      const pocketed = await built(document);
      const floor = loopAt(pocketed, last(document), 17);
      expect(floor).toHaveLength(4);
      const result = await outcome(
        filletEdges(document, {
          name: 'Floor round',
          targetBodyId: last(document),
          ...pickEdges(floor),
          size
        }).document
      );
      if (result.kind === 'built') {
        // A concave round adds material along the 80 mm floor perimeter.
        expect(result.volumes[0]!).toBeGreaterThan(
          pocketed.bodyRepresentations[last(document)]!.volume
        );
      }
    },
    300_000
  );
});
