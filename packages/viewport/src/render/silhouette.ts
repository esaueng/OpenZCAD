import type { MeshGeometry } from '@openzcad/shared';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import * as THREE from 'three';
import { createFatLineSegments, type FatLineOptions } from './scene';

/**
 * Outlines for curved surfaces (U10 slice 4).
 *
 * Every drawn edge comes from B-rep topology, and the outline of a cylinder,
 * cone, sphere or fillet seen side-on is not a B-rep edge, so curved parts
 * had no outline at all: a cylinder's side simply stopped at the stage.
 *
 * The outline of a tessellated surface is the set of mesh edges where one
 * neighbouring triangle faces the camera and the other faces away. Every
 * mesh edge inside a curved B-rep face is a candidate; each carries both
 * neighbours' normals, and the fat-line vertex shader keeps only the
 * candidates whose neighbours straddle the view direction this frame, by
 * collapsing the rest outside the clip volume. The work stays on the GPU
 * while orbiting, and the outline draws with exactly the width, ink and
 * antialiasing of the B-rep edges beside it.
 *
 * It follows the mesh the faces are drawn from, so it lies on the shaded
 * silhouette to the pixel. Planar faces are skipped (their interior edges can
 * never straddle), as are interior edges whose neighbours are coplanar.
 */

/** Disjoint xyz/xyz segment pairs, with both neighbouring normals each. */
export interface SilhouetteCandidates {
  positions: Float32Array;
  normalsA: Float32Array;
  normalsB: Float32Array;
}

/**
 * Above this, outlines are skipped: a dense import pays per frame for each
 * candidate, and building them costs about 35 ms per 65k triangles.
 */
export const MAX_SILHOUETTE_CANDIDATES = 150_000;

/** Neighbours this close to parallel cannot meaningfully straddle a view. */
const COPLANAR_DOT = 1 - 1e-7;

interface FaceRange {
  triangleStart: number;
  triangleCount: number;
}

interface OpenEdge {
  a: number;
  b: number;
  normal: number;
  /** Set once a second triangle in the same face shares the edge. */
  other: number;
  /** Shared by more than two triangles: not a manifold interior edge. */
  overused: boolean;
}

/**
 * Collects the interior edges of every curved face of `mesh`. Vertices are
 * matched by position, quantized to a millionth of the mesh's extent, so a
 * face whose tessellation splits vertices along a periodic seam still joins
 * across it.
 */
export function silhouetteCandidates(
  mesh: Pick<MeshGeometry, 'vertices' | 'indices'>,
  faces: readonly FaceRange[]
): SilhouetteCandidates | null {
  const { vertices, indices } = mesh;
  const triangleCount = Math.floor(indices.length / 3);
  if (triangleCount === 0 || faces.length === 0) return null;
  // A closed mesh has about 1.5 edges per triangle, so past this the cap
  // below would be reached anyway: give up before paying for the weld.
  if (triangleCount > MAX_SILHOUETTE_CANDIDATES) return null;

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < vertices.length; i += 1) {
    const value = vertices[i]!;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  // One weld id per vertex, so edges key on two small integers rather than
  // building a string per triangle corner.
  const quantum = Math.max((max - min) * 1e-6, 1e-9);
  const vertexCount = Math.floor(vertices.length / 3);
  const weld = new Uint32Array(vertexCount);
  const welded = new Map<string, number>();
  for (let v = 0; v < vertexCount; v += 1) {
    const position = `${Math.round(vertices[v * 3]! / quantum)},${Math.round(
      vertices[v * 3 + 1]! / quantum
    )},${Math.round(vertices[v * 3 + 2]! / quantum)}`;
    let id = welded.get(position);
    if (id === undefined) {
      id = welded.size;
      welded.set(position, id);
    }
    weld[v] = id;
  }
  const weldCount = welded.size;

  const normals = new Float32Array(triangleCount * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < triangleCount; t += 1) {
    a.fromArray(vertices, indices[t * 3]! * 3);
    b.fromArray(vertices, indices[t * 3 + 1]! * 3);
    c.fromArray(vertices, indices[t * 3 + 2]! * 3);
    c.sub(b);
    b.sub(a);
    b.cross(c);
    const length = b.length();
    if (length > 0) b.divideScalar(length);
    normals[t * 3] = b.x;
    normals[t * 3 + 1] = b.y;
    normals[t * 3 + 2] = b.z;
  }

  const positions: number[] = [];
  const normalsA: number[] = [];
  const normalsB: number[] = [];
  const pushNormal = (target: number[], triangle: number) => {
    target.push(
      normals[triangle * 3]!,
      normals[triangle * 3 + 1]!,
      normals[triangle * 3 + 2]!
    );
  };

  for (const face of faces) {
    const start = Math.max(face.triangleStart, 0);
    const end = Math.min(start + face.triangleCount, triangleCount);
    if (end - start < 2 || isPlanar(normals, start, end)) continue;
    const edges = new Map<number, OpenEdge>();
    for (let t = start; t < end; t += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const from = indices[t * 3 + corner]!;
        const to = indices[t * 3 + ((corner + 1) % 3)]!;
        const fromId = weld[from]!;
        const toId = weld[to]!;
        if (fromId === toId) continue;
        const edgeKey =
          fromId < toId ? fromId * weldCount + toId : toId * weldCount + fromId;
        const open = edges.get(edgeKey);
        if (!open) {
          edges.set(edgeKey, {
            a: from,
            b: to,
            normal: t,
            other: -1,
            overused: false
          });
        } else if (open.other === -1) {
          open.other = t;
        } else {
          open.overused = true;
        }
      }
    }
    for (const edge of edges.values()) {
      if (edge.other === -1 || edge.overused) continue;
      if (dotNormals(normals, edge.normal, edge.other) > COPLANAR_DOT) {
        continue;
      }
      positions.push(
        vertices[edge.a * 3]!,
        vertices[edge.a * 3 + 1]!,
        vertices[edge.a * 3 + 2]!,
        vertices[edge.b * 3]!,
        vertices[edge.b * 3 + 1]!,
        vertices[edge.b * 3 + 2]!
      );
      pushNormal(normalsA, edge.normal);
      pushNormal(normalsB, edge.other);
      if (normalsA.length / 3 > MAX_SILHOUETTE_CANDIDATES) return null;
    }
  }
  if (positions.length === 0) return null;
  return {
    positions: Float32Array.from(positions),
    normalsA: Float32Array.from(normalsA),
    normalsB: Float32Array.from(normalsB)
  };
}

