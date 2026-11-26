import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands,
  replayCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  assertDocumentContentSchema,
  createFeatureOnlyIds,
  createProjectDocument,
  findFeature,
  listFeaturesInOrder,
  listNodesByKind,
  normalizeDocument,
  resolveParamValue
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type FeatureId,
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';
import { edgeAxisLine } from '../apps/web/src/lib/inPlace/datumPicks';
import { inPlaceFeatureUpdate } from '../apps/web/src/lib/inPlace/edit';
import {
  IN_PLACE_TOOL_SPECS,
  requestNewAxis,
  resolveNewAxis,
  type InPlaceContext,
  type InPlaceSlots
} from '../apps/web/src/lib/inPlace/tools';
import type { RevolveAxisCandidate } from '../apps/web/src/lib/inPlace/revolve';

/**
 * M10 (Slice 5a): two Rotate about axis copies about one picked body edge,
 * one at +θ and one at −θ, each committed on its own. Move's stamps repeat
 * one transform k times and cannot put copies on opposite sides, so the
 * workflow is two separate copies. The body is an L prism with unequal
 * arms, and θ is no special angle, so a sign, unit or axis-direction slip
 * lands a copy visibly elsewhere. Every expected point comes from the
 * Rodrigues rotation about the edge line computed here, never from the
 * kernel's own transform.
 *
 * The commands are the ones the workspace commits: the shipping Rotate
 * about axis tool builds the request, a picked edge becomes a datum axis
 * composed into the same step (App.tsx `inPlaceCommandFor`), and a History
 * edit goes through `inPlaceFeatureUpdate`.
 */
