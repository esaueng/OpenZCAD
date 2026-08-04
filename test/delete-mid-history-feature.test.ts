import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  deleteFeature,
  filletEdges,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * Deleting a feature from the MIDDLE of the history either rebuilds correctly
 * or fails loudly. It never leaves a stale body standing.
 *
 * This pins behaviour that is currently CORRECT. That is deliberate, and the
 * reason is the failure mode rather than the defect rate: "fails loud" is
 * precisely the property that degrades to silence without anyone noticing. A
 * change that made a deleted operand leave its downstream boolean holding the
 * PREVIOUS result would produce a document that looks fine, measures fine, and
 * is quietly describing geometry the user deleted. Nothing else in the suite
 * would catch that.
 *
 * PRODUCT-level: everything goes through `syncDocument`, so these are the
 * volumes the UI prints and the warnings it shows. Every expectation is a
 * closed form written out here.
 *
 * The model throughout is two stacked boxes fused — 20^3 at the origin and
 * 10^3 sitting on top of it — so the history is `BoxA | BoxB | Stack | Fuse`
 * and every stage has an exact answer:
 *
 *   intact             8000, 1000, and 9000 for the fusion
 *   drop Stack         the union recomputes to 8000, because an untranslated
 *                      B is entirely INSIDE A (both are corner-at-origin)
 *   drop Fuse          the two operands remain, 8000 and 1000
 *   drop an operand    every dependent feature warns and produces no body
 *
 * The `drop Stack` row is the sharpest of these. It is the one case where a
 * cached result would be indistinguishable from a correct one at a glance:
 * the union still exists, still has a plausible volume, and only the NUMBER
 * says whether it was recomputed. 8000 means it re-fused; 9000 would mean it
 * handed back the answer from before the delete.
 */
