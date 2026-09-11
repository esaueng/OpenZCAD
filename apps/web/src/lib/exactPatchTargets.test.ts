import { describe, expect, it } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import { createSplitFeatureIds } from '@openzcad/document-core';
import { toBodyId } from '@openzcad/shared';
import { exactPatchTargets } from './aiPatchPreflight';

describe('exactPatchTargets', () => {
  it('requires both halves of a split to survive preflight', () => {
    const ids = createSplitFeatureIds();
    const targets = exactPatchTargets([
      commandFactories.splitBody({
        name: 'Cut',
        targetBodyId: toBodyId('body_source'),
        plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } },
        ids
      }),
      commandFactories.transformBody({
        name: 'Move',
        targetBodyId: toBodyId('body_moved'),
        translation: { x: 1, y: 0, z: 0 }
      })
    ]);
    expect(targets).toEqual([
      { featureName: 'Cut', resultBodyId: ids.bodyId },
      { featureName: 'Cut', resultBodyId: ids.secondBodyId },
      { featureName: 'Move', resultBodyId: 'body_moved' }
    ]);
  });
});
