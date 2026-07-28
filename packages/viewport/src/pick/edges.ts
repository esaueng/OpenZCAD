import type * as THREE from 'three';

/**
 * Exact topology edges render as screen-space fat lines so they read clearly
 * and their states are unmistakable: idle slate, hover glow, selected accent.
 */
export const EDGE_IDLE_COLOR = 0x151c26;
export const EDGE_HOVER_COLOR = 0xbfdcff;
export const EDGE_SELECTED_COLOR = 0x7cc0ff;
export const EDGE_IDLE_WIDTH = 1.4;
export const EDGE_HOVER_WIDTH = 4;
export const EDGE_SELECTED_WIDTH = 4.5;
export const EDGE_IDLE_OPACITY = 0.92;

/**
 * Extra screen-space width used only for edge picking. Line2 adds this to the
 * rendered width before testing the pointer, so an idle edge has a 3 px pick
 * radius without that radius changing as the camera zooms.
 */
const EDGE_PICK_PADDING_PX = 4;

/**
 * Edge and face intersections for the same topological boundary can differ by
 * a few floating-point ulps. Keep the allowance relative to camera distance;
 * a fixed model-unit allowance can select an edge hidden behind the face.
 */
const EDGE_DEPTH_RELATIVE_EPSILON = 1e-4;
const EDGE_DEPTH_ABSOLUTE_EPSILON = 1e-6;

export type TopologyHit = Pick<THREE.Intersection, 'distance' | 'object'>;

export function configureEdgeRaycasting(raycaster: THREE.Raycaster) {
  raycaster.params.Line2 = { threshold: EDGE_PICK_PADDING_PX };
}

/**
 * Promotes an edge that is effectively coplanar with the nearest hit, so a
 * boundary reads as pickable from the face it bounds. An edge genuinely
 * behind the face keeps its depth order.
 */
export function prioritizeVisibleEdgeHit<T extends TopologyHit>(hits: T[]) {
  const nearestDistance = hits[0]?.distance;
  if (nearestDistance === undefined) {
    return hits;
  }
  const depthTolerance = Math.max(
    EDGE_DEPTH_ABSOLUTE_EPSILON,
    Math.abs(nearestDistance) * EDGE_DEPTH_RELATIVE_EPSILON
  );
  const edgeHit = hits.find(
    (hit) =>
      (hit.object.userData as { topologyKind?: string }).topologyKind ===
        'edge' && hit.distance <= nearestDistance + depthTolerance
  );
  return edgeHit ? [edgeHit, ...hits.filter((hit) => hit !== edgeHit)] : hits;
}
