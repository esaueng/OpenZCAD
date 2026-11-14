import { afterAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type DirectEditOperation,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * Closing a rectangular window cut through a wall, the two ways a user
 * reaches for: push one wall of the window across to the opposite wall, or
 * select every wall of the window and delete them.
 *
 * The wall is 60 x 4 x 40 (x, y, z) and the window 16 wide and 15.65 tall,
 * through the 4 mm thickness — the proportions of the port window the
 * request was recorded on. Closed, the wall is whole again: 9600 mm³ and
 * six faces, exactly.
 */
const WALL_VOLUME = 60 * 4 * 40;
const WINDOW_HEIGHT = 15.65;

let adapter: ExactKernelAdapter | undefined;
afterAll(() => adapter?.dispose());

async function windowedWall(wallHeight = 40): Promise<{
  document: ProjectDocument;
  bodyId: BodyId;
}> {
  adapter ??= await createExactKernelAdapter();
  let document = createProjectDocument('Window', toUserId('user_window'));
  document = addPrimitiveFeature(document, {
    name: 'Wall',
    primitiveKind: 'box',
    dimensions: { width: 60, height: 4, depth: wallHeight }
  });
  const wall = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Window tool',
    primitiveKind: 'box',
    dimensions: { width: 16, height: 10, depth: WINDOW_HEIGHT }
  });
  document = transformBody(document, {
    name: 'Place the window',
    targetBodyId: document.bodyOrder.at(-1)!,
    translation: { x: 20, y: -3, z: 10 },
    rotationDeg: { x: 0, y: 0, z: 0 }
  }).document;
  const tool = document.bodyOrder.at(-1)!;
  const manager = new CommandManager(document);
  const cut = manager.execute(
    commandFactories.booleanBodies({
      name: 'Cut the window',
      operation: 'subtract',
      targetBodyIds: [wall, tool]
    })
  );
  const derived = await adapter.syncDocument(cut);
  expect(derived.warnings).toEqual([]);
  const bodyId = cut.bodyOrder.find(
    (id) => derived.bodyRepresentations[id] && !derived.bodyRepresentations[id].consumed
  )!;
  const windowVolume = 16 * 4 * WINDOW_HEIGHT;
  expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
    60 * 4 * wallHeight - windowVolume,
    6
  );
  return { document: { ...cut, derived }, bodyId };
}

function windowWalls(document: ProjectDocument, bodyId: BodyId) {
  const faces = document.derived.bodyRepresentations[bodyId]!.topology!.faces;
  // The window's walls are the planar faces across the wall's thickness
  // (normal ⟂ y) with a window-sized area.
  const walls = faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      Math.abs(face.geometry.normal!.y) < 1e-9 &&
      face.geometry.area > 30 &&
      face.geometry.area < 100
  );
  expect(walls).toHaveLength(4);
  const bottom = walls.find((face) => face.geometry!.normal!.z > 0.9)!;
  expect(bottom.geometry!.area).toBeCloseTo(64, 9);
  return { walls, bottom };
}

function snapshot(face: FaceTopology) {
  return {
    faceHash: face.hash,
    ...(face.reference ? { faceReference: face.reference } : {}),
    sourceSurfaceType: face.geometry!.surfaceType,
    sourceArea: face.geometry!.area,
    sourceCenter: face.geometry!.center
  };
}

async function edit(
  document: ProjectDocument,
  bodyId: BodyId,
  operation: DirectEditOperation
) {
  const manager = new CommandManager(document);
  manager.execute(
    commandFactories.directEditBody({
      name: 'Close the window',
      targetBodyId: bodyId,
      operation
    })
  );
  return adapter!.syncDocument(manager.document);
}

function offsetBottom(bottom: FaceTopology, offset: number): DirectEditOperation {
  return {
    kind: 'offset-face',
    ...snapshot(bottom),
    sourceSurfaceType: 'plane',
    sourceNormal: bottom.geometry!.normal!,
    offset
  };
}

