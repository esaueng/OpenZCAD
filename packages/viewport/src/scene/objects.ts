import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type {
  DisplayMode,
  SectionViewSettings,
  SketchOverlay
} from '../types';
import type { EdgeTopology } from '@openzcad/shared';
import { findBodyId, isViewerMesh, type ViewerMesh } from '../pick/meshes';
import { updateSectionCap } from './sectionCaps';
import {
  applyExactSection,
  type ExactSectionRegionDisplay
} from './exactSection';
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
    if (child.userData.exactSection === true) {
      const material = (child as THREE.Mesh).material;
      if (material instanceof THREE.Material) {
        material.visible = mode !== 'wireframe';
      }
    } else if (isViewerMesh(child) || child.userData.sectionCap === true) {
      const mesh = child as ViewerMesh;
      mesh.material.visible = mode !== 'wireframe';
      mesh.material.wireframe = false;
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

/**
 * The three.js clipping plane for one section-view setting. Points with
 * negative signed distance are clipped, so the normal points down the axis:
 * everything above `offset` along the chosen axis is cut away.
 */
export function sectionClippingPlane(
  section: SectionViewSettings
): THREE.Plane {
  const normal =
    section.plane === 'XY'
      ? new THREE.Vector3(0, 0, -1)
      : section.plane === 'XZ'
        ? new THREE.Vector3(0, -1, 0)
        : new THREE.Vector3(-1, 0, 0);
  return new THREE.Plane(normal, section.offset);
}

/**
 * Applies (or clears, with `null`) a display-only section plane to every
 * material under `root` — body meshes, their edge overlays, and any
 * highlight geometry parented to them. Closed mesh cross-sections receive
 * disposable caps; holes stay open. Back faces remain visible while sectioning
 * and normal face culling returns as soon as the section is cleared.
 *
 * `exact` replaces those caps with the kernel's own section geometry once it
 * has been computed for this plane position. The two never appear together on
 * the same body: one is an approximation of the cut drawn from the display
 * mesh, the other is the cross-section the export writes, and a viewport
 * showing both would be showing the same cut twice at two different
 * fidelities. It is per body, because the kernel can section one body of a
 * model and refuse another — and a body with no exact section still needs its
 * cap, or it renders as an open shell.
 */
export function applySectionPlane(
  root: THREE.Object3D,
  plane: THREE.Plane | null,
  exact: readonly ExactSectionRegionDisplay[] | null = null
) {
  const planes = plane ? [plane] : null;
  const meshes: ViewerMesh[] = [];
  root.updateWorldMatrix(true, true);
  root.traverse((child: THREE.Object3D) => {
    if (child.userData.sectionCap === true) return;
    // Exact section geometry lies in the cutting plane; clipping it would
    // clip it away.
    if (child.userData.exactSection === true) return;
    if (isViewerMesh(child)) meshes.push(child);
    const materials = (child as THREE.Mesh).material;
    for (const material of Array.isArray(materials)
      ? materials
      : materials
        ? [materials]
        : []) {
      material.clippingPlanes = planes;
      // Keep the frozen ground shadow honest: the cut body's shadow should
      // match what is rendered, not the uncut silhouette.
      material.clipShadows = plane !== null;
      if (isViewerMesh(child)) {
        material.side = plane ? THREE.DoubleSide : THREE.FrontSide;
      }
      material.needsUpdate = true;
    }
  });
  // Adding/removing children during traverse would skip siblings.
  const showExact = plane !== null && exact !== null && exact.length > 0;
  const exactBodyIds = new Set(
    showExact ? exact.map((region) => region.bodyId) : []
  );
  for (const mesh of meshes) {
    const replaced = exactBodyIds.has(findBodyId(mesh) ?? '');
    updateSectionCap(mesh, replaced ? null : plane);
  }
  applyExactSection(root, showExact ? exact : null);
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
