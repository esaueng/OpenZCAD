import { writeAsciiStl } from '@openzcad/io-stl';
import type { FeatureNode } from '@openzcad/shared';

/**
 * The single mesh handoff between a document and a kernel.
 *
 * An `imported-mesh` feature stores the triangle soup the STL parser produced.
 * Both exact kernels take meshes back in through their own STL importer — that
 * importer owns vertex welding and shell orientation, so the adapter must not
 * invent a second, divergent mesh-to-B-rep path. Serializing to ASCII STL here
 * keeps exactly one conversion in the tree.
 */
export type ImportedMeshFeatureData = Extract<
  FeatureNode['data'],
  { featureKind: 'imported-mesh' }
>;

export function importedMeshStl(feature: ImportedMeshFeatureData): string {
  return writeAsciiStl(feature.sourceName, [
    {
      name: feature.sourceName,
      vertices: feature.vertices,
      indices: feature.indices
    }
  ]);
}

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
