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

  it('names the variable-radius fields to drop when the end radius is blank', () => {
    // `updateFeature` skips undefined patch values, so "no end radius" cannot
    // travel in `data` at all. Without this the only way back from a variable
    // blend would be an end radius equal to the start radius, which is a
    // different kernel engine wearing the constant blend's numbers.
    const command = edgeModifierCommand(feature, 'fillet', {
      name: 'Fillet edges',
      targetBodyId: 'body_source' as BodyId,
      edgeHashes: [11, 12],
      size: 2
    });
    expect(command.payload).toMatchObject({
      clearData: ['endRadius', 'radiusLaw']
    });
  });

  it('carries the law with the end radius and clears nothing', () => {
    const command = edgeModifierCommand(feature, 'fillet', {
      name: 'Fillet edges',
      targetBodyId: 'body_source' as BodyId,
      edgeHashes: [11, 12],
      size: 1,
      endRadius: 3,
      radiusLaw: 'scurve'
    });
    expect(command.payload).toMatchObject({
      data: { radius: 1, endRadius: 3, radiusLaw: 'scurve' }
    });
    expect('clearData' in command.payload).toBe(false);
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
