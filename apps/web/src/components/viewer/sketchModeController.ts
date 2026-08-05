import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import {
  createFatLine,
  createFatLineMaterial,
  VIEWPORT_RENDER_ORDER,
  type FatLineResolution
} from '@openzcad/viewport';
import type { PlaneBasis } from '@openzcad/geometry';
import type { SketchObjectData } from '@openzcad/shared';
import {
  adaptiveGridSpacing,
  type SketchPoint
} from '../../lib/sketch/session';
import {
  objectPolylines,
  type SketchObjectPolyline
} from '../../lib/objectPolyline';
import { triangulateRegionGeometry } from './regionOverlay';

/**
 * Scene-side rig for in-viewport sketching: a tinted plane quad with a
 * grid, blue polylines for the session sketch's committed objects, and a
 * single orange polyline for the entity being drawn. All geometry lives in
 * one group so entering/leaving sketch mode is add/remove + dispose.
 */

const PLANE_EXTENT = 400;
const TINT_COLOR = 0x0d1b2e;
const COMMITTED_COLOR = 0x4da3ff;
const SELECTED_COLOR = 0xf59e0b;
const IN_PROGRESS_COLOR = 0xf59e0b;
const INFERENCE_COLOR = 0x7dd3fc;
/** Screen-space width in CSS pixels for the sketch polylines. */
const SKETCH_LINE_WIDTH = 1.6;

export interface SketchModeRig {
  group: THREE.Group;
  /** Rebuilds the committed (blue) polylines from the sketch's objects. */
  setObjects(
    objects: { id: string; data: SketchObjectData }[],
    selectedObjectId: string | null,
    resolve: (value: unknown) => number
  ): void;
  /** Updates the adaptive sketch-local grid and returns its minor spacing. */
  setGrid(worldPerPixel: number, visible: boolean): number;
  /** Closed profiles derived from the canonical sketch objects. */
  setProfiles(
    profiles: { outer: SketchPoint[]; holes: SketchPoint[][] }[],
    visible: boolean
  ): void;
  /** Returns the closest committed entity under the current ray. */
  pickObject(raycaster: THREE.Raycaster, threshold: number): string | null;
  /** Replaces the in-progress (orange) polyline; null hides it. */
  setInProgress(points: SketchPoint[] | null, closed: boolean): void;
  /** Temporary horizontal/vertical inference guide. */
  setInference(points: SketchPoint[] | null): void;
  /** Highlights open/gapped endpoints requested by profile diagnostics. */
  setDiagnostics(points: SketchPoint[]): void;
  dispose(): void;
}

function liftPoint(basis: PlaneBasis, point: SketchPoint): THREE.Vector3 {
  return new THREE.Vector3(
    basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
    basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
    basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
  );
}

/**
 * @param resolution Live viewport size in CSS pixels. Read on every rebuild
 * rather than captured once, so objects drawn after a resize come out at the
 * right width even before the next resize sweep.
 */
