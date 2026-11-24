import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  toBodyId,
  type BodyRepresentation,
  type FaceGeometry
} from '@openzcad/shared';
import {
  createObjectForBody,
  prepareBodyGeometry,
  sameBodyRenderGeometry,
  updateObjectForBody
} from './scene';
import { disposeObject } from '../scene/objects';

const RADIUS = 52.5;
const HEIGHT = 60;
const SEGMENTS = 96;
/** The kernel's stray vertex row, a few hundredths above the rim. */
const SLIVER_ROW = 0.023;

/**
 * A cylinder's side wall (axis +z) tessellated like the Lucky Ferret wall:
 * rim vertices at z = 0, a second row half a segment around at z = 0.023,
 * and one tall band of triangles to the top. Every triangle between the
 * first two rows spans a chord of the rim and tilts by up to ~45°.
 */
function sliverCylinder(
  geometry?: Partial<FaceGeometry>,
  reverse = false
): BodyRepresentation {
  const vertices: number[] = [];
  const ring = (z: number, phase: number) => {
    for (let i = 0; i < SEGMENTS; i += 1) {
      const angle = ((i + phase) / SEGMENTS) * Math.PI * 2;
      vertices.push(RADIUS * Math.cos(angle), RADIUS * Math.sin(angle), z);
    }
  };
  ring(0, 0);
  ring(SLIVER_ROW, 0.5);
  ring(HEIGHT, 0.5);
  const indices: number[] = [];
  const push = (a: number, b: number, c: number) =>
    reverse ? indices.push(a, c, b) : indices.push(a, b, c);
  for (let i = 0; i < SEGMENTS; i += 1) {
    const next = (i + 1) % SEGMENTS;
    const bottom = i;
    const bottomNext = next;
    const middle = SEGMENTS + i;
    const middlePrevious = SEGMENTS + ((i + SEGMENTS - 1) % SEGMENTS);
    const top = 2 * SEGMENTS + i;
    const topNext = 2 * SEGMENTS + next;
    // Rim to the sliver row: outward-facing (counter-clockwise from outside).
    push(bottom, bottomNext, middle);
    push(bottom, middle, middlePrevious);
    // Sliver row to the top: tall quads.
    push(middle, SEGMENTS + next, topNext);
    push(middle, topNext, top);
  }
  return {
    bodyId: toBodyId('body_sliver'),
    name: 'Sliver cylinder',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from(vertices),
      indices: Uint32Array.from(indices)
    },
    faceCount: 1,
    color: '#888888',
    consumed: false,
    exportableStep: true,
    volume: 1,
    bbox: {
      min: { x: -RADIUS, y: -RADIUS, z: 0 },
      max: { x: RADIUS, y: RADIUS, z: HEIGHT }
    },
    topology: {
      faces: [
        {
          topologyId: 'face:wall',
          hash: 1,
          triangleStart: 0,
          triangleCount: indices.length / 3,
          ...(geometry
            ? {
                geometry: {
                  surfaceType: 'cylinder',
                  area: 2 * Math.PI * RADIUS * HEIGHT,
                  center: { x: 0, y: 0, z: HEIGHT / 2 },
                  radius: RADIUS,
                  axisStart: { x: 0, y: 0, z: 0 },
                  axisEnd: { x: 0, y: 0, z: HEIGHT },
                  ...geometry
                }
              }
            : {})
        }
      ],
      edges: [{ topologyId: 'edge:1', hash: 1, points: [0, 0, 0, 1, 0, 0] }]
    }
  };
}

/** Largest angle, in degrees, between a shading normal and the radial one. */
function worstRadialError(
  positions: ArrayLike<number>,
  normals: ArrayLike<number>,
  sign = 1
) {
  let worst = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const length = Math.hypot(x, y);
    const dot =
      (sign * (normals[i]! * x + normals[i + 1]! * y)) /
      (length * Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!));
    worst = Math.max(worst, Math.acos(Math.min(1, dot)));
  }
  return THREE.MathUtils.radToDeg(worst);
}

