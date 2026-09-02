import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  directEditBody,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * Direct-edit pins versus lineage.
 *
 * A direct edit records the geometry of the face it was made on — radius,
 * axis, area — so that a hash-resolved face can be proven to be the one the
 * user picked. When the face resolves by lineage instead, identity is already
 * proven by role, and the same pins would refuse exactly the upstream edits
 * the feature exists to survive: a taller cylinder moves the wall's axis end,
 * a re-sized source changes its radius. These tests pin that a lineage-carried
 * `resize-cylindrical-face` follows such edits, and that the hash-only edit
 * still fails closed as it always has.
 */

const user = toUserId('user_lineage_pins');

function cylinderWall(body: BodyRepresentation | undefined) {
  return body?.topology?.faces.find(
    (face) => face.geometry?.surfaceType === 'cylinder'
  );
}

describe('resize-cylindrical-face under lineage', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  async function resizedCylinder(options: {
    withReference: boolean;
  }): Promise<{ document: ProjectDocument; bodyId: BodyId }> {
    const base = addPrimitiveFeature(createProjectDocument('Wall', user), {
      name: 'Cyl',
      primitiveKind: 'cylinder',
      dimensions: { radius: 4, height: 12 }
    });
    const bodyId = base.bodyOrder[0]!;
    const derived = await adapter.syncDocument(base);
    const wall = cylinderWall(derived.bodyRepresentations[bodyId]);
    expect(wall?.reference?.lineageName).toBe('primitive.cylinder.face.wall');
    const geometry = wall!.geometry!;
    const edited = directEditBody(base, {
      name: 'Set wall radius',
      targetBodyId: bodyId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: wall!.hash,
        ...(options.withReference ? { faceReference: wall!.reference } : {}),
        sourceRadius: geometry.radius!,
        sourceAxisStart: geometry.axisStart!,
        sourceAxisEnd: geometry.axisEnd!,
        concavity: 'boss',
        radius: 6
      }
    });
    const check = await adapter.syncDocument(edited.document);
    expect(check.warnings).toEqual([]);
    expect(check.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      Math.PI * 36 * 12,
      2
    );
    return { document: edited.document, bodyId };
  }

  function withDimensions(
    document: ProjectDocument,
    dimensions: Record<string, number>
  ) {
    const cylinder = listFeaturesInOrder(document).find(
      (feature) => feature.name === 'Cyl'
    )!;
    return updateFeature(document, {
      featureId: cylinder.featureId,
      data: { dimensions }
    });
  }

  it('follows a height change that moves the wall axis end', async () => {
    const { document, bodyId } = await resizedCylinder({ withReference: true });
    const after = await adapter.syncDocument(
      withDimensions(document, { height: 20 })
    );
    expect(after.warnings).toEqual([]);
    expect(after.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      Math.PI * 36 * 20,
      2
    );
  });

  it('follows a source radius change and still lands on the stored radius', async () => {
    const { document, bodyId } = await resizedCylinder({ withReference: true });
    const after = await adapter.syncDocument(
      withDimensions(document, { radius: 5 })
    );
    expect(after.warnings).toEqual([]);
    expect(after.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      Math.PI * 36 * 12,
      2
    );
  });

  it('is a quiet no-op when the source already reaches the stored radius', async () => {
    const { document, bodyId } = await resizedCylinder({ withReference: true });
    const after = await adapter.syncDocument(
      withDimensions(document, { radius: 6 })
    );
    expect(after.warnings).toEqual([]);
    expect(after.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      Math.PI * 36 * 12,
      2
    );
  });

  it('keeps a reference-free resize fail-closed after the same edits', async () => {
    const { document, bodyId } = await resizedCylinder({
      withReference: false
    });
    const after = await adapter.syncDocument(
      withDimensions(document, { height: 20 })
    );
    // The wall's fingerprint embeds its extent, so the hash stops resolving
    // before any recorded-geometry pin is reached; the edit contributes
    // nothing and the resized primitive stands alone.
    expect(after.warnings).toHaveLength(1);
    expect(after.warnings[0]).toMatch(/Set wall radius.*no longer/);
    expect(after.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      Math.PI * 16 * 20,
      2
    );
  });
});
