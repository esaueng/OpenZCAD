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
  type ProjectDocument
} from '@openzcad/shared';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { assertDirectEditOperation } from '../packages/kernel-adapter/src/exact-direct-edit-guards';

/**
 * Multi-face Offset: a set of faces on one plane pushed or pulled together
 * by one distance along their shared outward normal (`offset-faces`).
 *
 * The body is a 40 x 20 x 5 plate with two 10 x 10 posts standing on it,
 * each `POST_HEIGHT` tall, fused into one solid. The two post tops are
 * coplanar and face +z: the set the edit moves. The plate's own top, also
 * facing +z but lower, and a post's side wall are the faces a set must not
 * mix with them.
 */
const PLATE_VOLUME = 40 * 20 * 5;
const POST_AREA = 10 * 10;
const POST_HEIGHT = 10;

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

describe('offsetting a coplanar face set', () => {
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

  it('refuses parallel faces at different heights by name', async () => {
    const { document, bodyId } = await built();
    const [top] = postTops(document, bodyId, 5 + POST_HEIGHT);
    const plateTop = planar(
      facesOf(document, bodyId),
      { x: 0, y: 0, z: 1 },
      (face) => Math.abs(face.geometry!.center.z - 5) < 1e-9
    );
    expect(plateTop).toHaveLength(1);
    const derived = await edit(
      document,
      bodyId,
      offsetFaces([top!, plateTop[0]!], 2)
    );
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain(
      'the selected faces are parallel but at different heights'
    );
    // A refused edit leaves the body as the history built it.
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      PLATE_VOLUME + 2 * POST_AREA * POST_HEIGHT,
      6
    );
  }, 60_000);

  it('refuses faces that face different directions by name', async () => {
    const { document, bodyId } = await built();
    const [top] = postTops(document, bodyId, 5 + POST_HEIGHT);
    const sides = planar(
      facesOf(document, bodyId),
      { x: 1, y: 0, z: 0 },
      (face) => Math.abs(face.geometry!.area - 10 * POST_HEIGHT) < 1e-6
    );
    expect(sides.length).toBeGreaterThan(0);
    const derived = await edit(
      document,
      bodyId,
      offsetFaces([top!, sides[0]!], 2)
    );
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain(
      'the selected faces face different directions'
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
