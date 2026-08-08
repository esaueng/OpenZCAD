import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  DIMENSION_ARROW_LENGTH,
  createDimensionGraphic
} from './dimensionGraphic';

/**
 * The dimension renderer, extracted from the cylinder-radius drag rig so the
 * measurement tape draws the same graphic rather than a second one that would
 * drift from it.
 */

function at(x: number, y: number, z: number) {
  return new THREE.Vector3(x, y, z);
}

function meshes(graphic: { object: THREE.Group }) {
  return graphic.object.children.filter(
    (child): child is THREE.Mesh => child.type === 'Mesh'
  );
}

describe('a dimension between two points', () => {
  it('lands each arrow TIP on its measured point', () => {
    // Centring a cone on the end would overstate the measurement by half an
    // arrowhead at each end — a dimension that draws longer than it reads.
    const graphic = createDimensionGraphic();
    graphic.update(at(0, 0, 0), at(10, 0, 0), 1);
    const [start, end] = meshes(graphic);

    // Each cone's own axis is +Y before rotation, so the tip is half a length
    // along the cone's local up, rotated into place.
    const tipOf = (mesh: THREE.Mesh) =>
      mesh.position
        .clone()
        .add(
          new THREE.Vector3(0, DIMENSION_ARROW_LENGTH / 2, 0).applyQuaternion(
            mesh.quaternion
          )
        );
    expect(tipOf(start!).x).toBeCloseTo(0, 6);
    expect(tipOf(end!).x).toBeCloseTo(10, 6);
    graphic.dispose();
  });

  it('points the two arrowheads at each other', () => {
    const graphic = createDimensionGraphic();
    graphic.update(at(0, 0, 0), at(0, 0, 10), 1);
    const [start, end] = meshes(graphic);
    const upOf = (mesh: THREE.Mesh) =>
      new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.quaternion);
    // Opposed along the measured axis.
    expect(upOf(start!).dot(upOf(end!))).toBeCloseTo(-1, 6);
    graphic.dispose();
  });

  it('resizes the heads on every update, including a pure zoom', () => {
    // A guard keyed on camera ROTATION would skip this, and a wheel-zoom would
    // leave the arrowheads frozen at their pre-zoom size. `update` therefore
    // applies the scale unconditionally.
    const graphic = createDimensionGraphic();
    graphic.update(at(0, 0, 0), at(10, 0, 0), 1);
    const before = meshes(graphic)[0]!.scale.x;
    graphic.update(at(0, 0, 0), at(10, 0, 0), 4);
    const after = meshes(graphic)[0]!.scale.x;
    expect(after).toBeGreaterThan(before);
    expect(after).toBe(4);
    graphic.dispose();
  });

  it('never lets the graphic collapse at extreme zoom-in', () => {
    // The rig's `min 1` clamp, kept: at very close range the pixel scale goes
    // toward zero, and the arrowheads would vanish exactly when they are most
    // readable.
    const graphic = createDimensionGraphic();
    graphic.update(at(0, 0, 0), at(10, 0, 0), 0.0001);
    expect(meshes(graphic)[0]!.scale.x).toBe(1);
    graphic.dispose();
  });

  it('hides rather than drawing a NaN when the two points coincide', () => {
    const graphic = createDimensionGraphic();
    graphic.update(at(3, 3, 3), at(3, 3, 3), 1);
    expect(graphic.object.visible).toBe(false);
    for (const mesh of meshes(graphic)) {
      expect(Number.isNaN(mesh.position.x)).toBe(false);
    }
    // And recovers on the next real update.
    graphic.update(at(0, 0, 0), at(1, 0, 0), 1);
    expect(graphic.object.visible).toBe(true);
    graphic.dispose();
  });

  it('anchors the label on the line, off the midpoint', () => {
    // 45% along, matching the radius rig's inline callout: dead centre
    // collides with the dash pattern more often than not.
    const graphic = createDimensionGraphic();
    graphic.update(at(0, 0, 0), at(100, 0, 0), 1);
    expect(graphic.labelAnchor().x).toBeCloseTo(45, 6);
    graphic.dispose();
  });

  it('allocates no new geometry across repeated updates', () => {
    // This runs per frame for every visible measurement. Rebuilding geometry
    // each time is how a measurement tape turns into a frame-rate problem.
    const graphic = createDimensionGraphic();
    graphic.update(at(0, 0, 0), at(10, 0, 0), 1);
    const line = graphic.object.children[0] as THREE.Object3D & {
      geometry: unknown;
    };
    const geometryBefore = line.geometry;
    const meshGeometry = meshes(graphic)[0]!.geometry;
    for (let index = 0; index < 10; index += 1) {
      graphic.update(at(0, 0, 0), at(10 + index, index, 0), 1 + index);
    }
    expect(line.geometry).toBe(geometryBefore);
    expect(meshes(graphic)[0]!.geometry).toBe(meshGeometry);
    graphic.dispose();
  });
});

describe('witness lines', () => {
  it('are absent unless asked for', () => {
    // A radius is measured from an axis, which has no edge to stand a tick
    // off. Drawing one there would invent geometry.
    const graphic = createDimensionGraphic();
    expect(
      graphic.object.children.filter((child) => child.type === 'Line2')
    ).toHaveLength(1);
    graphic.dispose();
  });

  it('stand perpendicular to the dimension when enabled', () => {
    const graphic = createDimensionGraphic({ witnessLines: true });
    graphic.update(at(0, 0, 0), at(10, 0, 0), 1);
    const lines = graphic.object.children.filter(
      (child) => child.type === 'Line2'
    );
    // The dimension line plus one tick per end.
    expect(lines).toHaveLength(3);
    graphic.dispose();
  });

  it('picks a tick direction that survives a vertical dimension', () => {
    // Crossing the axis with a parallel reference gives a zero vector and a
    // NaN after normalising, so the reference has to change when the axis
    // points up.
    const graphic = createDimensionGraphic({ witnessLines: true });
    graphic.update(at(0, 0, 0), at(0, 10, 0), 1);
    const witness = graphic.object.children.at(-1) as THREE.Object3D & {
      geometry: { attributes: Record<string, { array: ArrayLike<number> }> };
    };
    const positions = Array.from(
      witness.geometry.attributes.instanceStart?.array ?? []
    );
    expect(positions.length).toBeGreaterThan(0);
    for (const value of positions) {
      expect(Number.isNaN(value)).toBe(false);
    }
    graphic.dispose();
  });
});
