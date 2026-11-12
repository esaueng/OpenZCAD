import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { toBodyId, type BodyRepresentation } from '@openzcad/shared';
import { createFatLineSegments } from '../render/scene';
import { createBodyEdgeOverlay } from '../render/edgeOverlay';
import {
  createBoreProfilePreview,
  createCylinderProfilePreview,
  createLinearProfilePreview
} from './cylinderProfilePreview';

const profile = {
  axisStart: { x: 0, y: 0, z: 2 },
  axisEnd: { x: 0, y: 0, z: 20 },
  radius: 28,
  coreRadius: 26
};

function objectAtPoints(points: number[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(points, 3)
  );
  return new THREE.Mesh(geometry);
}

// Two round rims, wall, and cap interior. Every rim point lies on a circle
// of radius two about its own section center (26, 2) or (26, 20).
const points = [
  0, 0, 0, 13, 0, 0, 26, 0, 0, 27.414213562, 0, 0.585786438, 28, 0, 2, 28, 0,
  11, 28, 0, 20, 27.414213562, 0, 21.414213562, 26, 0, 22, 0, 0, 22
];

function coordinates(object: THREE.Mesh) {
  return Array.from(object.geometry.getAttribute('position').array);
}

describe('cylinder profile preview', () => {
  it.each(['radius', 'height'] as const)(
    'preserves rim sections, cap planes and exact cancellation for %s',
    (dimension) => {
      const object = objectAtPoints(points);
      const original = coordinates(object);
      const preview = createCylinderProfilePreview(object, profile, dimension)!;
      for (const delta of [10, -8, 4]) {
        expect(preview.apply(delta)).toBe(true);
        const p = object.geometry.getAttribute('position');
        const dr = dimension === 'radius' ? delta : 0;
        const dz = dimension === 'height' ? delta : 0;
        expect(p.getX(0)).toBe(0);
        expect(p.getZ(0)).toBe(0);
        expect(p.getZ(9)).toBeCloseTo(22 + dz, 5);
        expect(p.getX(5)).toBeCloseTo(28 + dr, 5);
        expect(p.getZ(5)).toBeCloseTo(11 + dz / 2, 5);
        for (const i of [2, 3, 4, 6, 7, 8]) {
          const centerZ = i < 5 ? 2 : 20 + dz;
          expect(
            Math.hypot(p.getX(i) - (26 + dr), p.getZ(i) - centerZ)
          ).toBeCloseTo(2, 5);
        }
        expect(object.geometry.boundingBox!.max.z).toBeCloseTo(22 + dz, 5);
      }
      const latest = coordinates(object);
      for (const delta of [NaN, Infinity, -28])
        expect(preview.apply(delta)).toBe(false);
      expect(coordinates(object)).toEqual(latest);
      preview.restore();
      expect(coordinates(object)).toEqual(original);
    }
  );

  it('moves shared face buffers once and fat-line endpoints without deforming their quad', () => {
    const object = objectAtPoints(points);
    const highlight = new THREE.Mesh(new THREE.BufferGeometry());
    highlight.geometry.setAttribute(
      'position',
      object.geometry.getAttribute('position')
    );
    object.add(highlight);
    const line = createFatLineSegments([28, 0, 2, 28, 0, 20], {
      color: '#ffffff',
      linewidth: 1
    });
    object.add(line);
    const quad = Array.from(line.geometry.getAttribute('position').array);
    const originalPosition = object.geometry.getAttribute('position');
    const preview = createCylinderProfilePreview(object, profile, 'radius')!;
    expect(preview.cachedBytes).toBe((points.length + 6) * 8);
    for (let i = 0; i < 100; i += 1) preview.apply(i / 10);
    expect(object.geometry.getAttribute('position')).toBe(originalPosition);
    expect(line.geometry.getAttribute('instanceStart').getX(0)).toBeCloseTo(
      37.9,
      4
    );
    expect(line.geometry.getAttribute('instanceEnd').getX(0)).toBeCloseTo(
      37.9,
      4
    );
    expect(Array.from(line.geometry.getAttribute('position').array)).toEqual(
      quad
    );
    preview.restore();
    expect(line.geometry.getAttribute('instanceStart').getX(0)).toBe(28);
  });

  it.each(['radius', 'height'] as const)(
    'works about a translated and tilted axis for %s',
    (dimension) => {
      const object = objectAtPoints(points);
      const transform = new THREE.Matrix4()
        .makeRotationY(0.7)
        .setPosition(120, -30, 8);
      object.geometry.applyMatrix4(transform);
      const transformed = {
        ...profile,
        axisStart: new THREE.Vector3()
          .copy(profile.axisStart)
          .applyMatrix4(transform),
        axisEnd: new THREE.Vector3()
          .copy(profile.axisEnd)
          .applyMatrix4(transform)
      };
      const reference = objectAtPoints(points);
      createCylinderProfilePreview(reference, profile, dimension)!.apply(8);
      reference.geometry.applyMatrix4(transform);
      createCylinderProfilePreview(object, transformed, dimension)!.apply(8);
      coordinates(object).forEach((value, index) =>
        expect(value).toBeCloseTo(coordinates(reference)[index]!, 4)
      );
    }
  );

  it('refuses oversized preview caches without changing the installed geometry', () => {
    // 400k vertices: 9.6 MB of rest and velocity, past the 8 MB cap.
    const object = objectAtPoints(Array.from({ length: 1_200_000 }, () => 28));
    const version = (
      object.geometry.getAttribute('position') as THREE.BufferAttribute
    ).version;
    expect(createCylinderProfilePreview(object, profile, 'radius')).toBeNull();
    expect(
      (object.geometry.getAttribute('position') as THREE.BufferAttribute)
        .version
    ).toBe(version);
  });
});

