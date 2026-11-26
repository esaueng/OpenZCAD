import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addSketchObjects, findSketch } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { frameForPlaneRef } from '@openzcad/geometry';
import type {
  BodyId,
  DerivedState,
  EdgeTopology,
  ProjectDocument,
  SketchProjectionMode,
  TopologySelection
} from '@openzcad/shared';
import {
  assertProjectionsResolve,
  projectionFromPick
} from '../apps/web/src/lib/sketch/projection';
import {
  BOSS_PLANE,
  VOLUMES,
  referenceEligibilityPart
} from './fixtures/reference-eligibility-part';

/**
 * S06 / I01: which references an earlier sketch may use, against the exact
 * kernel on the invented part the browser spec opens
 * (test/e2e/sketch-reference-eligibility.spec.ts). Boss profile comes
 * before Cap: a linked projection of Cap's face is refused at the sketch's
 * place in the history, naming Cap, and changes nothing; an unlinked copy of
 * the same face is legal; the slab's edge, which comes before the sketch,
 * projects linked and stays current through the rebuild.
 */

const basis = frameForPlaneRef(BOSS_PLANE, (value) => Number(value));

function midpoint(edge: EdgeTopology) {
  const n = edge.points.length;
  return {
    x: (edge.points[0]! + edge.points[n - 3]!) / 2,
    y: (edge.points[1]! + edge.points[n - 2]!) / 2,
    z: (edge.points[2]! + edge.points[n - 1]!) / 2
  };
}

function edgesOf(derived: DerivedState, bodyId: BodyId): EdgeTopology[] {
  return derived.bodyRepresentations[bodyId]?.topology?.edges ?? [];
}

/** Cap's top face (z = 20), the face a click above the slab's edge lands on. */
function capTopFace(derived: DerivedState, capBodyId: BodyId) {
  const top = edgesOf(derived, capBodyId).filter(
    (edge) => Math.abs(midpoint(edge).z - 20) < 1e-9
  );
  expect(top).toHaveLength(4);
  const [first, ...rest] = top.map((edge) => edge.adjacentFaceHashes ?? []);
  const hash = first!.find((candidate) =>
    rest.every((hashes) => hashes.includes(candidate))
  );
  expect(hash).toBeDefined();
  return { bodyId: capBodyId, kind: 'face', hash } as TopologySelection;
}

/** The slab's x = 20 top edge (z = 10), which Boss profile comes after. */
function slabEdge(derived: DerivedState, baseBodyId: BodyId) {
  const edge = edgesOf(derived, baseBodyId).find((candidate) => {
    const mid = midpoint(candidate);
    return (
      Math.abs(mid.x - 20) < 1e-9 &&
      Math.abs(mid.y) < 1e-9 &&
      Math.abs(mid.z - 10) < 1e-9
    );
  });
  expect(edge?.reference).toBeDefined();
  return {
    bodyId: baseBodyId,
    kind: 'edge',
    topologyId: edge!.topologyId
  } as TopologySelection;
}

