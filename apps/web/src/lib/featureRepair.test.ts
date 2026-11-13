import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type FeatureId,
  type FeatureNode
} from '@openzcad/shared';
import type { FeatureWarning } from '@openzcad/shared';
import {
  builtOnFailedFeatures,
  failedFeatureIds,
  failedStepsInRepairOrder,
  failureLineage,
  featureNeedsRepair,
  featuresNeedingRepair,
  historyFailureTier
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

  it('counts a failed feature whose input stands in under its id', () => {
    // ADR-017 (November 2026): the failed Fillet has a body, its input.
    expect([
      ...featuresNeedingRepair(
        [
          feature('Base', { bodyId: 'b0' }),
          feature('Fillet', { bodyId: 'b1' })
        ],
        { b0: {}, b1: {} },
        [
          {
            featureId: 'Fillet',
            featureName: 'Fillet',
            message: 'Feature "Fillet": radius too large',
            kind: 'build-failed'
          } as FeatureWarning
        ]
      )
    ]).toEqual(['Fillet']);
  });
});

describe('builtOnFailedFeatures', () => {
  /** Block → Fillet → Chamfer → Paused → Last, and an unrelated branch. */
  function history() {
    let document = addPrimitiveFeature(
      createProjectDocument('Failed upstream', toUserId('user_repair')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    let body = document.bodyOrder.at(-1)!;
    for (const name of ['Fillet', 'Chamfer', 'Paused', 'Last']) {
      const modify = name === 'Fillet' ? filletEdges : chamferEdges;
      ({ document, bodyId: body } = modify(document, {
        name,
        targetBodyId: body,
        edgeHashes: [1],
        size: 1
      }));
    }
    document = addPrimitiveFeature(document, {
      name: 'Other',
      primitiveKind: 'box',
      dimensions: { width: 5, height: 5, depth: 5 }
    });
    ({ document } = chamferEdges(document, {
      name: 'Other chamfer',
      targetBodyId: document.bodyOrder.at(-1)!,
      edgeHashes: [1],
      size: 1
    }));
    const features = listFeaturesInOrder(document);
    const paused = features.find((node) => node.name === 'Paused')!;
    document = {
      ...document,
      nodes: {
        ...document.nodes,
        [paused.id]: {
          ...paused,
          metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
        }
      }
    };
    const id = (name: string) =>
      features.find((node) => node.name === name)!.featureId;
    return { document, id, features };
  }

  const named = (
    map: Map<FeatureId, FeatureNode>,
    features: readonly FeatureNode[]
  ) =>
    [...map].map(([featureId, origin]) => [
      features.find((node) => node.featureId === featureId)!.name,
      origin.name
    ]);

  it('flags every later step on the failed branch, through a suppressed one, and nothing else', () => {
    const { document, id, features } = history();
    expect(
      named(builtOnFailedFeatures(document, new Set([id('Fillet')])), features)
    ).toEqual([
      ['Chamfer', 'Fillet'],
      ['Last', 'Fillet']
    ]);
  });

  it('names the earliest failure and leaves failed steps to their own flag', () => {
    const { document, id, features } = history();
    expect(
      named(
        builtOnFailedFeatures(document, new Set([id('Fillet'), id('Chamfer')])),
        features
      )
    ).toEqual([['Last', 'Fillet']]);
    expect(builtOnFailedFeatures(document, new Set()).size).toBe(0);
  });

  it('maps every step after a failure to the earliest one, failed steps included', () => {
    const { document, id, features } = history();
    const failed = new Set([id('Fillet'), id('Chamfer'), id('Other chamfer')]);
    const lineage = failureLineage(document, failed);
    // Chamfer failed after Fillet; Paused passes Fillet's failure on to
    // Last; Other chamfer is its own first failure on another body.
    expect(named(lineage, features)).toEqual([
      ['Chamfer', 'Fillet'],
      ['Paused', 'Fillet'],
      ['Last', 'Fillet']
    ]);
    const tier = (name: string) =>
      historyFailureTier(id(name), failed.has(id(name)), lineage);
    expect(tier('Block')).toBeNull();
    expect(tier('Fillet')).toBe('root');
    expect(tier('Chamfer')).toBe('downstream');
    expect(tier('Last')).toBe('built-on-failed');
    expect(tier('Other')).toBeNull();
    expect(tier('Other chamfer')).toBe('root');
    // The chip visits the first failures, then the rest, each in order.
    expect(
      failedStepsInRepairOrder(features, failed, lineage).map(
        (node) => node.name
      )
    ).toEqual(['Fillet', 'Other chamfer', 'Chamfer']);
  });

  it('does not start a chain at a suppressed step, even when reported', () => {
    const { document, id } = history();
    expect(failureLineage(document, new Set([id('Paused')])).size).toBe(0);
    expect(failureLineage(document, new Set()).size).toBe(0);
  });
});
