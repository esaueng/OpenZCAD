import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  toBodyId,
  type BodyRepresentation,
  type BodyTopology,
  type MeshGeometry
} from '@openzcad/shared';
import { createObjectForBody } from './scene';

/*
 * The smoothing pass before it moved to typed arrays, kept verbatim as the
 * reference: render vertices, normals and indices must match it exactly.
 */
const CAD_CREASE_ANGLE = THREE.MathUtils.degToRad(30);
const DOT_EPSILON = 1e-10;

interface MeshFace {
  normal: THREE.Vector3;
  cornerAngles: [number, number, number];
}

interface MeshEdge {
  start: number;
  end: number;
  faces: number[];
}

function cornerAngle(
  center: THREE.Vector3,
  first: THREE.Vector3,
  second: THREE.Vector3
): number {
  const firstDirection = first.clone().sub(center);
  const secondDirection = second.clone().sub(center);
  const crossLength = firstDirection.cross(secondDirection).length();
  const dot = first.clone().sub(center).dot(second.clone().sub(center));
  return Math.atan2(crossLength, dot);
}

/**
 * Builds angle-weighted smoothing groups from triangle adjacency. Adjacent
 * triangles share a render vertex only when their dihedral angle is below the
 * CAD crease threshold, so large planar faces cannot borrow normals from their
 * side walls while cylinders and fillets remain visually smooth.
 */
function legacyGeometryFromMesh(
  mesh: MeshGeometry,
  topology?: BodyTopology
): THREE.BufferGeometry {
  const sourcePositions = mesh.vertices;
  const sourceIndices = mesh.indices;
  const triangleCount = Math.floor(sourceIndices.length / 3);
  const topologyFaceByTriangle = new Int32Array(triangleCount);
  topologyFaceByTriangle.fill(-1);
  for (const [topologyFaceIndex, face] of (topology?.faces ?? []).entries()) {
    const start = Math.max(0, Math.floor(face.triangleStart));
    const end = Math.min(
      triangleCount,
      Math.ceil(face.triangleStart + face.triangleCount)
    );
    for (let triangleIndex = start; triangleIndex < end; triangleIndex += 1) {
      topologyFaceByTriangle[triangleIndex] = topologyFaceIndex;
    }
  }
  const faces: MeshFace[] = [];
  const edges = new Map<string, MeshEdge>();

  for (let faceIndex = 0; faceIndex < triangleCount; faceIndex += 1) {
    const cornerOffset = faceIndex * 3;
    const indices = [
      sourceIndices[cornerOffset]!,
      sourceIndices[cornerOffset + 1]!,
      sourceIndices[cornerOffset + 2]!
    ] as const;
    const points = indices.map((index) =>
      new THREE.Vector3().fromArray(sourcePositions, index * 3)
    ) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
    const normal = new THREE.Vector3()
      .subVectors(points[1], points[0])
      .cross(new THREE.Vector3().subVectors(points[2], points[0]))
      .normalize();
    faces.push({
      normal,
      cornerAngles: [
        cornerAngle(points[0], points[1], points[2]),
        cornerAngle(points[1], points[2], points[0]),
        cornerAngle(points[2], points[0], points[1])
      ]
    });

    for (const [start, end] of [
      [indices[0], indices[1]],
      [indices[1], indices[2]],
      [indices[2], indices[0]]
    ] as const) {
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      const key = `${low}:${high}`;
      const edge = edges.get(key) ?? { start: low, end: high, faces: [] };
      edge.faces.push(faceIndex);
      edges.set(key, edge);
    }
  }

  const parent = sourceIndices.map((_, cornerIndex) => cornerIndex);
  const rank = sourceIndices.map(() => 0);
  const find = (cornerIndex: number): number => {
    let root = cornerIndex;
    while (parent[root] !== root) {
      root = parent[root]!;
    }
    let current = cornerIndex;
    while (parent[current] !== current) {
      const next = parent[current]!;
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) {
      return;
    }
    if (rank[leftRoot]! < rank[rightRoot]!) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    parent[rightRoot] = leftRoot;
    if (rank[leftRoot] === rank[rightRoot]) {
      rank[leftRoot] = rank[leftRoot]! + 1;
    }
  };
  const cornerForVertex = (faceIndex: number, vertexIndex: number) => {
    const offset = faceIndex * 3;
    for (let corner = offset; corner < offset + 3; corner += 1) {
      if (sourceIndices[corner] === vertexIndex) {
        return corner;
      }
    }
    return null;
  };

  const creaseDot = Math.cos(CAD_CREASE_ANGLE);
  for (const edge of edges.values()) {
    // Non-manifold edges stay creased; smoothing across more than two incident
    // faces can blend unrelated shells that merely share indexed vertices.
    if (edge.faces.length !== 2) {
      continue;
    }
    const [firstFaceIndex, secondFaceIndex] = edge.faces as [number, number];
    const firstFace = faces[firstFaceIndex]!;
    const secondFace = faces[secondFaceIndex]!;
    const firstTopologyFace = topologyFaceByTriangle[firstFaceIndex]!;
    const secondTopologyFace = topologyFaceByTriangle[secondFaceIndex]!;
    const hasTopologyFace = firstTopologyFace >= 0 || secondTopologyFace >= 0;
    const shouldSmooth = hasTopologyFace
      ? firstTopologyFace >= 0 && firstTopologyFace === secondTopologyFace
      : firstFace.normal.dot(secondFace.normal) + DOT_EPSILON >= creaseDot;
    if (!shouldSmooth) {
      continue;
    }
    for (const vertexIndex of [edge.start, edge.end]) {
      const firstCorner = cornerForVertex(firstFaceIndex, vertexIndex);
      const secondCorner = cornerForVertex(secondFaceIndex, vertexIndex);
      if (firstCorner !== null && secondCorner !== null) {
        union(firstCorner, secondCorner);
      }
    }
  }

  const normalsByGroup = new Map<number, THREE.Vector3>();
  for (
    let cornerIndex = 0;
    cornerIndex < sourceIndices.length;
    cornerIndex += 1
  ) {
    const root = find(cornerIndex);
    const faceIndex = Math.floor(cornerIndex / 3);
    const face = faces[faceIndex]!;
    const angle = face.cornerAngles[cornerIndex % 3]!;
    const contribution = face.normal.clone().multiplyScalar(angle);
    const accumulated = normalsByGroup.get(root) ?? new THREE.Vector3();
    accumulated.add(contribution);
    normalsByGroup.set(root, accumulated);
  }

  const vertices: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const outputIndexByGroup = new Map<number, number>();
  const renderSources: number[] = [];
  for (
    let cornerIndex = 0;
    cornerIndex < sourceIndices.length;
    cornerIndex += 1
  ) {
    const root = find(cornerIndex);
    let outputIndex = outputIndexByGroup.get(root);
    if (outputIndex === undefined) {
      outputIndex = vertices.length / 3;
      outputIndexByGroup.set(root, outputIndex);
      const sourceIndex = sourceIndices[cornerIndex]!;
      renderSources.push(sourceIndex);
      vertices.push(
        sourcePositions[sourceIndex * 3]!,
        sourcePositions[sourceIndex * 3 + 1]!,
        sourcePositions[sourceIndex * 3 + 2]!
      );
      const normal = normalsByGroup.get(root)!.normalize();
      normals.push(normal.x, normal.y, normal.z);
    }
    indices.push(outputIndex);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(vertices, 3)
  );
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}