describe('earlier-sketch reference eligibility (S06 / I01)', () => {
  let adapter: ExactKernelAdapter;
  let part: ReturnType<typeof referenceEligibilityPart>;
  let built: ProjectDocument;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    part = referenceEligibilityPart();
    built = {
      ...part.document,
      derived: await adapter.syncDocument(part.document)
    };
    expect(built.derived.featureWarnings ?? []).toEqual([]);
  }, 120_000);

  afterAll(() => adapter?.dispose());

  /** Adds the pick to Boss profile and rebuilds, as the browser's candidate. */
  async function candidate(
    selection: TopologySelection,
    mode: SketchProjectionMode
  ) {
    const sketch = findSketch(built, part.bossSketchId)!;
    const pick = projectionFromPick({
      document: built,
      sketch,
      selection,
      basis,
      mode,
      construction: true
    });
    const added = addSketchObjects(built, {
      sketchId: part.bossSketchId,
      objects: pick.objects
    });
    const derived = await adapter.syncDocument(added.document);
    return { pick, objectIds: added.objectNodeIds, derived };
  }

  it('builds the invented part', () => {
    const volumes = built.derived.bodyRepresentations;
    expect(volumes[part.baseBodyId]!.volume).toBeCloseTo(VOLUMES.base, 6);
    expect(volumes[part.bossBodyId]!.volume).toBeCloseTo(VOLUMES.boss, 6);
    expect(volumes[part.capBodyId]!.volume).toBeCloseTo(VOLUMES.cap, 6);
  });

  it('refuses a linked projection of the later face, naming the later feature', async () => {
    const face = capTopFace(built.derived, part.capBodyId);
    const { pick, objectIds, derived } = await candidate(face, 'linked');
    // The browser side builds the candidate: the refusal comes after the
    // pick, from the exact build at the sketch's place in history.
    expect(pick.objects).toHaveLength(4);
    for (const objectId of objectIds) {
      expect(derived.sketchProjections?.[objectId]).toEqual({
        status: 'broken',
        reason: `its source body is unavailable at the sketch's place in the history (source feature "Cap").`
      });
    }
    expect(() => assertProjectionsResolve(derived, objectIds)).toThrow(
      `Switch Project to Unlinked and pick again: "Cap" is after this sketch, so it can't stay linked.`
    );
  });

  it('copies the later face unlinked: a legal, independent reference', async () => {
    const face = capTopFace(built.derived, part.capBodyId);
    const { pick, objectIds, derived } = await candidate(face, 'unlinked');
    expect(pick.objects.map((object) => object.projection?.mode)).toEqual([
      'unlinked',
      'unlinked',
      'unlinked',
      'unlinked'
    ]);
    // An unlinked copy carries no build verdict and builds like drawn
    // construction geometry: nothing downstream moves.
    for (const objectId of objectIds)
      expect(derived.sketchProjections?.[objectId]).toBeUndefined();
    expect(derived.featureWarnings ?? []).toEqual([]);
    expect(derived.bodyRepresentations[part.bossBodyId]!.volume).toBeCloseTo(
      VOLUMES.boss,
      6
    );
  });

  it('projects the earlier slab edge linked and keeps it current through the rebuild', async () => {
    const edge = slabEdge(built.derived, part.baseBodyId);
    const { pick, objectIds, derived } = await candidate(edge, 'linked');
    expect(pick.objects).toHaveLength(1);
    expect(pick.objects[0]).toMatchObject({
      objectKind: 'line',
      construction: true,
      projection: { mode: 'linked' }
    });
    const line = pick.objects[0] as { x1: number; x2: number };
    expect(line.x1).toBeCloseTo(20, 9);
    expect(line.x2).toBeCloseTo(20, 9);
    expect(derived.sketchProjections?.[objectIds[0]!]).toEqual({
      status: 'current'
    });
    expect(() => assertProjectionsResolve(derived, objectIds)).not.toThrow();
    expect(derived.featureWarnings ?? []).toEqual([]);
    const volumes = derived.bodyRepresentations;
    expect(volumes[part.bossBodyId]!.volume).toBeCloseTo(VOLUMES.boss, 6);
    expect(volumes[part.capBodyId]!.volume).toBeCloseTo(VOLUMES.cap, 6);
  });

  // The later-body refusal says how to recover and why: the case above
  // shows an unlinked copy of the same face is legal, so the sentence leads
  // with the Project tool's Unlinked mode and names Cap. The refusal is
  // taken in a hook, so a setup error cannot pass as the sentence.
  describe('the later-face refusal', () => {
    let refusal: unknown;
    beforeAll(async () => {
      const face = capTopFace(built.derived, part.capBodyId);
      const { objectIds, derived } = await candidate(face, 'linked');
      try {
        assertProjectionsResolve(derived, objectIds);
      } catch (error) {
        refusal = error;
      }
    });

    it('refuses, naming the later feature', () => {
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain('"Cap"');
    });

    it('offers the unlinked route', () => {
      expect((refusal as Error).message).toBe(
        `Switch Project to Unlinked and pick again: "Cap" is after this sketch, so it can't stay linked.`
      );
    });
  });
});
