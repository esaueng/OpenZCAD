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
 * A cut that removes too little, on a kernel that reports success.
 *
 * BrepKit 3.0.1 repairs most of the historical cross-drilled-shaft family,
 * but the r=2.5 bore still returns a result that adds 1.12 mm³ even though an
 * exact intersect proves 2.27 mm³ of positive-volume overlap. The result is
 * structurally acceptable, so the overlap/removal contract is the only
 * witness that the confirmed subtract did not take.
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

describe('a cut that does not take fails closed', { timeout: 120_000 }, () => {
  it('refuses the cross-drilled shaft with measured overlap and removal', async () => {
    const { derived, resultBodyId, shaftBodyId, toolBodyId } =
      await crossDrill(2.5);
    expect(derived.warnings).toEqual([
      'Feature "Drilled": Subtract refused: the tool overlaps the target by 2.27475 mm³, but the kernel removed -1.121515 mm³; the accepted minimum is 1.137375 mm³ (50% of measured overlap). The target and tools were left unchanged.'
    ]);
    expect(derived.bodyRepresentations[resultBodyId]).toBeUndefined();
    expect(derived.bodyRepresentations[shaftBodyId]?.consumed).toBe(false);
    expect(derived.bodyRepresentations[toolBodyId]?.consumed).toBe(false);
    expect(derived.exportableBodyIds).toEqual(
      expect.arrayContaining([shaftBodyId, toolBodyId])
    );
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
});
