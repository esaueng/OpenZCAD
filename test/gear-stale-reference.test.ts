import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import { listFeaturesInOrder, updateFeature } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type { BodyRepresentation, ProjectDocument } from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { staleGearReferenceDocument } from './support/stale-gear-reference';

function cap(body: BodyRepresentation, sense: number) {
  return body.topology!.faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      sense * (face.geometry.normal?.z ?? 0) > 0.99
  )!;
}

describe(
  'gear teeth saved with a live hash and an older reference',
  { timeout: 60_000 },
  () => {
    let adapter: ExactKernelAdapter;
    let document: ProjectDocument;
    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
      document = await staleGearReferenceDocument();
    });
    afterAll(() => adapter.dispose());

    it.each([1, -1])(
      'offsets cap %s across reversals, undo/redo and reopening',
      async (sense) => {
        const gear = listFeaturesInOrder(document).at(-1)!;
        if (gear.data.featureKind !== 'gear') throw new Error('Expected gear');
        expect(gear.data.faceHash).not.toBe(
          gear.data.faceReference!.currentHash
        );
        const manager = new CommandManager(document);
        const initial = await adapter.syncDocument(document);
        expect(initial.warnings).toEqual([]);
        const volumePerHeight =
          initial.bodyRepresentations[gear.bodyId!]!.volume / 81;
        let previousHeight = 81;
        for (const height of [86, 41, 56]) {
          const derived = await adapter.syncDocument(manager.document);
          const face = cap(derived.bodyRepresentations[gear.bodyId!]!, sense);
          const plan = planFaceOffset({
            document: { ...manager.document, derived },
            bodyId: gear.bodyId!,
            face,
            faceHash: face.hash,
            offset: height - previousHeight
          });
          expect(plan?.kind).toBe('primitive-dimension');
          manager.execute(plan!.command);
          const next = await adapter.syncDocument(manager.document);
          expect(next.warnings).toEqual([]);
          const body = next.bodyRepresentations[gear.bodyId!]!;
          expect(body.bbox.min.z).toBeCloseTo(sense === 1 ? 0 : 81 - height, 6);
          expect(body.bbox.max.z).toBeCloseTo(sense === 1 ? height : 81, 6);
          expect(body.volume).toBeCloseTo(volumePerHeight * height, 3);
          expect(
            body.topology!.faces.filter((f) =>
              f.reference?.lineageName.includes('.flank.')
            )
          ).toHaveLength(40);
          previousHeight = height;
        }
        manager.undo();
        const undone = await adapter.syncDocument(manager.document);
        expect(undone.warnings).toEqual([]);
        expect(undone.bodyRepresentations[gear.bodyId!]!.volume).toBeCloseTo(
          volumePerHeight * 41,
          3
        );
        manager.redo();
        const reopened = await createExactKernelAdapter();
        try {
          const rebuilt = await reopened.syncDocument(
            JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
          );
          expect(rebuilt.warnings).toEqual([]);
          expect(rebuilt.bodyRepresentations[gear.bodyId!]!.volume).toBeCloseTo(
            volumePerHeight * 56,
            3
          );
        } finally {
          reopened.dispose();
        }
      }
    );

    it.each(['missing-lineage', 'invalid-witness'] as const)(
      'refuses %s even when the legacy hash still matches',
      async (failure) => {
        const gear = listFeaturesInOrder(document).at(-1)!;
        if (gear.data.featureKind !== 'gear') throw new Error('Expected gear');
        const reference = gear.data.faceReference!;
        const broken = updateFeature(document, {
          featureId: gear.featureId,
          data: {
            faceReference:
              failure === 'missing-lineage'
                ? {
                    ...reference,
                    lineageName: 'primitive.cylinder.face.missing'
                  }
                : { ...reference, currentHash: reference.currentHash + 1 }
          }
        });
        const rebuilt = await adapter.syncDocument(broken);
        expect(rebuilt.warnings).toHaveLength(1);
        expect(rebuilt.warnings[0]).toContain('Gear face is stale:');
        expect(rebuilt.bodyRepresentations[gear.bodyId!]).toBeUndefined();
      }
    );

    it('keeps hash-only gear picks fail-closed after the blank height changes', async () => {
      const legacy = structuredClone(document);
      const gear = listFeaturesInOrder(legacy).at(-1)!;
      if (gear.data.featureKind !== 'gear') throw new Error('Expected gear');
      delete gear.data.faceReference;
      expect((await adapter.syncDocument(legacy)).warnings).toEqual([]);
      const primitive = listFeaturesInOrder(legacy)[0]!;
      const rebuilt = await adapter.syncDocument(
        updateFeature(legacy, {
          featureId: primitive.featureId,
          data: { dimensions: { height: 86 } }
        })
      );
      expect(rebuilt.warnings).toHaveLength(1);
      expect(rebuilt.warnings[0]).toContain('A selected face no longer exists');
      expect(rebuilt.bodyRepresentations[gear.bodyId!]).toBeUndefined();
    });
  }
);
