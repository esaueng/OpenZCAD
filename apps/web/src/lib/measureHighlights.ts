import type { TopologySelection } from '@openzcad/shared';
import type { Measurement } from './measurements';

/**
 * M13: the edges and faces a measurement measured, as the viewport lights
 * them while its row is hovered. A body target (a whole-body figure) lights
 * nothing here: the hover draws entities, not solids. Kept apart from the
 * measurement library so the workspace can call it without loading that
 * deferred chunk.
 */
export function measurementHighlightTargets(
  measurement: Pick<Measurement, 'targets'>
): TopologySelection[] {
  return measurement.targets.flatMap((target): TopologySelection[] =>
    target.kind === 'edge' || target.kind === 'face'
      ? [
          {
            bodyId: target.bodyId,
            kind: target.kind,
            ...(target.topologyId ? { topologyId: target.topologyId } : {}),
            ...(target.hash !== undefined ? { hash: target.hash } : {}),
            ...(target.reference ? { reference: target.reference } : {})
          }
        ]
      : []
  );
}
