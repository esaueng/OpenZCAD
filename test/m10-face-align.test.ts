import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  assertDocumentContentSchema,
  createProjectDocument,
  listFeaturesInOrder,
  normalizeDocument
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';
import {
  faceAlignFromPicks,
  faceAlignSpec,
  placePoint,
  rotationFromDegrees
} from '../apps/web/src/lib/inPlace/faceAlign';
import type {
  FacePick,
  InPlaceContext,
  InPlaceSlots
} from '../apps/web/src/lib/inPlace/tools';

/**
 * M10 (slice 5b): Align, face to face, on synthetic boxes in the exact
 * kernel. The command is the one the workspace commits: the Align spec
 * builds the request from two picked faces, and App turns it into the
 * ordinary Move (`commandFactories.transformBody`, rotation included). Every
 * expected corner comes from the placement applied to the moving box's own
 * corners here, never from the kernel's transform.
 */
describe(
  'Align face to face on boxes (M10 slice 5b)',
  { timeout: 120_000 },
  () => {
    let adapter: ExactKernelAdapter;
    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });
    afterAll(() => adapter.dispose());

    const user = toUserId('user_m10_face_align');
    const TARGET_SIZE = { width: 40, height: 10, depth: 30 };
    const MOVING_SIZE = { width: 12, height: 6, depth: 8 };
    const MOVING_VOLUME = 12 * 6 * 8;

    async function build(document: ProjectDocument): Promise<DerivedState> {
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      return derived;
    }

    const key = (point: Vector3) =>
      [point.x, point.y, point.z]
        .map((v) => (Math.round(v * 1e5) / 1e5 || 0).toFixed(5))
        .join(',');
    const pointSet = (points: Vector3[]) => points.map(key).sort();

    function vertices(derived: DerivedState, bodyId: BodyId): Vector3[] {
      const body = derived.bodyRepresentations[bodyId];
      expect(body, `body ${bodyId} built`).toBeDefined();
      const corners = new Map<string, Vector3>();
      for (const edge of body!.topology?.edges ?? []) {
        const p = edge.points;
        for (const at of [0, p.length - 3]) {
          const point = { x: p[at]!, y: p[at + 1]!, z: p[at + 2]! };
          corners.set(key(point), point);
        }
      }
      return [...corners.values()];
    }

    /** The face a click on this flat face picks (App `inPlaceFacePick`). */
    function facePick(
      derived: DerivedState,
      bodyId: BodyId,
      choose: (normal: Vector3, centre: Vector3) => number
    ): FacePick {
      const faces = derived.bodyRepresentations[bodyId]!.topology!.faces.filter(
        (face) =>
          face.geometry?.surfaceType.toLowerCase() === 'plane' &&
          face.geometry.normal
      );
      const best = faces.reduce((a, b) =>
        choose(
          b.geometry!.normal!,
          b.geometry!.centroid ?? b.geometry!.center
        ) >
        choose(a.geometry!.normal!, a.geometry!.centroid ?? a.geometry!.center)
          ? b
          : a
      );
      const geometry = best.geometry!;
      return {
        bodyId,
        hash: best.hash,
        topologyId: best.topologyId,
        surfaceType: geometry.surfaceType,
        normal: geometry.normal!,
        ...(geometry.centroid ? { centroid: geometry.centroid } : {}),
        center: geometry.center
      };
    }

    const slots = (faces: FacePick[]): InPlaceSlots => ({
      profiles: [],
      axis: null,
      path: [],
      guide: [],
      faces,
      bodies: [],
      plane: null,
      edges: [],
      refs: [],
      image: null
    });

    /** Two boxes: the target, and a smaller one turned and lifted off it. */
    function twoBoxes(turnDeg: Vector3) {
      const manager = new CommandManager(createProjectDocument('Align', user));
      manager.execute(
        commandFactories.addPrimitive({
          name: 'Target',
          primitiveKind: 'box',
          dimensions: TARGET_SIZE
        })
      );
      manager.execute(
        commandFactories.addPrimitive({
          name: 'Moving',
          primitiveKind: 'box',
          dimensions: MOVING_SIZE
        })
      );
      const [targetId, movingId] = manager.document.bodyOrder;
      manager.execute(
        commandFactories.transformBody({
          name: 'Place',
          targetBodyId: movingId!,
          translation: { x: 55, y: -12, z: 37 },
          rotationDeg: turnDeg
        })
      );
      return { manager, targetId: targetId!, movingId: movingId! };
    }

    /** What Done commits for Align (App.tsx `inPlaceCommandFor`). */
    function alignCommand(
      faces: FacePick[],
      options: { flip?: boolean; offset?: number } = {}
    ) {
      const offset = options.offset ?? 0;
      const ctx = {
        liveBodyIds: () => [faces[0]!.bodyId, faces[1]!.bodyId]
      } as unknown as InPlaceContext;
      expect(faceAlignSpec.ready(slots(faces), {}, ctx)).toBe(true);
      const request = faceAlignSpec.request(
        slots(faces),
        { offset },
        { flip: options.flip ? 'yes' : 'no' },
        ctx,
        { offset }
      );
      if (request?.tool !== 'transform') throw new Error('No Align request.');
      return commandFactories.transformBody({
        name: 'Align',
        targetBodyId: request.targetBodyId,
        translation: request.translation,
        ...(request.rotationDeg ? { rotationDeg: request.rotationDeg } : {}),
        ...(request.pivot ? { pivot: request.pivot } : {})
      });
    }

    const topOf = (d: DerivedState, id: BodyId) =>
      d.bodyRepresentations[id]!.bbox.max.z;

    it('puts an oblique face flush on the target top, with nothing else changed', async () => {
      const { manager, targetId, movingId } = twoBoxes({
        x: 20,
        y: -35,
        z: 50
      });
      const before = await build(manager.document);
      // The moving box's face pointing most downward, which is oblique.
      const moving = facePick(before, movingId, (n) => -n.z);
      expect(Math.abs(moving.normal!.z)).toBeLessThan(0.99);
      // The target's top face, facing +Z.
      const target = facePick(before, targetId, (n, c) => n.z * 1e3 + c.z);
      expect(target.normal!.z).toBeCloseTo(1, 12);
      const top = topOf(before, targetId);
      const targetCorners = pointSet(vertices(before, targetId));
      const movingCorners = vertices(before, movingId);

      const entries = manager.document.editHistory!.entries.length;
      manager.execute(alignCommand([moving, target]));
      // One History step, a Move.
      expect(manager.document.editHistory!.entries).toHaveLength(entries + 1);
      const align = listFeaturesInOrder(manager.document).at(-1)!;
      expect(align.featureKind).toBe('transform');
      expect(align.name).toBe('Align');
      expect(align.data).toMatchObject({
        featureKind: 'transform',
        targetBodyId: movingId
      });
      expect('copy' in align.data).toBe(false);

      const after = await build(manager.document);
      const placement = faceAlignFromPicks([moving, target], false, 0)!;
      const expected = movingCorners.map((p) => placePoint(placement, p));
      expect(pointSet(vertices(after, movingId))).toEqual(pointSet(expected));
      // The contact plane: the moving box sits on the target's top, and its
      // picked face now faces straight down there.
      const bbox = after.bodyRepresentations[movingId]!.bbox;
      expect(bbox.min.z).toBeCloseTo(top, 6);
      expect(bbox.min.x).toBeCloseTo(Math.min(...expected.map((p) => p.x)), 6);
      expect(bbox.max.y).toBeCloseTo(Math.max(...expected.map((p) => p.y)), 6);
      const landed = facePick(after, movingId, (n) => -n.z);
      expect(landed.normal!.z).toBeCloseTo(-1, 9);
      const centre = landed.centroid ?? landed.center!;
      expect(centre.z).toBeCloseTo(top, 6);
      // In-plane, the face's centre stayed where it was: only Z moved.
      const from = moving.centroid ?? moving.center!;
      expect(centre.x).toBeCloseTo(from.x, 6);
      expect(centre.y).toBeCloseTo(from.y, 6);
      // Rigid: the volume holds, and the target never moved.
      expect(after.bodyRepresentations[movingId]!.volume).toBeCloseTo(
        MOVING_VOLUME,
        6
      );
      expect(pointSet(vertices(after, targetId))).toEqual(targetCorners);

      // The kernel's own matrix agrees with the turn Align stored.
      const stored = align.data as { transform: { rotationDeg: Vector3 } };
      const m = transformMatrix(
        { x: 0, y: 0, z: 0 },
        stored.transform.rotationDeg
      );
      const r = rotationFromDegrees(stored.transform.rotationDeg);
      for (const [row, values] of r.entries()) {
        expect(m[row * 4]).toBeCloseTo(values.x, 14);
        expect(m[row * 4 + 1]).toBeCloseTo(values.y, 14);
        expect(m[row * 4 + 2]).toBeCloseTo(values.z, 14);
      }

      // Undo takes the box back; Redo brings it to the same place.
      manager.undo();
      expect(manager.document.editHistory!.cursor).toBe(entries);
      const undone = await build(manager.document);
      expect(pointSet(vertices(undone, movingId))).toEqual(
        pointSet(movingCorners)
      );
      manager.redo();
      const redone = await build(manager.document);
      expect(pointSet(vertices(redone, movingId))).toEqual(pointSet(expected));

      // Reopened from saved JSON and replayed from the command log, in a
      // fresh kernel, the box is where Align put it.
      const saved = normalizeDocument(
        JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
      );
      assertDocumentContentSchema(saved);
      const replayed = replayCommands(
        createProjectDocument('Align', user),
        manager.document.commandLog
      );
      const fresh = await createExactKernelAdapter();
      try {
        for (const reopened of [saved, replayed]) {
          const derived = await fresh.syncDocument(reopened);
          expect(derived.warnings).toEqual([]);
          expect(pointSet(vertices(derived, movingId))).toEqual(
            pointSet(expected)
          );
          expect(derived.bodyRepresentations[movingId]!.volume).toBeCloseTo(
            MOVING_VOLUME,
            6
          );
        }
      } finally {
        fresh.dispose();
      }
    });

    it('turns a top face over onto a top face, half a turn, flush', async () => {
      const { manager, targetId, movingId } = twoBoxes({ x: 0, y: 0, z: 0 });
      const before = await build(manager.document);
      const moving = facePick(before, movingId, (n) => n.z);
      const target = facePick(before, targetId, (n, c) => n.z * 1e3 + c.z);
      expect(moving.normal!.z).toBeCloseTo(1, 12);
      const movingCorners = vertices(before, movingId);
      const top = topOf(before, targetId);
      const box = before.bodyRepresentations[movingId]!.bbox;
      const tall = box.max.z - box.min.z;
      manager.execute(alignCommand([moving, target]));
      const after = await build(manager.document);
      const placement = faceAlignFromPicks([moving, target], false, 0)!;
      expect(pointSet(vertices(after, movingId))).toEqual(
        pointSet(movingCorners.map((p) => placePoint(placement, p)))
      );
      // Upside down on the target: its old top is now its bottom, on the top.
      const bbox = after.bodyRepresentations[movingId]!.bbox;
      expect(bbox.min.z).toBeCloseTo(top, 6);
      expect(bbox.max.z).toBeCloseTo(top + tall, 6);
      expect(after.bodyRepresentations[movingId]!.volume).toBeCloseTo(
        MOVING_VOLUME,
        6
      );
    });

    it('with Flip and an Offset, lays the face in the target plane, gapped', async () => {
      const { manager, targetId, movingId } = twoBoxes({ x: 0, y: 90, z: 0 });
      const before = await build(manager.document);
      // A side of the turned box, facing ±X, made to face +Z like the top.
      const moving = facePick(before, movingId, (n) => n.x);
      const target = facePick(before, targetId, (n, c) => n.z * 1e3 + c.z);
      const top = topOf(before, targetId);
      manager.execute(
        alignCommand([moving, target], { flip: true, offset: 2.5 })
      );
      const after = await build(manager.document);
      const landed = facePick(after, movingId, (n) => n.z);
      expect(landed.normal!.z).toBeCloseTo(1, 9);
      expect((landed.centroid ?? landed.center!).z).toBeCloseTo(top + 2.5, 6);
      // Flipped, the box hangs below its face: it sinks into the target.
      expect(after.bodyRepresentations[movingId]!.bbox.max.z).toBeCloseTo(
        top + 2.5,
        6
      );
      expect(after.bodyRepresentations[movingId]!.volume).toBeCloseTo(
        MOVING_VOLUME,
        6
      );
    });
  }
);