describe('rounded cylinder with its curved outline installed', () => {
  /**
   * The e2e's Ø140 × 22 cylinder with R2 rims, as the viewer installs it: a
   * lathed mesh with the edge overlay and its curved-surface outline, sized
   * so the preview caches about what the kernel's mesh needs (2.3 MB). The
   * outline's share pushed that radius preview past the old 2 MB cap, so the
   * drag rebuilt the body on every frame instead.
   */
  function roundedCylinder() {
    const profilePoints: THREE.Vector2[] = [];
    for (let i = 0; i <= 8; i += 1)
      profilePoints.push(new THREE.Vector2((68 * i) / 8, 0));
    const arc = (cy: number, from: number) => {
      for (let i = 1; i <= 16; i += 1) {
        const angle = from + (Math.PI / 2) * (i / 16);
        profilePoints.push(
          new THREE.Vector2(68 + 2 * Math.cos(angle), cy + 2 * Math.sin(angle))
        );
      }
    };
    arc(2, -Math.PI / 2);
    for (let i = 1; i < 20; i += 1)
      profilePoints.push(new THREE.Vector2(70, 2 + (18 * i) / 20));
    arc(20, 0);
    for (let i = 7; i >= 0; i -= 1)
      profilePoints.push(new THREE.Vector2((68 * i) / 8, 22));
    // Lathe turns about +y; the cylinder's axis is +z, as the kernel's is.
    const lathe = new THREE.LatheGeometry(profilePoints, 400).rotateX(
      Math.PI / 2
    );
    const vertices = Float32Array.from(lathe.getAttribute('position').array);
    const indices = Uint32Array.from(lathe.getIndex()!.array);
    lathe.dispose();
    const body: BodyRepresentation = {
      bodyId: toBodyId('body_rounded_cylinder'),
      name: 'Cylinder 1',
      source: 'primitive',
      mesh: { kind: 'mesh', vertices, indices },
      faceCount: 1,
      color: '#99a0b2',
      consumed: false,
      exportableStep: true,
      volume: 1,
      bbox: { min: { x: -70, y: -70, z: 0 }, max: { x: 70, y: 70, z: 22 } },
      topology: {
        faces: [
          {
            topologyId: 'face:1',
            hash: 1,
            triangleStart: 0,
            triangleCount: indices.length / 3
          }
        ],
        edges: []
      }
    };
    const mesh = new THREE.Mesh(
      new THREE.BufferGeometry()
        .setAttribute('position', new THREE.BufferAttribute(vertices, 3))
        .setIndex(new THREE.BufferAttribute(indices, 1))
    );
    const overlay = createBodyEdgeOverlay(body, { width: 800, height: 600 });
    mesh.add(overlay);
    return { mesh, silhouette: overlay.silhouetteEdges! };
  }

  it('previews the radius instead of refusing the outline cache', () => {
    const { mesh, silhouette } = roundedCylinder();
    expect(silhouette).toBeTruthy();
    const rounded = {
      axisStart: { x: 0, y: 0, z: 2 },
      axisEnd: { x: 0, y: 0, z: 20 },
      radius: 70,
      coreRadius: 68
    };
    const preview = createCylinderProfilePreview(mesh, rounded, 'radius');
    expect(preview).not.toBeNull();
    // The case the old cap refused: more than 2 MB once the outline counts.
    expect(preview!.cachedBytes).toBeGreaterThan(2 * 1024 * 1024);
    const position = mesh.geometry.getAttribute('position');
    const radial = (index: number) =>
      Math.hypot(position.getX(index), position.getY(index));
    const rest = Array.from({ length: position.count }, (_, index) =>
      radial(index)
    );
    const wall = rest.findIndex((value) => Math.abs(value - 70) < 1e-4);
    expect(wall).toBeGreaterThanOrEqual(0);
    expect(preview!.apply(5)).toBe(true);
    expect(radial(wall)).toBeCloseTo(75, 3);
    preview!.restore();
    rest.forEach((value, index) => expect(radial(index)).toBeCloseTo(value, 4));
  });
});

