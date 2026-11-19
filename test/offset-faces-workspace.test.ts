import { afterAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type FaceTopology,
  type ProjectDocument,
  type TopologySelection
} from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { OFFSET_FACES_OPPOSITE_NORMALS } from '../packages/kernel-adapter/src/exact-direct-edit-ops';
import { MAX_REMOVED_FACES } from '../packages/kernel-adapter/src/exact-direct-edit-guards';
import {
  MAX_OFFSET_SET_FACES,
  OFFSET_SET_OPPOSITE_NORMALS,
  buildOffsetFaces,
  faceSetOffsetStart
} from '../apps/web/src/lib/faceSetOffset';
import {
  buildOffsetFaceSetLead,
  faceSetOffsetPlanes
} from '../apps/web/src/lib/faceSetOffsetChain';

/**
 * M07: the workspace refuses a face set two of whose faces face opposite
 * ways before any handle appears, in the words a rebuild would refuse it
 * with, and bounds the set as the kernel does. A reworded or rebounded
 * kernel guard fails here instead of leaving the verb saying something
 * else. Faces on several planes, parallel or facing different directions,
 * the kernel chains, and the workspace arms them.
 */
describe('face set offset workspace contract', () => {
  it('refuses in the kernel’s words and bounds the set as the kernel does', () => {
    expect(OFFSET_SET_OPPOSITE_NORMALS).toBe(OFFSET_FACES_OPPOSITE_NORMALS);
    expect(MAX_OFFSET_SET_FACES).toBe(MAX_REMOVED_FACES);
  });
});

/**
 * A 40 x 20 x 5 plate with one 10 x 10 x 10 post fused on it: the post's top
 * and the plate's own top face +z, 10 apart.
 */
const PLATE_VOLUME = 40 * 20 * 5;
const POST_AREA = 10 * 10;
const PLATE_TOP_AREA = 40 * 20 - POST_AREA;

let adapter: ExactKernelAdapter | undefined;
afterAll(() => adapter?.dispose());

async function postOnPlate() {
  let document = createProjectDocument('Post', toUserId('user_offset_set_ui'));
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 20, depth: 5 }
  });
  const plate = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Post',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  document = transformBody(document, {
    name: 'Place post',
    targetBodyId: document.bodyOrder.at(-1)!,
    translation: { x: 5, y: 5, z: 5 },
    rotationDeg: { x: 0, y: 0, z: 0 }
  }).document;
  const fused = booleanBodies(document, {
    name: 'Fuse',
    operation: 'union',
    targetBodyIds: [plate, document.bodyOrder.at(-1)!]
  });
  adapter ??= await createExactKernelAdapter();
  const derived = await adapter.syncDocument(fused.document);
  expect(derived.warnings).toEqual([]);
  return { document: { ...fused.document, derived }, bodyId: fused.bodyId };
}

function upAt(
  derived: ProjectDocument['derived'],
  bodyId: BodyId,
  z: number
): FaceTopology[] {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      (face.geometry.normal?.z ?? 0) > 1 - 1e-9 &&
      Math.abs(face.geometry.center.z - z) < 1e-9
  );
}

describe('a chained face set from the workspace', () => {
  it('arms, builds every face along its own normal, and previews its lead plane alone', async () => {
    const { document, bodyId } = await postOnPlate();
    const pick = (face: FaceTopology): TopologySelection => ({
      bodyId,
      kind: 'face',
      topologyId: face.topologyId,
      hash: face.hash
    });
    const [plateTop] = upAt(document.derived, bodyId, 5);
    const [postTop] = upAt(document.derived, bodyId, 15);
    expect(plateTop?.geometry?.area).toBeCloseTo(PLATE_TOP_AREA, 9);
    // The slot-floor-and-top set the workspace used to refuse now arms.
    const start = faceSetOffsetStart(document, [
      pick(plateTop!),
      pick(postTop!)
    ]);
    const input = {
      document,
      bodyId,
      face: { topologyId: start.face.topologyId, hash: start.face.hash },
      members: start.members
    };
    for (const offset of [2, -2]) {
      const full = buildOffsetFaces({ ...input, offset })!;
      const derived = await adapter!.syncDocument(full.apply(document));
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
        PLATE_VOLUME + POST_AREA * 10 + (POST_AREA + PLATE_TOP_AREA) * offset,
        6
      );
      expect(upAt(derived, bodyId, 5 + offset)).toHaveLength(1);
      expect(upAt(derived, bodyId, 15 + offset)).toHaveLength(1);

      // The drag's display-only lane: the chain's first step alone, the
      // post top pushed out first, the plate top pulled in first.
      const lead = buildOffsetFaceSetLead({ ...input, offset })!;
      const shown = await adapter!.syncDocument(lead.apply(document));
      expect(shown.warnings).toEqual([]);
      const [moved, stayed] = offset > 0 ? [15, 5] : [5, 15];
      expect(upAt(shown, bodyId, moved + offset)).toHaveLength(1);
      expect(upAt(shown, bodyId, stayed)).toHaveLength(1);
    }
  }, 60_000);
});

/**
 * A 40 x 20 x 10 block with a 10 x 10 x 5 pocket cut into its top: the
 * pocket's floor faces +z at z = 5, its left wall faces +x at x = 15, and the
 * wall opposite faces -x at x = 25.
 */
