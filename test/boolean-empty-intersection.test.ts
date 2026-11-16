import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  listNodesByKind,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import type {
  DerivedState,
  FeatureId,
  ProjectDocument
} from '@openzcad/shared';

/**
 * An Intersect of bodies that share no volume. The kernel answers it with an
 * empty solid instead of a refusal, and measuring that solid threw an untyped
 * "solid has no vertices" out of the whole document sync. Found by the K10
 * matrix (box × sphere sliver, source-shrink) once Remus 1.142 built the
 * sliver intersect it used to refuse; reachable on every pin.
 */

type PrimitiveInput = Parameters<typeof addPrimitiveFeature>[1];

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

const EXPECTED_SENTENCE =
  'Intersect refused: "Box 1 Body" and "Tool Body" do not overlap, so ' +
  'nothing would be left. Move the bodies so they overlap, then try again.';

function intersectDocument(
  tool: PrimitiveInput,
  translation: { x: number; y: number; z: number }
): { document: ProjectDocument; toolFeatureId: FeatureId } {
  let document = addPrimitiveFeature(
    createProjectDocument('Empty intersect', toUserId('user_empty_intersect')),
    {
      name: 'Box 1',
      primitiveKind: 'box',
      dimensions: { width: 60, height: 60, depth: 20 }
    }
  );
  const box = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, tool);
  const toolFeatureId = listNodesByKind(document, 'feature').at(-1)!.featureId;
  const moved = transformBody(document, {
    name: 'Place tool',
    targetBodyId: document.bodyOrder.at(-1)!,
    translation
  });
  const intersected = booleanBodies(moved.document, {
    name: 'Intersect',
    operation: 'intersect',
    targetBodyIds: [box, moved.bodyId]
  });
  return { document: intersected.document, toolFeatureId };
}

function expectTypedEmptyRefusal(derived: DerivedState): void {
  const warning = (derived.featureWarnings ?? []).find(
    (candidate) => candidate.featureName === 'Intersect'
  );
  expect(warning, 'the Intersect feature warns').toBeDefined();
  expect(warning!.message).toContain(EXPECTED_SENTENCE);
  expect(warning!.kernelRefusal).toMatchObject({
    family: 'boolean',
    category: 'invalid_input',
    code: 'empty_result'
  });
}

describe('an Intersect that leaves no material', () => {
  it.each<{
    label: string;
    tool: PrimitiveInput;
    at: { x: number; y: number; z: number };
  }>([
    {
      label: 'a sphere above the box',
      tool: {
        name: 'Tool',
        primitiveKind: 'sphere',
        dimensions: { radius: 10 }
      },
      at: { x: 30, y: 30, z: 31 }
    },
    {
      label: 'a box beside the box',
      tool: {
        name: 'Tool',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      },
      at: { x: 100, y: 0, z: 0 }
    }
  ])('refuses $label by name instead of throwing', async ({ tool, at }) => {
    const { document } = intersectDocument(tool, at);
    const derived = await adapter.syncDocument(document);
    expectTypedEmptyRefusal(derived);
  }, 120_000);

  it('refuses an edit that moves the tool out of contact', async () => {
    // Base-anchored or centred, a 30 mm cylinder at z = −10 overlaps the box
    // (z 0..20) and a 4 mm one clears it.
    const { document, toolFeatureId } = intersectDocument(
      {
        name: 'Tool',
        primitiveKind: 'cylinder',
        dimensions: { radius: 5, height: 30 }
      },
      { x: 30, y: 30, z: -10 }
    );
    const built = await adapter.syncDocument(document);
    expect(
      (built.featureWarnings ?? []).filter(
        (warning) => warning.featureName === 'Intersect'
      ),
      'the overlapping intersect builds'
    ).toEqual([]);

    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.updateFeature(
        {
          featureId: toolFeatureId,
          data: { dimensions: { radius: 5, height: 4 } }
        },
        'Shorten the tool'
      )
    );
    const edited = await adapter.syncDocument(manager.document);
    expectTypedEmptyRefusal(edited);
  }, 120_000);
});