describe('linear profile preview', () => {
  it.each([1, -1])(
    'preserves end rounds, overlays and source buffers for side %s',
    (sign) => {
      const source = [
        0, 0, 0, 0.586, 1.414, 0, 2, 2, 0, 10, 2, 0, 18, 2, 0, 19.414, 1.414, 0,
        20, 0, 0
      ];
      const object = objectAtPoints(source);
      const highlight = new THREE.Mesh(new THREE.BufferGeometry());
      highlight.geometry.setAttribute(
        'position',
        object.geometry.getAttribute('position')
      );
      object.add(highlight);
      const line = createFatLineSegments([0.586, 1.414, 0, 19.414, 1.414, 0], {
        color: '#ffffff',
        linewidth: 1
      });
      object.add(line);
      const quad = Array.from(line.geometry.getAttribute('position').array);
      const original = coordinates(object);
      const profile = {
        axisStart: { x: sign > 0 ? 2 : 18, y: 0, z: 0 },
        axisEnd: { x: sign > 0 ? 18 : 2, y: 0, z: 0 }
      };
      const preview = createLinearProfilePreview(object, profile)!;
      for (const delta of [12, -5, 4, 0]) {
        expect(preview.apply(delta)).toBe(true);
        const position = object.geometry.getAttribute('position');
        for (const i of [0, 1, 2, 4, 5, 6]) {
          const moves = sign > 0 ? i >= 4 : i <= 2;
          expect(position.getX(i)).toBeCloseTo(
            source[i * 3]! + (moves ? sign * delta : 0),
            4
          );
          expect(position.getY(i)).toBeCloseTo(source[i * 3 + 1]!, 4);
        }
        expect(line.geometry.getAttribute('instanceStart').getX(0)).toBeCloseTo(
          position.getX(1),
          4
        );
        expect(line.geometry.getAttribute('instanceEnd').getX(0)).toBeCloseTo(
          position.getX(5),
          4
        );
        expect(
          Array.from(line.geometry.getAttribute('position').array)
        ).toEqual(quad);
      }
      expect(preview.apply(-16)).toBe(false);
      expect(preview.apply(NaN)).toBe(false);
      preview.restore();
      expect(coordinates(object)).toEqual(original);
      expect(source[0]).toBe(0);
    }
  );
});

describe('bore profile preview', () => {
  // A 10 mm bore through z 0..20, with a 1 mm round where it opens on the top
  // cap (z 20..21), inside a body whose outer wall sits at radius 30.
  const bore = {
    axisStart: { x: 0, y: 0, z: 0 },
    axisEnd: { x: 0, y: 0, z: 20 },
    radius: 10,
    rimStart: 0,
    rimEnd: 1
  };
  const rimAt = (angle: number) => [
    10 + 1 - Math.cos(angle),
    0,
    20 + Math.sin(angle)
  ];
  const borePoints = [
    // wall: bottom, middle, top
    10,
    0,
    0,
    0,
    10,
    10,
    10,
    0,
    20,
    // rim round, and where it meets the cap
    ...rimAt(Math.PI / 4),
    11,
    0,
    21,
    // cap interior and outer wall
    20,
    0,
    21,
    30,
    0,
    21,
    30,
    0,
    0,
    // the bottom cap's outer corner, inside nothing
    0,
    30,
    0
  ];

  it('pushes the wall and its rim round out and leaves the body', () => {
    const object = objectAtPoints(borePoints);
    const original = coordinates(object);
    const preview = createBoreProfilePreview(object, bore)!;
    expect(preview).not.toBeNull();
    for (const delta of [3, -4]) {
      expect(preview.apply(delta)).toBe(true);
      const p = object.geometry.getAttribute('position');
      expect(p.getX(0)).toBeCloseTo(10 + delta, 5);
      expect(p.getZ(0)).toBeCloseTo(0, 5);
      expect(p.getY(1)).toBeCloseTo(10 + delta, 5);
      expect(p.getZ(1)).toBeCloseTo(10, 5);
      expect(p.getX(2)).toBeCloseTo(10 + delta, 5);
      // The round keeps its cross-section about a centre that moved with it.
      expect(Math.hypot(p.getX(3) - (11 + delta), p.getZ(3) - 20)).toBeCloseTo(
        1,
        5
      );
      expect(p.getX(4)).toBeCloseTo(11 + delta, 5);
      expect(p.getZ(4)).toBeCloseTo(21, 5);
      for (const index of [5, 6, 7, 8]) {
        expect([p.getX(index), p.getY(index), p.getZ(index)]).toEqual(
          original.slice(index * 3, index * 3 + 3)
        );
      }
    }
    preview.restore();
    expect(coordinates(object)).toEqual(original);
  });

  it('refuses a radius at or below zero and a body with no bore points', () => {
    const preview = createBoreProfilePreview(objectAtPoints(borePoints), bore)!;
    expect(preview.apply(-10)).toBe(false);
    expect(
      createBoreProfilePreview(objectAtPoints([30, 0, 0, 0, 30, 5]), bore)
    ).toBeNull();
  });
});