function dotNormals(normals: Float32Array, left: number, right: number) {
  return (
    normals[left * 3]! * normals[right * 3]! +
    normals[left * 3 + 1]! * normals[right * 3 + 1]! +
    normals[left * 3 + 2]! * normals[right * 3 + 2]!
  );
}

function isPlanar(normals: Float32Array, start: number, end: number) {
  for (let t = start + 1; t < end; t += 1) {
    if (dotNormals(normals, start, t) < COPLANAR_DOT) return false;
  }
  return true;
}

const NORMAL_ATTRIBUTE_ANCHOR = 'uniform vec2 resolution;';
const VIEW_ANCHOR = 'vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );';
const OUTPUT_ANCHOR = 'gl_Position = clip;';

/**
 * The fat-line vertex shader, keeping only segments whose two neighbouring
 * normals straddle the view direction. The test runs on the view-space
 * positions before any depth bias moves them.
 */
export function silhouetteVertexShader(source: string): string {
  for (const anchor of [NORMAL_ATTRIBUTE_ANCHOR, VIEW_ANCHOR, OUTPUT_ANCHOR]) {
    if (source.split(anchor).length !== 2) {
      throw new Error(
        `Fat-line shader changed: silhouette anchor "${anchor}" not found once.`
      );
    }
  }
  return source
    .replace(
      NORMAL_ATTRIBUTE_ANCHOR,
      `${NORMAL_ATTRIBUTE_ANCHOR}
		attribute vec3 instanceNormalA;
		attribute vec3 instanceNormalB;`
    )
    .replace(
      VIEW_ANCHOR,
      `${VIEW_ANCHOR}
			vec3 silhouetteToEye = projectionMatrix[ 2 ][ 3 ] == - 1.0
				? - 0.5 * ( start.xyz + end.xyz )
				: vec3( 0.0, 0.0, 1.0 );
			float silhouetteFacingA = dot( normalMatrix * instanceNormalA, silhouetteToEye );
			float silhouetteFacingB = dot( normalMatrix * instanceNormalB, silhouetteToEye );
			bool silhouetteHidden = silhouetteFacingA * silhouetteFacingB > 0.0;`
    )
    .replace(
      OUTPUT_ANCHOR,
      // Outside the clip volume: the segment's quad is culled before raster.
      'gl_Position = silhouetteHidden ? vec4( 0.0, 0.0, 2.0, 1.0 ) : clip;'
    );
}

/** The outline batch for one body's curved faces, or null when it has none. */
export function createSilhouetteLines(
  candidates: SilhouetteCandidates,
  options: FatLineOptions
): LineSegments2 {
  const lines = createFatLineSegments(candidates.positions, options);
  lines.geometry.setAttribute(
    'instanceNormalA',
    new THREE.InstancedBufferAttribute(candidates.normalsA, 3)
  );
  lines.geometry.setAttribute(
    'instanceNormalB',
    new THREE.InstancedBufferAttribute(candidates.normalsB, 3)
  );
  const material: LineMaterial = lines.material;
  material.vertexShader = silhouetteVertexShader(material.vertexShader);
  // Its program differs from every other fat line's; say so, or three may
  // reuse a cached plain fat-line program for it.
  material.customProgramCacheKey = () => 'openzcad-silhouette';
  lines.name = 'body-edge-silhouette';
  lines.raycast = () => undefined;
  return lines;
}
