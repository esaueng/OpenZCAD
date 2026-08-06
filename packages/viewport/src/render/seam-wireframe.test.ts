import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import type { BodyRepresentation, EdgeTopology } from '@openzcad/shared';
import { createBodyEdgeOverlay } from './edgeOverlay';

function edge(
  topologyId: string,
  displayRole: 'seam' | undefined
): EdgeTopology {
  return {
    topologyId,
    hash: topologyId.length,
    points: [0, 0, 0, 1, 0, 0, 2, 0, 0],
    ...(displayRole ? { displayRole } : {})
  };
}

function overlayFor(edges: EdgeTopology[]) {
  return createBodyEdgeOverlay({
    bodyId: 'body_test' as BodyRepresentation['bodyId'],
    topology: { edges, faces: [] }
  });
}

/**
 * Wireframe hides the faces, so edges are all a body has left. A sphere and a
 * torus own nothing but seams — construction boundaries the shaded view is
 * right to suppress — and suppressing them there too left those bodies drawing
 * nothing at all: present in the tree, selectable, and invisible.
 */
describe('wireframe seam fallback', () => {
  it('draws seams in wireframe for a body that has only seams', () => {
    const overlay = overlayFor([edge('seam_a', 'seam'), edge('seam_b', 'seam')]);
    expect(overlay.seamEdges).not.toBeNull();

    overlay.setDisplayMode('shaded-edges');
    expect(overlay.seamEdges!.visible).toBe(false);
    expect(overlay.idleEdges.visible).toBe(false);

    overlay.setDisplayMode('wireframe');
    expect(overlay.seamEdges!.visible).toBe(true);
  });

  it('leaves a body with real edges alone', () => {
    const overlay = overlayFor([edge('feature_a', undefined), edge('seam_b', 'seam')]);
    // A seam beside a feature edge is still just a seam: nothing to rescue, so
    // no fallback batch exists to leak into the shaded view.
    expect(overlay.seamEdges).toBeNull();
    overlay.setDisplayMode('wireframe');
    expect(overlay.idleEdges.visible).toBe(true);
  });

  it('keeps seams out of picking', () => {
    const overlay = overlayFor([edge('seam_a', 'seam')]);
    // Seams carry no topology identity, so nothing downstream can resolve a
    // pick to one and hand it to a fillet.
    expect(overlay.ownershipBySegment).toHaveLength(0);
    expect(overlay.seamEdges!.raycast).toBeDefined();
    // The override returns nothing for any ray, so a seam can never resolve to
    // a pick that a fillet could then be handed.
    expect(
      overlay.seamEdges!.raycast(
        {} as unknown as THREE.Raycaster,
        [] as THREE.Intersection[]
      )
    ).toBeUndefined();
  });
});
