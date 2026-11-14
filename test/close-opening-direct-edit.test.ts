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
import { cutFaceDeletion } from '../apps/web/src/lib/featureDeletion';
import { faceLineageTrace, isCutFace } from '../apps/web/src/lib/historyFocus';

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
    (id) =>
      derived.bodyRepresentations[id] &&
      !derived.bodyRepresentations[id].consumed
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

function offsetBottom(
  bottom: FaceTopology,
  offset: number
): DirectEditOperation {
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

/**
 * The window's corners rounded, or its sides drafted: the push across still
 * closes it, through the same exact sweep, and stops short of it exactly as
 * the kernel's own move does.
 */
describe('closing a shaped window by pushing its floor', () => {
  /** Applies a feature to the window's body and returns the rebuilt body. */
  async function reshaped(
    shape: (
      document: ProjectDocument,
      bodyId: BodyId
    ) => Parameters<CommandManager['execute']>[0]
  ) {
    const { document, bodyId } = await windowedWall();
    const manager = new CommandManager(document);
    manager.execute(shape(document, bodyId));
    const derived = await adapter!.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const shapedId = [...manager.document.bodyOrder]
      .reverse()
      .find(
        (id) =>
          derived.bodyRepresentations[id] &&
          !derived.bodyRepresentations[id].consumed
      )!;
    return { document: { ...manager.document, derived }, bodyId: shapedId };
  }

  /** The window floor: the upward plane whose centre is the window's. */
  function floorOf(document: ProjectDocument, bodyId: BodyId) {
    const floor = document.derived.bodyRepresentations[
      bodyId
    ]!.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        face.geometry.normal!.z > 0.9 &&
        Math.abs(face.geometry.center.z - 10) < 1e-9
    );
    expect(floor).toBeDefined();
    return floor!;
  }

  it('closes a window with rounded corners', async () => {
    const { document, bodyId } = await reshaped((built, id) => {
      const topology = built.derived.bodyRepresentations[id]!.topology!;
      const { walls } = windowWalls(built, id);
      const hashes = new Set(walls.map((face) => face.hash));
      const corners = topology.edges.filter(
        (edge) =>
          edge.adjacentFaceHashes?.length === 2 &&
          edge.adjacentFaceHashes.every((hash) => hashes.has(hash))
      );
      expect(corners).toHaveLength(4);
      return commandFactories.filletEdges({
        name: 'Round the corners',
        targetBodyId: id,
        edgeHashes: corners.map((edge) => edge.hash),
        size: 2
      });
    });
    const rounded = document.derived.bodyRepresentations[bodyId]!.volume;
    // Four 2 mm corners, each a square less a quarter disc, through 4 mm.
    expect(rounded).toBeCloseTo(
      WALL_VOLUME - 16 * 4 * WINDOW_HEIGHT + 4 * 4 * (4 - Math.PI),
      6
    );
    const floor = floorOf(document, bodyId);
    // Short of the top the kernel carries the floor and its fillets up.
    const partial = await edit(document, bodyId, offsetBottom(floor, 10));
    expect(partial.warnings).toEqual([]);
    expect(partial.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      rounded + 16 * 4 * 10,
      6
    );
    for (const offset of [WINDOW_HEIGHT, 16]) {
      const closed = await edit(document, bodyId, offsetBottom(floor, offset));
      expect(closed.warnings).toEqual([]);
      const body = closed.bodyRepresentations[bodyId]!;
      expect(body.volume).toBeCloseTo(WALL_VOLUME, 6);
      expect(body.faceCount).toBe(6);
    }
  }, 60_000);

  /**
   * A wall whose window tool had its two sides drafted before the cut: the
   * kernel drafts a face with no hole in it, and the cut carries the taper
   * into the window. The floor stays 16 wide; the top is narrower for a
   * positive angle and wider for a negative one.
   */
  async function draftedWindow(angleDeg: number) {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Window', toUserId('user_window'));
    document = addPrimitiveFeature(document, {
      name: 'Wall',
      primitiveKind: 'box',
      dimensions: { width: 60, height: 4, depth: 40 }
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
    const placed = document.bodyOrder.at(-1)!;
    const manager = new CommandManager(document);
    const tool = (
      await adapter.syncDocument(manager.document)
    ).bodyRepresentations[placed]!.topology!.faces.filter(
      (face) => Math.abs(face.geometry!.normal!.x) > 0.9
    );
    expect(tool).toHaveLength(2);
    manager.execute(
      commandFactories.draftBody({
        name: 'Draft the sides',
        targetBodyId: placed,
        faceHashes: tool.map((face) => face.hash),
        pullDirection: { x: 0, y: 0, z: 1 },
        neutralPoint: { x: 28, y: 2, z: 10 },
        angleDeg
      })
    );
    const drafted = manager.document.bodyOrder.at(-1)!;
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Cut the window',
        operation: 'subtract',
        targetBodyIds: [wall, drafted]
      })
    );
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const bodyId = [...manager.document.bodyOrder]
      .reverse()
      .find(
        (id) =>
          derived.bodyRepresentations[id] &&
          !derived.bodyRepresentations[id].consumed
      )!;
    return { document: { ...manager.document, derived }, bodyId };
  }

  for (const angleDeg of [5, -5]) {
    it(`closes a window whose sides are drafted ${angleDeg}°`, async () => {
      const { document, bodyId } = await draftedWindow(angleDeg);
      const drafted = document.derived.bodyRepresentations[bodyId]!.volume;
      const square = WALL_VOLUME - 16 * 4 * WINDOW_HEIGHT;
      // The taper changes the window: smaller or larger than the square one.
      expect(Math.abs(drafted - square)).toBeGreaterThan(1);
      const floor = floorOf(document, bodyId);
      expect(floor.geometry!.area).toBeCloseTo(64, 9);
      const partial = await edit(document, bodyId, offsetBottom(floor, 10));
      expect(partial.warnings).toEqual([]);
      expect(partial.bodyRepresentations[bodyId]!.volume).toBeGreaterThan(
        drafted
      );
      for (const offset of [WINDOW_HEIGHT, 20]) {
        const closed = await edit(
          document,
          bodyId,
          offsetBottom(floor, offset)
        );
        expect(closed.warnings).toEqual([]);
        const body = closed.bodyRepresentations[bodyId]!;
        expect(body.volume).toBeCloseTo(WALL_VOLUME, 6);
        expect(body.faceCount).toBe(6);
      }
    }, 60_000);
  }
});

