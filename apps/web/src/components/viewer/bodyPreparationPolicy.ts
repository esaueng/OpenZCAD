import {
  MAX_MESH_SOLID_CONVERSION_TRIANGLES,
  type GeometryBodyRepresentation
} from '@openzcad/shared';

/** Dense exact bodies exceed an interactive main-thread installation budget. */
export const BODY_PREPARATION_TRIANGLES = 20_000;
export function denseBodyNeedsPreparation(body: GeometryBodyRepresentation) {
  const triangles = body.mesh.indices.length / 3;
  // Large reference meshes already upload their facets directly, without smoothing.
  return (
    triangles > BODY_PREPARATION_TRIANGLES &&
    !(
      body.meshReference === true &&
      triangles > MAX_MESH_SOLID_CONVERSION_TRIANGLES
    )
  );
}
