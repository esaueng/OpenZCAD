import * as THREE from 'three';
import type { HoleGhost } from '../../lib/holeGhost';

/** Opacity of the bore where the body hides it: an X-ray, not a solid. */
export const HOLE_GHOST_HIDDEN_OPACITY = 0.14;
/** Opacity of any part of the bore in the open, which is a miss to notice. */
export const HOLE_GHOST_VISIBLE_OPACITY = 0.32;
/** The darkened opening drawn on the entry face. */
export const HOLE_GHOST_OPENING_OPACITY = 0.55;
const OPENING_COLOR = 0x0b0d10;

export interface HoleGhostRig {
  group: THREE.Group;
  dispose(): void;
}

/**
 * The open Hole card's bore in the scene: where the hole enters, which way
 * it runs, how big it is.
 *
 * It used to be one translucent cylinder drawn over everything. Laid across
 * the entry face with nothing to say which part was inside the body, it read
 * as a post standing on the face — "adding a cylinder" — although it ran
 * down from the face. Now the parts say which way the bore goes:
 *
 * - a dark opening on the entry face, depth-tested so only the face shows
 *   it: the mark a hole leaves;
 * - the barrel twice, faint where the body hides it and stronger where it
 *   is in the open, so a bore inside the part is a ghost and one that misses
 *   it stands out;
 * - the entry rim solid over everything, and the far rim dashed, as a hidden
 *   line is drawn.
 */
export function buildHoleGhostRig(
  ghost: HoleGhost,
  color: THREE.ColorRepresentation
): HoleGhostRig {
  const group = new THREE.Group();
  group.name = 'hole-ghost';
  const { entry, axis, radius, depth } = ghost;
  const direction = new THREE.Vector3(axis.x, axis.y, axis.z).normalize();
  const origin = new THREE.Vector3(entry.x, entry.y, entry.z);
  // Cylinder and rims are built along +Y, the opening disc facing +Z.
  const alongAxis = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction
  );
  const facingOut = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    direction.clone().negate()
  );

  const barrelGeometry = new THREE.CylinderGeometry(
    radius,
    radius,
    depth,
    40,
    1,
    true
  );
  const hiddenFill = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: HOLE_GHOST_HIDDEN_OPACITY,
    side: THREE.DoubleSide,
    depthFunc: THREE.GreaterDepth,
    depthWrite: false
  });
  const visibleFill = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: HOLE_GHOST_VISIBLE_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const barrelCenter = origin.clone().addScaledVector(direction, depth / 2);
  for (const [name, material] of [
    ['hole-ghost-barrel-hidden', hiddenFill],
    ['hole-ghost-barrel', visibleFill]
  ] as const) {
    const barrel = new THREE.Mesh(barrelGeometry, material);
    barrel.name = name;
    barrel.quaternion.copy(alongAxis);
    barrel.position.copy(barrelCenter);
    barrel.renderOrder = 20;
    group.add(barrel);
  }

  const openingGeometry = new THREE.CircleGeometry(radius, 48);
  const openingMaterial = new THREE.MeshBasicMaterial({
    color: OPENING_COLOR,
    transparent: true,
    opacity: HOLE_GHOST_OPENING_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
    // Coplanar with the entry face: pulled toward the camera so the face
    // never wins the depth test against it.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4
  });
  const opening = new THREE.Mesh(openingGeometry, openingMaterial);
  opening.name = 'hole-ghost-opening';
  opening.quaternion.copy(facingOut);
  opening.position.copy(origin);
  opening.renderOrder = 21;
  group.add(opening);

  const rimGeometry = new THREE.BufferGeometry().setFromPoints(
    Array.from({ length: 64 }, (_, index) => {
      const angle = (index / 64) * Math.PI * 2;
      return new THREE.Vector3(
        Math.cos(angle) * radius,
        0,
        Math.sin(angle) * radius
      );
    })
  );
  const entryRimMaterial = new THREE.LineBasicMaterial({
    color,
    depthTest: false,
    transparent: true
  });
  const exitRimMaterial = new THREE.LineDashedMaterial({
    color,
    depthTest: false,
    transparent: true,
    opacity: 0.7,
    dashSize: Math.max(radius * 0.3, 1e-3),
    gapSize: Math.max(radius * 0.2, 1e-3)
  });
  for (const [name, along, material] of [
    ['hole-ghost-entry-rim', 0, entryRimMaterial],
    ['hole-ghost-exit-rim', depth, exitRimMaterial]
  ] as const) {
    const rim = new THREE.LineLoop(rimGeometry, material);
    rim.name = name;
    rim.quaternion.copy(alongAxis);
    rim.position.copy(origin).addScaledVector(direction, along);
    rim.renderOrder = 22;
    group.add(rim);
  }
  // Dash lengths are read from per-vertex distances along the loop.
  rimGeometry.setAttribute(
    'lineDistance',
    new THREE.Float32BufferAttribute(
      Array.from(
        { length: 64 },
        (_, index) => (index / 64) * Math.PI * 2 * radius
      ),
      1
    )
  );

  return {
    group,
    dispose() {
      barrelGeometry.dispose();
      hiddenFill.dispose();
      visibleFill.dispose();
      openingGeometry.dispose();
      openingMaterial.dispose();
      rimGeometry.dispose();
      entryRimMaterial.dispose();
      exitRimMaterial.dispose();
    }
  };
}
