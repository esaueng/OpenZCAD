import { describe, expect, it } from 'vitest';
import type { BodyId, FeatureId, FeatureNode } from '@openzcad/shared';
import { edgeModifierCommand } from './edgeModifierEdit';

const feature = {
  id: 'node_fillet',
  kind: 'feature',
  name: 'Fillet edges',
  parentId: 'part',
  revisionId: null,
  featureId: 'feat_fillet' as FeatureId,
  bodyId: 'body_result' as BodyId,
  data: {
    featureKind: 'fillet',
    targetBodyId: 'body_source' as BodyId,
    edgeHashes: [11, 12],
    radius: 2
  }
} as unknown as FeatureNode;

describe('edge modifier edit command', () => {
  it('carries the edge set with the size so a fillet can take more edges', () => {
    const command = edgeModifierCommand(feature, 'fillet', {
      name: 'Fillet edges',
      targetBodyId: 'body_source' as BodyId,
      edgeHashes: [11, 12, 13],
      size: 3
    });
    expect(command.payload).toMatchObject({
      featureId: 'feat_fillet',
      name: 'Fillet edges',
      data: { edgeHashes: [11, 12, 13], radius: 3 }
    });
    expect(command.label).toBe('Edit Fillet edges');
  });

  it('creates when there is no feature to edit', () => {
    const command = edgeModifierCommand(null, 'chamfer', {
      name: 'Chamfer edges',
      targetBodyId: 'body_source' as BodyId,
      edgeHashes: [11],
      size: 1,
      angleDeg: 30
    });
    expect(command.payload).toMatchObject({
      name: 'Chamfer edges',
      edgeHashes: [11],
      size: 1,
      angleDeg: 30
    });
  });
});
