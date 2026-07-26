import * as THREE from 'three';
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
const IN_PROGRESS_COLOR = 0xf59e0b;
const CIRCLE_SEGMENTS = 96;

export interface SketchModeRig {
  group: THREE.Group;
  /** Rebuilds the committed (blue) polylines from the sketch's objects. */
  setObjects(objects: SketchObjectData[], resolve: (value: unknown) => number): void;
  /** Replaces the in-progress (orange) polyline; null hides it. */
  setInProgress(points: SketchPoint[] | null, closed: boolean): void;
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
      let sweep = ((resolve(data.endAngleDeg) - resolve(data.startAngleDeg)) * Math.PI) / 180;
      if (sweep <= 0) {
        sweep += Math.PI * 2;
      }
      const steps = Math.max(8, Math.ceil((sweep / (Math.PI * 2)) * CIRCLE_SEGMENTS));
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

export function buildSketchModeRig(basis: PlaneBasis): SketchModeRig {
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
  const grid = new THREE.GridHelper(PLANE_EXTENT, PLANE_EXTENT / 10, 0x2c3a4d, 0x1b2634);
  const gridMaterial = grid.material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.5;
  gridMaterial.depthWrite = false;
  grid.quaternion.copy(
    quaternion.clone().multiply(
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0, 1)
      )
    )
  );
  grid.position.copy(origin);
  grid.renderOrder = 6;
  group.add(grid);

  const committedGroup = new THREE.Group();
  committedGroup.name = 'sketch-committed';
  group.add(committedGroup);

  const inProgressMaterial = new THREE.LineBasicMaterial({
    color: IN_PROGRESS_COLOR,
    transparent: true,
    opacity: 0.95,
    depthTest: false
  });
  const inProgressGeometry = new THREE.BufferGeometry();
  const inProgress = new THREE.Line(inProgressGeometry, inProgressMaterial);
  inProgress.renderOrder = 12;
  inProgress.visible = false;
  inProgress.frustumCulled = false;
  group.add(inProgress);

  const disposeChildren = (container: THREE.Object3D) => {
    for (const child of [...container.children]) {
      container.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        (child.geometry as THREE.BufferGeometry).dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  };

  return {
    group,
    setObjects(objects, resolve) {
      disposeChildren(committedGroup);
      for (const data of objects) {
        let polyline: { points: SketchPoint[]; closed: boolean } | null;
        try {
          polyline = objectPolyline(data, resolve);
        } catch {
          continue;
        }
        if (!polyline || polyline.points.length < 2) {
          continue;
        }
        const vertices = polyline.points.map((point) =>
          liftPoint(basis, point)
        );
        const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
        const material = new THREE.LineBasicMaterial({
          color: COMMITTED_COLOR,
          transparent: true,
          opacity: 0.95,
          depthTest: false
        });
        const line = polyline.closed
          ? new THREE.LineLoop(geometry, material)
          : new THREE.Line(geometry, material);
        line.renderOrder = 11;
        line.frustumCulled = false;
        committedGroup.add(line);
      }
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
      inProgress.geometry.dispose();
      inProgress.geometry = new THREE.BufferGeometry().setFromPoints(vertices);
      inProgress.visible = true;
    },
    dispose() {
      group.removeFromParent();
      disposeChildren(committedGroup);
      tint.geometry.dispose();
      tint.material.dispose();
      grid.geometry.dispose();
      gridMaterial.dispose();
      inProgress.geometry.dispose();
      inProgressMaterial.dispose();
    }
  };
}