export function buildSketchModeRig(
  basis: PlaneBasis,
  resolution: () => FatLineResolution
): SketchModeRig {
  const group = new THREE.Group();
  group.name = 'sketch-mode';

  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(basis.normal.x, basis.normal.y, basis.normal.z)
  );
  const origin = new THREE.Vector3(
    basis.origin.x,
    basis.origin.y,
    basis.origin.z
  );

  // Plane tint, slightly behind the sketch geometry to avoid z-fighting.
  const tint = new THREE.Mesh(
    new THREE.PlaneGeometry(PLANE_EXTENT, PLANE_EXTENT),
    new THREE.MeshBasicMaterial({
      color: TINT_COLOR,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  tint.quaternion.copy(quaternion);
  tint.position
    .copy(origin)
    .addScaledVector(
      new THREE.Vector3(basis.normal.x, basis.normal.y, basis.normal.z),
      -0.05
    );
  tint.renderOrder = 5;
  group.add(tint);

  // Grid oriented onto the plane. Two helpers separate major and minor lines;
  // their geometry is rebuilt only when the adaptive 1-2-5 step changes.
  const gridGroup = new THREE.Group();
  gridGroup.name = 'sketch-grid';
  gridGroup.quaternion.copy(
    quaternion
      .clone()
      .multiply(
        new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 1)
        )
      )
  );
  gridGroup.position.copy(origin);
  gridGroup.renderOrder = 6;
  group.add(gridGroup);
  let activeGridSpacing = 0;

  const disposeGrid = () => {
    for (const child of [...gridGroup.children]) {
      gridGroup.remove(child);
      if (child instanceof THREE.LineSegments) {
        (child.geometry as THREE.BufferGeometry).dispose();
        const material = child.material as THREE.Material | THREE.Material[];
        if (Array.isArray(material)) {
          material.forEach((entry) => entry.dispose());
        } else {
          material.dispose();
        }
      }
    }
  };

  const rebuildGrid = (spacing: number) => {
    disposeGrid();
    const extent = spacing * 100;
    const minor = new THREE.GridHelper(extent, 100, 0x8aa4cf, 0x33415a);
    const major = new THREE.GridHelper(extent, 20, 0x9db7df, 0x52698f);
    for (const [helper, opacity] of [
      [minor, 0.32],
      [major, 0.44]
    ] as const) {
      const material = helper.material;
      material.transparent = true;
      material.opacity = opacity;
      material.depthWrite = false;
      helper.renderOrder = 6;
      gridGroup.add(helper);
    }
    activeGridSpacing = spacing;
  };
  rebuildGrid(10);

  const originMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 8,
    sizeAttenuation: false,
    depthTest: true,
    depthWrite: false
  });
  const originMarker = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints([origin]),
    originMaterial
  );
  originMarker.name = 'sketch-origin';
  originMarker.renderOrder = VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH;
  group.add(originMarker);

  const committedGroup = new THREE.Group();
  committedGroup.name = 'sketch-committed';
  group.add(committedGroup);

  const profileGroup = new THREE.Group();
  profileGroup.name = 'sketch-profiles';
  group.add(profileGroup);

  const inProgressMaterial = createFatLineMaterial({
    color: IN_PROGRESS_COLOR,
    linewidth: SKETCH_LINE_WIDTH,
    opacity: 0.95,
    depthTest: true,
    resolution: resolution()
  });
  const inProgress = new Line2(new LineGeometry(), inProgressMaterial);
  inProgress.renderOrder = VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH;
  inProgress.visible = false;
  inProgress.frustumCulled = false;
  group.add(inProgress);

  const inferenceMaterial = createFatLineMaterial({
    color: INFERENCE_COLOR,
    linewidth: 1,
    opacity: 0.72,
    depthTest: false,
    resolution: resolution()
  });
  inferenceMaterial.dashed = true;
  inferenceMaterial.dashSize = 1.2;
  inferenceMaterial.gapSize = 0.8;
  const inference = new Line2(new LineGeometry(), inferenceMaterial);
  inference.name = 'sketch-inference';
  inference.renderOrder = VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH;
  inference.visible = false;
  inference.frustumCulled = false;
  group.add(inference);

  const diagnosticMaterial = new THREE.PointsMaterial({
    color: 0xff5d73,
    size: 9,
    sizeAttenuation: false,
    depthTest: true,
    depthWrite: false
  });
  const diagnostics = new THREE.Points(
    new THREE.BufferGeometry(),
    diagnosticMaterial
  );
  diagnostics.name = 'sketch-profile-diagnostics';
  diagnostics.renderOrder = VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH;
  diagnostics.visible = false;
  group.add(diagnostics);

  const disposeChildren = (container: THREE.Object3D) => {
    for (const child of [...container.children]) {
      container.remove(child);
      // Line2 extends Mesh, so fat lines are covered by the Mesh branch.
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        (child.geometry as THREE.BufferGeometry).dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  };

  return {
    group,
    setObjects(objects, selectedObjectId, resolve) {
      disposeChildren(committedGroup);
      for (const object of objects) {
        // One object can draw several runs — a text object is one loop per
        // glyph region plus one per counter.
        let polylines: SketchObjectPolyline[];
        try {
          polylines = objectPolylines(object.data, resolve);
        } catch {
          continue;
        }
        for (const polyline of polylines) {
          if (polyline.points.length < 2) {
            continue;
          }
          const vertices = polyline.points.map((point) =>
            liftPoint(basis, point)
          );
          // The native line stays on as an invisible pick proxy. Line2 raycasts
          // against a screen-space threshold whereas pickObject's caller supplies
          // a world-unit radius, so keeping it leaves selection behaviour exactly
          // as it was. Both are siblings: an invisible parent would hide the
          // visual with it.
          const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
          const pickProxy = polyline.closed
            ? new THREE.LineLoop(geometry, new THREE.LineBasicMaterial())
            : new THREE.Line(geometry, new THREE.LineBasicMaterial());
          pickProxy.visible = false;
          pickProxy.frustumCulled = false;
          pickProxy.userData.sketchObjectId = object.id;
          committedGroup.add(pickProxy);

          const visual = createFatLine(vertices, {
            color:
              object.id === selectedObjectId
                ? SELECTED_COLOR
                : object.data.construction
                  ? 0x7b8da3
                  : COMMITTED_COLOR,
            linewidth: SKETCH_LINE_WIDTH,
            opacity: object.data.construction ? 0.72 : 0.95,
            depthTest: true,
            closed: polyline.closed,
            resolution: resolution()
          });
          if (object.data.construction) {
            visual.material.dashed = true;
            visual.material.dashSize = 1.4;
            visual.material.gapSize = 1;
          }
          visual.renderOrder = VIEWPORT_RENDER_ORDER.ACTIVE_SKETCH;
          visual.frustumCulled = false;
          visual.raycast = () => undefined; // the proxy is the only pick target
          committedGroup.add(visual);
        }
      }
    },
    setGrid(worldPerPixel, visible) {
      const spacing = adaptiveGridSpacing(worldPerPixel);
      if (Math.abs(spacing - activeGridSpacing) > activeGridSpacing * 1e-9) {
        rebuildGrid(spacing);
      }
      gridGroup.visible = visible;
      return spacing;
    },
    setProfiles(profiles, visible) {
      disposeChildren(profileGroup);
      profileGroup.visible = visible;
      if (!visible) {
        return;
      }
      for (const profile of profiles) {
        if (profile.outer.length < 3) {
          continue;
        }
        const { positions, indices } = triangulateRegionGeometry(
          profile.outer,
          profile.holes,
          basis
        );
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.BufferAttribute(positions, 3)
        );
        geometry.setIndex(indices);
        const material = new THREE.MeshBasicMaterial({
          color: 0x2f7fbd,
          toneMapped: false,
          transparent: true,
          opacity: 0.14,
          depthTest: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_FILL;
        profileGroup.add(mesh);
      }
    },
    pickObject(raycaster, threshold) {
      const priorThreshold = raycaster.params.Line?.threshold;
      raycaster.params.Line = {
        threshold: Math.max(threshold, Number.EPSILON)
      };
      const hit = raycaster.intersectObjects(committedGroup.children, false)[0];
      raycaster.params.Line = { threshold: priorThreshold ?? 1 };
      return typeof hit?.object.userData.sketchObjectId === 'string'
        ? hit.object.userData.sketchObjectId
        : null;
    },
    setInProgress(points, closed) {
      if (!points || points.length < 2) {
        inProgress.visible = false;
        return;
      }
      const vertices = points.map((point) => liftPoint(basis, point));
      if (closed && vertices.length > 2) {
        vertices.push(vertices[0]!.clone());
      }
      const geometry = new LineGeometry();
      geometry.setPositions(
        vertices.flatMap((vertex) => [vertex.x, vertex.y, vertex.z])
      );
      inProgress.geometry.dispose();
      inProgress.geometry = geometry;
      inProgress.computeLineDistances();
      const { width, height } = resolution();
      inProgressMaterial.resolution.set(
        Math.max(width, 1),
        Math.max(height, 1)
      );
      inProgress.visible = true;
    },
    setInference(points) {
      if (!points || points.length < 2) {
        inference.visible = false;
        return;
      }
      const geometry = new LineGeometry();
      geometry.setPositions(
        points
          .map((point) => liftPoint(basis, point))
          .flatMap((point) => [point.x, point.y, point.z])
      );
      inference.geometry.dispose();
      inference.geometry = geometry;
      inference.computeLineDistances();
      const { width, height } = resolution();
      inferenceMaterial.resolution.set(Math.max(width, 1), Math.max(height, 1));
      inference.visible = true;
    },
    setDiagnostics(points) {
      diagnostics.geometry.dispose();
      diagnostics.geometry = new THREE.BufferGeometry().setFromPoints(
        points.map((point) => liftPoint(basis, point))
      );
      diagnostics.visible = points.length > 0;
    },
    dispose() {
      group.removeFromParent();
      disposeChildren(committedGroup);
      disposeChildren(profileGroup);
      disposeGrid();
      tint.geometry.dispose();
      tint.material.dispose();
      originMarker.geometry.dispose();
      originMaterial.dispose();
      inProgress.geometry.dispose();
      inProgressMaterial.dispose();
      inference.geometry.dispose();
      inferenceMaterial.dispose();
      diagnostics.geometry.dispose();
      diagnosticMaterial.dispose();
    }
  };
}