describe('exact shading normals on analytic faces', () => {
  it('reproduces the rim streaks with facet normals alone', () => {
    const data = prepareBodyGeometry(sliverCylinder());
    expect(worstRadialError(data.positions, data.normals)).toBeGreaterThan(10);
  });

  it('shades a cylinder with sliver strips by its exact radial normal', () => {
    const data = prepareBodyGeometry(sliverCylinder({}));
    expect(worstRadialError(data.positions, data.normals)).toBeLessThan(0.01);
  });

  it('follows the facet orientation of a reversed face', () => {
    const data = prepareBodyGeometry(sliverCylinder({}, true));
    expect(worstRadialError(data.positions, data.normals, -1)).toBeLessThan(
      0.01
    );
  });

  it('keeps facet normals when the measured surface no longer fits the mesh', () => {
    const stale = prepareBodyGeometry(sliverCylinder({ radius: RADIUS + 1 }));
    const facets = prepareBodyGeometry(sliverCylinder());
    expect(Array.from(stale.normals)).toEqual(Array.from(facets.normals));
  });

  it('keeps facet normals when the measurement fits only part of the face', () => {
    // The old axis, moved sideways by one radius: the measured cylinder
    // still passes through two generators of the mesh.
    const moved = prepareBodyGeometry(
      sliverCylinder({
        axisStart: { x: RADIUS, y: 0, z: 0 },
        axisEnd: { x: RADIUS, y: 0, z: HEIGHT }
      })
    );
    const facets = prepareBodyGeometry(sliverCylinder());
    expect(Array.from(moved.normals)).toEqual(Array.from(facets.normals));
  });

  it('treats a measurement change as a render change', () => {
    expect(sameBodyRenderGeometry(sliverCylinder(), sliverCylinder({}))).toBe(
      false
    );
    expect(sameBodyRenderGeometry(sliverCylinder({}), sliverCylinder({}))).toBe(
      true
    );
  });

  it('keeps the exact normals when a reused body is updated in place', () => {
    const body = sliverCylinder({});
    const object = createObjectForBody(body) as THREE.Mesh;
    try {
      expect(updateObjectForBody(object, sliverCylinder({}))).toBe(true);
      const geometry = object.geometry;
      expect(
        worstRadialError(
          geometry.getAttribute('position').array,
          geometry.getAttribute('normal').array
        )
      ).toBeLessThan(0.01);
    } finally {
      disposeObject(object);
    }
  });

  it('shades cone and torus faces by their exact normals', () => {
    const torus = new THREE.TorusGeometry(20, 4, 24, 96);
    const cone = new THREE.CylinderGeometry(4, 10, 12, 96, 1, true);
    try {
      const faces = [
        {
          mesh: torus,
          geometry: {
            surfaceType: 'torus',
            torusCenter: { x: 0, y: 0, z: 0 },
            axis: { x: 0, y: 0, z: 1 },
            majorRadius: 20,
            minorRadius: 4
          },
          exact: (x: number, y: number, z: number) => {
            const rho = Math.hypot(x, y);
            return [x - (20 * x) / rho, y - (20 * y) / rho, z];
          }
        },
        {
          // THREE's cylinder runs along +y; radius 4 at y = 6, 10 at y = -6,
          // so the apex sits at y = 14 and the half-angle is atan(6 / 12).
          mesh: cone,
          geometry: {
            surfaceType: 'cone',
            apex: { x: 0, y: 14, z: 0 },
            axis: { x: 0, y: 1, z: 0 },
            halfAngle: Math.atan2(6, 12)
          },
          exact: (x: number, _y: number, z: number) => {
            const rho = Math.hypot(x, z);
            return [(x / rho) * 12, 6, (z / rho) * 12];
          }
        }
      ];
      for (const { mesh, geometry, exact } of faces) {
        const body = sliverCylinder({});
        body.mesh = {
          kind: 'mesh',
          vertices: Float32Array.from(mesh.getAttribute('position').array),
          indices: Uint32Array.from(mesh.getIndex()!.array)
        };
        body.topology!.faces = [
          {
            topologyId: 'face:0',
            hash: 1,
            triangleStart: 0,
            triangleCount: body.mesh.indices.length / 3,
            geometry: {
              area: 1,
              center: { x: 0, y: 0, z: 0 },
              ...geometry
            }
          }
        ];
        const data = prepareBodyGeometry(body);
        let worst = 0;
        for (let i = 0; i < data.positions.length; i += 3) {
          const [ex, ey, ez] = exact(
            data.positions[i]!,
            data.positions[i + 1]!,
            data.positions[i + 2]!
          ) as [number, number, number];
          const n = [
            data.normals[i]!,
            data.normals[i + 1]!,
            data.normals[i + 2]!
          ];
          const dot =
            (n[0]! * ex + n[1]! * ey + n[2]! * ez) /
            (Math.hypot(ex, ey, ez) * Math.hypot(n[0]!, n[1]!, n[2]!));
          worst = Math.max(worst, Math.acos(Math.min(1, dot)));
        }
        expect(THREE.MathUtils.radToDeg(worst)).toBeLessThan(0.01);
      }
    } finally {
      torus.dispose();
      cone.dispose();
    }
  });
});
