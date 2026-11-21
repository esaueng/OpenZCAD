import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { toBodyId, type BodyRepresentation } from '@openzcad/shared';
import {
  applyCoplanarBodyDepthSlots,
  COPLANAR_DEPTH_ATTRIBUTE,
  coplanarBodyDepthSlots
} from './coplanarBodies';
import { createObjectForBody } from './scene';

function box(
  id: string,
  x = 0,
  y = 0,
  z = 0,
  width = 100,
  depth = 80
): BodyRepresentation {
  const geometry = new THREE.BoxGeometry(width, depth, 10);
  geometry.translate(x + width / 2, y + depth / 2, z + 5);
  const mesh = {
    kind: 'mesh' as const,
    vertices: Float32Array.from(geometry.getAttribute('position').array),
    indices: Uint32Array.from(geometry.getIndex()!.array)
  };
  geometry.dispose();
  return {
    bodyId: toBodyId(id),
    name: id,
    source: 'primitive',
    mesh,
    faceCount: 6,
    color: '#ff0000',
    consumed: false,
    exportableStep: true,
    volume: width * depth * 10,
    bbox: { min: { x, y, z }, max: { x: x + width, y: y + depth, z: z + 10 } },
    topology: {
      faces: Array.from({ length: 6 }, (_, index) => ({
        topologyId: `${id}:${index}`,
        hash: index,
        triangleStart: index * 2,
        triangleCount: 2
      })),
      edges: []
    }
  };
}

