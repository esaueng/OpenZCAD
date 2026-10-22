import type { FeatureData, SketchId } from '@openzcad/shared';
import type { ExactBuildResult } from './exact-types';

type ProjectionFailureSource = Pick<
  ExactBuildResult,
  'sketchProjectionFailures'
>;

/** A sketch export must not emit its stored geometry after a failed solve. */
export function assertSketchProjectionsValid(
  result: ProjectionFailureSource,
  sketchId: SketchId
): void {
  const failure = result.sketchProjectionFailures?.get(sketchId);
  if (failure !== undefined) {
    throw new Error(
      `Sketch ${sketchId} cannot use its linked projections: ${failure}`
    );
  }
}

/** Refuse only the feature's authored sketch inputs, before geometry builds. */
export function assertFeatureSketchProjectionsValid(
  result: ProjectionFailureSource,
  data: FeatureData
): void {
  switch (data.featureKind) {
    case 'extrude':
    case 'revolve':
      assertSketchProjectionsValid(result, data.sketchId);
      break;
    case 'loft':
      for (const section of data.sections)
        assertSketchProjectionsValid(result, section.sketchId);
      break;
    case 'sweep':
      assertSketchProjectionsValid(result, data.profile.sketchId);
      assertSketchProjectionsValid(result, data.path.sketchId);
      if (data.guide) assertSketchProjectionsValid(result, data.guide.sketchId);
      break;
    case 'helical-sweep':
      assertSketchProjectionsValid(result, data.profile.sketchId);
      break;
  }
}
