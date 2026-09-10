import { expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  setParameter
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

it('replays an exact identity at the source value and refuses unsupported parameter states', async () => {
  const adapter = await createExactKernelAdapter();
  let document = createProjectDocument(
    'Conditional boolean',
    toUserId('user_condition')
  );
  document = addPrimitiveFeature(document, {
    name: 'Source',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  const source = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Tool',
    primitiveKind: 'box',
    dimensions: { width: 2, height: 2, depth: 2 }
  });
  const tool = document.bodyOrder.at(-1)!;
  document = setParameter(document, {
    name: 'opening_width',
    expression: '46'
  });
  const result = booleanBodies(document, {
    name: 'Conditional cut',
    operation: 'subtract',
    targetBodyIds: [source, tool],
    activeWhen: 'require_one_of(opening_width,46,50)-46'
  });
  document = result.document;
  try {
    for (const [width, volume] of [
      [46, 1000],
      [50, 992],
      [46, 1000]
    ]) {
      document = setParameter(document, {
        name: 'opening_width',
        expression: String(width)
      });
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      expect(derived.bodyRepresentations[result.bodyId]?.volume).toBeCloseTo(
        volume!,
        6
      );
      expect(derived.exportableBodyIds).toEqual([result.bodyId]);
    }
    const refused = await adapter.syncDocument(
      setParameter(document, { name: 'opening_width', expression: '48' })
    );
    expect(
      refused.warnings.some((w) => w.includes('supported values: 46, 50'))
    ).toBe(true);
    expect(refused.bodyRepresentations[result.bodyId]).toBeUndefined();
    expect(refused.bodyRepresentations[source]?.consumed).toBe(false);
  } finally {
    adapter.dispose();
  }
}, 60_000);
