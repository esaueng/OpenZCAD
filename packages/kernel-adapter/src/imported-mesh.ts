import type { FeatureNode } from '@openzcad/shared';

/** A readable triangle mesh that the file translator cannot make a B-rep. */
export class MeshConversionError extends Error {}

// Keep the existing mesh handoff exports while the Worker build places its
// payload helpers in a separate chunk behind the exact adapter's lazy load.
export {
  importedMeshStl,
  importedMeshTriangles
} from './imported-mesh-payload';

export type ImportedMeshFeatureData = Extract<
  FeatureNode['data'],
  { featureKind: 'imported-mesh' }
>;

/**
 * Typed refusal for the one thing an imported mesh still cannot do.
 *
 * A mesh arrives as thousands of independent planar facets with no analytic
 * surfaces behind them. Booleans against such a shell are not a modelling
 * operation the kernel can complete at a usable cost or tolerance, and the
 * legacy polyhedral kernel could not do it either. Refuse by name rather than
 * dropping the feature: the user needs to know which body is the problem and
 * what to do about it.
 */
export function meshBooleanUnsupportedError(bodyName: string): Error {
  return new Error(
    `Body "${bodyName}" is an imported mesh, which has no exact surfaces to ` +
      'boolean against. Convert the mesh to a solid, or build the cut from ' +
      'exact bodies instead.'
  );
}
