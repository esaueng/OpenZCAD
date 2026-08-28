import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  disposeRetiringOverlays,
  disposeSettledOverlays,
  retireOverlay,
  type RetiringOverlay
} from './retiringOverlays';

function host() {
  const fadeIns = new Set<THREE.Material>();
  let renders = 0;
  return {
    fadeIns,
    requestRender: () => {
      renders += 1;
    },
    renders: () => renders
  };
}

/** A selection highlight hanging under a body, as the rebuild leaves it. */
function highlight() {
  const parent = new THREE.Object3D();
  const group = new THREE.Group();
  group.name = 'body-selection-overlay';
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.34 })
  );
  group.add(mesh);
  parent.add(group);
  return { parent, group, material: mesh.material };
}

describe('retiring a deselected highlight', () => {
  it('renames it, aims its materials at zero, and holds it for disposal', () => {
    const scene = host();
    const retiring: RetiringOverlay[] = [];
    const { parent, group, material } = highlight();

    retireOverlay(scene, retiring, group);

    // The rebuild finds selection overlays by name; a fading one must not be
    // mistaken for the current selection's.
    expect(group.name).toBe('body-selection-overlay-retiring');
    expect(material.userData.targetOpacity).toBe(0);
    expect(scene.fadeIns.has(material)).toBe(true);
    expect(retiring).toHaveLength(1);
    expect(group.parent).toBe(parent);
    expect(scene.renders()).toBe(1);
  });

  it('disposes an overlay with nothing to fade rather than queueing it', () => {
    const scene = host();
    const retiring: RetiringOverlay[] = [];
    const parent = new THREE.Object3D();
    const group = new THREE.Group();
    parent.add(group);

    retireOverlay(scene, retiring, group);

    expect(retiring).toHaveLength(0);
    expect(group.parent).toBeNull();
  });

  it('disposes it once its fade has reached zero', () => {
    const scene = host();
    const retiring: RetiringOverlay[] = [];
    const { group, material } = highlight();
    retireOverlay(scene, retiring, group);

    disposeSettledOverlays(retiring);
    expect(retiring).toHaveLength(1);

    material.opacity = 0;
    disposeSettledOverlays(retiring);
    expect(retiring).toHaveLength(0);
    expect(group.parent).toBeNull();
  });

  /**
   * The fade rides the selection manager's fade set, and a rebuild that
   * replaces the bodies clears that set outright. Anything mid-fade stops
   * easing there and never reaches zero, so the settled sweep never disposes
   * it — and a non-empty retiring list is one of the conditions that keeps
   * the viewport's on-demand render loop awake. Deselecting a body and then
   * editing a parameter inside the same fade used to leave the viewport
   * rendering at full rate on a still scene for the rest of the session.
   */
  it('is disposed outright when the rebuild kills its fade', () => {
    const scene = host();
    const retiring: RetiringOverlay[] = [];
    const { group, material } = highlight();
    retireOverlay(scene, retiring, group);

    // What `SelectionManager.resetForRebuild` does on a bodies-changed pass.
    scene.fadeIns.clear();
    material.opacity = 0.21;

    // The settled sweep alone cannot retire it: the fade will never advance
    // again, so the opacity it stopped at is the opacity it keeps.
    disposeSettledOverlays(retiring);
    expect(retiring).toHaveLength(1);

    disposeRetiringOverlays(retiring);
    expect(retiring).toHaveLength(0);
    expect(group.parent).toBeNull();
    expect(group.children).toHaveLength(0);
  });
});
