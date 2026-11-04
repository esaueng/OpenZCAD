import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import type { ProjectDocument } from '@openzcad/shared';
import {
  listFeaturesInOrder,
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  faceOffsetBaseline,
  planFaceOffset
} from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { filletedUnion, unionEndFace } from './support/filleted-union';

describe('filleted union end-face resizing', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  let model: Awaited<ReturnType<typeof filletedUnion>>;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    model = await filletedUnion(adapter);
  }, 120_000);
  afterAll(() => adapter.dispose());

  it.each([5.59, -1, 0.01])(
    'moves by %s mm with the NURBS blend in place',
    async (offset) => {
      const { document, body, bodyId } = model;
      const face = unionEndFace(body);
      expect(
        body.topology!.faces.some((f) => f.geometry?.surfaceType === 'bspline')
      ).toBe(true);
      expect(faceOffsetBaseline(document, bodyId, face, face.hash)).toEqual({
        total: 30,
        sense: 1
      });
      const plan = planFaceOffset({
        document,
        bodyId,
        face,
        faceHash: face.hash,
        offset
      });
      expect(plan?.kind).toBe('primitive-dimension');
      const after = await adapter.syncDocument(plan!.command.apply(document));
      expect(after.warnings).toEqual([]);
      const changed = after.bodyRepresentations[bodyId]!;
      expect(unionEndFace(changed).geometry!.center.x).toBeCloseTo(
        30 + offset,
        7
      );
      expect(unionEndFace(changed).geometry!.area).toBeCloseTo(
        face.geometry!.area,
        6
      );
      expect(changed.bbox.min).toEqual(body.bbox.min);
      expect(changed.topology!.faces).toHaveLength(body.topology!.faces.length);
      expect(
        changed.topology!.faces.filter(
          (f) => f.geometry?.surfaceType === 'bspline'
        )
      ).toHaveLength(2);
      const blends = changed.topology!.faces.filter(
        (f) =>
          f.geometry?.featureType === 'blend' &&
          f.geometry.blendRadius !== undefined
      );
      expect(blends.length).toBeGreaterThan(0);
      for (const blend of blends) expect(blend.geometry!.blendRadius).toBe(5);
    }
  );

  it('survives undo, redo and a fresh rebuild after reopening', async () => {
    const { document, bodyId, body } = model;
    const face = unionEndFace(body);
    const plan = planFaceOffset({
      document,
      bodyId,
      face,
      faceHash: face.hash,
      offset: 5.59
    })!;
    const manager = new CommandManager(document);
    manager.execute(plan.command);
    const resized = await adapter.syncDocument(manager.document);
    expect(resized.warnings).toEqual([]);
    const expected = resized.bodyRepresentations[bodyId]!;
    manager.undo();
    const undone = await adapter.syncDocument(manager.document);
    expect(undone.warnings).toEqual([]);
    expect(
      unionEndFace(undone.bodyRepresentations[bodyId]!).geometry!.center.x
    ).toBe(30);
    manager.redo();
    const reopened = normalizeDocument(
      JSON.parse(
        JSON.stringify(withoutDerivedProjection(manager.document))
      ) as ProjectDocument
    );
    const fresh = await createExactKernelAdapter();
    try {
      const after = await fresh.syncDocument(reopened);
      expect(after.warnings).toEqual([]);
      expect(after.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
        expected.volume,
        6
      );
      expect(
        unionEndFace(after.bodyRepresentations[bodyId]!).geometry!.center.x
      ).toBeCloseTo(35.59, 7);
      expect(
        listFeaturesInOrder(reopened).filter((f) => f.featureKind === 'fillet')
      ).toHaveLength(1);
    } finally {
      fresh.dispose();
    }
  });

  it('keeps explicit local offsets on the local move route', () => {
    const { document, bodyId, body } = model;
    const face = unionEndFace(body);
    expect(
      planFaceOffset({
        document,
        bodyId,
        face,
        faceHash: face.hash,
        offset: 1,
        localOnly: true
      })?.kind
    ).toBe('direct-edit');
  });
});
