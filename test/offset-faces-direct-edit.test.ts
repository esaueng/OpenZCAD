import { afterAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  listFeaturesInOrder,
  repairedDirectEditOperation,
  staleDirectEditFaceRepair,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type DirectEditOperation,
  type FaceTopology,
  type OffsetFaceSnapshot,
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { assertDirectEditOperation } from '../packages/kernel-adapter/src/exact-direct-edit-guards';

/**
 * Multi-face Offset: a set of planar faces pushed or pulled together by one
 * distance along each face's own outward normal (`offset-faces`). Faces on
 * one plane move as one group; any other set moves as a chain of groups,
 * one per plane, whether its faces are parallel, meet at an edge or lie
 * apart. Faces pointing opposite ways are refused.
 *
 * The body is a 40 x 20 x 5 plate with two 10 x 10 posts standing on it,
 * each `POST_HEIGHT` tall, fused into one solid. The two post tops are
 * coplanar and face +z; the plate's own top also faces +z, lower. The
 * plate's bottom faces the opposite way, which a set must not mix with
 * them; a post's side walls face other ways, which a set may.
 */
const PLATE_VOLUME = 40 * 20 * 5;
const POST_AREA = 10 * 10;
const POST_HEIGHT = 10;
const PLATE_TOP_AREA = 40 * 20 - 2 * POST_AREA;

let adapter: ExactKernelAdapter | undefined;
afterAll(() => adapter?.dispose());

function postsDocument(postHeight = POST_HEIGHT): {
  document: ProjectDocument;
  bodyId: BodyId;
} {
  let document = createProjectDocument('Posts', toUserId('user_offset_faces'));
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 20, depth: 5 }
  });
  const plate = document.bodyOrder.at(-1)!;
  const posts: BodyId[] = [];
  for (const [index, x] of [5, 25].entries()) {
    document = addPrimitiveFeature(document, {
      name: `Post ${index + 1}`,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: postHeight }
    });
    document = transformBody(document, {
      name: `Place post ${index + 1}`,
      targetBodyId: document.bodyOrder.at(-1)!,
      translation: { x, y: 5, z: 5 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    posts.push(document.bodyOrder.at(-1)!);
  }
  const fused = booleanBodies(document, {
    name: 'Fuse',
    operation: 'union',
    targetBodyIds: [plate, ...posts]
  });
  return { document: fused.document, bodyId: fused.bodyId };
}

async function built(postHeight = POST_HEIGHT) {
  adapter ??= await createExactKernelAdapter();
  const { document, bodyId } = postsDocument(postHeight);
  const derived = await adapter.syncDocument(document);
  expect(derived.warnings).toEqual([]);
  expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
    PLATE_VOLUME + 2 * POST_AREA * postHeight,
    6
  );
  return { document: { ...document, derived }, bodyId };
}

function facesOf(document: ProjectDocument, bodyId: BodyId): FaceTopology[] {
  return document.derived.bodyRepresentations[bodyId]!.topology!.faces;
}

function planar(
  faces: FaceTopology[],
  normal: { x: number; y: number; z: number },
  predicate: (face: FaceTopology) => boolean = () => true
): FaceTopology[] {
  return faces.filter((face) => {
    const n = face.geometry?.normal;
    return (
      face.geometry?.surfaceType === 'plane' &&
      n !== undefined &&
      n.x * normal.x + n.y * normal.y + n.z * normal.z > 1 - 1e-9 &&
      predicate(face)
    );
  });
}

function postTops(document: ProjectDocument, bodyId: BodyId, z: number) {
  const tops = planar(
    facesOf(document, bodyId),
    { x: 0, y: 0, z: 1 },
    (face) => Math.abs(face.geometry!.center.z - z) < 1e-9
  );
  expect(tops).toHaveLength(2);
  for (const top of tops) expect(top.geometry!.area).toBeCloseTo(POST_AREA, 9);
  return tops;
}

