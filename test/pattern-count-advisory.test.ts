import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  patternBody,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

/**
 * ZC-095: entry refuses a fractional pattern count, but a count expression
 * can still evaluate to one after a parameter edit. The build keeps the
 * rounding saved documents rely on and now says so instead of hiding it.
 */
describe('pattern count advisory (ZC-095)', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  function pattern(seats: string, count: string) {
    let document: ProjectDocument = createProjectDocument(
      'Pattern count',
      toUserId('user_pattern_count')
    );
    document = setParameter(document, { name: 'seats', expression: seats });
    document = addPrimitiveFeature(document, {
      name: 'Peg',
      primitiveKind: 'box',
      dimensions: { width: 2, height: 2, depth: 2 }
    });
    return patternBody(document, {
      name: 'Row',
      targetBodyId: document.bodyOrder[0]!,
      patternKind: 'linear',
      count,
      axis: 'x',
      spacing: 5
    });
  }

  it('rounds a fractional evaluated count and raises an advisory naming it', async () => {
    const row = pattern('5', 'seats / 2');
    const derived = await adapter.syncDocument(row.document);
    expect(derived.warnings).toEqual([
      'Feature "Row": Pattern count evaluates to 2.5, not a whole number; it was rounded to 3.'
    ]);
    expect(derived.featureWarnings).toContainEqual(
      expect.objectContaining({ featureName: 'Row', kind: 'advisory' })
    );
    // Rounded, as before: three pegs 5 apart.
    const bbox = derived.bodyRepresentations[row.bodyId]!.bbox;
    expect(bbox.max.x - bbox.min.x).toBeCloseTo(12, 6);
  });

  it('stays silent for a whole evaluated count', async () => {
    const row = pattern('6', 'seats / 2');
    const derived = await adapter.syncDocument(row.document);
    expect(derived.warnings).toEqual([]);
  });
});
