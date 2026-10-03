import { describe, expect, it } from 'vitest';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  type FeatureNode
} from '@openzcad/shared';
import { featureNeedsRepair, featuresNeedingRepair } from './featureRepair';

function feature(
  id: string,
  options: { bodyId?: string; sketch?: boolean; suppressed?: boolean } = {}
): FeatureNode {
  return {
    id,
    kind: 'feature',
    name: id,
    featureId: id,
    featureKind: options.sketch ? 'sketch' : 'primitive',
    ...(options.bodyId ? { bodyId: options.bodyId } : {}),
    ...(options.suppressed
      ? { metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true } }
      : {})
  } as unknown as FeatureNode;
}

describe('featureNeedsRepair', () => {
  it('flags a live feature whose body the rebuild did not produce', () => {
    expect(featureNeedsRepair(feature('Hole', { bodyId: 'b2' }), {})).toBe(
      true
    );
    expect(
      featureNeedsRepair(feature('Hole', { bodyId: 'b2' }), { b2: {} })
    ).toBe(false);
  });

  it('never flags a suppressed feature, a sketch, or a bodyless feature', () => {
    expect(
      featureNeedsRepair(
        feature('Boss', { bodyId: 'b1', suppressed: true }),
        {}
      )
    ).toBe(false);
    expect(
      featureNeedsRepair(feature('Sketch', { bodyId: 'b1', sketch: true }), {})
    ).toBe(false);
    expect(featureNeedsRepair(feature('Param'), {})).toBe(false);
  });
});

describe('featuresNeedingRepair', () => {
  it('collects the ids of every feature needing repair', () => {
    expect([
      ...featuresNeedingRepair(
        [
          feature('Base', { bodyId: 'b0' }),
          feature('Boss', { bodyId: 'b1', suppressed: true }),
          feature('Hole', { bodyId: 'b2' }),
          feature('Fillet', { bodyId: 'b3' })
        ],
        { b0: {} }
      )
    ]).toEqual(['Hole', 'Fillet']);
  });
});