function plateTopOf(document: ProjectDocument, bodyId: BodyId): FaceTopology {
  const tops = planar(
    facesOf(document, bodyId),
    { x: 0, y: 0, z: 1 },
    (face) => Math.abs(face.geometry!.center.z - 5) < 1e-9
  );
  expect(tops).toHaveLength(1);
  expect(tops[0]!.geometry!.area).toBeCloseTo(PLATE_TOP_AREA, 9);
  return tops[0]!;
}

/** The body's vertices, rounded and sorted: its edges' end positions. */
function vertexPoints(body: {
  topology?: { vertices?: { point: Vector3 }[] };
}) {
  return (body.topology?.vertices ?? [])
    .map(({ point }) =>
      [point.x, point.y, point.z].map((v) => v.toFixed(6)).join(',')
    )
    .sort();
}

function snapshot(face: FaceTopology): OffsetFaceSnapshot {
  return {
    faceHash: face.hash,
    ...(face.reference ? { faceReference: face.reference } : {}),
    sourceSurfaceType: 'plane',
    sourceArea: face.geometry!.area,
    sourceCenter: face.geometry!.center,
    sourceNormal: face.geometry!.normal!
  };
}

function offsetFaces(
  faces: FaceTopology[],
  offset: number | string
): DirectEditOperation {
  const [first, ...rest] = faces.map(snapshot);
  return {
    kind: 'offset-faces',
    ...first!,
    offset,
    additionalFaces: rest
  };
}

function withEdit(
  document: ProjectDocument,
  bodyId: BodyId,
  operation: DirectEditOperation
): ProjectDocument {
  const manager = new CommandManager(document);
  manager.execute(
    commandFactories.directEditBody({
      name: 'Offset faces',
      targetBodyId: bodyId,
      operation
    })
  );
  return manager.document;
}

async function edit(
  document: ProjectDocument,
  bodyId: BodyId,
  operation: DirectEditOperation
) {
  return adapter!.syncDocument(withEdit(document, bodyId, operation));
}

