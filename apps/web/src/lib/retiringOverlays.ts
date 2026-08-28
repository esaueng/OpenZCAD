import type * as THREE from 'three';
import { clearGroup } from '@openzcad/viewport';

/** A retired overlay and the object it was hanging under. */
export interface RetiringOverlay {
  group: THREE.Group;
  parent: THREE.Object3D;
}

/** The part of the scene context a retiring overlay touches. */
interface FadeHost {
  readonly fadeIns: Set<THREE.Material>;
  requestRender(): void;
}

/**
 * Starts a deselected highlight fading instead of deleting it outright.
 *
 * The overlay is renamed first: the rebuild finds selection overlays by name,
 * and a fading one must not be mistaken for the current selection's. Its
 * materials are handed to the same fade the entrance uses, aimed at zero.
 */
export function retireOverlay(
  host: FadeHost,
  retiring: RetiringOverlay[],
  group: THREE.Group
) {
  const parent = group.parent;
  if (!parent) {
    return;
  }
  group.name = `${group.name}-retiring`;
  let hasMaterial = false;
  group.traverse((child) => {
    const material = (child as THREE.Mesh).material;
    if (material && !Array.isArray(material)) {
      material.userData.targetOpacity = 0;
      host.fadeIns.add(material);
      hasMaterial = true;
    }
  });
  if (!hasMaterial) {
    clearGroup(group);
    parent.remove(group);
    return;
  }
  retiring.push({ group, parent });
  host.requestRender();
}

/**
 * Disposes every retired overlay outright, settled or not.
 *
 * A retiring overlay fades by riding the selection manager's fade set, and a
 * rebuild that replaces the bodies clears that set — so anything still fading
 * at that moment stopped easing partway, never reached zero, and was never
 * disposed by `disposeSettledOverlays`. The entry then sat in the retiring
 * list for the rest of the session, which is one of the conditions that keeps
 * the render loop awake: deselecting a body and editing a parameter within
 * the same fade left the viewport rendering at full rate on a still scene,
 * forever, with the half-faded highlight and its materials leaked behind it.
 */
export function disposeRetiringOverlays(retiring: RetiringOverlay[]) {
  for (const entry of retiring) {
    clearGroup(entry.group);
    entry.parent.remove(entry.group);
  }
  retiring.length = 0;
}

/** Disposes retired overlays once their fade has reached zero. */
export function disposeSettledOverlays(retiring: RetiringOverlay[]) {
  for (let index = retiring.length - 1; index >= 0; index -= 1) {
    const entry = retiring[index]!;
    let faded = true;
    entry.group.traverse((child) => {
      const material = (child as THREE.Mesh).material;
      if (material && !Array.isArray(material) && material.opacity > 0) {
        faded = false;
      }
    });
    if (faded) {
      clearGroup(entry.group);
      entry.parent.remove(entry.group);
      retiring.splice(index, 1);
    }
  }
}
