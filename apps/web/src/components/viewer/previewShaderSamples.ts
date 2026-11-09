import * as THREE from 'three';
import { createBodyGhost, createFatLineSegments } from '@openzcad/viewport';

/** Use tiny geometry to describe the real preview programs, never a model copy. */
export function previewShaderSamples(
  source: THREE.Material,
  visit: (mesh: THREE.Mesh) => void
) {
  const geometry = new THREE.BoxGeometry();
  const material = source.clone();
  material.onBeforeCompile = source.onBeforeCompile;
  material.customProgramCacheKey = source.customProgramCacheKey;
  const body = new THREE.Mesh(geometry, material);
  const edge = createFatLineSegments([0, 0, 0, 1, 0, 0], {
    color: 0,
    linewidth: 1
  });
  edge.name = 'body-edge';
  body.add(edge);
  const ghost = createBodyGhost(body, {
    faceRange: { triangleStart: 0, triangleCount: 2 }
  });
  const sample = () => {
    visit(body);
    ghost.object.traverse((child) => {
      if (child instanceof THREE.Mesh) visit(child as THREE.Mesh);
    });
  };
  try {
    sample();
    // A pull introduces one clipping plane on both the live solid and veil.
    // Warm those separately: they have different Three program cache keys.
    body.scale.x = 2;
    body.updateMatrixWorld(true);
    ghost.veilAddedMaterial(body);
    sample();
  } finally {
    ghost.dispose();
    geometry.dispose();
    material.dispose();
    edge.geometry.dispose();
    edge.material.dispose();
  }
}