function body(mesh: MeshGeometry, topology?: BodyTopology): BodyRepresentation {
  return {
    bodyId: toBodyId('body_parity'),
    name: 'Parity',
    source: 'primitive',
    mesh,
    faceCount: topology?.faces.length ?? 0,
    color: '#334455',
    consumed: false,
    exportableStep: true,
    volume: 1,
    bbox: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
    ...(topology ? { topology } : {})
  };
}

function fromThree(geometry: THREE.BufferGeometry): MeshGeometry {
  const indexed = geometry.index ? geometry : geometry.toNonIndexed();
  return {
    kind: 'mesh',
    vertices: Float32Array.from(indexed.getAttribute('position').array),
    indices: indexed.index
      ? Uint32Array.from(indexed.index.array)
      : Uint32Array.from(
          { length: indexed.getAttribute('position').count },
          (_, i) => i
        )
  };
}

/** Welds coincident vertices, as the exact mesher's output is welded. */
function welded(geometry: THREE.BufferGeometry): MeshGeometry {
  const source = fromThree(geometry);
  const keys = new Map<string, number>();
  const vertices: number[] = [];
  const remap: number[] = [];
  for (let i = 0; i < source.vertices.length / 3; i += 1) {
    const key = Array.from(source.vertices.slice(i * 3, i * 3 + 3))
      .map((value) => value.toFixed(5))
      .join(',');
    let index = keys.get(key);
    if (index === undefined) {
      index = vertices.length / 3;
      keys.set(key, index);
      vertices.push(...source.vertices.slice(i * 3, i * 3 + 3));
    }
    remap.push(index);
  }
  return {
    kind: 'mesh',
    vertices: Float32Array.from(vertices),
    indices: Uint32Array.from(source.indices, (index) => remap[index]!)
  };
}