async function pocketedBlock() {
  let document = createProjectDocument(
    'Pocket',
    toUserId('user_offset_set_ui')
  );
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 20, depth: 10 }
  });
  const block = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Pocket',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 5 }
  });
  document = transformBody(document, {
    name: 'Place pocket',
    targetBodyId: document.bodyOrder.at(-1)!,
    translation: { x: 15, y: 5, z: 5 },
    rotationDeg: { x: 0, y: 0, z: 0 }
  }).document;
  const cut = booleanBodies(document, {
    name: 'Cut',
    operation: 'subtract',
    targetBodyIds: [block, document.bodyOrder.at(-1)!]
  });
  adapter ??= await createExactKernelAdapter();
  const derived = await adapter.syncDocument(cut.document);
  expect(derived.warnings).toEqual([]);
  expect(derived.bodyRepresentations[cut.bodyId]!.volume).toBeCloseTo(
    40 * 20 * 10 - 10 * 10 * 5,
    6
  );
  return { document: { ...cut.document, derived }, bodyId: cut.bodyId };
}

function facing(
  derived: ProjectDocument['derived'],
  bodyId: BodyId,
  axis: 'x' | 'y' | 'z',
  sign: 1 | -1,
  at: number
): FaceTopology[] {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      sign * (face.geometry.normal?.[axis] ?? 0) > 1 - 1e-9 &&
      Math.abs(face.geometry.center[axis] - at) < 1e-9
  );
}

describe('a face set facing different directions from the workspace', () => {
  it('arms a pocket’s floor and wall, moves each along its own normal, and leads with the floor', async () => {
    const { document, bodyId } = await pocketedBlock();
    const pick = (face: FaceTopology): TopologySelection => ({
      bodyId,
      kind: 'face',
      topologyId: face.topologyId,
      hash: face.hash
    });
    const [floor] = facing(document.derived, bodyId, 'z', 1, 5);
    const [wall] = facing(document.derived, bodyId, 'x', 1, 15);
    const [opposite] = facing(document.derived, bodyId, 'x', -1, 25);
    expect(floor && wall && opposite).toBeTruthy();
    expect(() =>
      faceSetOffsetStart(document, [pick(wall!), pick(opposite!)])
    ).toThrow(OFFSET_FACES_OPPOSITE_NORMALS);
    // The floor, then the wall: the handle arms on the wall's normal.
    const start = faceSetOffsetStart(document, [pick(floor!), pick(wall!)]);
    expect(start.face.topologyId).toBe(wall!.topologyId);
    expect(start.normal.x).toBeCloseTo(1, 12);
    const input = {
      document,
      bodyId,
      face: { topologyId: start.face.topologyId, hash: start.face.hash },
      members: start.members
    };
    for (const offset of [1, -1]) {
      const full = buildOffsetFaces({ ...input, offset })!;
      const derived = await adapter!.syncDocument(full.apply(document));
      expect(derived.warnings).toEqual([]);
      // The pocket left is (10 - offset) wide and (5 - offset) deep.
      expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
        40 * 20 * 10 - (10 - offset) * 10 * (5 - offset),
        6
      );
      expect(facing(derived, bodyId, 'z', 1, 5 + offset)).toHaveLength(1);
      expect(facing(derived, bodyId, 'x', 1, 15 + offset)).toHaveLength(1);
      expect(facing(derived, bodyId, 'x', -1, 25)).toHaveLength(1);

      // Up-facing faces lead the chain whichever face holds the handle:
      // the drag's display-only lane moves the floor alone.
      expect(
        faceSetOffsetPlanes(input, offset)?.map((plane) =>
          plane.map((face) => face.topologyId)
        )
      ).toEqual([[floor!.topologyId], [wall!.topologyId]]);
      const lead = buildOffsetFaceSetLead({ ...input, offset })!;
      const shown = await adapter!.syncDocument(lead.apply(document));
      expect(shown.warnings).toEqual([]);
      expect(facing(shown, bodyId, 'z', 1, 5 + offset)).toHaveLength(1);
      expect(facing(shown, bodyId, 'x', 1, 15)).toHaveLength(1);
    }
  }, 60_000);

  it('names a later step that refuses, as the kernel orders the chain', async () => {
    const { document, bodyId } = await pocketedBlock();
    const pick = (face: FaceTopology): TopologySelection => ({
      bodyId,
      kind: 'face',
      topologyId: face.topologyId,
      hash: face.hash
    });
    const [top] = facing(document.derived, bodyId, 'z', 1, 10);
    const [wall] = facing(document.derived, bodyId, 'x', 1, 15);
    // The wall, then the top: the top holds the handle (face 1), the wall
    // is face 2.
    const start = faceSetOffsetStart(document, [pick(wall!), pick(top!)]);
    const input = {
      document,
      bodyId,
      face: { topologyId: start.face.topologyId, hash: start.face.hash },
      members: start.members,
      offset: 11
    };
    // The top leads and rises 11 alone; the wall, pushed 11 across the
    // 10-wide pocket, is the step that refuses.
    expect(
      faceSetOffsetPlanes(input, input.offset)?.map((plane) =>
        plane.map((face) => face.topologyId)
      )
    ).toEqual([[top!.topologyId], [wall!.topologyId]]);
    const lead = buildOffsetFaceSetLead(input)!;
    const shown = await adapter!.syncDocument(lead.apply(document));
    expect(shown.warnings).toEqual([]);
    const derived = await adapter!.syncDocument(
      buildOffsetFaces(input)!.apply(document)
    );
    expect(derived.warnings[0]).toContain(
      "Offsetting face 2 after the others would change the body's topology. Offset fewer faces, or a smaller distance."
    );
  }, 60_000);
});
