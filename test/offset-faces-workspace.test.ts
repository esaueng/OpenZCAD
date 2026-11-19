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
import { OFFSET_FACES_MIXED_DIRECTIONS } from '../packages/kernel-adapter/src/exact-direct-edit-ops';
import { MAX_REMOVED_FACES } from '../packages/kernel-adapter/src/exact-direct-edit-guards';
import {
  MAX_OFFSET_SET_FACES,
  OFFSET_SET_NOT_SAME_NORMAL,
  buildOffsetFaceSetLead,
  buildOffsetFaces,
  faceSetOffsetStart
} from '../apps/web/src/lib/faceSetOffset';

/**
 * M07: the workspace refuses a face set whose faces do not all face the same
 * way before any handle appears, in the words a rebuild would refuse it
 * with, and bounds the set as the kernel does. A reworded or rebounded
 * kernel guard fails here instead of leaving the verb saying something
 * else. Parallel faces at different heights the kernel chains, and the
 * workspace arms them.
 */
describe('face set offset workspace contract', () => {
  it('refuses in the kernel’s words and bounds the set as the kernel does', () => {
    expect(OFFSET_SET_NOT_SAME_NORMAL).toBe(OFFSET_FACES_MIXED_DIRECTIONS);
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
