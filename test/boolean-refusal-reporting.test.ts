import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * What a user sees when the exact pipeline will not do their boolean.
 *
 * Remus's plain booleans became exact-only: rather than returning a silently
 * tessellated approximation they refuse, and they refuse by throwing kernel
 * prose — "exact-only policy: the exact boolean pipeline could not produce
 * this result and the approximate fallback was declined". Propagated as-is
 * that reaches the feature panel as engine noise, which is indistinguishable
 * to a user from the product being broken.
 *
 * Two offset unit spheres are the proven curved-curved case the exact
 * pipeline declines. This pins what the refusal reads as, and — more
 * importantly — that the kernel's own taxonomy travels with it so nothing
 * downstream has to match on the sentence.
 */
describe('a union the exact pipeline cannot build', () => {
  let adapter: ExactKernelAdapter | undefined;

  it('refuses by name, with the kernel category attached', async () => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Spheres', toUserId('user_boolean'));
    document = addPrimitiveFeature(document, {
      name: 'Ball',
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const first = document.bodyOrder.at(-1)!;
    document = addPrimitiveFeature(document, {
      name: 'Ball 2',
      primitiveKind: 'sphere',
      dimensions: { radius: 1 }
    });
    const second = document.bodyOrder.at(-1)!;
    document = transformBody(document, {
      name: 'Offset the second ball',
      targetBodyId: second,
      translation: { x: 0.5, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const offsetBody = document.bodyOrder.at(-1)!;
    const manager = new CommandManager(document);
    const united = manager.execute(
      commandFactories.booleanBodies({
        name: 'Weld',
        operation: 'union',
        targetBodyIds: [first, offsetBody]
      })
    );

    const derived = await adapter.syncDocument(united);
    const refusal = derived.featureWarnings?.find((entry) =>
      entry.featureName.startsWith('Weld')
    );
    expect(refusal).toBeDefined();

    // Plain language: the operation that refused, the bodies it refused on,
    // and what could not be done. Not a stack trace, and not "kernel failed".
    const sentence = refusal!.message.split('\n')[0]!;
    expect(sentence).toContain('Union refused');
    expect(sentence).toContain('could not be combined exactly');
    expect(sentence).not.toContain('exact-only policy');

    // The kernel's taxonomy rides along, so a caller that wants to treat
    // "the engine declined this pair" differently from "the input was
    // invalid" never has to read the English.
    expect(refusal!.exactBooleanRefusal).toEqual({
      operation: 'fuse',
      category: 'quality_refused',
      code: 'exact_only_unattainable'
    });

    // The refusal costs the user nothing: their two bodies are still there.
    expect(derived.bodyRepresentations[first]?.consumed).toBe(false);
    expect(derived.bodyRepresentations[offsetBody]?.consumed).toBe(false);
  }, 120_000);

  it('builds the ordinary box-minus-cylinder subtract unchanged', async () => {
    adapter ??= await createExactKernelAdapter();
    let document = createProjectDocument('Plate', toUserId('user_boolean'));
    document = addPrimitiveFeature(document, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 60, height: 18, depth: 24 }
    });
    const plate = document.bodyOrder.at(-1)!;
    document = addPrimitiveFeature(document, {
      name: 'Bore',
      primitiveKind: 'cylinder',
      dimensions: { radius: 6, height: 28 }
    });
    const bore = document.bodyOrder.at(-1)!;
    document = transformBody(document, {
      name: 'Place the bore',
      targetBodyId: bore,
      translation: { x: 30, y: 9, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const placedBore = document.bodyOrder.at(-1)!;
    const manager = new CommandManager(document);
    const drilled = manager.execute(
      commandFactories.booleanBodies({
        name: 'Drill',
        operation: 'subtract',
        targetBodyIds: [plate, placedBore]
      })
    );

    const derived = await adapter.syncDocument(drilled);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[drilled.bodyOrder.at(-1)!]!;
    expect(body.volume).toBeCloseTo(60 * 18 * 24 - Math.PI * 36 * 24, 1);
    expect(
      (body.topology?.faces ?? []).some(
        (face) => face.geometry?.surfaceType === 'cylinder'
      )
    ).toBe(true);
  }, 120_000);
});