/**
 * A window cut across a thicker strip of wall — a rib along the inside, the
 * way a case's rail band thickens the wall a port crosses. The window floor
 * is then an L where the window takes the rib's end, or a T where the rib
 * runs through it, with a reflex corner at each side of the rib, and pushing
 * it up to the top still closes the window exactly.
 */
describe('closing a window whose floor is not convex', () => {
  interface Ribbed {
    /** Where the 8-wide rib starts along the wall. */
    ribX: number;
    /** How far the rib stands proud of the wall's inside. */
    ribDepth: number;
    /** How far the whole part sits above the origin. */
    lift: number;
  }

  /** The window (x 20 to 36) across a full-height rib inside the wall. */
  async function ribbedWindow({ ribX, ribDepth, lift }: Ribbed) {
    const ribbedVolume = WALL_VOLUME + 8 * ribDepth * 40;
    const floorArea =
      16 * 4 + (Math.min(36, ribX + 8) - Math.max(20, ribX)) * ribDepth;
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Window', toUserId('user_window'));
    const place = (name: string, x: number, y: number, z: number) => {
      document = transformBody(document, {
        name,
        targetBodyId: document.bodyOrder.at(-1)!,
        translation: { x, y, z: z + lift },
        rotationDeg: { x: 0, y: 0, z: 0 }
      }).document;
      return document.bodyOrder.at(-1)!;
    };
    document = addPrimitiveFeature(document, {
      name: 'Wall',
      primitiveKind: 'box',
      dimensions: { width: 60, height: 4, depth: 40 }
    });
    const wall =
      lift === 0
        ? document.bodyOrder.at(-1)!
        : place('Place the wall', 0, 0, 0);
    document = addPrimitiveFeature(document, {
      name: 'Rib',
      primitiveKind: 'box',
      dimensions: { width: 8, height: ribDepth, depth: 40 }
    });
    const rib = place('Place the rib', ribX, 4, 0);
    document = addPrimitiveFeature(document, {
      name: 'Window tool',
      primitiveKind: 'box',
      dimensions: { width: 16, height: 10, depth: WINDOW_HEIGHT }
    });
    const tool = place('Place the window', 20, -3, 10);
    // Volumes far from the origin keep fewer exact digits.
    const digits = lift === 0 ? 6 : 3;
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Add the rib',
        operation: 'union',
        targetBodyIds: [wall, rib]
      })
    );
    const ribbedId = manager.document.bodyOrder.at(-1)!;
    const ribbed = (await adapter.syncDocument(manager.document))
      .bodyRepresentations[ribbedId]!;
    expect(ribbed.volume).toBeCloseTo(ribbedVolume, digits);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Cut the window',
        operation: 'subtract',
        targetBodyIds: [ribbedId, tool]
      })
    );
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const bodyId = [...manager.document.bodyOrder]
      .reverse()
      .find(
        (id) =>
          derived.bodyRepresentations[id] &&
          !derived.bodyRepresentations[id].consumed
      )!;
    expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      ribbedVolume - floorArea * WINDOW_HEIGHT,
      digits
    );
    const floor = derived.bodyRepresentations[bodyId]!.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        face.geometry.normal!.z > 0.9 &&
        Math.abs(face.geometry.center.z - (10 + lift)) < 1e-6
    );
    expect(floor?.geometry!.area).toBeCloseTo(floorArea, digits);
    return {
      document: { ...manager.document, derived },
      bodyId,
      floor: floor!,
      floorArea,
      ribbedVolume,
      ribbedFaceCount: ribbed.faceCount,
      digits
    };
  }

  for (const [shape, ribbed] of [
    // The window takes the rib's end: one reflex corner.
    ['an L-shaped floor', { ribX: 16, ribDepth: 1, lift: 0 }],
    // The rib runs through the window: a reflex corner at each side of it.
    ['a T-shaped floor', { ribX: 24, ribDepth: 1, lift: 0 }],
    // A 0.05 rib on a part a kilometre up: the outline's tolerance follows
    // the face, not how far from the origin it is.
    [
      'a thin-ribbed floor far from the origin',
      { ribX: 16, ribDepth: 0.05, lift: 1e6 }
    ]
  ] as const) {
    it(`pushes ${shape} to the top and closes the window`, async () => {
      const {
        document,
        bodyId,
        floor,
        floorArea,
        ribbedVolume,
        ribbedFaceCount,
        digits
      } = await ribbedWindow(ribbed);

      // Short of the top the kernel's own move does it, as before.
      const partial = await edit(document, bodyId, offsetBottom(floor, 10));
      expect(partial.warnings).toEqual([]);
      expect(partial.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
        ribbedVolume - floorArea * (WINDOW_HEIGHT - 10),
        digits
      );

      // At the top, and past it into the wall above, the window closes and
      // the ribbed wall is whole again: nothing more, nothing less.
      for (const offset of [WINDOW_HEIGHT, 20]) {
        const closed = await edit(
          document,
          bodyId,
          offsetBottom(floor, offset)
        );
        expect(closed.warnings).toEqual([]);
        const body = closed.bodyRepresentations[bodyId]!;
        expect(body.volume).toBeCloseTo(ribbedVolume, digits);
        expect(body.faceCount).toBe(ribbedFaceCount);
        expect(body.bbox.max.z).toBeCloseTo(40 + ribbed.lift, 6);
        expect(body.bbox.max.y).toBeCloseTo(4 + ribbed.ribDepth, 6);
      }
    }, 60_000);
  }
});

