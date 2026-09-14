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

  it('names the angle to drop so a second distance can be added', () => {
    // The chamfer form hides the angle field the moment a second distance is
    // filled, so a stored angle left behind by a patch is one no visible
    // control can clear — and a chamfer carrying both is refused by its own
    // validator. Naming the key is the only way back.
    const chamfer = {
      ...feature,
      data: {
        featureKind: 'chamfer',
        targetBodyId: 'body_source' as BodyId,
        edgeHashes: [11],
        distance: 2,
        angleDeg: 30
      }
    } as unknown as FeatureNode;
    const command = edgeModifierCommand(chamfer, 'chamfer', {
      name: 'Bevel',
      targetBodyId: 'body_source' as BodyId,
      edgeHashes: [11],
      size: 2,
      distance2: 5
    });
    expect(command.payload).toMatchObject({
      data: { distance: 2, distance2: 5 },
      clearData: ['angleDeg']
    });
    expect(
      (command.payload as { data: Record<string, unknown> }).data.angleDeg
    ).toBeUndefined();
  });

  it('clears both chamfer extras when the form offers neither', () => {
    const command = edgeModifierCommand(feature, 'chamfer', {
      name: 'Bevel',
      targetBodyId: 'body_source' as BodyId,
      edgeHashes: [11],
      size: 2
    });
    expect(command.payload).toMatchObject({
      clearData: ['angleDeg', 'distance2']
    });
  });

  it('keeps a typed angle and clears only the second distance', () => {
    const command = edgeModifierCommand(feature, 'chamfer', {
      name: 'Bevel',
      targetBodyId: 'body_source' as BodyId,
      edgeHashes: [11],
      size: 2,
      angleDeg: 30
    });
    expect(command.payload).toMatchObject({
      data: { distance: 2, angleDeg: 30 },
      clearData: ['distance2']
    });
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
