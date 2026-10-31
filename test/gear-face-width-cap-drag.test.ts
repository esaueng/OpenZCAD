import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createParameterIds,
  createProjectDocument,
  gearBody,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type FaceTopology,
  type ParamValue,
  type ProjectDocument
} from '@openzcad/shared';
import {
  faceOffsetBaseline,
  planFaceOffset
} from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { gearHeightPreviewProfile } from '../apps/web/src/lib/interaction/gearHeightPreviewProfile';

/**
 * A gear built as its own body (module 0.8, 20 teeth, 10 wide) beside a box
 * and a placed cylinder. Its caps used to plan as a local push/pull, which the
 * kernel refuses on involute flanks; they now edit the gear's face width.
 */
function scene(gear: Partial<Parameters<typeof gearBody>[1]> = {}): {
  document: ProjectDocument;
  gearId: BodyId;
} {
  let document = addPrimitiveFeature(
    createProjectDocument('Gear width', toUserId('user_gear_width')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 30, height: 18, depth: 24 }
    }
  );
  document = addPrimitiveFeature(document, {
    name: 'Cylinder',
    primitiveKind: 'cylinder',
    dimensions: { radius: 6, height: 28 }
  });
  document = transformBody(document, {
    name: 'Place Cylinder',
    targetBodyId: document.bodyOrder[1]!,
    translation: { x: 34, y: 0, z: 0 }
  }).document;
  const result = gearBody(document, {
    name: 'Gear',
    gearType: 'external',
    sizing: 'module',
    pitch: 0.8,
    teeth: 20,
    faceWidth: 10,
    origin: { x: 34, y: 33, z: 28 },
    axis: { x: 0, y: 0, z: 1 },
    ...gear
  });
  return { document: result.document, gearId: result.bodyId };
}

function cap(body: BodyRepresentation, side: 'start' | 'end'): FaceTopology {
  return body.topology!.faces.find(
    (face) => face.reference?.lineageName === `gear.face.cap.${side}`
  )!;
}

function flanks(body: BodyRepresentation): number {
  return body.topology!.faces.filter((face) =>
    face.reference?.lineageName.includes('.flank')
  ).length;
}