describe('deleting a feature from the middle of the history', () => {
  let adapter: ExactKernelAdapter;

  /** `BoxA | BoxB | Stack | Fuse` — 8000 fused with 1000 stacked on top. */
  const fused = () => {
    let document = createProjectDocument('Fuse', toUserId('user_del'));
    document = addPrimitiveFeature(document, {
      name: 'BoxA',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 20 }
    });
    const a = document.bodyOrder.at(-1)!;
    document = addPrimitiveFeature(document, {
      name: 'BoxB',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const b = document.bodyOrder.at(-1)!;
    document = transformBody(document, {
      name: 'Stack',
      targetBodyId: b,
      translation: { x: 0, y: 0, z: 20 }
    }).document;
    document = booleanBodies(document, {
      name: 'Fuse',
      operation: 'union',
      targetBodyIds: [a, b]
    }).document;
    return document;
  };

  const drop = (
    document: ReturnType<typeof createProjectDocument>,
    name: string
  ) => {
    const feature = listFeaturesInOrder(document).find(
      (candidate) => (candidate as { name?: string }).name === name
    );
    expect(feature, `no feature named ${name}`).toBeTruthy();
    return deleteFeature(document, { featureId: feature!.featureId });
  };

  const read = async (document: ReturnType<typeof createProjectDocument>) => {
    adapter ??= await createExactKernelAdapter();
    const derived = await adapter.syncDocument(document);
    return {
      volumes: document.bodyOrder.map(
        (id) => derived.bodyRepresentations[id]?.volume
      ),
      warnings: derived.warnings
    };
  };

  it('fuses the two boxes before anything is deleted', async () => {
    const { volumes, warnings } = await read(fused());
    expect(volumes).toEqual([8000, 1000, 9000]);
    expect(warnings).toEqual([]);
  }, 120_000);

  it('RECOMPUTES the union when the transform under an operand goes', async () => {
    // The sharp one. Without the stack translation B sits entirely inside A,
    // so the union is 8000 — not the 9000 it was a moment ago. A cached
    // result would be indistinguishable except by this number.
    const { volumes, warnings } = await read(drop(fused(), 'Stack'));
    expect(volumes).toEqual([8000, 1000, 8000]);
    expect(warnings).toEqual([]);
  }, 120_000);

  it('leaves the operands alone when the boolean itself goes', async () => {
    const { volumes, warnings } = await read(drop(fused(), 'Fuse'));
    expect(volumes).toEqual([8000, 1000]);
    expect(warnings).toEqual([]);
  }, 120_000);

  it.each([
    ['BoxB', 8000, ['Stack', 'Fuse']],
    ['BoxA', 1000, ['Fuse']]
  ] as const)(
    'refuses loudly, not silently, when operand %s goes',
    async (dropped, survivingVolume, complainingFeatures) => {
      const { volumes, warnings } = await read(drop(fused(), dropped));
      // The surviving primitive still measures; the dependent body does not
      // exist at all, rather than existing with a stale volume.
      expect(volumes[0]).toBe(survivingVolume);
      expect(volumes.at(-1)).toBeUndefined();
      // And every feature that lost its input says so by name.
      for (const feature of complainingFeatures) {
        expect(warnings.join(' ')).toContain(`"${feature}"`);
      }
      expect(warnings.join(' ')).toMatch(/unavailable/);
    },
    120_000
  );

  describe('with a downstream fillet on the fused body', () => {
    const fusedAndFilleted = async () => {
      adapter ??= await createExactKernelAdapter();
      const document = fused();
      const target = document.bodyOrder.at(-1)!;
      const derived = await adapter.syncDocument(document);
      const edges = derived.bodyRepresentations[target]!.topology?.edges ?? [];
      // A vertical edge of the big box at (20, 20), far from the fused cap,
      // so the fillet is a plain 90 deg break on a straight edge of length 20.
      const edge = edges.find((candidate) => {
        const points = candidate.points;
        const n = points.length;
        const direction = [
          points[n - 3]! - points[0]!,
          points[n - 2]! - points[1]!,
          points[n - 1]! - points[2]!
        ].map(Math.abs);
        const isZ =
          direction[2]! > direction[0]! && direction[2]! > direction[1]!;
        return (
          isZ &&
          Math.abs((points[n - 3]! + points[0]!) / 2 - 20) < 1e-9 &&
          Math.abs((points[n - 2]! + points[1]!) / 2 - 20) < 1e-9
        );
      });
      expect(edge, 'no vertical edge at (20, 20)').toBeTruthy();
      return filletEdges(document, {
        name: 'Break',
        targetBodyId: target,
        edgeHashes: [edge!.hash],
        size: 2
      }).document;
    };

    /** r^2 (1 - pi/4) L, the prism a 90 deg fillet removes. */
    const CUT = 4 * (1 - Math.PI / 4) * 20;

    it('carries the fillet through the intact history', async () => {
      const { volumes, warnings } = await read(await fusedAndFilleted());
      expect(volumes.slice(0, 3)).toEqual([8000, 1000, 9000]);
      // The fillet does not land on the closed form — see
      // test/filleted-body-volume.test.ts, where that is pinned as its own
      // defect. What matters here is that it lands at ALL, and on the right
      // body, so this asserts the neighbourhood rather than the exact value.
      expect(volumes[3]!).toBeGreaterThan(9000 - CUT - 0.1);
      expect(volumes[3]!).toBeLessThan(9000 - CUT + 0.1);
      expect(warnings).toEqual([]);
    }, 120_000);

    it('re-lands the fillet on the rebuilt body when the transform goes', async () => {
      // Every stage downstream recomputes: the union drops to 8000, and the
      // fillet finds its edge again on the rebuilt body rather than failing.
      // 7982.798 is the filleted-20-box reading, which is what says the
      // fillet landed on the SAME edge of a now-different body.
      const { volumes, warnings } = await read(
        drop(await fusedAndFilleted(), 'Stack')
      );
      expect(volumes.slice(0, 3)).toEqual([8000, 1000, 8000]);
      expect(volumes[3]!).toBeCloseTo(7982.79834915, 6);
      expect(warnings).toEqual([]);
    }, 120_000);

    it.each(['BoxB', 'Fuse'] as const)(
      'refuses the fillet loudly when %s goes',
      async (dropped) => {
        const { volumes, warnings } = await read(
          drop(await fusedAndFilleted(), dropped)
        );
        // No filleted body at all, and the fillet names itself in a warning.
        expect(volumes.at(-1)).toBeUndefined();
        expect(warnings.join(' ')).toContain('"Break"');
        expect(warnings.join(' ')).toMatch(/unavailable/);
      },
      120_000
    );
  });
});