/**
 * A round port cut through the wall by a cylinder. Its wall is inferred to
 * the cylinder that cut it, and deleting that tool would leave the subtract
 * with nothing to cut; Delete on the wall heals it instead.
 */
describe('closing a round hole by deleting its wall', () => {
  it('fills the hole a subtract cut, and only a cut face', async () => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Port', toUserId('user_port'));
    document = addPrimitiveFeature(document, {
      name: 'Wall',
      primitiveKind: 'box',
      dimensions: { width: 60, height: 4, depth: 40 }
    });
    const wall = document.bodyOrder.at(-1)!;
    document = addPrimitiveFeature(document, {
      name: 'Port tool',
      primitiveKind: 'cylinder',
      dimensions: { radius: 5, height: 10 }
    });
    // Stood along +y and through the wall's 4 mm thickness.
    document = transformBody(document, {
      name: 'Place the port',
      targetBodyId: document.bodyOrder.at(-1)!,
      translation: { x: 28, y: -3, z: 18 },
      rotationDeg: { x: -90, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Cut the port',
        operation: 'subtract',
        targetBodyIds: [wall, document.bodyOrder.at(-1)!]
      })
    );
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const built = { ...manager.document, derived };
    const bodyId = built.bodyOrder.at(-1)!;
    const body = derived.bodyRepresentations[bodyId]!;
    expect(body.volume).toBeCloseTo(WALL_VOLUME - Math.PI * 25 * 4, 6);
    const pick = (face: FaceTopology) => ({
      bodyId,
      kind: 'face' as const,
      topologyId: face.topologyId,
      hash: face.hash
    });
    const bore = body.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    const front = body.topology!.faces.find(
      (face) => face.geometry?.normal && face.geometry.normal.y < -0.9
    )!;
    expect(isCutFace(built, pick(bore))).toBe(true);
    const cut = Object.values(built.nodes).find(
      (node) => node.kind === 'feature' && node.name === 'Cut the port'
    );
    expect(cut?.kind).toBe('feature');
    expect(faceLineageTrace(built, bore.reference!)?.cutBy).toBe(
      cut?.kind === 'feature' ? cut.featureId : undefined
    );
    // The wall's own faces were not cut: Delete keeps its feature meaning.
    expect(isCutFace(built, pick(front))).toBe(false);

    const removal = cutFaceDeletion(built, pick(bore));
    const healed = new CommandManager(built);
    healed.execute(removal.command);
    const filled = await adapter.syncDocument(healed.document);
    expect(filled.warnings).toEqual([]);
    expect(filled.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      WALL_VOLUME,
      6
    );
    expect(filled.bodyRepresentations[bodyId]!.faceCount).toBe(6);
    // The cutting tool and its subtract are still in the history.
    expect(
      Object.values(healed.document.nodes).filter(
        (node) =>
          node.kind === 'feature' &&
          (node.name === 'Port tool' || node.name === 'Cut the port')
      )
    ).toHaveLength(2);
  }, 60_000);
});
