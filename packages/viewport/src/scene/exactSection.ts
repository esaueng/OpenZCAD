import * as THREE from 'three';

/**
 * Kernel-computed section geometry, drawn instead of the display caps.
 *
 * The two are deliberately different things. `sectionCaps` intersects the
 * disposable tessellation and fills what it can, which is fast enough to keep
 * up with a slider drag and is an approximation of the cut. What arrives here
 * comes from the kernel's own section operation: exact cross-section faces,
 * their boundary curves, and an area that has been checked against the
 * tessellation before it was allowed this far. It is the geometry the DXF
 * export writes, so it is drawn with its boundary curves showing — the cut
 * outline you would get in a file, not a shaded approximation of it.
 */

/** Kernel-computed section geometry, never a document face or a pick target. */
export const EXACT_SECTION = 'viewport-exact-section';

/**
 * Cut-surface fill: a cool slate against the warm default body colour, so the
 * exact cut never reads as more of the body's own surface.
 */
const CUT_COLOR = 0x86a9c6;
/** The section curves themselves, drawn over the fill. */
const CURVE_COLOR = 0x14293c;

export interface ExactSectionLoopDisplay {
  /** Closed document-space polyline; the closing point is not repeated. */
  readonly points: readonly (readonly [number, number, number])[];
}

export interface ExactSectionRegionDisplay {
  /** The body this cross-section belongs to. */
  readonly bodyId: string;
  /** Triangles of the cut surface, in document space. */
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly loops: readonly ExactSectionLoopDisplay[];
}

function disposeSection(group: THREE.Object3D) {
  group.traverse((child: THREE.Object3D) => {
    const disposable = child as unknown as {
      geometry?: { dispose(): void };
      material?: { dispose(): void };
    };
    disposable.geometry?.dispose();
    disposable.material?.dispose();
  });
}

/**
 * Replace the exact section geometry under `root`.
 *
 * Passing `null` (or nothing to draw) removes it, which is what happens the
 * moment the plane moves again: an exact section belongs to one plane
 * position, and showing it beside a clipped preview of a different one would
 * be a drawing of a cut that is not on screen.
 */
export function applyExactSection(
  root: THREE.Object3D,
  regions: readonly ExactSectionRegionDisplay[] | null
) {
  const previous = root.getObjectByName(EXACT_SECTION);
  if (previous) {
    previous.removeFromParent();
    disposeSection(previous);
  }
  if (!regions || regions.length === 0) {
    return;
  }
  const group = new THREE.Group();
  group.name = EXACT_SECTION;
  group.userData.exactSection = true;
  for (const region of regions) {
    if (region.indices.length >= 3) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(region.positions, 3)
      );
      geometry.setIndex(new THREE.BufferAttribute(region.indices, 1));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshPhongMaterial({
          color: CUT_COLOR,
          side: THREE.DoubleSide,
          // The cut surface lies in the clipping plane itself; without the
          // offset it fights the clipped body's own edge for the same depth.
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1
        })
      );
      mesh.name = `${EXACT_SECTION}-fill`;
      mesh.userData.exactSection = true;
      mesh.raycast = () => undefined;
      group.add(mesh);
    }
    for (const loop of region.loops) {
      if (loop.points.length < 2) {
        continue;
      }
      const points = new Float32Array(loop.points.length * 3);
      loop.points.forEach((point, index) => {
        points.set(point, index * 3);
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
      // A LineLoop, not LineSegments: the display-mode pass owns the body's
      // edge overlays and must not recolour or hide a section curve.
      const curve = new THREE.LineLoop(
        geometry,
        new THREE.LineBasicMaterial({ color: CURVE_COLOR, depthTest: false })
      );
      curve.name = `${EXACT_SECTION}-curve`;
      curve.userData.exactSection = true;
      curve.renderOrder = 1;
      curve.raycast = () => undefined;
      group.add(curve);
    }
  }
  root.add(group);
}
