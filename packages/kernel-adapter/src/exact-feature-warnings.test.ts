import { describe, expect, it } from 'vitest';
import { toFeatureId } from '@openzcad/shared';
import type { ExactBuildResult } from './exact-types';
import {
  amendFeatureWarning,
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
    const reason = 'Union returned a faceted approximation.';
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
      'Feature "Union": Union returned a faceted approximation.',
      'Feature "Union": Union returned a faceted approximation. Move the second operand.'
    ]);
    expect(result.featureWarnings?.map((entry) => entry.message)).toEqual(
      result.warnings
    );
  });
});
