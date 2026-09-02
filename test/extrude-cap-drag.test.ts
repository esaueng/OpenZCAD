import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import type {
  BodyId,
  DerivedState,
  FaceTopology,
  ProjectDocument,
  SketchObjectData
} from '@openzcad/shared';
import { extrudeCapAncestor } from '../apps/web/src/lib/interaction/extrudeCapAncestry';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';

/**
 * The extrude stays open after it lands: the handle moves to the far cap and
 * a drag along that cap's outward normal edits the stored distance. The sign
 * of that edit depends on which way the cap faces, and this file pins the
 * table against the real kernel — a boss and a free body grow with the drag,
 * a pocket's floor pulled outward makes the cut shallower — by applying the
 * planned edit and measuring where the cap ended up.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

const user = toUserId('user_extrude_cap_drag');
const PLATE = { width: 40, height: 24, depth: 10 };
const boss: SketchObjectData = {
  objectKind: 'rectangle',
  width: 10,
  height: 6,
  centerX: 20,
  centerY: 12
};

function facesOf(derived: DerivedState, bodyId: BodyId): FaceTopology[] {
  return derived.bodyRepresentations[bodyId]?.topology?.faces ?? [];
}

/** The one face the ancestry proves to be the extrude's far cap. */
function farCap(
  document: ProjectDocument,
  derived: DerivedState,
  bodyId: BodyId
): { face: FaceTopology; sense: 1 | -1; distance: number } {
  const caps = facesOf(derived, bodyId).flatMap((face) => {
    const ancestor = extrudeCapAncestor(
      document,
      bodyId,
      face.reference,
      face.hash
    );
    return ancestor ? [{ face, ...ancestor }] : [];
  });
  expect(caps).toHaveLength(1);
  return caps[0]!;
}

async function build(
  operation: 'new-body' | 'add' | 'cut',
  distance: number
): Promise<{
  document: ProjectDocument;
  derived: DerivedState;
  bodyId: BodyId;
}> {
  let base = createProjectDocument('Extrude cap drag', user);
  let targetBodyId: BodyId | undefined;
  if (operation !== 'new-body') {
    base = addPrimitiveFeature(base, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: PLATE
    });
    targetBodyId = base.bodyOrder[0]!;
  }
  const { document: withSketch, sketchId } = addSketchFeature(base, {
    name: 'Top sketch',
    planeRef: {
      type: 'canonical',
      plane: 'XY',
      offset: operation === 'new-body' ? 0 : PLATE.depth
    },
    objects: [boss]
  });
  const objectIds = [...(findSketch(withSketch, sketchId)?.objectIds ?? [])];
  const { document, bodyId } = extrudeSketch(withSketch, {
    name: 'Extrude',
    sketchId,
    distance,
    ...(operation === 'new-body' ? {} : { operation, targetBodyId }),
    profiles: [{ all: true, sourceEntityIds: objectIds }]
  });
  const derived = await adapter.syncDocument(document);
  expect(derived.warnings).toEqual([]);
  return { document, derived, bodyId };
}

describe('extrude far-cap drag', { timeout: 120_000 }, () => {
  it.each([
    // operation, stored distance, where the cap sits, the sign a drag along
    // its outward normal applies to the stored distance, and where the cap
    // sits after a +1 drag
    ['new-body', 8, 8, 1, 9],
    ['new-body', -8, -8, -1, -9],
    ['add', 8, PLATE.depth + 8, 1, PLATE.depth + 9],
    // A pocket floor faces back out of the hole, so pulling it outward
    // adds to the negative distance: the cut gets shallower.
    ['cut', -4, PLATE.depth - 4, 1, PLATE.depth - 3]
  ] as const)(
    '%s by %d: the far cap at z=%d has sense %d and a +1 drag moves it to z=%d',
    async (operation, distance, capZ, sense, movedZ) => {
      const { document, derived, bodyId } = await build(operation, distance);
      const cap = farCap(document, derived, bodyId);
      expect(cap.distance).toBe(distance);
      expect(cap.sense).toBe(sense);
      expect(cap.face.geometry?.center.z).toBeCloseTo(capZ, 6);
      // The far cap's outward normal: away from the sketch for a boss or a
      // free body, back toward it out of the pocket for a cut.
      expect(cap.face.geometry?.normal?.z).toBeCloseTo(
        operation === 'cut' ? -Math.sign(distance) : Math.sign(distance),
        9
      );

      const plan = planFaceOffset({
        document,
        bodyId,
        face: cap.face,
        faceHash: cap.face.hash,
        offset: 1
      });
      expect(plan?.kind).toBe('extrude-distance');
      if (plan?.kind !== 'extrude-distance') {
        return;
      }
      expect(plan.value).toBe(distance + sense);
      expect(plan.preflightRejection).toBeUndefined();
      const edited = plan.command.apply(document);
      const rebuilt = await adapter.syncDocument(edited);
      expect(rebuilt.warnings).toEqual([]);
      const moved = farCap(edited, rebuilt, bodyId);
      expect(moved.distance).toBe(distance + sense);
      expect(moved.face.geometry?.center.z).toBeCloseTo(movedZ, 6);
    }
  );

  it('refuses a drag that would take the extrusion through its sketch plane', async () => {
    const { document, derived, bodyId } = await build('cut', -4);
    const cap = farCap(document, derived, bodyId);
    const plan = planFaceOffset({
      document,
      bodyId,
      face: cap.face,
      faceHash: cap.face.hash,
      offset: 4
    });
    expect(plan?.kind).toBe('extrude-distance');
    expect(
      plan?.kind === 'extrude-distance' ? plan.preflightRejection : undefined
    ).toMatch(/no depth/);
  });
});
