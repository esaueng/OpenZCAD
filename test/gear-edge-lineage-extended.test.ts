import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  gearBody,
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
  type DerivedState
} from '@openzcad/shared';
import { expectPassedThrough } from './support/failed-pass-through';
import {
  between,
  edgeNamed,
  expectRimBlend,
  modifyEdge,
  teethOnBoss
} from './support/gear-edge-fixtures';

/**
 * M14 gear edge names beyond the cap rim (`gear-edge-lineage.test.ts`): the
 * shoulder's rim on its collar, a shoulder's edge at one tooth space, a
 * whole-face gear's bore rim and a tooth's own edge.
 *
 * The kernel decides which of these edges it can blend. On this pin it
 * rounds the shoulder's rim but refuses to chamfer it ("Closed rim edges …
 * could not be chamfered on this body"); at a tooth space of a split
 * shoulder it builds an approximate fillet and no chamfer; at a tooth tip it
 * builds an approximate fillet on some teeth and spans and refuses others;
 * and a cap's edge at one tooth it blends neither way. So those cases are
 * fillets here. The refusals are geometric: the edge is found by name
 * either way, which the tooth-tip case checks directly.
 */

/** The fillet's one advisory where its surface is a fitted spline. */
const APPROXIMATE = /This fillet is approximate/;

/** The modifier built, with at most the approximate-surface advisory. */
function expectBuilt(derived: DerivedState, step: string): void {
  for (const warning of derived.featureWarnings ?? []) {
    expect(warning.kind, `${step}: ${warning.message}`).toBe('advisory');
    expect(warning.message, step).toMatch(APPROXIMATE);
  }
}

