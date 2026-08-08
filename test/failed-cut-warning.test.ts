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
 * volume.
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
  }).document;
  const adapter = await createExactKernelAdapter();
  try {
    return await adapter.syncDocument(cut);
  } finally {
    adapter.dispose();
  }
}

describe('subtractive cuts after the kernel rollback', { timeout: 120_000 }, () => {
  it('stays quiet when the restored kernel removes the cross-drilled bore', async () => {
    const derived = await crossDrill(3);
    expect(derived.warnings).toEqual([]);
    const body = Object.values(derived.bodyRepresentations).find(
      (candidate) => !candidate.consumed
    );
    expect(body?.volume).toBeCloseTo(704.23, 1);
  });

  it('stays quiet for a cut that works', async () => {
    // The control, and the assertion that makes the one above mean something:
    // without it the guard would pass just as happily if it fired on every
    // subtract. A box with a bore well inside it cuts cleanly.
    let doc = addPrimitiveFeature(createProjectDocument('Clean', user), {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 40, depth: 20 }
    });
    const block = doc.bodyOrder[0] as BodyId;
    doc = addPrimitiveFeature(doc, {
      name: 'Hole',
      primitiveKind: 'cylinder',
      dimensions: { radius: 5, height: 40 }
    });
    let hole = doc.bodyOrder[1] as BodyId;
    const placed = transformBody(doc, {
      name: 'Place',
      targetBodyId: hole,
      translation: { x: 20, y: 20, z: -10 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    });
    doc = placed.document;
    hole = placed.bodyId;
    const cut = booleanBodies(doc, {
      name: 'Bored',
      operation: 'subtract',
      targetBodyIds: [block, hole]
    }).document;
    const adapter = await createExactKernelAdapter();
    try {
      const derived = await adapter.syncDocument(cut);
      expect(derived.warnings).toEqual([]);
      // And it really did cut: 40*40*20 less a full-depth r5 bore.
      const body = Object.values(derived.bodyRepresentations).find(
        (candidate) => !candidate.consumed
      );
      expect(body?.volume).toBeCloseTo(32000 - Math.PI * 25 * 20, 1);
    } finally {
      adapter.dispose();
    }
  });
});
