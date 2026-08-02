import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * A body with a fully enclosed void reports its volume as if it were solid.
 *
 * This is a PRODUCT-level pin, not a kernel one: it goes through
 * `syncDocument`, so it measures what a user is actually shown. Hollowing a
 * part is a core CAD workflow, and today the number that comes back is the
 * un-hollowed volume with **no warning attached**.
 *
 * The kernel side: `kernel.volume(solid, tol)` ignores inner shells, while
 * `massProperties` gets the same body right to 1.2e-9. The adapter reads
 * `kernel.volume` for every body it reports, so the wrong route is the one
 * that reaches the UI.
 *
 * Do NOT "fix" this by switching the adapter to `massProperties`. That route
 * has its own open defects — a quadric sector wider than pi reads as its own
 * complement (4.3% light), and a trimmed torus face reads 2-12% low. Neither
 * route is trustworthy everywhere; the kernel has to be fixed and the choice
 * of route should follow that, not lead it.
 *
 * These are `it.fails` deliberately. They assert what SHOULD be true, so the
 * day the kernel stops ignoring inner shells they turn red — which is the
 * signal to delete the `.fails` and keep the assertion, rather than a signal
 * that something broke.
 */
describe('a body with an enclosed void', () => {
  let adapter: ExactKernelAdapter;

  const hollowCylinder = async () => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument(
      'Hollow cylinder',
      toUserId('user_hollow')
    );
    document = addPrimitiveFeature(document, {
      name: 'Outer',
      primitiveKind: 'cylinder',
      dimensions: { radius: 10, height: 20 }
    });
    const outerId = document.bodyOrder.at(-1)!;
    document = addPrimitiveFeature(document, {
      name: 'Cavity',
      primitiveKind: 'cylinder',
      dimensions: { radius: 4, height: 8 }
    });
    const cavityId = document.bodyOrder.at(-1)!;
    // z 6..14 inside an outer spanning 0..20, so the cavity touches nothing
    // and the result genuinely has two shells rather than a through bore.
    document = transformBody(document, {
      name: 'Seat the cavity fully inside',
      targetBodyId: cavityId,
      translation: { x: 0, y: 0, z: 6 }
    }).document;
    document = booleanBodies(document, {
      name: 'Hollowed',
      operation: 'subtract',
      targetBodyIds: [outerId, cavityId]
    }).document;
    const derived = await adapter.syncDocument(document);
    return {
      derived,
      body: derived.bodyRepresentations[document.bodyOrder.at(-1)!]
    };
  };

  /** pi*10^2*20 - pi*4^2*8, computed here rather than read from the kernel. */
  const CLOSED_FORM = Math.PI * 100 * 20 - Math.PI * 16 * 8;
  /** What the un-hollowed cylinder measures, i.e. the wrong answer today. */
  const AS_IF_SOLID = Math.PI * 100 * 20;

  it.fails('reports the hollow volume rather than the solid one', async () => {
    const { body } = await hollowCylinder();
    expect(body).toBeDefined();
    expect(
      Math.abs(body!.volume - CLOSED_FORM) / CLOSED_FORM
    ).toBeLessThan(1e-6);
  });

  it('measures exactly the un-hollowed volume today, and says nothing', async () => {
    // The companion to the pin above: it records the specific wrong value,
    // so a change that merely perturbs it is distinguishable from one that
    // fixes it. 6283.185307179587 is not approximately the solid cylinder --
    // it IS the solid cylinder, which is what makes this a dropped shell
    // rather than an integration error.
    const { body, derived } = await hollowCylinder();
    expect(body).toBeDefined();
    expect(body!.volume).toBeCloseTo(AS_IF_SOLID, 9);
    expect(body!.volume / CLOSED_FORM - 1).toBeGreaterThan(0.068);
    // And the part that makes it dangerous rather than merely wrong.
    expect(derived.warnings).toEqual([]);
  });
});
