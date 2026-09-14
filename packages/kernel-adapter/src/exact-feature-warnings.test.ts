import { describe, expect, it } from 'vitest';
import { toFeatureId } from '@openzcad/shared';
import type { ExactBuildResult } from './exact-types';
import {
  amendFeatureWarning,
  hasRefusingFeatureWarning,
  raiseFeatureWarning
} from './exact-feature-warnings';

function emptyBuildResult(): ExactBuildResult {
  return {
    shapes: new Map(),
    sketchBases: new Map(),
    consumed: new Set(),
    importedStepDiagnostics: new Map(),
    meshBodies: new Set(),
    partialRevolveBodies: new Set(),
    warnings: [],
    featureWarnings: [],
    referenceRepairs: []
  };
}

describe('feature warning amendments', () => {
  it('updates the record for the feature whose warning was amended', () => {
    const result = emptyBuildResult();
    const first = {
      featureId: toFeatureId('feat_first'),
      name: 'Union'
    };
    const second = {
      featureId: toFeatureId('feat_second'),
      name: 'Union'
    };
    const reason = 'Union refused: these bodies could not be combined exactly.';
    raiseFeatureWarning(result, first, reason, 'refusal');
    const secondWarning = raiseFeatureWarning(
      result,
      second,
      reason,
      'refusal'
    );

    amendFeatureWarning(
      result,
      secondWarning,
      second.featureId,
      'Move the second operand.'
    );

    expect(result.warnings).toEqual([
      'Feature "Union": Union refused: these bodies could not be combined exactly.',
      'Feature "Union": Union refused: these bodies could not be combined exactly. Move the second operand.'
    ]);
    expect(result.featureWarnings?.map((entry) => entry.message)).toEqual(
      result.warnings
    );
  });

  it('appends the remedy to the sentence, not to the hidden detail', () => {
    const result = emptyBuildResult();
    const feature = {
      featureId: toFeatureId('feat_union'),
      name: 'Union'
    };
    const index = raiseFeatureWarning(
      result,
      feature,
      'Union refused: these bodies could not be combined exactly.\n' +
        'Kernel refusal exact_only_unattainable (quality_refused)',
      'refusal'
    );

    amendFeatureWarning(
      result,
      index,
      feature.featureId,
      'Moving Cylinder +1 mm in Z clears it.'
    );

    expect(result.warnings).toEqual([
      'Feature "Union": Union refused: these bodies could not be combined ' +
        'exactly. Moving Cylinder +1 mm in Z clears it.\n' +
        'Kernel refusal exact_only_unattainable (quality_refused)'
    ]);
    expect(result.featureWarnings?.map((entry) => entry.message)).toEqual(
      result.warnings
    );
  });
});

describe('feature warning identity', () => {
  it('does not let a same-named advisory hide another feature refusal', () => {
    const result = emptyBuildResult();
    const advisoryFeature = {
      featureId: toFeatureId('feat_advisory'),
      name: 'Shared name'
    };
    const unionFeature = {
      featureId: toFeatureId('feat_union'),
      name: 'Shared name'
    };
    raiseFeatureWarning(
      result,
      advisoryFeature,
      'Curves were approximated with segments.',
      'advisory'
    );

    // The old name-prefix check says the union already warned here.
    expect(
      result.warnings.some((warning) =>
        warning.startsWith('Feature "Shared name":')
      )
    ).toBe(true);
    expect(hasRefusingFeatureWarning(result, unionFeature.featureId)).toBe(
      false
    );
    raiseFeatureWarning(
      result,
      unionFeature,
      'Union produced an open result.',
      'refusal'
    );
    expect(hasRefusingFeatureWarning(result, unionFeature.featureId)).toBe(
      true
    );
    expect(result.warnings).toEqual([
      'Feature "Shared name": Curves were approximated with segments.',
      'Feature "Shared name": Union produced an open result.'
    ]);
  });
});
