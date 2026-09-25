import { describe, expect, it, vi } from 'vitest';
import {
  attachDerivedState,
  createProjectDocument
} from '@openzcad/document-core';
import { toFeatureId, toUserId, type DerivedState } from '@openzcad/shared';
import { exactWarningBaseline, newExactWarnings } from './exactWarnings';

describe('warning attribution after document hydration', () => {
  const failure = (id: string) => ({
    featureId: toFeatureId(id),
    featureName: 'Round',
    kind: 'build-failed' as const,
    message: 'Feature "Round": missing edge'
  });
  it('rebuilds lost attribution without excusing a new failure with the same display text', async () => {
    const document = createProjectDocument(
      'Warning baseline',
      toUserId('local')
    );
    const derived: DerivedState = {
      ...document.derived,
      warnings: [failure('a').message],
      featureWarnings: [failure('a')]
    };
    const attached = attachDerivedState(document, derived);
    expect(attached.derived.featureWarnings).toBeUndefined();
    const derive = vi.fn().mockResolvedValue(derived);
    const base = await exactWarningBaseline(attached, derive);
    expect(derive).toHaveBeenCalledExactlyOnceWith(attached);
    expect(newExactWarnings(base, derived)).toEqual([]);
    expect(
      newExactWarnings(base, { ...derived, featureWarnings: [failure('b')] })
    ).toEqual([failure('b').message]);
    expect(
      newExactWarnings(base, {
        ...derived,
        featureWarnings: [failure('a'), failure('a')]
      })
    ).toHaveLength(1);
    expect(attached.derived.featureWarnings).toBeUndefined();
  });
  it('does not rebuild clean baselines or suppress a failed baseline check', async () => {
    const document = createProjectDocument('Baseline', toUserId('local'));
    const derive = vi.fn().mockRejectedValue(new Error('Worker unavailable'));
    expect(await exactWarningBaseline(document, derive)).toBe(document);
    expect(derive).not.toHaveBeenCalled();
    await expect(
      exactWarningBaseline(
        {
          ...document,
          derived: { ...document.derived, warnings: ['failure'] }
        },
        derive
      )
    ).rejects.toThrow('Worker unavailable');
  });
});