describe(
  'signed Rotate about axis copies about a picked edge (M10)',
  {
    timeout: 120_000
  },
  () => {
    let adapter: ExactKernelAdapter;
    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });
    afterAll(() => adapter.dispose());

    const user = toUserId('user_m10_signed_rotate');
    const THETA = 35;
    const EDITED = 62;
    // L profile on XY with unequal arms, extruded 6 up Z: volume 2304.
    const L_PROFILE: [number, number][] = [
      [0, 0],
      [30, 0],
      [30, 8],
      [12, 8],
      [12, 20],
      [0, 20]
    ];
    const HEIGHT = 6;
    const VOLUME = (30 * 8 + 12 * 12) * HEIGHT;
    const axisRotate = IN_PLACE_TOOL_SPECS['axis-rotate'];

    function lBlock(): { manager: CommandManager; sourceId: BodyId } {
      const manager = new CommandManager(
        createProjectDocument('Signed rotate copies', user)
      );
      manager.execute(
        commandFactories.addSketch({
          name: 'L profile',
          planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
          objects: L_PROFILE.map(([x1, y1], index) => {
            const [x2, y2] = L_PROFILE[(index + 1) % L_PROFILE.length]!;
            return { objectKind: 'line' as const, x1, y1, x2, y2 };
          })
        })
      );
      const sketch = listNodesByKind(manager.document, 'sketch')[0]!;
      const objects = sketch.objectIds.map((objectId) => {
        const node = manager.document.nodes[objectId];
        if (node?.kind !== 'sketch-object')
          throw new Error('No sketch object.');
        return { id: node.id, data: node.data };
      });
      const profiles = computeSketchProfileAnalysis(objects, (value) =>
        resolveParamValue(value, {}, 'profile dimension')
      ).profiles;
      expect(profiles).toHaveLength(1);
      const [profile] = profiles;
      manager.execute(
        commandFactories.extrudeSketch({
          name: 'L block',
          sketchId: sketch.sketchId,
          profile: {
            profileId: profile!.profileId,
            regionFingerprint: profile!.regionFingerprint,
            samplePoint: profile!.samplePoint,
            sourceArea: profile!.area,
            sourceEntityIds: profile!.sourceEntityIds
          },
          distance: HEIGHT,
          operation: 'new-body'
        })
      );
      return { manager, sourceId: manager.document.bodyOrder[0] as BodyId };
    }

    async function build(document: ProjectDocument): Promise<DerivedState> {
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      return derived;
    }

    const vertices = (derived: DerivedState, bodyId: BodyId): Vector3[] => {
      const body = derived.bodyRepresentations[bodyId];
      expect(body, `body ${bodyId} built`).toBeDefined();
      expect(body!.consumed).not.toBe(true);
      // The ends of every edge's exact polyline: the solid's corners.
      const corners = new Map<string, Vector3>();
      for (const edge of body!.topology?.edges ?? []) {
        const p = edge.points;
        for (const at of [0, p.length - 3]) {
          const point = { x: p[at]!, y: p[at + 1]!, z: p[at + 2]! };
          corners.set(key(point), point);
        }
      }
      return [...corners.values()];
    };

    const sub = (a: Vector3, b: Vector3): Vector3 => ({
      x: a.x - b.x,
      y: a.y - b.y,
      z: a.z - b.z
    });
    const dot = (a: Vector3, b: Vector3) => a.x * b.x + a.y * b.y + a.z * b.z;
    const cross = (a: Vector3, b: Vector3): Vector3 => ({
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    });

    /** Rodrigues: `point` turned `deg` right-handed about the line. */
    function rotateAbout(
      point: Vector3,
      origin: Vector3,
      direction: Vector3,
      deg: number
    ): Vector3 {
      const length = Math.hypot(direction.x, direction.y, direction.z);
      const k = {
        x: direction.x / length,
        y: direction.y / length,
        z: direction.z / length
      };
      const v = sub(point, origin);
      const t = (deg * Math.PI) / 180;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const kxv = cross(k, v);
      const kv = dot(k, v) * (1 - c);
      return {
        x: origin.x + v.x * c + kxv.x * s + k.x * kv,
        y: origin.y + v.y * c + kxv.y * s + k.y * kv,
        z: origin.z + v.z * c + kxv.z * s + k.z * kv
      };
    }

    function distanceToLine(
      point: Vector3,
      origin: Vector3,
      direction: Vector3
    ): number {
      const length = Math.hypot(direction.x, direction.y, direction.z);
      const c = cross(sub(point, origin), direction);
      return Math.hypot(c.x, c.y, c.z) / length;
    }

    const key = (point: Vector3) =>
      [point.x, point.y, point.z]
        .map((v) => (Math.round(v * 1e5) / 1e5 || 0).toFixed(5))
        .join(',');
    const pointSet = (points: Vector3[]) => points.map(key).sort();

    /** The L's 12 corners, independent of any build. */
    const SOURCE_CORNERS: Vector3[] = [0, HEIGHT].flatMap((z) =>
      L_PROFILE.map(([x, y]) => ({ x, y, z }))
    );

    /** The picked edge: the L's top far edge, (30, 0, 6) to (30, 8, 6). */
    function pickTopFarEdge(document: ProjectDocument, sourceId: BodyId) {
      const edges =
        document.derived.bodyRepresentations[sourceId]!.topology!.edges;
      const edge = edges.find((candidate) => {
        const witness = candidate.reference?.witness;
        if (!witness || witness.closed) return false;
        const ends = witness.endpoints.map((end) => end.map((q) => q * 1e-6));
        return ends.every(
          ([x, , z]) => Math.abs(x! - 30) < 1e-9 && Math.abs(z! - HEIGHT) < 1e-9
        );
      });
      expect(edge?.reference).toBeDefined();
      const axis = edgeAxisLine(document, {
        bodyId: sourceId,
        kind: 'edge',
        hash: edge!.hash
      });
      if ('reason' in axis) throw new Error(axis.reason);
      // The line runs from the witness's end 0 toward its end 1.
      const witness = edge!.reference!.witness;
      if (witness.closed) throw new Error('The picked edge is closed.');
      const [end0, end1] = witness.endpoints.map((end) => ({
        x: end[0] * 1e-6,
        y: end[1] * 1e-6,
        z: end[2] * 1e-6
      }));
      return { axis, end0: end0!, end1: end1! };
    }

    function slotsFor(
      sourceId: BodyId,
      axis: RevolveAxisCandidate
    ): InPlaceSlots {
      return {
        profiles: [],
        axis,
        path: [],
        guide: [],
        faces: [],
        bodies: [
          {
            bodyId: sourceId,
            min: { x: 0, y: 0, z: 0 },
            max: { x: 30, y: 20, z: HEIGHT }
          }
        ],
        plane: null,
        edges: [],
        refs: [],
        image: null
      };
    }

    /**
     * What Done commits for a Rotate about axis copy (App.tsx
     * `inPlaceCommandFor`): a picked line becomes a datum axis composed
     * into the same step as the turn; an existing datum is turned about
     * as it is.
     */
    function copyCommand(
      sourceId: BodyId,
      axis: RevolveAxisCandidate,
      angle: number,
      axisName: string
    ): { command: AnyCommand; datumId: FeatureId | null; copyId: BodyId } {
      const request = axisRotate.request(
        slotsFor(sourceId, axis),
        { angle },
        { copy: 'yes' },
        {} as InPlaceContext
      );
      expect(request).toMatchObject({
        tool: 'transform',
        targetBodyId: sourceId,
        copy: true,
        axisRotation: { angleDeg: angle }
      });
      const definition = requestNewAxis(request!);
      const ids = definition ? createFeatureOnlyIds() : null;
      const resolved = resolveNewAxis(request!, ids?.featureId ?? null);
      if (!resolved || resolved.tool !== 'transform') {
        throw new Error('The request did not resolve onto a datum.');
      }
      const transform = commandFactories.transformBody({
        name: 'Rotate',
        targetBodyId: resolved.targetBodyId,
        translation: resolved.translation,
        ...(resolved.axisRotation
          ? { axisRotation: resolved.axisRotation }
          : {}),
        copy: true,
        bodyName: `L block copy ${angle}`
      });
      const copyId = (transform.payload.ids as { bodyId: BodyId }).bodyId;
      if (!definition || !ids) {
        return { command: transform, datumId: null, copyId };
      }
      const datum = commandFactories.addDatumAxis({
        name: axisName,
        definition,
        ids
      });
      return {
        command: composeCommands('Rotate', [datum, transform]),
        datumId: ids.featureId,
        copyId
      };
    }

    /** Every check on one copy: the corners, their reach and the volume. */
    function expectCopyAt(
      derived: DerivedState,
      copyId: BodyId,
      line: { origin: Vector3; direction: Vector3 },
      deg: number
    ) {
      const expected = SOURCE_CORNERS.map((corner) =>
        rotateAbout(corner, line.origin, line.direction, deg)
      );
      const actual = vertices(derived, copyId);
      expect(pointSet(actual)).toEqual(pointSet(expected));
      // Each corner keeps its distance to the axis.
      expect(
        actual
          .map((p) => distanceToLine(p, line.origin, line.direction).toFixed(6))
          .sort()
      ).toEqual(
        SOURCE_CORNERS.map((p) =>
          distanceToLine(p, line.origin, line.direction).toFixed(6)
        ).sort()
      );
      expect(derived.bodyRepresentations[copyId]!.volume).toBeCloseTo(
        VOLUME,
        6
      );
    }

    function expectSourceUnchanged(derived: DerivedState, sourceId: BodyId) {
      expect(pointSet(vertices(derived, sourceId))).toEqual(
        pointSet(SOURCE_CORNERS)
      );
      expect(derived.bodyRepresentations[sourceId]!.volume).toBeCloseTo(
        VOLUME,
        6
      );
    }

    async function twoCopies() {
      const { manager, sourceId } = lBlock();
      const built = await build(manager.document);
      const picked = pickTopFarEdge(
        { ...manager.document, derived: built },
        sourceId
      );
      const plus = copyCommand(sourceId, picked.axis, THETA, 'Axis 1');
      expect(plus.datumId).not.toBeNull();
      manager.execute(plus.command);
      const minus = copyCommand(sourceId, picked.axis, -THETA, 'Axis 2');
      expect(minus.datumId).not.toBeNull();
      manager.execute(minus.command);
      return {
        manager,
        sourceId,
        picked,
        plus: { ...plus, datumId: plus.datumId! },
        minus: { ...minus, datumId: minus.datumId! }
      };
    }

    it('puts the +θ and −θ copies on opposite sides of the picked edge', async () => {
      const { manager, sourceId, picked, plus, minus } = await twoCopies();
      // The edge pick is a line from end 0 toward end 1 along the top far edge.
      const { axis, end0, end1 } = picked;
      expect(axis.origin).toEqual(end0);
      const span = sub(end1, end0);
      expect(dot(axis.direction, span)).toBeCloseTo(8, 9);
      expect(axis.choice).toMatchObject({ define: { kind: 'edge' } });

      const derived = await build(manager.document);
      expect(manager.document.bodyOrder).toEqual([
        sourceId,
        plus.copyId,
        minus.copyId
      ]);
      // Both datum axes publish the same line, the one the pick showed.
      for (const datumId of [plus.datumId, minus.datumId]) {
        const line = derived.datumAxes?.[datumId];
        expect(line).toBeDefined();
        expect(key(line!.origin)).toBe(key(end0));
        expect(key(line!.direction)).toBe(key(axis.direction));
      }
      const line = { origin: end0, direction: span };
      expectCopyAt(derived, plus.copyId, line, THETA);
      expectCopyAt(derived, minus.copyId, line, -THETA);
      expectSourceUnchanged(derived, sourceId);

      // A sign slip shows: the two copies are not the same body, and each
      // sits on its own side of the source's top plane. With the axis along
      // +Y, +θ tips the L's far-from-edge corners up (+Z).
      expect(pointSet(vertices(derived, plus.copyId))).not.toEqual(
        pointSet(vertices(derived, minus.copyId))
      );
      const tip = { x: 0, y: 0, z: HEIGHT };
      const plusTip = rotateAbout(tip, end0, span, THETA);
      const minusTip = rotateAbout(tip, end0, span, -THETA);
      expect(Math.sign(axis.direction.y)).toBe(1);
      expect(plusTip.z).toBeGreaterThan(HEIGHT);
      expect(minusTip.z).toBeLessThan(HEIGHT);
      expect(vertices(derived, plus.copyId).map(key)).toContain(key(plusTip));
      expect(vertices(derived, minus.copyId).map(key)).toContain(key(minusTip));
    });

    it('records each copy as one History step, and one Undo removes only that copy', async () => {
      const { manager, sourceId, plus, minus } = await twoCopies();
      const history = manager.document.editHistory!;
      // Sketch, extrude, +θ copy, −θ copy.
      expect(history.entries).toHaveLength(4);
      expect(history.cursor).toBe(4);
      expect(manager.undoLabel).toBe('Rotate');
      const kinds = () =>
        listFeaturesInOrder(manager.document).map((feature) => [
          feature.name,
          feature.featureKind
        ]);
      expect(kinds()).toEqual([
        ['L profile', 'sketch'],
        ['L block', 'extrude'],
        ['Axis 1', 'datum-axis'],
        ['Rotate', 'transform'],
        ['Axis 2', 'datum-axis'],
        ['Rotate', 'transform']
      ]);

      manager.undo();
      // The −θ copy and the datum its step added are gone; nothing else moved.
      expect(manager.document.bodyOrder).toEqual([sourceId, plus.copyId]);
      expect(findFeature(manager.document, minus.datumId)).toBeUndefined();
      expect(kinds()).toHaveLength(4);
      const afterOne = await build(manager.document);
      const line = {
        origin: afterOne.datumAxes![plus.datumId]!.origin,
        direction: afterOne.datumAxes![plus.datumId]!.direction
      };
      expectCopyAt(afterOne, plus.copyId, line, THETA);
      expectSourceUnchanged(afterOne, sourceId);
      expect(afterOne.bodyRepresentations[minus.copyId]).toBeUndefined();

      manager.undo();
      expect(manager.document.bodyOrder).toEqual([sourceId]);
      expect(findFeature(manager.document, plus.datumId)).toBeUndefined();

      // Redo brings both back under the same ids, in place.
      manager.redo();
      manager.redo();
      expect(manager.document.bodyOrder).toEqual([
        sourceId,
        plus.copyId,
        minus.copyId
      ]);
      const redone = await build(manager.document);
      expectCopyAt(redone, minus.copyId, line, -THETA);
    });

    it('moves only the first copy when its angle is edited in History', async () => {
      const { manager, sourceId, plus, minus } = await twoCopies();
      const before = await build(manager.document);
      const line = {
        origin: before.datumAxes![plus.datumId]!.origin,
        direction: before.datumAxes![plus.datumId]!.direction
      };
      const secondBefore = pointSet(vertices(before, minus.copyId));

      // Re-armed from History the turn keeps its datum: the edit's axis slot
      // is the stored axis, and the copy stays a copy.
      const rotate = listFeaturesInOrder(manager.document).find(
        (feature) => feature.bodyId === plus.copyId
      )!;
      expect(rotate.data).toMatchObject({
        featureKind: 'transform',
        copy: true
      });
      const savedAxis: RevolveAxisCandidate = {
        id: `datum:${plus.datumId}`,
        label: 'Axis 1',
        origin: line.origin,
        direction: line.direction,
        choice: { datumFeatureId: plus.datumId }
      };
      const request = axisRotate.request(
        slotsFor(sourceId, savedAxis),
        { angle: EDITED },
        { copy: 'yes' },
        {} as InPlaceContext
      );
      const resolved = resolveNewAxis(request!, null);
      if (!resolved || resolved.tool !== 'transform') {
        throw new Error('The edit request did not resolve.');
      }
      const update = inPlaceFeatureUpdate(rotate, resolved);
      expect(update).not.toBeNull();
      manager.execute(commandFactories.updateFeature(update!, 'Edit Rotate'));
      expect(manager.document.editHistory!.entries).toHaveLength(5);
      expect(
        findFeature(manager.document, rotate.featureId)!.data
      ).toMatchObject({
        featureKind: 'transform',
        copy: true,
        axisRotation: {
          axis: { type: 'datum-axis', datumFeatureId: plus.datumId },
          angleDeg: EDITED
        }
      });
      expect(manager.document.bodyOrder).toEqual([
        sourceId,
        plus.copyId,
        minus.copyId
      ]);

      const edited = await build(manager.document);
      expectCopyAt(edited, plus.copyId, line, EDITED);
      expect(pointSet(vertices(edited, minus.copyId))).toEqual(secondBefore);
      expectCopyAt(edited, minus.copyId, line, -THETA);
      expectSourceUnchanged(edited, sourceId);
    });

    it('reopens and replays with the same bodies, angles and positions', async () => {
      const { manager, sourceId, plus, minus } = await twoCopies();
      const live = await build(manager.document);
      const line = {
        origin: live.datumAxes![plus.datumId]!.origin,
        direction: live.datumAxes![plus.datumId]!.direction
      };
      const angles = (document: ProjectDocument) =>
        listFeaturesInOrder(document)
          .filter((feature) => feature.data.featureKind === 'transform')
          .map((feature) => [
            feature.bodyId,
            (feature.data as { axisRotation?: { angleDeg: unknown } })
              .axisRotation?.angleDeg
          ]);
      expect(angles(manager.document)).toEqual([
        [plus.copyId, THETA],
        [minus.copyId, -THETA]
      ]);

      // Reopened from its saved JSON, in a fresh kernel.
      const saved = normalizeDocument(
        JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
      );
      assertDocumentContentSchema(saved);
      // Replayed from its command log onto a blank project.
      const replayed = replayCommands(
        createProjectDocument('Signed rotate copies', user),
        manager.document.commandLog
      );
      const fresh = await createExactKernelAdapter();
      try {
        for (const document of [saved, replayed]) {
          expect(document.bodyOrder).toEqual([
            sourceId,
            plus.copyId,
            minus.copyId
          ]);
          expect(angles(document)).toEqual(angles(manager.document));
          const derived = await fresh.syncDocument(document);
          expect(derived.warnings).toEqual([]);
          for (const bodyId of document.bodyOrder) {
            expect(pointSet(vertices(derived, bodyId))).toEqual(
              pointSet(vertices(live, bodyId))
            );
          }
          expectCopyAt(derived, plus.copyId, line, THETA);
          expectCopyAt(derived, minus.copyId, line, -THETA);
          expectSourceUnchanged(derived, sourceId);
        }
      } finally {
        fresh.dispose();
      }
    });

    it('turns the second copy about the drawn Axis 1 when the click lands on it', async () => {
      // In the workspace Axis 1 is drawn along the picked edge after the
      // first copy, and a drawn axis line takes the click before the model
      // under it (test/e2e/signed-rotate-copies.spec.ts). The second copy
      // then turns about Axis 1 itself and adds no datum.
      const { manager, sourceId } = lBlock();
      const built = await build(manager.document);
      const picked = pickTopFarEdge(
        { ...manager.document, derived: built },
        sourceId
      );
      const plus = copyCommand(sourceId, picked.axis, THETA, 'Axis 1');
      manager.execute(plus.command);
      const axisOne: RevolveAxisCandidate = {
        id: `datum:${plus.datumId}`,
        label: 'Axis 1',
        origin: picked.axis.origin,
        direction: picked.axis.direction,
        choice: { datumFeatureId: plus.datumId! }
      };
      const minus = copyCommand(sourceId, axisOne, -THETA, 'Axis 2');
      expect(minus.datumId).toBeNull();
      manager.execute(minus.command);
      expect(manager.document.editHistory!.entries).toHaveLength(4);
      expect(
        listFeaturesInOrder(manager.document).map((feature) => feature.name)
      ).toEqual(['L profile', 'L block', 'Axis 1', 'Rotate', 'Rotate']);
      const line = {
        origin: picked.end0,
        direction: sub(picked.end1, picked.end0)
      };
      const both = await build(manager.document);
      expectCopyAt(both, plus.copyId, line, THETA);
      expectCopyAt(both, minus.copyId, line, -THETA);
      expectSourceUnchanged(both, sourceId);

      // One Undo takes the second copy alone; Axis 1 is the first's.
      manager.undo();
      expect(manager.document.bodyOrder).toEqual([sourceId, plus.copyId]);
      expect(findFeature(manager.document, plus.datumId!)).toBeDefined();
      manager.redo();

      // Editing the first copy's angle leaves the second where it was: it
      // shares the datum, and the datum follows the source's edge.
      const rotate = listFeaturesInOrder(manager.document).find(
        (feature) => feature.bodyId === plus.copyId
      )!;
      const request = axisRotate.request(
        slotsFor(sourceId, axisOne),
        { angle: EDITED },
        { copy: 'yes' },
        {} as InPlaceContext
      );
      const resolved = resolveNewAxis(request!, null);
      if (!resolved || resolved.tool !== 'transform') {
        throw new Error('The edit request did not resolve.');
      }
      manager.execute(
        commandFactories.updateFeature(
          inPlaceFeatureUpdate(rotate, resolved)!,
          'Edit Rotate'
        )
      );
      const edited = await build(manager.document);
      expectCopyAt(edited, plus.copyId, line, EDITED);
      expectCopyAt(edited, minus.copyId, line, -THETA);
      expectSourceUnchanged(edited, sourceId);

      const replayed = replayCommands(
        createProjectDocument('Signed rotate copies', user),
        manager.document.commandLog
      );
      const again = await build(replayed);
      expectCopyAt(again, plus.copyId, line, EDITED);
      expectCopyAt(again, minus.copyId, line, -THETA);
    });
  }
);
