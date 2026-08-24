import type * as THREE from 'three';
import { SELECTION_SEMANTICS } from '../render/semantics';

/**
 * Exact topology edges render as screen-space fat lines so they read clearly
 * and their states are unmistakable: idle slate, hover glow, selected accent.
 */
export const EDGE_IDLE_COLOR = SELECTION_SEMANTICS.idle.edge;
/** Idle edge contrast when there is no shaded face behind the topology. */
export const EDGE_WIREFRAME_COLOR = SELECTION_SEMANTICS.idle.wireframeEdge;
export const EDGE_HOVER_COLOR = SELECTION_SEMANTICS.hover.edge;
export const EDGE_SELECTED_COLOR = SELECTION_SEMANTICS.selected.edge;
export const EDGE_IDLE_WIDTH = SELECTION_SEMANTICS.idle.edgeWidth;
export const EDGE_HOVER_WIDTH = SELECTION_SEMANTICS.hover.edgeWidth;
export const EDGE_SELECTED_WIDTH = SELECTION_SEMANTICS.selected.edgeWidth;
export const EDGE_IDLE_OPACITY = SELECTION_SEMANTICS.idle.edgeOpacity;

export function idleEdgeColor(edge: THREE.Object3D): number {
  return edge.userData.displayMode === 'wireframe'
    ? EDGE_WIREFRAME_COLOR
    : EDGE_IDLE_COLOR;
}

/**
 * Extra screen-space width used only for edge picking. Line2 tests the pointer
 * against `(material.linewidth + threshold) * 0.5`, so the pick radius in CSS
 * pixels is half the sum — it does not change as the camera zooms.
 *
 * At the original padding of 4 an idle edge answered within (1.4 + 4) / 2 ≈
 * 2.7 px. That is inside the jitter of an ordinary mouse drag-and-release, so
 * edges read as unpickable in hand testing even though picking worked: a
 * measured horizontal sweep found bands only 3–5 px wide. Padding 8 gives
 * (1.4 + 8) / 2 ≈ 4.7 px, comparable to desktop CAD, while staying far enough
 * below the face it bounds that surfaces are still easy to hit away from
 * their boundary.
 */
const EDGE_PICK_PADDING_PX = 8;

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
