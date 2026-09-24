import type * as THREE from 'three';

/**
 * Marks a material whose compiled program should outlive it. Disposing a
 * material releases its program, and three.js deletes a program nobody holds,
 * so anything rebuilt with an identical material — a rig re-armed on every
 * preview, a body replaced by its next exact result, the highlight on the
 * face that body now selects — recompiled the same shaders each time. On a
 * software GL runner one link costs 100–650 ms of blocked main thread: 19
 * extra links in one resize flow timed the suite out, and a body commit
 * relinked five. A kept material is simply dropped; its program stays cached
 * for the next identical material. It owns no other GPU resource, and
 * geometries are still disposed.
 */
export function keepProgram<T extends THREE.Material>(material: T): T {
  material.userData.keepProgram = true;
  return material;
}

/** Disposes a material unless {@link keepProgram} asked for its program. */
export function disposeMaterial(material: THREE.Material) {
  if (material.userData.keepProgram !== true) {
    material.dispose();
  }
}