function groupsAsFaces(geometry: THREE.BufferGeometry): BodyTopology {
  return {
    faces: geometry.groups.map((group, i) => ({
      topologyId: `face:${i}`,
      hash: i,
      triangleStart: group.start / 3,
      triangleCount: group.count / 3
    })),
    edges: []
  };
}

/** Exact equality without building a diff of large buffers. */
function expectSameValues(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>
) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    if (!Object.is(actual[i], expected[i])) {
      expect({ index: i, value: actual[i] }).toEqual({
        index: i,
        value: expected[i]
      });
    }
  }
}

function expectIdentical(mesh: MeshGeometry, topology?: BodyTopology) {
  const actual = (createObjectForBody(body(mesh, topology)) as THREE.Mesh)
    .geometry;
  const expected = legacyGeometryFromMesh(mesh, topology);
  expect(actual.getIndex()!.array.constructor).toBe(
    expected.getIndex()!.array.constructor
  );
  expectSameValues(actual.getIndex()!.array, expected.getIndex()!.array);
  for (const name of ['position', 'normal']) {
    expectSameValues(
      actual.getAttribute(name).array,
      expected.getAttribute(name).array
    );
  }
}

/** Seeded pseudo-random soup with shared, repeated and degenerate corners. */
function randomMesh(seed: number, vertexCount: number, triangles: number) {
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    kind: 'mesh' as const,
    vertices: Float32Array.from(
      { length: vertexCount * 3 },
      () => next() * 4 - 2
    ),
    indices: Uint32Array.from({ length: triangles * 3 }, () =>
      Math.floor(next() * vertexCount)
    )
  };
}

describe('typed-array smoothing parity', () => {
  it('matches the reference on welded analytic shapes, with and without faces', () => {
    const shapes = [
      new THREE.BoxGeometry(2, 3, 4, 2, 2, 2),
      new THREE.CylinderGeometry(3, 3, 5, 24, 2),
      new THREE.TorusGeometry(4, 1, 12, 24),
      new THREE.SphereGeometry(2, 16, 12)
    ];
    for (const shape of shapes) {
      const mesh = welded(shape);
      expectIdentical(mesh);
      expectIdentical(mesh, groupsAsFaces(shape));
      shape.dispose();
    }
  });

  it('matches the reference on non-manifold and degenerate triangle soups', () => {
    for (let seed = 1; seed <= 6; seed += 1)
      expectIdentical(randomMesh(seed, 40, 120));
    // Partial face ranges leave some triangles without a topology face.
    const mesh = randomMesh(7, 60, 200);
    expectIdentical(mesh, {
      faces: [
        { topologyId: 'face:a', hash: 1, triangleStart: 0, triangleCount: 50 },
        { topologyId: 'face:b', hash: 2, triangleStart: 80, triangleCount: 40 }
      ],
      edges: []
    });
  });

  // The reference implementation needs a few seconds for 90k vertices.
  it(
    'switches to 32-bit indices where the reference does',
    { timeout: 60_000 },
    () => {
      const shape = new THREE.PlaneGeometry(10, 10, 300, 300);
      const mesh = fromThree(shape);
      expect(mesh.vertices.length / 3).toBeGreaterThan(65536);
      expectIdentical(mesh);
      shape.dispose();
    }
  );

  it('outlines a deferred-topology body along its face boundaries', () => {
    const shape = new THREE.BoxGeometry(2, 2, 2, 3, 3, 3);
    const object = createObjectForBody(
      body(welded(shape), groupsAsFaces(shape))
    ) as THREE.Mesh;
    shape.dispose();
    const outline = object.children.find((child) => child.name === 'body-edge');
    const starts = (
      outline as unknown as {
        geometry: THREE.BufferGeometry;
      }
    ).geometry.getAttribute('instanceStart');
    // 12 cube edges of 3 segments each, and no line across a face interior.
    expect(starts.count).toBe(36);
    for (let i = 0; i < starts.count; i += 1) {
      const onEdge = [starts.getX(i), starts.getY(i), starts.getZ(i)].filter(
        (value) => Math.abs(Math.abs(value) - 1) < 1e-6
      ).length;
      expect(onEdge).toBeGreaterThanOrEqual(2);
    }
  });
});
