import * as THREE from 'three';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { createFatLineSegments, type FatLineResolution } from '../render/scene';
import { SELECTION_SEMANTICS } from '../render/semantics';

const GHOST_OPACITY = 0.22;
const GHOST_EDGE_OPACITY = 0.45;

export interface BodyGhost {
  /** Add beside the body it was taken from. */
  readonly object: THREE.Group;
  /** Follows the section view when it moves or closes under a kept ghost. */
  setClippingPlane(plane: THREE.Plane | null): void;
  dispose(): void;
}

/**
 * A translucent copy of a body as it is now, kept while a drag reshapes the
 * body itself: the solid shows the part as it will be, the ghost the part as
 * it was. The ghost sits a little behind the solid in depth, so wherever the
 * two surfaces coincide the solid wins, and the ghost shows only material
 * the change removes. Material the change adds covers the ghost. Its edges
 * stay, faintly, and `faceRange` (the dragged face's triangles) is filled in
 * the selection colour at its old place.
 *
 * Take it before the body is deformed: it copies the body's positions.
 */
export function createBodyGhost(
  body: THREE.Mesh,
  options: {
    faceRange?: { triangleStart: number; triangleCount: number };
    resolution?: FatLineResolution;
    /** The active section's cut, so the ghost is cut like the body. */
    clippingPlane?: THREE.Plane | null;
  } = {}
): BodyGhost {
  const clippingPlanes = options.clippingPlane ? [options.clippingPlane] : null;
  const object = new THREE.Group();
  object.name = 'offset-body-ghost';
  object.matrixAutoUpdate = false;
  body.updateMatrixWorld(true);
  object.matrix.copy(body.matrixWorld);
  const geometry = body.geometry.clone();
  const material = new THREE.MeshStandardMaterial({
    color: 0xb8bfcc,
    roughness: 0.75,
    metalness: 0,
    transparent: true,
    opacity: GHOST_OPACITY,
    depthWrite: false,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 8,
    clippingPlanes
  });
  const shell = new THREE.Mesh(geometry, material);
  shell.name = 'offset-body-ghost-shell';
  shell.renderOrder = 26;
  object.add(shell);

  let face: THREE.Mesh | null = null;
  const index = geometry.index;
  const range = options.faceRange;
  if (index && range && range.triangleCount > 0) {
    const start = range.triangleStart * 3;
    const end = Math.min(index.count, start + range.triangleCount * 3);
    const faceIndices: number[] = [];
    for (let i = start; i < end; i++) faceIndices.push(index.getX(i));
    const faceGeometry = new THREE.BufferGeometry();
    faceGeometry.setAttribute('position', geometry.getAttribute('position'));
    faceGeometry.setIndex(faceIndices);
    face = new THREE.Mesh(
      faceGeometry,
      new THREE.MeshBasicMaterial({
        color: SELECTION_SEMANTICS.selected.face,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 4,
        clippingPlanes
      })
    );
    face.name = 'offset-body-ghost-face';
    face.renderOrder = 27;
    object.add(face);
  }

  let edges: LineSegments2 | null = null;
  const points: number[] = [];
  body.traverse((child) => {
    if (child.name !== 'body-edge' && child.name !== 'body-edge-tangent')
      return;
    const lines = child as THREE.Mesh;
    const start = lines.geometry?.getAttribute('instanceStart');
    const finish = lines.geometry?.getAttribute('instanceEnd');
    if (!start || !finish) return;
    for (let i = 0; i < start.count; i++)
      points.push(
        start.getX(i),
        start.getY(i),
        start.getZ(i),
        finish.getX(i),
        finish.getY(i),
        finish.getZ(i)
      );
  });
  if (points.length) {
    edges = createFatLineSegments(Float32Array.from(points), {
      color: 0xd5dae4,
      linewidth: 1,
      opacity: GHOST_EDGE_OPACITY,
      ...(options.resolution ? { resolution: options.resolution } : {})
    });
    // Fat lines are triangles too: the same bias as the shell keeps an old
    // edge that coincides with the new solid behind it, so a pull covers
    // the ghost's outline as well as its surface.
    edges.material.depthWrite = false;
    edges.material.polygonOffset = true;
    edges.material.polygonOffsetFactor = 2;
    edges.material.polygonOffsetUnits = 8;
    edges.material.clippingPlanes = clippingPlanes;
    edges.name = 'offset-body-ghost-edges';
    edges.renderOrder = 27;
    object.add(edges);
  }

  object.traverse((child) => {
    child.raycast = () => undefined;
    child.castShadow = false;
    child.receiveShadow = false;
  });
  return {
    object,
    setClippingPlane(plane) {
      const planes = plane ? [plane] : null;
      object.traverse((child) => {
        const material = (child as THREE.Mesh).material as
          THREE.Material | undefined;
        if (!material) return;
        material.clippingPlanes = planes;
        material.needsUpdate = true;
      });
    },
    dispose() {
      object.removeFromParent();
      geometry.dispose();
      material.dispose();
      if (face) {
        face.geometry.dispose();
        (face.material as THREE.Material).dispose();
      }
      if (edges) {
        edges.geometry.dispose();
        edges.material.dispose();
      }
    }
  };
}
