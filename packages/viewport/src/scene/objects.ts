import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { DisplayMode, SketchOverlay } from '../types';
import type { EdgeTopology } from '@openzcad/shared';
import { isViewerMesh } from '../pick/meshes';
import {
  EDGE_IDLE_COLOR,
  EDGE_IDLE_OPACITY,
  EDGE_WIREFRAME_COLOR
} from '../pick/edges';

export function disposeObject(object: THREE.Object3D) {
  object.traverse((child: THREE.Object3D) => {
    const disposable = child as unknown as {
      geometry?: { dispose(): void };
      material?: { dispose(): void } | { dispose(): void }[];
    };
    disposable.geometry?.dispose();
    if (Array.isArray(disposable.material)) {
      for (const material of disposable.material) {
        material.dispose();
      }
    } else {
      disposable.material?.dispose();
    }
  });
}

/** CSS2D label elements stay in the DOM unless removed explicitly. */
export function clearGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    child.traverse((node: THREE.Object3D) => {
      if (node instanceof CSS2DObject) {
        node.element.remove();
      }
    });
    group.remove(child);
    disposeObject(child);
  }
}

/** Smooth B-Rep parameterization seams are topology, not visible part edges. */
export function shouldRenderTopologyEdge(edge: EdgeTopology): boolean {
  return edge.displayRole !== 'seam' && edge.points.length >= 6;
}

export function makeLabel(className: string, text: string): CSS2DObject {
  const element = document.createElement('div');
  element.className = className;
  element.textContent = text;
  return new CSS2DObject(element);
}

/**
 * CAD display modes keep analytic/topological edges separate from the
 * tessellated face mesh. Three's material wireframe exposes every render
 * triangle, which is useful for mesh debugging but is not a CAD wireframe.
 */
export function applyDisplayMode(bodyGroup: THREE.Group, mode: DisplayMode) {
  bodyGroup.traverse((child: THREE.Object3D) => {
    if (isViewerMesh(child)) {
      child.material.visible = mode !== 'wireframe';
      child.material.wireframe = false;
    } else if (child instanceof THREE.LineSegments || child instanceof Line2) {
      child.visible = mode !== 'shaded';
      child.userData.displayMode = mode;
      const material = child.material as THREE.Material & {
        color?: THREE.Color;
      };
      if (child.userData.selected !== true && material.color) {
        material.color.setHex(
          mode === 'wireframe' ? EDGE_WIREFRAME_COLOR : EDGE_IDLE_COLOR
        );
        material.opacity = mode === 'wireframe' ? 1 : EDGE_IDLE_OPACITY;
      }
    }
  });
}

export function sketchCentroid(sketch: SketchOverlay): THREE.Vector3 {
  const centroid = new THREE.Vector3();
  for (const point of sketch.points) {
    centroid.add(new THREE.Vector3(point.x, point.y, point.z));
  }
  return centroid.divideScalar(Math.max(sketch.points.length, 1));
}

/** Draws on top of the model so the drag target is never buried in geometry. */
export function markExtrudeGizmo(object: THREE.Object3D) {
  object.traverse((child) => {
    child.userData.extrudeGizmo = true;
    child.renderOrder = 20;
    const material = (child as THREE.Mesh | THREE.Line).material;
    if (material instanceof THREE.Material) {
      material.depthTest = false;
      material.transparent = true;
    }
  });
}

/** A lightweight live prism; the canonical B-rep is only created on confirm. */
export function createExtrudePreviewGeometry(
  sketch: SketchOverlay,
  distance: number
): THREE.BufferGeometry {
  const count = sketch.points.length;
  const normal = new THREE.Vector3(
    sketch.normal.x,
    sketch.normal.y,
    sketch.normal.z
  );
  const vertices: number[] = [];
  for (const point of sketch.points) {
    vertices.push(point.x, point.y, point.z);
  }
  for (const point of sketch.points) {
    vertices.push(
      point.x + normal.x * distance,
      point.y + normal.y * distance,
      point.z + normal.z * distance
    );
  }

  const localPoints = sketch.profile.map(
    (point) => new THREE.Vector2(point.x, point.y)
  );
  const capTriangles = THREE.ShapeUtils.triangulateShape(localPoints, []);
  const indices: number[] = [];
  for (const triangle of capTriangles) {
    const [a, b, c] = triangle;
    if (a === undefined || b === undefined || c === undefined) {
      continue;
    }
    indices.push(a, c, b, a + count, b + count, c + count);
  }
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    indices.push(index, next, next + count, index, next + count, index + count);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(vertices, 3)
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
