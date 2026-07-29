import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import {
  createFatLine,
  createFatLineMaterial,
  type FatLineResolution
} from '@openzcad/viewport';
import type { PlaneBasis } from '@openzcad/geometry';
import type { SketchObjectData } from '@openzcad/shared';
import type { SketchPoint } from '../../lib/sketch/session';

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
const CIRCLE_SEGMENTS = 96;
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
  /** Returns the closest committed entity under the current ray. */
  pickObject(raycaster: THREE.Raycaster, threshold: number): string | null;
  /** Replaces the in-progress (orange) polyline; null hides it. */
  setInProgress(points: SketchPoint[] | null, closed: boolean): void;
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

/** Sampled plane-local polyline for one sketch object; null for unsupported. */
export function objectPolyline(
  data: SketchObjectData,
  resolve: (value: unknown) => number
): { points: SketchPoint[]; closed: boolean } | null {
  switch (data.objectKind) {
    case 'line':
      return {
        points: [
          { x: resolve(data.x1), y: resolve(data.y1) },
          { x: resolve(data.x2), y: resolve(data.y2) }
        ],
        closed: false
      };
    case 'rectangle': {
      const width = resolve(data.width) / 2;
      const height = resolve(data.height) / 2;
      const cx = resolve(data.centerX);
      const cy = resolve(data.centerY);
      return {
        points: [
          { x: cx - width, y: cy - height },
          { x: cx + width, y: cy - height },
          { x: cx + width, y: cy + height },
          { x: cx - width, y: cy + height }
        ],
        closed: true
      };
    }
    case 'circle':
    case 'polygon': {
      const radius = resolve(data.radius);
      const cx = resolve(data.centerX);
      const cy = resolve(data.centerY);
      const sides =
        data.objectKind === 'polygon'
          ? Math.max(3, Math.round(resolve(data.sides)))
          : CIRCLE_SEGMENTS;
      const phase = data.objectKind === 'polygon' ? Math.PI / 2 : 0;
      const points: SketchPoint[] = [];
      for (let index = 0; index < sides; index += 1) {
        const angle = (index / sides) * Math.PI * 2 + phase;
        points.push({
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius
        });
      }
      return { points, closed: true };
    }
    case 'arc': {
      const radius = resolve(data.radius);
      const cx = resolve(data.centerX);
      const cy = resolve(data.centerY);
      const start = (resolve(data.startAngleDeg) * Math.PI) / 180;
      let sweep =
        ((resolve(data.endAngleDeg) - resolve(data.startAngleDeg)) * Math.PI) /
        180;
      if (sweep <= 0) {
        sweep += Math.PI * 2;
      }
      const steps = Math.max(
        8,
        Math.ceil((sweep / (Math.PI * 2)) * CIRCLE_SEGMENTS)
      );
      const points: SketchPoint[] = [];
      for (let index = 0; index <= steps; index += 1) {
        const angle = start + (sweep * index) / steps;
        points.push({
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius
        });
      }
      return { points, closed: false };
    }
  }
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

  // Grid oriented onto the plane. GridHelper spans XZ with +Y normal.
  const grid = new THREE.GridHelper(
    PLANE_EXTENT,
    PLANE_EXTENT / 10,
    0x2c3a4d,
    0x1b2634
  );
  const gridMaterial = grid.material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.5;
  gridMaterial.depthWrite = false;
  grid.quaternion.copy(
    quaternion
      .clone()
      .multiply(
        new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 1)
        )
      )
  );
  grid.position.copy(origin);
  grid.renderOrder = 6;
  group.add(grid);

  const originMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 8,
    sizeAttenuation: false,
    depthTest: false,
    depthWrite: false
  });
  const originMarker = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints([origin]),
    originMaterial
  );
  originMarker.name = 'sketch-origin';
  originMarker.renderOrder = 10;
  group.add(originMarker);

  const committedGroup = new THREE.Group();
  committedGroup.name = 'sketch-committed';
  group.add(committedGroup);

  const inProgressMaterial = createFatLineMaterial({
    color: IN_PROGRESS_COLOR,
    linewidth: SKETCH_LINE_WIDTH,
    opacity: 0.95,
    depthTest: false,
    resolution: resolution()
  });
  const inProgress = new Line2(new LineGeometry(), inProgressMaterial);
  inProgress.renderOrder = 12;
  inProgress.visible = false;
  inProgress.frustumCulled = false;
  group.add(inProgress);

  const diagnosticMaterial = new THREE.PointsMaterial({
    color: 0xff5d73,
    size: 9,
    sizeAttenuation: false,
    depthTest: false,
    depthWrite: false
  });
  const diagnostics = new THREE.Points(
    new THREE.BufferGeometry(),
    diagnosticMaterial
  );
  diagnostics.name = 'sketch-profile-diagnostics';
  diagnostics.renderOrder = 14;
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
        let polyline: { points: SketchPoint[]; closed: boolean } | null;
        try {
          polyline = objectPolyline(object.data, resolve);
        } catch {
          continue;
        }
        if (!polyline || polyline.points.length < 2) {
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
          depthTest: false,
          closed: polyline.closed,
          resolution: resolution()
        });
        if (object.data.construction) {
          visual.material.dashed = true;
          visual.material.dashSize = 1.4;
          visual.material.gapSize = 1;
        }
        visual.renderOrder = 11;
        visual.frustumCulled = false;
        visual.raycast = () => undefined; // the proxy is the only pick target
        committedGroup.add(visual);
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
      tint.geometry.dispose();
      tint.material.dispose();
      grid.geometry.dispose();
      gridMaterial.dispose();
      originMarker.geometry.dispose();
      originMaterial.dispose();
      inProgress.geometry.dispose();
      inProgressMaterial.dispose();
      diagnostics.geometry.dispose();
      diagnosticMaterial.dispose();
    }
  };
}