describe('offsetting a face set', () => {
  it('grows and shrinks both post tops together, exactly', async () => {
    const { document, bodyId } = await built();
    const tops = postTops(document, bodyId, 5 + POST_HEIGHT);
    for (const offset of [2, -2, 3.5]) {
      const derived = await edit(document, bodyId, offsetFaces(tops, offset));
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId]!;
      expect(body.volume).toBeCloseTo(
        PLATE_VOLUME + 2 * POST_AREA * (POST_HEIGHT + offset),
        6
      );
      expect(body.bbox.max.z).toBeCloseTo(5 + POST_HEIGHT + offset, 9);
      // Both tops moved: two +z faces at the new height, none left behind.
      postTops({ ...document, derived }, bodyId, 5 + POST_HEIGHT + offset);
      expect(
        planar(
          body.topology!.faces,
          { x: 0, y: 0, z: 1 },
          (face) => Math.abs(face.geometry!.center.z - 5 - POST_HEIGHT) < 1e-9
        )
      ).toHaveLength(0);
    }
  }, 60_000);

  it('takes the distance as an expression', async () => {
    const { document, bodyId } = await built();
    const tops = postTops(document, bodyId, 5 + POST_HEIGHT);
    const derived = await edit(document, bodyId, offsetFaces(tops, '1 + 1'));
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      PLATE_VOLUME + 2 * POST_AREA * (POST_HEIGHT + 2),
      6
    );
  }, 60_000);

  it('moves parallel faces at different heights together, exactly', async () => {
    // A post top and the plate's own top: parallel, 10 apart. The chain
    // moves the leading plane first, so the plate top never meets the
    // post top it rises towards.
    const { document, bodyId } = await built();
    const [top] = postTops(document, bodyId, 5 + POST_HEIGHT);
    const plateTop = plateTopOf(document, bodyId);
    for (const offset of [2, -2]) {
      const derived = await edit(
        document,
        bodyId,
        offsetFaces([top!, plateTop], offset)
      );
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId]!;
      expect(body.volume).toBeCloseTo(
        PLATE_VOLUME +
          2 * POST_AREA * POST_HEIGHT +
          (POST_AREA + PLATE_TOP_AREA) * offset,
        6
      );
      // Post 2, not in the set, stays at its height.
      expect(body.bbox.max.z).toBeCloseTo(
        5 + POST_HEIGHT + Math.max(offset, 0),
        9
      );
      const upAt = (z: number) =>
        planar(
          body.topology!.faces,
          { x: 0, y: 0, z: 1 },
          (face) => Math.abs(face.geometry!.center.z - z) < 1e-9
        );
      expect(upAt(5 + offset)).toHaveLength(1);
      expect(upAt(5 + POST_HEIGHT + offset)).toHaveLength(1);
      expect(upAt(5 + POST_HEIGHT)).toHaveLength(1);
    }
  }, 60_000);

  it('builds the same solid whatever order the faces are stored in', async () => {
    const { document, bodyId } = await built();
    const tops = postTops(document, bodyId, 5 + POST_HEIGHT);
    const plateTop = plateTopOf(document, bodyId);
    const orders = [
      [tops[0]!, tops[1]!, plateTop],
      [plateTop, tops[1]!, tops[0]!],
      [tops[1]!, plateTop, tops[0]!]
    ];
    const results = [];
    for (const order of orders) {
      const derived = await edit(document, bodyId, offsetFaces(order, 3));
      expect(derived.warnings).toEqual([]);
      results.push(derived.bodyRepresentations[bodyId]!);
    }
    for (const body of results) {
      expect(body.volume).toBeCloseTo(
        PLATE_VOLUME + 2 * POST_AREA * POST_HEIGHT + 3 * 40 * 20,
        6
      );
      expect(body.topology!.faces).toHaveLength(
        results[0]!.topology!.faces.length
      );
      expect(vertexPoints(body)).toEqual(vertexPoints(results[0]!));
    }
  }, 60_000);

  it('refuses faces that face opposite ways by name', async () => {
    const { document, bodyId } = await built();
    const [top] = postTops(document, bodyId, 5 + POST_HEIGHT);
    const bottom = planar(facesOf(document, bodyId), { x: 0, y: 0, z: -1 });
    expect(bottom).toHaveLength(1);
    const derived = await edit(
      document,
      bodyId,
      offsetFaces([top!, bottom[0]!], 2)
    );
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain(
      'The selected faces face opposite ways, so one offset would thicken one and thin the other. Offset them separately.'
    );
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      PLATE_VOLUME + 2 * POST_AREA * POST_HEIGHT,
      6
    );
  }, 60_000);

  it('refuses a later step that would run into a face left behind', async () => {
    // Post 1's top leads up by 12; the plate top then follows it to 17,
    // past post 2's top at 15, which is not in the set.
    const { document, bodyId } = await built();
    const tops = postTops(document, bodyId, 5 + POST_HEIGHT);
    const first = tops.find((face) => face.geometry!.center.x < 20)!;
    const derived = await edit(
      document,
      bodyId,
      offsetFaces([first, plateTopOf(document, bodyId)], 12)
    );
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain(
      "Offsetting face 2 after the others would change the body's topology. Offset fewer faces, or a smaller distance."
    );
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      PLATE_VOLUME + 2 * POST_AREA * POST_HEIGHT,
      6
    );
  }, 60_000);

  it('moves a post top with its own side wall: faces that meet at an edge', async () => {
    // The shared edge ends where the raised top meets the moved wall: the
    // post becomes 12 wide and 12 tall, whatever order the steps take.
    const { document, bodyId } = await built();
    const tops = postTops(document, bodyId, 5 + POST_HEIGHT);
    const first = tops.find((face) => face.geometry!.center.x < 20)!;
    const wall = planar(
      facesOf(document, bodyId),
      { x: 1, y: 0, z: 0 },
      (face) => Math.abs(face.geometry!.center.x - 15) < 1e-9
    );
    expect(wall).toHaveLength(1);
    const shapes = [];
    for (const order of [
      [first, wall[0]!],
      [wall[0]!, first]
    ]) {
      const derived = await edit(document, bodyId, offsetFaces(order, 2));
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId]!;
      expect(body.volume).toBeCloseTo(
        PLATE_VOLUME + POST_AREA * POST_HEIGHT + 12 * 10 * 12,
        6
      );
      expect(body.bbox.max.z).toBeCloseTo(17, 9);
      shapes.push(
        body.topology!.edges.map((edge) => edge.length!.toFixed(6)).sort()
      );
    }
    expect(shapes[1]).toEqual(shapes[0]);
    // The moved wall's top edge, 10 long, now sits at x = 17, z = 17.
    const corner = planar(
      facesOf(
        {
          ...document,
          derived: await edit(
            document,
            bodyId,
            offsetFaces([first, wall[0]!], 2)
          )
        },
        bodyId
      ),
      { x: 1, y: 0, z: 0 },
      (face) => Math.abs(face.geometry!.center.x - 17) < 1e-9
    );
    expect(corner).toHaveLength(1);
    expect(corner[0]!.geometry!.area).toBeCloseTo(10 * 12, 9);
  }, 60_000);

  it('moves faces that face different directions and are apart', async () => {
    // Post 1's top and post 2's side wall: not parallel, and apart.
    const { document, bodyId } = await built();
    const tops = postTops(document, bodyId, 5 + POST_HEIGHT);
    const first = tops.find((face) => face.geometry!.center.x < 20)!;
    const wall = planar(
      facesOf(document, bodyId),
      { x: 1, y: 0, z: 0 },
      (face) => Math.abs(face.geometry!.center.x - 35) < 1e-9
    );
    expect(wall).toHaveLength(1);
    const derived = await edit(
      document,
      bodyId,
      offsetFaces([first, wall[0]!], 2)
    );
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId]!;
    expect(body.volume).toBeCloseTo(
      // Post 1 grows 2 up, post 2 grows 2 toward +x: 2 × 100 each.
      PLATE_VOLUME + 2 * POST_AREA * POST_HEIGHT + 4 * POST_AREA,
      6
    );
    expect(body.bbox.max.x).toBeCloseTo(40, 9);
  }, 60_000);

  it('refuses two later faces that face opposite ways, whatever the first', async () => {
    // Post 1's top, then post 1's two x walls: neither wall is opposite the
    // top, but they are opposite each other.
    const { document, bodyId } = await built();
    const tops = postTops(document, bodyId, 5 + POST_HEIGHT);
    const first = tops.find((face) => face.geometry!.center.x < 20)!;
    const plus = planar(
      facesOf(document, bodyId),
      { x: 1, y: 0, z: 0 },
      (face) => Math.abs(face.geometry!.center.x - 15) < 1e-9
    );
    const minus = planar(
      facesOf(document, bodyId),
      { x: -1, y: 0, z: 0 },
      (face) => Math.abs(face.geometry!.center.x - 5) < 1e-9
    );
    expect(plus).toHaveLength(1);
    expect(minus).toHaveLength(1);
    const derived = await edit(
      document,
      bodyId,
      offsetFaces([first, plus[0]!, minus[0]!], 2)
    );
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain(
      'The selected faces face opposite ways, so one offset would thicken one and thin the other. Offset them separately.'
    );
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      PLATE_VOLUME + 2 * POST_AREA * POST_HEIGHT,
      6
    );
  }, 60_000);

  it('refuses a drifted face in the set rather than moving another', async () => {
    const { document, bodyId } = await built();
    const tops = postTops(document, bodyId, 5 + POST_HEIGHT);
    const operation = offsetFaces(tops, 2) as Extract<
      DirectEditOperation,
      { kind: 'offset-faces' }
    >;
    const drifted: DirectEditOperation = {
      ...operation,
      additionalFaces: [
        {
          ...operation.additionalFaces[0]!,
          sourceArea: operation.additionalFaces[0]!.sourceArea + 1
        }
      ]
    };
    const derived = await edit(document, bodyId, drifted);
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain(
      'Face 2 of the offset set no longer matches the body. Select the faces again.'
    );
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      PLATE_VOLUME + 2 * POST_AREA * POST_HEIGHT,
      6
    );
  }, 60_000);

  it('after an upstream change, repairs the first face and asks for the rest', async () => {
    // Two post tops on one plane share a carrier, so the body publishes no
    // lineage name for either: both are pinned by hash, and a taller post
    // changes it. A re-pick refreshes the first face; the second, which a
    // re-pick never guesses, refuses and asks for the faces again.
    const { document, bodyId } = await built();
    const tops = postTops(document, bodyId, 5 + POST_HEIGHT);
    let taller = withEdit(document, bodyId, offsetFaces(tops, 2));
    for (const name of ['Post 1', 'Post 2']) {
      const post = listFeaturesInOrder(taller).find(
        (feature) => feature.name === name
      )!;
      taller = updateFeature(taller, {
        featureId: post.featureId,
        data: { dimensions: { width: 10, height: 10, depth: 12 } }
      });
    }
    const stale = await adapter!.syncDocument(taller);
    expect(stale.warnings).toHaveLength(1);
    const offset = listFeaturesInOrder(taller).at(-1)!;
    const repair = staleDirectEditFaceRepair(offset, stale.warnings);
    expect(repair?.operationKind).toBe('offset-faces');
    const [newTop] = postTops({ ...taller, derived: stale }, bodyId, 17);
    expect(offset.data.featureKind).toBe('direct-edit');
    if (offset.data.featureKind !== 'direct-edit') return;
    const repaired = updateFeature(taller, {
      featureId: offset.featureId,
      data: {
        operation: repairedDirectEditOperation(offset.data.operation, newTop!)
      }
    });
    const rebuilt = await adapter!.syncDocument(repaired);
    expect(rebuilt.warnings).toHaveLength(1);
    expect(rebuilt.warnings[0]).toContain(
      'Face 2 of the offset set no longer matches the body. Select the faces again.'
    );
    // Not a warning a first-face re-pick can fix, so none is offered.
    expect(
      staleDirectEditFaceRepair(
        listFeaturesInOrder(repaired).at(-1)!,
        rebuilt.warnings
      )
    ).toBeNull();
  }, 60_000);

  it('a later single-face offset still finds a moved top', async () => {
    const { document, bodyId } = await built();
    const tops = postTops(document, bodyId, 5 + POST_HEIGHT);
    const edited = withEdit(document, bodyId, offsetFaces(tops, 2));
    const derived = await adapter!.syncDocument(edited);
    const moved = postTops({ ...edited, derived }, bodyId, 7 + POST_HEIGHT);
    const again = await edit({ ...edited, derived }, bodyId, {
      kind: 'offset-face',
      ...snapshot(moved[0]!),
      offset: 1
    });
    expect(again.warnings).toEqual([]);
    expect(again.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      PLATE_VOLUME + 2 * POST_AREA * (POST_HEIGHT + 2) + POST_AREA,
      6
    );
  }, 60_000);

  it('an unknown kind refuses whole, the way an older build meets this one', async () => {
    // Before this kind existed, the guard's default refused it outright; an
    // older build therefore skips the edit behind a warning instead of
    // moving only the first face. A kind newer than this build is the same.
    const { document, bodyId } = await built();
    const tops = postTops(document, bodyId, 5 + POST_HEIGHT);
    const future = {
      ...offsetFaces(tops, 2),
      kind: 'offset-faces-v2'
    } as unknown as DirectEditOperation;
    const derived = await edit(document, bodyId, future);
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain(
      'Direct-edit operation kind is not supported.'
    );
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      PLATE_VOLUME + 2 * POST_AREA * POST_HEIGHT,
      6
    );
  }, 60_000);
});

