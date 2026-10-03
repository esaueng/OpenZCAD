import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyDisplayMode } from './objects';
import {
  EDGE_IDLE_COLOR,
  EDGE_IDLE_OPACITY,
  EDGE_WIREFRAME_COLOR
} from '../pick/edges';

function bodyWithEdges() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshPhongMaterial()
  );
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(body.geometry),
    new THREE.LineBasicMaterial()
  );
  body.add(edges);
  group.add(body);
  return { group, body, edges };
}

describe('applyDisplayMode', () => {
  it('restores a selected face made while its body was in wireframe', () => {
    const { group, body } = bodyWithEdges();
    applyDisplayMode(group, 'wireframe');
    const selectedFace = new THREE.Mesh(
      body.geometry.clone(),
      body.material.clone()
    );
    selectedFace.userData.selectionOverlay = true;
    selectedFace.userData.ownColourFill = true;
    body.add(selectedFace);
    expect(selectedFace.material.visible).toBe(false);

    for (const mode of [
      'wireframe',
      'shaded-edges',
      'wireframe',
      'shaded'
    ] as const) {
      applyDisplayMode(group, mode);
      expect(selectedFace.visible).toBe(mode !== 'wireframe');
      expect(selectedFace.material.visible).toBe(mode !== 'wireframe');
    }
  });

  it.each([
    ['shaded-edges', true, true],
    ['shaded', true, false],
    ['wireframe', false, true]
  ] as const)(
    'renders %s with faces=%s and topology edges=%s',
    (mode, facesVisible, edgesVisible) => {
      const { group, body, edges } = bodyWithEdges();

      applyDisplayMode(group, mode);

      expect(body.material.visible).toBe(facesVisible);
      expect(body.material.wireframe).toBe(false);
      expect(edges.visible).toBe(edgesVisible);
      expect(edges.material.color.getHex()).toBe(
        mode === 'wireframe' ? EDGE_WIREFRAME_COLOR : EDGE_IDLE_COLOR
      );
      expect(edges.material.opacity).toBe(
        mode === 'wireframe' ? 1 : EDGE_IDLE_OPACITY
      );
    }
  );
});
