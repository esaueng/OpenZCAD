import { describe, expect, it } from 'vitest';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  type FeatureNode
} from '@openzcad/shared';
import type { FeatureWarning } from '@openzcad/shared';
import {
  failedFeatureIds,
  featureNeedsRepair,
  featuresNeedingRepair
} from './featureRepair';

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

describe('failed bodyless features', () => {
  function warning(
    featureId: string,
    kind: FeatureWarning['kind']
  ): FeatureWarning {
    return {
      featureId,
      featureName: featureId,
      message: `${featureId}: ${kind}`,
      kind
    } as FeatureWarning;
  }

  it('reads only build failures and refusals as failed', () => {
    expect([
      ...failedFeatureIds([
        warning('Move', 'build-failed'),
        warning('Union', 'refusal'),
        warning('Pattern', 'advisory'),
        warning('Boss', 'suppressed')
      ])
    ]).toEqual(['Move', 'Union']);
    expect(failedFeatureIds(undefined).size).toBe(0);
  });

  it('flags a failed transform even though its target body still exists', () => {
    // A transform edits its target in place and owns no body, so the body
    // check alone can never see it fail.
    const move = feature('Move');
    const failed = failedFeatureIds([warning('Move', 'build-failed')]);
    expect(featureNeedsRepair(move, { b0: {} })).toBe(false);
    expect(featureNeedsRepair(move, { b0: {} }, failed)).toBe(true);
  });

  it('keeps suppressed features and sketches out even when reported', () => {
    const failed = failedFeatureIds([
      warning('Move', 'build-failed'),
      warning('Sketch', 'build-failed')
    ]);
    expect(
      featureNeedsRepair(feature('Move', { suppressed: true }), {}, failed)
    ).toBe(false);
    expect(
      featureNeedsRepair(feature('Sketch', { sketch: true }), {}, failed)
    ).toBe(false);
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
