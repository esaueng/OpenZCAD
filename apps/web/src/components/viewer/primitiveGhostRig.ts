import * as THREE from 'three';
import type { PrimitiveGhost } from '../../lib/primitiveGhost';

/** Opacity of the ghost where a body hides it: an X-ray, as the hole ghost. */
export const PRIMITIVE_GHOST_HIDDEN_OPACITY = 0.1;
/** Opacity of the ghost in the open. */
export const PRIMITIVE_GHOST_VISIBLE_OPACITY = 0.22;
/** Edges sharper than this outline the ghost; smooth walls stay unlined. */
const EDGE_THRESHOLD_DEG = 25;
const ROUND_SEGMENTS = 48;

export interface PrimitiveGhostRig {
  group: THREE.Group;
  dispose(): void;
}

/**
 * The solid in its own frame, already placed relative to the anchor point the
 * card's Position row names: built so the group only needs translating to
 * `ghost.position`.
 */
function ghostGeometry(ghost: PrimitiveGhost): THREE.BufferGeometry {
  // `primitiveGhostFor` resolves every key a kind is built from.
  const d = (key: string): number => ghost.dimensions[key] ?? 0;
  switch (ghost.kind) {
    case 'box': {
      // Corner-anchored: the box grows along +X, +Y, +Z from its corner.
      const geometry = new THREE.BoxGeometry(
        d('width'),
        d('height'),
        d('depth')
      );
      geometry.translate(d('width') / 2, d('height') / 2, d('depth') / 2);
      return geometry;
    }
    case 'cylinder':
    case 'cone': {
      const top = ghost.kind === 'cylinder' ? d('radius') : d('topRadius');
      const bottom =
        ghost.kind === 'cylinder' ? d('radius') : d('bottomRadius');
      // three builds along +Y; turned so it rises along +Z from its base
      // centre, as the kernel's cylinder and cone do.
      const geometry = new THREE.CylinderGeometry(
        top,
        bottom,
        d('height'),
        ROUND_SEGMENTS
      );
      geometry.rotateX(Math.PI / 2);
      geometry.translate(0, 0, d('height') / 2);
      return geometry;
    }
    case 'sphere':
      return new THREE.SphereGeometry(
        d('radius'),
        ROUND_SEGMENTS,
        ROUND_SEGMENTS / 2
      );
    case 'torus':
      // three's torus already lies in the XY plane about +Z.
      return new THREE.TorusGeometry(
        d('majorRadius'),
        d('minorRadius'),
        ROUND_SEGMENTS / 2,
        ROUND_SEGMENTS
      );
  }
}

/**
 * The open Box/Cylinder/… card's solid in the scene, before Create.
 *
 * Drawn the way the hole ghost is, in the same preview colour: a translucent
 * fill, fainter where an existing body hides it, and its sharp edges solid
 * where visible and dashed where hidden, as hidden lines are drawn. It is
 * display only — three geometry, no kernel call — so it can follow every
 * keystroke.
 */
export function buildPrimitiveGhostRig(
  ghost: PrimitiveGhost,
  color: THREE.ColorRepresentation
): PrimitiveGhostRig {
  const group = new THREE.Group();
  group.name = 'primitive-ghost';
  group.position.set(ghost.position.x, ghost.position.y, ghost.position.z);

  const geometry = ghostGeometry(ghost);
  const hiddenFill = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: PRIMITIVE_GHOST_HIDDEN_OPACITY,
    depthFunc: THREE.GreaterDepth,
    depthWrite: false
  });
  const visibleFill = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: PRIMITIVE_GHOST_VISIBLE_OPACITY,
    depthWrite: false
  });
  for (const [name, material] of [
    ['primitive-ghost-fill-hidden', hiddenFill],
    ['primitive-ghost-fill', visibleFill]
  ] as const) {
    const fill = new THREE.Mesh(geometry, material);
    fill.name = name;
    fill.renderOrder = 20;
    group.add(fill);
  }

  const edges = new THREE.EdgesGeometry(geometry, EDGE_THRESHOLD_DEG);
  const visibleEdgeMaterial = new THREE.LineBasicMaterial({
    color,
    transparent: true
  });
  const hiddenEdgeMaterial = new THREE.LineDashedMaterial({
    color,
    transparent: true,
    opacity: 0.6,
    depthFunc: THREE.GreaterDepth,
    dashSize: 1,
    gapSize: 0.6
  });
  const visibleEdges = new THREE.LineSegments(edges, visibleEdgeMaterial);
  visibleEdges.name = 'primitive-ghost-edges';
  visibleEdges.renderOrder = 22;
  group.add(visibleEdges);
  const hiddenEdges = new THREE.LineSegments(edges, hiddenEdgeMaterial);
  hiddenEdges.name = 'primitive-ghost-edges-hidden';
  hiddenEdges.renderOrder = 22;
  // Dash lengths scale with the solid, so a 2 mm pin and a 2 m plate both
  // read as dashed rather than solid or dotted.
  edges.computeBoundingSphere();
  const size = Math.max(edges.boundingSphere?.radius ?? 1, 1e-3);
  hiddenEdgeMaterial.dashSize = size * 0.06;
  hiddenEdgeMaterial.gapSize = size * 0.04;
  hiddenEdges.computeLineDistances();
  group.add(hiddenEdges);

  // A ghost never takes a pick: the click belongs to the bodies under it.
  group.traverse((object) => {
    object.raycast = () => {};
  });

  return {
    group,
    dispose() {
      geometry.dispose();
      hiddenFill.dispose();
      visibleFill.dispose();
      edges.dispose();
      visibleEdgeMaterial.dispose();
      hiddenEdgeMaterial.dispose();
    }
  };
}