describe(
  'cap drags on a gear built as its own body',
  { timeout: 120_000 },
  () => {
    let adapter: ExactKernelAdapter;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });
    afterAll(() => adapter.dispose());

    async function derive(document: ProjectDocument): Promise<ProjectDocument> {
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      return { ...document, derived };
    }

    function drag(
      document: ProjectDocument,
      gearId: BodyId,
      side: 'start' | 'end',
      offset: number,
      exact?: ParamValue
    ) {
      const face = cap(document.derived.bodyRepresentations[gearId]!, side);
      return planFaceOffset({
        document,
        bodyId: gearId,
        face,
        faceHash: face.hash,
        offset,
        ...(exact === undefined ? {} : { exact })
      });
    }

    it('resizes 10 → 13 → 9 mm from the top cap, keeping the bottom, teeth and other bodies', async () => {
      const { document: start, gearId } = scene();
      const manager = new CommandManager(await derive(start));
      const before = manager.document.derived;
      const gear = before.bodyRepresentations[gearId]!;
      const top = cap(gear, 'end');
      expect(top.geometry!.area).toBeCloseTo(196.91996, 4);
      expect(
        faceOffsetBaseline(manager.document, gearId, top, top.hash)
      ).toEqual({
        total: 10,
        sense: 1
      });

      let current = manager.document;
      for (const [offset, width] of [
        [3, 13],
        [-4, 9]
      ] as const) {
        const plan = drag(current, gearId, 'end', offset);
        expect(plan?.kind).toBe('gear-width');
        expect(plan?.kind === 'gear-width' && plan.value).toBeCloseTo(width, 9);
        expect(plan?.kind === 'gear-width' && plan.preflightRejection).toBe(
          undefined
        );
        manager.execute(plan!.command);
        current = await derive(manager.document);
        const body = current.derived.bodyRepresentations[gearId]!;
        expect(body.bbox.min.z).toBeCloseTo(28, 6);
        expect(body.bbox.max.z).toBeCloseTo(28 + width, 6);
        // A prism: the cross-section, and so every tooth, is unchanged.
        expect(body.volume).toBeCloseTo((gear.volume / 10) * width, 3);
        expect(cap(body, 'end').geometry!.area).toBeCloseTo(
          top.geometry!.area,
          6
        );
        expect(cap(body, 'start').geometry!.center.z).toBeCloseTo(28, 6);
        expect(flanks(body)).toBe(flanks(gear));
        for (const other of manager.document.bodyOrder.slice(0, 2)) {
          expect(body.bodyId).not.toBe(other);
          const unchanged = current.derived.bodyRepresentations[other]!;
          expect(unchanged.bbox).toEqual(
            before.bodyRepresentations[other]!.bbox
          );
          expect(unchanged.volume).toBeCloseTo(
            before.bodyRepresentations[other]!.volume,
            9
          );
        }
      }
      // Persisted, not merely displayed.
      const stored = listFeaturesInOrder(manager.document).at(-1)!;
      expect(stored.data.featureKind === 'gear' && stored.data.faceWidth).toBe(
        9
      );

      manager.undo();
      expect(
        (await derive(manager.document)).derived.bodyRepresentations[gearId]!
          .bbox.max.z
      ).toBeCloseTo(41, 6);
      manager.undo();
      expect(
        (await derive(manager.document)).derived.bodyRepresentations[gearId]!
          .bbox.max.z
      ).toBeCloseTo(38, 6);
      manager.redo();
      const reopened = JSON.parse(
        JSON.stringify(manager.document)
      ) as ProjectDocument;
      expect(
        (await derive(reopened)).derived.bodyRepresentations[gearId]!.bbox.max.z
      ).toBeCloseTo(41, 6);
    });

    it('moves the origin back for a bottom-cap drag so the top stays put', async () => {
      const { document: start, gearId } = scene();
      const document = await derive(start);
      const gear = document.derived.bodyRepresentations[gearId]!;
      const plan = drag(document, gearId, 'start', 2);
      expect(plan?.kind).toBe('gear-width');
      const after = await derive(plan!.command.apply(document));
      const body = after.derived.bodyRepresentations[gearId]!;
      expect(body.bbox.min.z).toBeCloseTo(26, 6);
      expect(body.bbox.max.z).toBeCloseTo(38, 6);
      expect(body.volume).toBeCloseTo((gear.volume / 10) * 12, 3);
      // The far cap is the same face in the same place, teeth included.
      expect(body.bbox.min.x).toBeCloseTo(gear.bbox.min.x, 9);
      expect(body.bbox.max.y).toBeCloseTo(gear.bbox.max.y, 9);
    });

    it('keeps a typed expression live and follows a rotated placement', async () => {
      const { document: base, gearId } = scene();
      const withParameter = commandFactories
        .setParameter({
          name: 'extra',
          expression: '3',
          ids: createParameterIds()
        })
        .apply(base);
      const rotated = transformBody(withParameter, {
        name: 'Tip Gear',
        targetBodyId: gearId,
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 90, y: 0, z: 0 }
      }).document;
      const document = await derive(rotated);
      const gear = document.derived.bodyRepresentations[gearId]!;
      const plan = drag(document, gearId, 'end', 3, 'extra');
      expect(plan?.kind).toBe('gear-width');
      const applied = plan!.command.apply(document);
      const stored = listFeaturesInOrder(applied).find(
        (feature) => feature.data.featureKind === 'gear'
      )!;
      expect(stored.data.featureKind === 'gear' && stored.data.faceWidth).toBe(
        '10 + (extra)'
      );
      const body = (await derive(applied)).derived.bodyRepresentations[gearId]!;
      expect(body.volume).toBeCloseTo((gear.volume / 10) * 13, 3);
    });

    it('previews a standalone spur gear across its full axial span', async () => {
      const { document: start, gearId } = scene();
      const document = await derive(start);
      const body = document.derived.bodyRepresentations[gearId]!;
      const profile = gearHeightPreviewProfile(
        document,
        body,
        cap(body, 'end')
      );
      expect(profile?.axisStart.z).toBeCloseTo(28, 6);
      expect(profile?.axisEnd.z).toBeCloseTo(38, 6);
    });

    it('refuses a width at or below zero before asking the kernel', async () => {
      const { document: start, gearId } = scene();
      const plan = drag(await derive(start), gearId, 'end', -10);
      expect(plan?.kind === 'gear-width' && plan.preflightRejection).toBe(
        'That distance would leave the gear with no width.'
      );
    });

    it('refuses a helical start-cap drag that would turn the far teeth', async () => {
      const { document: start, gearId } = scene({ helixAngleDeg: 15 });
      const document = await derive(start);
      const bottom = drag(document, gearId, 'start', 2);
      expect(
        bottom?.kind === 'gear-width' && bottom.preflightRejection
      ).toMatch(/helical/);
      expect(
        gearHeightPreviewProfile(
          document,
          document.derived.bodyRepresentations[gearId],
          cap(document.derived.bodyRepresentations[gearId]!, 'end')
        )
      ).toBeNull();
      // The end cap is still a plain width edit: the start face stays.
      const top = drag(document, gearId, 'end', 2);
      expect(top?.kind === 'gear-width' && top.preflightRejection).toBe(
        undefined
      );
      const body = (await derive(top!.command.apply(document))).derived
        .bodyRepresentations[gearId]!;
      expect(body.bbox.min.z).toBeCloseTo(28, 6);
      expect(body.bbox.max.z).toBeCloseTo(40, 6);
    });

    it('does not guess for a stale face, a local offset or a gear cut by a later feature', async () => {
      const { document: start, gearId } = scene();
      const document = await derive(start);
      const top = cap(document.derived.bodyRepresentations[gearId]!, 'end');
      expect(
        planFaceOffset({
          document,
          bodyId: gearId,
          face: top,
          faceHash: top.hash + 1,
          offset: 3
        })?.kind
      ).toBe('direct-edit');
      expect(
        planFaceOffset({
          document,
          bodyId: gearId,
          face: top,
          faceHash: top.hash,
          offset: 3,
          localOnly: true
        })?.kind
      ).toBe('direct-edit');
      // Once another feature consumes the gear, its caps are no longer the
      // gear's alone to resize.
      let cut = addPrimitiveFeature(document, {
        name: 'Bore',
        primitiveKind: 'cylinder',
        dimensions: { radius: 2, height: 20 }
      });
      const boreId = cut.bodyOrder.at(-1)!;
      cut = transformBody(cut, {
        name: 'Place Bore',
        targetBodyId: boreId,
        translation: { x: 34, y: 33, z: 23 }
      }).document;
      cut = commandFactories
        .booleanBodies({
          name: 'Bore Gear',
          operation: 'subtract',
          targetBodyIds: [gearId, boreId]
        })
        .apply(cut);
      const bored = await derive(cut);
      const resultId = listFeaturesInOrder(bored).at(-1)!.bodyId!;
      const body = bored.derived.bodyRepresentations[resultId]!;
      const face = body.topology!.faces.find(
        (candidate) =>
          candidate.geometry?.surfaceType === 'plane' &&
          candidate.geometry.normal!.z > 0.99
      )!;
      expect(body.volume).toBeLessThan(
        document.derived.bodyRepresentations[gearId]!.volume
      );
      expect(
        planFaceOffset({
          document: bored,
          bodyId: resultId,
          face,
          faceHash: face.hash,
          offset: 3
        })?.kind
      ).toBe('direct-edit');
    });
  }
);