describe('the offset-faces contract', () => {
  const face = (hash: number, z = 15): OffsetFaceSnapshot => ({
    faceHash: hash,
    sourceSurfaceType: 'plane',
    sourceArea: 100,
    sourceCenter: { x: hash, y: 0, z },
    sourceNormal: { x: 0, y: 0, z: 1 }
  });
  const valid = (): Extract<DirectEditOperation, { kind: 'offset-faces' }> => ({
    kind: 'offset-faces',
    ...face(1),
    offset: 2,
    additionalFaces: [face(2)]
  });

  it('accepts a well-formed set', () => {
    expect(() => assertDirectEditOperation(valid())).not.toThrow();
  });

  it.each([
    ['no additional face', { additionalFaces: [] }, /at least two faces/],
    ['a repeated face', { additionalFaces: [face(1)] }, /names a face twice/],
    [
      'a curved additional face',
      { additionalFaces: [{ ...face(2), sourceSurfaceType: 'cylinder' }] },
      /face 2 must be planar/
    ],
    [
      'an additional face without a normal',
      { additionalFaces: [{ ...face(2), sourceNormal: undefined }] },
      /face 2 normal must be a vector/
    ],
    [
      'too many faces',
      {
        additionalFaces: Array.from({ length: 64 }, (_, index) =>
          face(index + 2)
        )
      },
      /at most 64 faces/
    ],
    ['a missing offset', { offset: undefined }, /offset must be a finite/]
  ])('refuses %s', (_label, patch, message) => {
    expect(() =>
      assertDirectEditOperation({
        ...valid(),
        ...patch
      } as unknown as DirectEditOperation)
    ).toThrow(message);
  });

  it('refuses an additional face reference that names another hash', () => {
    const { document, bodyId } = postsDocument();
    const reference = { kind: 'face', currentHash: 99 };
    const manager = new CommandManager(document);
    expect(() =>
      manager.execute(
        commandFactories.directEditBody({
          name: 'Offset',
          targetBodyId: bodyId,
          operation: {
            ...valid(),
            additionalFaces: [
              { ...face(2), faceReference: reference } as OffsetFaceSnapshot
            ]
          }
        })
      )
    ).toThrow(/does not match its legacy face hash/);
  });

  it('refuses on replay a reference that names another face than its hash', () => {
    // Authoring refuses this pair; a stored document is checked again, or
    // the reference (resolved first, pins skipped) would move another face.
    const reference = {
      kind: 'face',
      currentHash: 3,
      witnessVersion: 1
    };
    expect(() =>
      assertDirectEditOperation({
        ...valid(),
        additionalFaces: [{ ...face(2), faceReference: reference }]
      } as unknown as DirectEditOperation)
    ).toThrow(/face 2 reference does not match its face hash/);
    expect(() =>
      assertDirectEditOperation({
        ...valid(),
        faceReference: reference
      } as unknown as DirectEditOperation)
    ).toThrow(/face 1 reference does not match its face hash/);
    expect(() =>
      assertDirectEditOperation({
        ...valid(),
        additionalFaces: [
          { ...face(2), faceReference: { ...reference, currentHash: 2 } }
        ]
      } as unknown as DirectEditOperation)
    ).not.toThrow();
  });

  it('repairs only the first face and keeps the others pinned', () => {
    const operation = { ...valid(), offset: 'lift' };
    const repaired = repairedDirectEditOperation(operation, {
      hash: 7,
      geometry: {
        surfaceType: 'plane',
        area: 120,
        center: { x: 0, y: 0, z: 17 },
        normal: { x: 0, y: 0, z: 1 }
      }
    });
    expect(repaired).toEqual({
      kind: 'offset-faces',
      faceHash: 7,
      sourceSurfaceType: 'plane',
      sourceArea: 120,
      sourceCenter: { x: 0, y: 0, z: 17 },
      sourceNormal: { x: 0, y: 0, z: 1 },
      offset: 'lift',
      additionalFaces: operation.additionalFaces
    });
    expect(() =>
      repairedDirectEditOperation(operation, {
        hash: 2,
        geometry: {
          surfaceType: 'plane',
          area: 100,
          center: { x: 2, y: 0, z: 15 },
          normal: { x: 0, y: 0, z: 1 }
        }
      })
    ).toThrow(/already in the offset set/);
  });
});
