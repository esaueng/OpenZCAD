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
 * A body with a fully enclosed void reports the volume of the material that
 * is actually there.
 *
 * PRODUCT-level, not kernel: everything goes through `syncDocument`, so this
 * is the number a user is shown. Hollowing a part is a core CAD workflow.
 *
 * HISTORY, kept because it explains the shape of these assertions. This file
 * was written as a pair of pins while the defect was live: the app reported
 * 6283.185307179587 for this body, which is not approximately the solid
 * cylinder — it IS the solid cylinder, exactly. That is what identified it as
 * a dropped shell rather than an integration error.
 *
 * brepkit#61 fixed it. `try_analytic_solid_volume` is the FIRST rung of
 * `solid_volume`'s fast-path ladder and read its face list from
 * `solid.outer_shell()` alone, so a cavity carried as an INNER shell was
 * invisible and the outer wall still matched the primitive recogniser. Four
 * further paths shared the blindness. The recogniser now refuses outright
 * when an inner shell is present, since its closed forms cannot describe a
 * cavity.
 *
 * That PR also corrected the scope this was filed under. It is NOT "any
 * shelled or hollowed part" — only bodies whose OUTER SHELL ALONE is a
 * recognisable primitive were ever affected. A hollowed box never matched the
 * recogniser and was always correct, which is why the box control below is a
 * control and not a second pin.
 *
 * Every expectation here is a closed form written out in this file.
 * `mass_properties` is never used as the reference: it shares
 * `integrate_face` with `solid_volume`, so their agreement is structurally
 * blind and has hidden real errors on this project.
 */
describe('a body with an enclosed void', () => {
  let adapter: ExactKernelAdapter;

  /** Outer cylinder r10 h20, cavity r4 h8 seated fully inside it. */
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

  /** A 20-box with an 8x8x8 box void seated fully inside — the control. */
  const hollowBox = async () => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Hollow box', toUserId('user_hollow'));
    document = addPrimitiveFeature(document, {
      name: 'Outer',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 20 }
    });
    const outerId = document.bodyOrder.at(-1)!;
    document = addPrimitiveFeature(document, {
      name: 'Cavity',
      primitiveKind: 'box',
      dimensions: { width: 8, height: 8, depth: 8 }
    });
    const cavityId = document.bodyOrder.at(-1)!;
    // Boxes are built corner-at-origin, so an untranslated cavity would share
    // the outer box's corner and open through three faces instead of being
    // enclosed. 6..14 on every axis inside 0..20 keeps it a true cavity.
    //
    // The cavity is a BOX rather than a cylinder deliberately: every face
    // here is planar, so nothing is tessellated and the closed form is exact.
    // A cylindrical cavity reads 3.0e-5 high instead, which is the inscribed
    // mesh, not a defect -- brepkit#61 records the same residual class, since
    // the recogniser now refuses on an inner shell and defers to a mesh path.
    document = transformBody(document, {
      name: 'Seat the cavity fully inside',
      targetBodyId: cavityId,
      translation: { x: 6, y: 6, z: 6 }
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
  /** What the un-hollowed cylinder measures — the answer this used to give. */
  const AS_IF_SOLID = Math.PI * 100 * 20;

  it('reports the hollow volume rather than the solid one', async () => {
    const { body } = await hollowCylinder();
    expect(body).toBeDefined();
    expect(Math.abs(body!.volume - CLOSED_FORM) / CLOSED_FORM).toBeLessThan(
      1e-6
    );
  });

  it('lands on the closed form exactly, not merely near it', async () => {
    // The companion to the pin above. It used to record the specific WRONG
    // value so that a change which merely perturbed it stayed distinguishable
    // from one that fixed it. It now records the specific RIGHT value, for
    // the same reason in the other direction: 5881.061447520093 is the closed
    // form to the last digit, so a future regression that lands "close" is
    // still caught here.
    const { body, derived } = await hollowCylinder();
    expect(body).toBeDefined();
    expect(body!.volume).toBeCloseTo(5881.061447520093, 9);
    // And it is emphatically no longer the un-hollowed cylinder. The old
    // reading was 6283.185307179587, over by exactly the cavity.
    expect(AS_IF_SOLID - body!.volume).toBeCloseTo(Math.PI * 16 * 8, 9);
    expect(derived.warnings).toEqual([]);
  });

  it('leaves a hollowed box alone, which was always correct', async () => {
    // The scope control. brepkit#61 established that only bodies whose outer
    // shell alone is a recognisable primitive were ever affected, so this one
    // measured correctly before the fix as well. If it ever moves, the fix
    // has reached further than it was supposed to.
    const { body, derived } = await hollowBox();
    expect(body).toBeDefined();
    const expected = 8000 - 512;
    expect(Math.abs(body!.volume - expected) / expected).toBeLessThan(1e-6);
    expect(derived.warnings).toEqual([]);
  });
});
