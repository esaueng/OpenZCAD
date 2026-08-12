import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type BodyId } from '@openzcad/shared';
import { createExactKernelAdapter } from '../packages/kernel-adapter/src/exact';

/**
 * The corrupting 061c1b2 kernel returned an undrilled shaft from this cut and
 * relied on the adapter's failed-cut guard to keep that corruption from being
 * silent. The vetted kernel restored by the rollback removes the bore again,
 * so the same operation must now stay warning-free and report the drilled
 * volume. The guard remains fail-closed if a future kernel regresses.
 */
const user = toUserId('user_failed_cut');

async function crossDrill(boreRadius: number) {
  let doc = addPrimitiveFeature(createProjectDocument('Drill', user), {
    name: 'Shaft',
    primitiveKind: 'cylinder',
    dimensions: { radius: 3, height: 30 }
  });
  const shaft = doc.bodyOrder[0] as BodyId;
  doc = addPrimitiveFeature(doc, {
    name: 'Bore',
    primitiveKind: 'cylinder',
    dimensions: { radius: boreRadius, height: 40 }
  });
  let bore = doc.bodyOrder[1] as BodyId;
  // Lay the bore across the shaft: rotate its axis onto Y, then centre it.
  const placed = transformBody(doc, {
    name: 'Place',
    targetBodyId: bore,
    translation: { x: 0, y: -20, z: 15 },
    rotationDeg: { x: -90, y: 0, z: 0 }
  });
  doc = placed.document;
  bore = placed.bodyId;
  const cut = booleanBodies(doc, {
    name: 'Drilled',
    operation: 'subtract',
    targetBodyIds: [shaft, bore]
  });
  const adapter = await createExactKernelAdapter();
  try {
    return {
      derived: await adapter.syncDocument(cut.document),
      resultBodyId: cut.bodyId,
      shaftBodyId: shaft,
      toolBodyId: bore
    };
  } finally {
    adapter.dispose();
  }
}

describe(
  'subtractive cut validation after the kernel rollback',
  { timeout: 120_000 },
  () => {
    it('stays quiet when the restored kernel removes the cross-drilled bore', async () => {
      const { derived, resultBodyId, shaftBodyId, toolBodyId } =
        await crossDrill(3);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[resultBodyId]?.volume).toBeCloseTo(
        704.23,
        1
      );
      expect(derived.bodyRepresentations[shaftBodyId]?.consumed).toBe(true);
      expect(derived.bodyRepresentations[toolBodyId]?.consumed).toBe(true);
      expect(derived.exportableBodyIds).toEqual([resultBodyId]);
    });

    it('keeps a valid multi-tool bore subtract unchanged', async () => {
      // The control, and the assertion that makes the one above mean something:
      // without it the guard would pass just as happily if it fired on every
      // subtract. Two disjoint bores also prove the existing sequential
      // multi-tool semantics still cut every tool from the evolving target.
      let doc = addPrimitiveFeature(createProjectDocument('Clean', user), {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 40, depth: 20 }
      });
      const block = doc.bodyOrder[0] as BodyId;
      doc = addPrimitiveFeature(doc, {
        name: 'Hole A',
        primitiveKind: 'cylinder',
        dimensions: { radius: 5, height: 40 }
      });
      const placedA = transformBody(doc, {
        name: 'Place A',
        targetBodyId: doc.bodyOrder[1] as BodyId,
        translation: { x: 12, y: 20, z: -10 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      });
      doc = addPrimitiveFeature(placedA.document, {
        name: 'Hole B',
        primitiveKind: 'cylinder',
        dimensions: { radius: 5, height: 40 }
      });
      const placedB = transformBody(doc, {
        name: 'Place B',
        targetBodyId: doc.bodyOrder.at(-1) as BodyId,
        translation: { x: 28, y: 20, z: -10 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      });
      const cut = booleanBodies(placedB.document, {
        name: 'Bored',
        operation: 'subtract',
        targetBodyIds: [block, placedA.bodyId, placedB.bodyId]
      });
      const adapter = await createExactKernelAdapter();
      try {
        const derived = await adapter.syncDocument(cut.document);
        expect(derived.warnings).toEqual([]);
        const body = derived.bodyRepresentations[cut.bodyId];
        // And both bores really cut: 40*40*20 less two full-depth r5 bores.
        expect(body?.volume).toBeCloseTo(32000 - 2 * Math.PI * 25 * 20, 1);
        expect(derived.exportableBodyIds).toEqual([cut.bodyId]);
      } finally {
        adapter.dispose();
      }
    });
  }
);
