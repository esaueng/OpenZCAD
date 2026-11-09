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
  return {
    geometry: prepareBodyGeometry(body),
    tangentIds: body.topology
      ? tangentEdgeIds(
          body.mesh,
          body.topology,
          facetedSource(body.source) ? FACETED_JOINT_MAX_ANGLE : undefined
        )
      : new Set(),
    silhouettes: body.topology
      ? silhouetteCandidates(body.mesh, body.topology.faces)
      : null
  };
}
