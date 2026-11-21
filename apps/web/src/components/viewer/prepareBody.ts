import type { GeometryBodyRepresentation } from '@openzcad/shared';
import { prepareBodyGeometry } from '../../../../../packages/viewport/src/render/scene';
import { silhouetteCandidates } from '../../../../../packages/viewport/src/render/silhouette';
import { facetedSource } from '../../../../../packages/viewport/src/render/edgeOverlay';
import {
  FACETED_JOINT_MAX_ANGLE,
  tangentEdgeIds
} from '../../../../../packages/viewport/src/render/tangentEdges';
import type { PreparedBody } from '../../../../../packages/viewport/src/render/preparedBody';

/** The worker and first-open fallback must produce the same disposable arrays. */
export function prepareBody(body: GeometryBodyRepresentation): PreparedBody {
  let shadingPairs: ((first: number, second: number) => boolean) | undefined;
  const geometry = prepareBodyGeometry(body, (pairs) => {
    shadingPairs = pairs;
  });
  const faceted = facetedSource(body.source);
  return {
    geometry,
    tangentIds: body.topology
      ? tangentEdgeIds(
          body.mesh,
          body.topology,
          faceted ? FACETED_JOINT_MAX_ANGLE : undefined,
          faceted ? undefined : shadingPairs
        )
      : new Set(),
    silhouettes: body.topology
      ? silhouetteCandidates(body.mesh, body.topology.faces)
      : null
  };
}
