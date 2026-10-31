import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { listFeaturesInOrder, transformBody } from '@openzcad/document-core';
import type {
  BodyRepresentation,
  ParamValue,
  ProjectDocument
} from '@openzcad/shared';
import { gearHeightPreviewProfile } from '../apps/web/src/lib/interaction/gearHeightPreviewProfile';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { spurGearDocument } from './support/spur-gear';

describe('spur gear height preview', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;
  let body: BodyRepresentation;
  let document: ProjectDocument;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    document = await spurGearDocument();
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    document.derived = derived;
    body = derived.bodyRepresentations[document.bodyOrder.at(-1)!]!;
  });

  it.each([50, -10])(
    'matches the exact rebuilt height and volume for a %s mm drag',
    async (offset) => {
      const cap = body.topology!.faces.find(
        (f) => f.reference?.lineageName === 'gear.face.cap.end'
      )!;
      const profile = gearHeightPreviewProfile(document, body, cap)!;
      const plan = planFaceOffset({
        document,
        bodyId: body.bodyId,
        face: cap,
        faceHash: cap.hash,
        offset
      })!;
      expect(plan.kind).toBe('primitive-dimension');
      const after = await adapter.syncDocument(plan.command.apply(document));
      expect(after.warnings).toEqual([]);
      const exact = after.bodyRepresentations[body.bodyId]!;
      expect(exact.bbox.min.z).toBeCloseTo(profile.axisStart.z, 4);
      expect(exact.bbox.max.z).toBeCloseTo(profile.axisEnd.z + offset, 4);
      expect(exact.volume / body.volume).toBeCloseTo((26 + offset) / 26, 4);
    }
  );

  it.each([15, '10 + 5', 'unknown_angle'] satisfies ParamValue[])(
    'declines a nonzero or unresolved helix (%s)',
    (helixAngleDeg) => {
      const gear = listFeaturesInOrder(document).find(
        (f) => f.data.featureKind === 'gear'
      )!;
      if (gear.data.featureKind !== 'gear') throw new Error('Missing gear');
      const changed: ProjectDocument = {
        ...document,
        nodes: {
          ...document.nodes,
          [gear.id]: { ...gear, data: { ...gear.data, helixAngleDeg } }
        }
      };
      const cap = body.topology!.faces.find(
        (f) => f.reference?.lineageName === 'gear.face.cap.end'
      )!;
      expect(gearHeightPreviewProfile(changed, body, cap)).toBeNull();
    }
  );

  it('declines a cap without the current lineage and primitive ancestry', () => {
    const cap = body.topology!.faces.find(
      (f) => f.reference?.lineageName === 'gear.face.cap.end'
    )!;
    const stale = { ...cap, hash: cap.hash + 1 };
    const changed = {
      ...body,
      topology: {
        ...body.topology!,
        faces: body.topology!.faces.map((f) => (f === cap ? stale : f))
      }
    };
    expect(gearHeightPreviewProfile(document, changed, stale)).toBeNull();
  });

  it('declines a transformed gear when its cap lineage is unavailable', async () => {
    const transformed = transformBody(document, {
      name: 'Pose gear',
      targetBodyId: body.bodyId,
      translation: { x: 120, y: -30, z: 8 },
      rotationDeg: { x: 0, y: 90, z: 0 },
      scale: 2
    }).document;
    const derived = await adapter.syncDocument(transformed);
    expect(derived.warnings).toEqual([]);
    const posed = derived.bodyRepresentations[body.bodyId]!;
    const cap = posed.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' && face.geometry.normal!.x > 0.99
    )!;
    expect(cap).toBeDefined();
    expect(gearHeightPreviewProfile(transformed, posed, cap)).toBeNull();
  });
  afterAll(() => adapter.dispose());
  it.each([1, -1])('recognizes the gear cap facing %s', (sense) => {
    const cap = body.topology!.faces.find(
      (f) =>
        f.geometry?.surfaceType === 'plane' &&
        f.geometry.normal!.z * sense > 0.99
    )!;
    const profile = gearHeightPreviewProfile(document, body, cap);
    expect(profile).not.toBeNull();
    expect(profile!.axisStart.z).toBeCloseTo(sense === 1 ? 0 : 26, 4);
    expect(profile!.axisEnd.z).toBeCloseTo(sense === 1 ? 26 : 0, 4);
  });
});
