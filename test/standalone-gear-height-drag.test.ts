import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  gearBody,
  importStepBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type FaceTopology
} from '@openzcad/shared';
import {
  faceOffsetBaseline,
  planFaceOffset
} from '../apps/web/src/lib/interaction/faceOffsetPlan';

function cap(body: BodyRepresentation, side: 'start' | 'end'): FaceTopology {
  const face = body.topology!.faces.find(
    (entry) => entry.reference?.lineageName === `gear.face.cap.${side}`
  );
  expect(face).toBeDefined();
  return face!;
}

describe('standalone gear height dragging', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  it.each(['external', 'internal'] as const)(
    'reduces a 40 mm %s gear to 25 mm and keeps its base, teeth and sibling',
    async (gearType) => {
      const made = gearBody(
        createProjectDocument('Gear height', toUserId('user_gear_height')),
        {
          name: 'Gear 1',
          gearType,
          sizing: 'module',
          pitch: 2,
          teeth: 20,
          faceWidth: 40,
          ...(gearType === 'internal'
            ? { rimDiameter: 80, dedendum: 0.8, rootFillet: 0 }
            : {}),
          origin: { x: 0, y: 0, z: 7 },
          axis: { x: 0, y: 0, z: 1 }
        }
      );
      const document = addPrimitiveFeature(made.document, {
        name: 'Sibling',
        primitiveKind: 'box',
        dimensions: { width: 2, height: 3, depth: 4 }
      });
      document.derived = await adapter.syncDocument(document);
      expect(document.derived.warnings).toEqual([]);
      const before = document.derived.bodyRepresentations[made.bodyId]!;
      const top = cap(before, 'end');
      expect(faceOffsetBaseline(document, made.bodyId, top, top.hash)).toEqual({
        total: 40,
        sense: 1
      });
      const plan = planFaceOffset({
        document,
        bodyId: made.bodyId,
        face: top,
        faceHash: top.hash,
        offset: -15
      });
      expect(plan?.kind).toBe('gear-width');
      const manager = new CommandManager(document);
      manager.execute(plan!.command);
      const derive = () => adapter.syncDocument(manager.document);
      const changed = await derive();
      expect(changed.warnings).toEqual([]);
      const after = changed.bodyRepresentations[made.bodyId]!;
      expect(after.bbox.min.z).toBeCloseTo(7, 6);
      expect(after.bbox.max.z).toBeCloseTo(32, 6);
      expect(after.volume).toBeCloseTo((before.volume * 25) / 40, 3);
      expect(after.faceCount).toBe(before.faceCount);
      expect(manager.document.featureOrder).toHaveLength(
        document.featureOrder.length
      );
      const siblingId = document.bodyOrder.find((id) => id !== made.bodyId)!;
      expect(changed.bodyRepresentations[siblingId]!.bbox).toEqual(
        document.derived.bodyRepresentations[siblingId]!.bbox
      );
      expect(manager.undo()).toBeTruthy();
      expect(
        (await derive()).bodyRepresentations[made.bodyId]!.bbox.max.z
      ).toBeCloseTo(47, 6);
      expect(manager.redo()).toBeTruthy();
      expect(
        (await derive()).bodyRepresentations[made.bodyId]!.bbox.max.z
      ).toBeCloseTo(32, 6);
      const reopened = JSON.parse(
        JSON.stringify(manager.document)
      ) as typeof document;
      expect(
        (await adapter.syncDocument(reopened)).bodyRepresentations[made.bodyId]!
          .bbox.max.z
      ).toBeCloseTo(32, 6);
      const step = await adapter.exportStep(manager.document, [made.bodyId]);
      const imported = importStepBody(
        createProjectDocument(
          'Resized gear STEP',
          toUserId('user_gear_height')
        ),
        {
          name: 'Gear',
          artifactId: 'resized-gear',
          sourceName: 'gear.step',
          stepText: step
        }
      );
      const roundTrip = await adapter.syncDocument(imported.document);
      expect(roundTrip.warnings).toEqual([]);
      const exported = roundTrip.bodyRepresentations[imported.bodyId]!;
      expect(exported.bbox.min.z).toBeCloseTo(7, 5);
      expect(exported.bbox.max.z).toBeCloseTo(32, 5);
      expect(exported.volume).toBeCloseTo(after.volume, 1);
    }
  );

  it('moves the near cap while keeping the opposite end fixed on an X-axis gear', async () => {
    const made = gearBody(
      createProjectDocument('Tilted gear', toUserId('user_gear_height')),
      {
        name: 'Gear',
        gearType: 'external',
        sizing: 'module',
        pitch: 2,
        teeth: 20,
        faceWidth: 40,
        origin: { x: 7, y: 20, z: 30 },
        axis: { x: 1, y: 0, z: 0 }
      }
    );
    const document = made.document;
    document.derived = await adapter.syncDocument(document);
    expect(document.derived.warnings).toEqual([]);
    const before = document.derived.bodyRepresentations[made.bodyId]!;
    const start = cap(before, 'start');
    expect(
      faceOffsetBaseline(document, made.bodyId, start, start.hash)
    ).toEqual({ total: 40, sense: 1 });
    const plan = planFaceOffset({
      document,
      bodyId: made.bodyId,
      face: start,
      faceHash: start.hash,
      offset: -15
    });
    expect(plan?.kind).toBe('gear-width');
    const result = await adapter.syncDocument(plan!.command.apply(document));
    expect(result.warnings).toEqual([]);
    const after = result.bodyRepresentations[made.bodyId]!;
    expect(after.bbox.max.x).toBeCloseTo(before.bbox.max.x, 6);
    expect(after.bbox.min.x).toBeCloseTo(before.bbox.min.x + 15, 6);
    expect(after.bbox.max.y).toBeCloseTo(before.bbox.max.y, 6);
    expect(after.volume).toBeCloseTo((before.volume * 25) / 40, 3);
  });
});