describe('coplanar opaque body depth', () => {
  it('keeps a persistent winner for partial and exact overlap, independent of insertion order', () => {
    const a = box('a');
    for (const b of [box('b'), box('b', 15, 10, 0, 70, 60)]) {
      expect([...coplanarBodyDepthSlots([a, b])]).toEqual([
        ['a', 0],
        ['b', 1]
      ]);
      expect([
        ...coplanarBodyDepthSlots([b, { ...a, name: 'Renamed' }])
      ]).toEqual([
        ['a', 0],
        ['b', 1]
      ]);
    }
  });

  it('reuses slots for unrelated bodies instead of increasing bias with scene size', () => {
    const bodies = [
      box('a'),
      box('b'),
      ...Array.from({ length: 100 }, (_, i) => box(`d${i}`, (i + 1) * 200))
    ];
    const slots = coplanarBodyDepthSlots(bodies);
    expect(slots.get('b')).toBe(1);
    expect(
      [...slots]
        .filter(([id]) => id.startsWith('d'))
        .every(([, slot]) => slot === 0)
    ).toBe(true);
    expect([
      ...coplanarBodyDepthSlots([box('a'), box('b'), box('c')]).values()
    ]).toEqual([0, 1, 2]);
  });

  it('leaves separated surfaces and edge-only or opposite-facing contact on the normal depth path', () => {
    for (const b of [
      box('b', 15, 10, 0.1, 70, 60),
      box('b', 100),
      box('b', 0, 0, 10)
    ])
      expect([...coplanarBodyDepthSlots([box('a'), b]).values()]).toEqual([
        0, 0
      ]);
  });

  it('supports planar mesh-only references without requiring exact face metadata', () => {
    const a = box('a');
    const b = box('b', 15, 10, 0, 70, 60);
    delete a.topology;
    delete b.topology;
    expect([...coplanarBodyDepthSlots([a, b]).values()]).toEqual([0, 1]);
  });

  it('handles two dense planar references without comparing every triangle pair', () => {
    const segments = 100;
    const geometry = new THREE.PlaneGeometry(100, 80, segments, segments);
    geometry.translate(50, 40, 10);
    const a = box('a');
    a.mesh = {
      kind: 'mesh',
      vertices: Float32Array.from(geometry.getAttribute('position').array),
      indices: Uint32Array.from(geometry.getIndex()!.array)
    };
    delete a.topology;
    const b = { ...a, bodyId: toBodyId('b'), mesh: structuredClone(a.mesh) };
    // 20,000 triangles per reference: a pairwise face scan would do 400M
    // comparisons. This exercises the real mesh fallback, not a timing mock.
    expect([...coplanarBodyDepthSlots([a, b]).values()]).toEqual([0, 1]);
    geometry.dispose();
  });

  it('rechecks offsets when parallel faces share a normal lookup', () => {
    function shelves(id: string, heights: number[]): BodyRepresentation {
      const body = box(id);
      body.mesh = {
        kind: 'mesh',
        vertices: Float32Array.from(
          heights.flatMap((z) => [0, 0, z, 2, 0, z, 0, 2, z])
        ),
        indices: Uint32Array.from({ length: heights.length * 3 }, (_, i) => i)
      };
      delete body.topology;
      body.bbox = {
        min: { x: 0, y: 0, z: Math.min(...heights) },
        max: { x: 2, y: 2, z: Math.max(...heights) }
      };
      return body;
    }
    const first = shelves('a', [0, 2]);
    for (const [height, expected] of [
      [1, 0],
      [2, 1],
      [1, 0],
      [0, 1]
    ] as const) {
      expect(
        coplanarBodyDepthSlots([first, shelves('b', [height])]).get('b')
      ).toBe(expected);
    }
  });

  it('rebuilds cached plane buckets when a retained mesh gets new face ranges', () => {
    const a = box('a');
    const b = box('b');
    const original = a.topology!;
    b.topology = { ...b.topology!, faces: [b.topology!.faces[0]!] };
    const slot = () => coplanarBodyDepthSlots([a, b]).get('b');
    expect(slot()).toBe(1);
    a.topology = { ...original, faces: [original.faces[1]!] };
    expect(slot()).toBe(0);
    a.topology = original;
    expect(slot()).toBe(1);
  });

  it('does not treat curved face ranges as one planar face', () => {
    const a = box('a');
    const b = box('b');
    for (const body of [a, b])
      body.topology = {
        faces: [
          { topologyId: 'curved', hash: 0, triangleStart: 0, triangleCount: 12 }
        ],
        edges: []
      };
    expect([...coplanarBodyDepthSlots([a, b]).values()]).toEqual([0, 0]);
  });

  it('keeps a shallow mesh neighbour at its real depth when it shares smoothed vertices', () => {
    const a = box('a');
    const b = box('b');
    const vertices = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0.1]);
    a.mesh = { kind: 'mesh', vertices, indices: Uint32Array.of(0, 1, 2) };
    b.mesh = {
      kind: 'mesh',
      vertices: vertices.slice(),
      indices: Uint32Array.of(0, 1, 2, 0, 1, 3)
    };
    delete a.topology;
    delete b.topology;
    const object = createObjectForBody(b) as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshPhongMaterial
    >;
    expect(object.geometry.getAttribute('position').count).toBe(4);
    const before = object.geometry.toNonIndexed();
    applyCoplanarBodyDepthSlots([a, b], new Map([[b.bodyId, object]]));
    const depth = object.geometry.getAttribute(COPLANAR_DEPTH_ATTRIBUTE);
    expect(Array.from(depth.array)).toEqual([8, 8, 8, 0, 0, 0]);
    expect(object.geometry.getAttribute('position').array).toEqual(
      before.getAttribute('position').array
    );
    expect(object.geometry.getAttribute('normal').array).toEqual(
      before.getAttribute('normal').array
    );
    expect(Array.from(object.geometry.getIndex()!.array)).toEqual([
      0, 1, 2, 3, 4, 5
    ]);
    before.dispose();
    object.geometry.dispose();
    object.material.dispose();
  });

  it('excludes translucent and consumed bodies', () => {
    for (const overrides of [{ opacity: 0.5 }, { consumed: true }]) {
      const b = { ...box('b'), ...overrides };
      expect([...coplanarBodyDepthSlots([box('a'), b])]).toEqual([['a', 0]]);
    }
  });

  it('updates retained primary materials and resets after hiding/moving a competitor without touching geometry or overlays', () => {
    const a = box('a');
    const b = box('b', 15, 10, 0, 70, 60);
    const objects = new Map(
      [a, b].map((body) => [body.bodyId, createObjectForBody(body)])
    );
    const object = objects.get(b.bodyId) as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshPhongMaterial
    >;
    const positions = object.geometry.getAttribute('position').array.slice();
    const source = b.mesh.vertices.slice();
    const matrix = object.matrix.clone();
    const overlay = new THREE.Mesh(
      new THREE.PlaneGeometry(),
      new THREE.MeshBasicMaterial()
    );
    object.add(overlay);
    applyCoplanarBodyDepthSlots([a, b], objects);
    const depth = object.geometry.getAttribute(COPLANAR_DEPTH_ATTRIBUTE);
    expect(Math.max(...depth.array)).toBeGreaterThan(0);
    expect(object.material.polygonOffsetUnits).toBe(1);
    expect(object.material.depthWrite).toBe(true);
    expect(object.material.depthTest).toBe(true);
    expect(object.geometry.getAttribute('position').array).toEqual(positions);
    expect(b.mesh.vertices).toEqual(source);
    expect(object.matrix).toEqual(matrix);
    expect(overlay.material.polygonOffsetUnits).toBe(0);
    applyCoplanarBodyDepthSlots([b], objects);
    expect(Math.max(...depth.array)).toBe(0);
    applyCoplanarBodyDepthSlots([a, b], objects);
    applyCoplanarBodyDepthSlots([a, { ...b, opacity: 0.4 }], objects);
    expect(Math.max(...depth.array)).toBe(0);
    for (const entry of objects.values()) {
      (entry as THREE.Mesh).geometry.dispose();
      ((entry as THREE.Mesh).material as THREE.Material).dispose();
    }
    overlay.geometry.dispose();
    overlay.material.dispose();
  });

  it('biases only competing faces, preserving a real gap above a body with coplanar sides', () => {
    const a = box('a');
    const b = box('b', 0, 0, 0.02);
    const object = createObjectForBody(b) as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshPhongMaterial
    >;
    applyCoplanarBodyDepthSlots([a, b], new Map([[b.bodyId, object]]));
    const depth = object.geometry.getAttribute(COPLANAR_DEPTH_ATTRIBUTE);
    const normal = object.geometry.getAttribute('normal');
    let biasedSides = 0;
    for (let index = 0; index < depth.count; index++) {
      if (Math.abs(normal.getZ(index)) > 0.9) expect(depth.getX(index)).toBe(0);
      else if (depth.getX(index) > 0) biasedSides++;
    }
    expect(biasedSides).toBeGreaterThan(0);
    expect(object.material.polygonOffsetUnits).toBe(1);
    object.geometry.dispose();
    object.material.dispose();
  });
});