describe('closing a window through a wall', () => {
  it('pushes the bottom wall to the top wall and closes the window', async () => {
    const { document, bodyId } = await windowedWall();
    const { bottom } = windowWalls(document, bodyId);

    // Short of the top the kernel's own move does it, as before.
    const partial = await edit(document, bodyId, offsetBottom(bottom, 10));
    expect(partial.warnings).toEqual([]);
    expect(partial.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      WALL_VOLUME - 16 * 4 * (WINDOW_HEIGHT - 10),
      6
    );

    // At the top the window closes; a snapped drag past it into the wall
    // above adds nothing more, because that is wall already.
    for (const offset of [WINDOW_HEIGHT, 16, 20]) {
      const closed = await edit(document, bodyId, offsetBottom(bottom, offset));
      expect(closed.warnings).toEqual([]);
      const body = closed.bodyRepresentations[bodyId]!;
      expect(body.volume).toBeCloseTo(WALL_VOLUME, 6);
      expect(body.faceCount).toBe(6);
      expect(body.bbox.max.z).toBeCloseTo(40, 9);
    }
  }, 60_000);

  it('still refuses a push that would leave the body', async () => {
    // The window's top is 5 below the wall's top: a 25 push would build
    // material above the wall, which is not the face moving — it stays the
    // kernel's refusal.
    const { document, bodyId } = await windowedWall(30);
    const { bottom } = windowWalls(document, bodyId);
    const refused = await edit(document, bodyId, offsetBottom(bottom, 25));
    expect(refused.warnings.join('\n')).toMatch(
      /swept face reaches nonadjacent face/
    );
    expect(refused.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      60 * 4 * 30 - 16 * 4 * WINDOW_HEIGHT,
      6
    );
  }, 60_000);

  it('deletes the four walls of the window and closes it', async () => {
    const { document, bodyId } = await windowedWall();
    const { walls } = windowWalls(document, bodyId);
    const [first, ...rest] = walls;
    const closed = await edit(document, bodyId, {
      kind: 'remove-faces',
      ...snapshot(first!),
      additionalFaces: rest.map(snapshot)
    });
    expect(closed.warnings).toEqual([]);
    const body = closed.bodyRepresentations[bodyId]!;
    expect(body.volume).toBeCloseTo(WALL_VOLUME, 6);
    expect(body.faceCount).toBe(6);
  }, 60_000);

  it('names the missing walls when only some are selected', async () => {
    const { document, bodyId } = await windowedWall();
    const { walls } = windowWalls(document, bodyId);
    const [first, second, third] = walls;
    const refused = await edit(document, bodyId, {
      kind: 'remove-faces',
      ...snapshot(first!),
      additionalFaces: [snapshot(second!), snapshot(third!)]
    });
    expect(refused.warnings).toHaveLength(1);
    expect(refused.warnings[0]).toContain(
      'Removing the 3 selected faces failed'
    );
    expect(refused.warnings[0]).toContain(
      'To close an opening, select every face around it.'
    );
    // A refused edit leaves the body as the history built it.
    expect(refused.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      WALL_VOLUME - 16 * 4 * WINDOW_HEIGHT,
      6
    );
  }, 60_000);

  it('refuses a stale face in the set rather than removing another', async () => {
    const { document, bodyId } = await windowedWall();
    const { walls } = windowWalls(document, bodyId);
    const [first, ...rest] = walls;
    const refused = await edit(document, bodyId, {
      kind: 'remove-faces',
      ...snapshot(first!),
      additionalFaces: rest.map((face, index) =>
        index === 0
          ? { ...snapshot(face), sourceArea: face.geometry!.area + 1 }
          : snapshot(face)
      )
    });
    expect(refused.warnings).toHaveLength(1);
    expect(refused.warnings[0]).toContain(
      'A selected face no longer matches its recorded geometry.'
    );
  }, 60_000);
});