describe('edge modifiers on gear shoulders, bores and teeth (M14)', {
  timeout: 900_000
}, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 60_000);

  afterAll(() => adapter.dispose());

  it.each(['start', 'end'] as const)(
    'keeps a fillet on the shoulder’s rim through span, offset, tooth-count and height edits, teeth anchored at the %s',
    async (anchor) => {
      // Ø14.4 tips under the Ø22 collar leave a shoulder wide enough to
      // round.
      const gear = await teethOnBoss(adapter, {
        fit: 'module',
        pitch: 0.8,
        teeth: 18,
        faceWidth: 6,
        offset: 3,
        ...(anchor === 'end' ? { anchor } : {})
      });
      // Where the lower collar ends at the teeth: 3 up either way.
      const rim = edgeNamed(gear.body, between('collar.start', 'shoulder.start'));
      const size = 0.3;
      const modified = modifyEdge('fillet', gear.document, gear.bodyId, rim, size);
      let document = modified.document;
      const ids = { gear: gear.bodyId, modified: modified.bodyId };
      const blend = {
        kind: 'fillet' as const,
        radius: 11,
        size,
        side: 'outer' as const
      };
      expectRimBlend(await adapter.syncDocument(document), 'as built', ids, {
        ...blend,
        z: 3
      });
      // The shoulder's height after each edit: the offset from the start,
      // or what the length and the offset leave below teeth from the end.
      for (const [step, featureId, data, fromStart, fromEnd] of [
        ['shorter teeth', gear.gearId, { faceWidth: 4 }, 3, 5],
        ['another offset', gear.gearId, { offset: 2 }, 2, 6],
        ['more teeth', gear.gearId, { teeth: 20 }, 2, 6],
        ['a taller blank', gear.blankId, { dimensions: { height: 14 } }, 2, 8]
      ] as const) {
        document = updateFeature(document, { featureId, data });
        expectRimBlend(await adapter.syncDocument(document), step, ids, {
          ...blend,
          z: anchor === 'end' ? fromEnd : fromStart
        });
      }
    }
  );

  it.each([
    ['start', { faceWidth: 4 }],
    ['end', { offset: 2 }]
  ] as const)(
    'keeps a fillet at one tooth space of a split shoulder through a span and a tooth-count edit, teeth anchored at the %s',
    async (anchor, span) => {
      // Keep-diameter teeth: the tips stand on the collars and split each
      // shoulder per tooth space, `shoulder.end[k]` beside `root[k]`.
      const gear = await teethOnBoss(adapter, {
        faceWidth: 6,
        offset: 3,
        ...(anchor === 'end' ? { anchor } : {})
      });
      const corner = edgeNamed(gear.body, between('root[3]', 'shoulder.end[3]'));
      const modified = modifyEdge(
        'fillet',
        gear.document,
        gear.bodyId,
        corner,
        0.1
      );
      let document = modified.document;
      const check = async (step: string) => {
        const derived = await adapter.syncDocument(document);
        expectBuilt(derived, step);
        // An inside corner: the fillet adds a sliver and its blend faces.
        const before = derived.bodyRepresentations[gear.bodyId]!;
        const after = derived.bodyRepresentations[modified.bodyId]!;
        const added = after.volume - before.volume;
        expect(added, step).toBeGreaterThan(1e-4);
        expect(added, step).toBeLessThan(0.05);
        expect(after.faceCount, step).toBeGreaterThan(before.faceCount);
      };
      await check('as built');
      for (const [step, data] of [
        ['a span edit', span],
        ['fewer teeth', { teeth: 18 }]
      ] as const) {
        document = updateFeature(document, { featureId: gear.gearId, data });
        await check(step);
      }
    }
  );

  it.each(['fillet', 'chamfer'] as const)(
    'keeps a %s on a whole-face gear’s bore rim through tooth-count, module, face-width and bore edits',
    async (kind) => {
      const gear = gearBody(
        createProjectDocument('Gear', toUserId('user_gear_edges')),
        {
          name: 'Gear 1',
          gearType: 'external',
          sizing: 'module',
          pitch: 2,
          teeth: 20,
          faceWidth: 5,
          boreDiameter: 8,
          origin: { x: 0, y: 0, z: 0 },
          axis: { x: 0, y: 0, z: 1 }
        }
      );
      const body = (await adapter.syncDocument(gear.document))
        .bodyRepresentations[gear.bodyId]!;
      const rim = edgeNamed(body, between('bore', 'cap.start'));
      const size = 0.5;
      const modified = modifyEdge(kind, gear.document, gear.bodyId, rim, size);
      let document = modified.document;
      const gearId = listFeaturesInOrder(document).find(
        (feature) => feature.data.featureKind === 'gear'
      )!.featureId;
      const ids = { gear: gear.bodyId, modified: modified.bodyId };
      const blend = { kind, size, side: 'inner' as const, z: 0 };
      expectRimBlend(await adapter.syncDocument(document), 'as built', ids, {
        ...blend,
        radius: 4
      });
      for (const [step, data, radius] of [
        ['more teeth', { teeth: 24 }, 4],
        ['a coarser module', { pitch: 2.5 }, 4],
        // What a drag of the gear's far cap stores.
        ['a wider face', { faceWidth: 8 }, 4],
        ['a larger bore', { boreDiameter: 10 }, 5]
      ] as const) {
        document = updateFeature(document, { featureId: gearId, data });
        expectRimBlend(await adapter.syncDocument(document), step, ids, {
          ...blend,
          radius
        });
      }
    }
  );

  it('finds a tooth’s tip edge by its tooth from whole-face teeth to part of the face and back, and refuses once that tooth is gone', async () => {
    const gear = await teethOnBoss(adapter, {});
    // The last of the 20 teeth: its edge between a flank and the tip land.
    const name = between('tooth[19].flank.minus', 'tooth[19].tip');
    const modified = modifyEdge(
      'fillet',
      gear.document,
      gear.bodyId,
      edgeNamed(gear.body, name),
      0.1
    );
    let document = modified.document;
    const ids: { gear: BodyId; modified: BodyId } = {
      gear: gear.bodyId,
      modified: modified.bodyId
    };
    // Whether the kernel can round a tooth tip depends on the tooth and the
    // span (it builds some as an approximate fillet and refuses others as
    // geometry it cannot trim). What the edge's name decides is that the
    // fillet is asked for on this edge: it builds, or the kernel refuses the
    // blend itself, and the reference is never reported lost.
    const resolved = async (step: string): Promise<boolean> => {
      const derived = await adapter.syncDocument(document);
      const failure = (derived.featureWarnings ?? []).find(
        (warning) => warning.kind === 'build-failed'
      );
      if (failure) {
        expect(failure.featureName, step).toBe('Edge break');
        expect(failure.kernelRefusal?.code, step).not.toBe('reference_missing');
        expect(failure.message, step).toMatch(
          /Fillet could not be created on 1 selected edge/
        );
        expect(failure.message, step).not.toMatch(/stale|no longer exists/);
        return false;
      }
      expectBuilt(derived, step);
      // An outside edge: the fillet takes a sliver off the tooth.
      const removed =
        derived.bodyRepresentations[ids.gear]!.volume -
        derived.bodyRepresentations[ids.modified]!.volume;
      expect(removed, step).toBeGreaterThan(1e-3);
      expect(removed, step).toBeLessThan(0.5);
      return true;
    };
    expect(await resolved('whole face')).toBe(true);
    document = updateFeature(document, {
      featureId: gear.gearId,
      data: { faceWidth: 6, offset: 3 }
    });
    await resolved('part of the face');
    document = updateFeature(document, {
      featureId: gear.gearId,
      clearData: ['faceWidth', 'offset']
    });
    expect(await resolved('whole face again')).toBe(true);
    // 18 teeth are `tooth[0]`…`tooth[17]`: the edge named is no longer
    // there, and the fillet does not move to a tooth that is.
    document = updateFeature(document, {
      featureId: gear.gearId,
      data: { teeth: 18 }
    });
    const derived = await adapter.syncDocument(document);
    const refusal = derived.featureWarnings!.find(
      (warning) => warning.kind === 'build-failed'
    );
    expect(refusal?.featureName).toBe('Edge break');
    expect(refusal?.kernelRefusal?.code).toBe('reference_missing');
    expect(refusal?.message).toMatch(
      /Edge modifier edge is stale: The selected edge lineage no longer exists\./
    );
    expectPassedThrough(derived, ids.modified, ids.gear);
    expect(
      derived.bodyRepresentations[ids.gear]!.topology!.edges.map(
        (edge) => edge.reference?.lineageName
      )
    ).not.toContain(name);
    // The tooth back: the same reference finds its edge.
    document = updateFeature(document, {
      featureId: gear.gearId,
      data: { teeth: 22 }
    });
    await resolved('22 teeth');
  });
});
