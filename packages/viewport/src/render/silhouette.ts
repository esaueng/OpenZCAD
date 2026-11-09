import type { MeshGeometry } from '@openzcad/shared';
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
 * neighbours' normals, and `updateSilhouette` draws only the candidates
 * whose neighbours straddle the view, picked again whenever the view
 * changes. The outline draws with exactly the width, ink and antialiasing of
 * the B-rep edges beside it.
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
 * Above this, outlines are skipped: building them costs about 35 ms per 65k
 * triangles, and picking them again costs a pass over every candidate each
 * time the view moves.
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

/** What `createSilhouetteLines` keeps to pick the outline again per view. */
interface SilhouetteState {
  readonly candidates: SilhouetteCandidates;
  /** Each candidate's midpoint, where a perspective eye ray is aimed. */
  readonly midpoints: Float32Array;
  /** The drawn segments: the first `instanceCount` are this view's outline. */
  readonly drawn: Float32Array;
  readonly buffer: THREE.InterleavedBuffer;
  /** The object-space eye the drawn outline was picked for. */
  readonly lastEye: Float64Array;
  lastPerspective: boolean | null;
}

const SILHOUETTE_STATE = Symbol('openzcad-silhouette');

type SilhouetteLines = LineSegments2 & {
  [SILHOUETTE_STATE]?: SilhouetteState;
};

/**
 * The outline batch for one body's curved faces.
 *
 * It holds every candidate but draws only those whose two neighbouring
 * triangles straddle the view, picked on the CPU by `updateSilhouette`
 * whenever the camera or the body moves. A fillet tessellated into thousands
 * of triangles yields tens of thousands of candidates, of which a few hundred
 * are ever on the outline. Testing each one in the vertex shader cost every
 * frame a fat-line quad per candidate: a 13-face sleeve with five fillets
 * drew 59k of them, which was most of each frame on a software rasterizer
 * and a needless share of it on a tablet GPU. Here the test is two dot
 * products per candidate and runs only when the view changes, and the
 * outline draws with the stock fat-line program shared with every other
 * edge.
 */
export function createSilhouetteLines(
  candidates: SilhouetteCandidates,
  options: FatLineOptions
): LineSegments2 {
  const count = candidates.positions.length / 6;
  // `setPositions` keeps the array it is given; hand it a copy to overwrite,
  // so the candidates themselves stay intact.
  const lines: SilhouetteLines = createFatLineSegments(
    Float32Array.from(candidates.positions),
    options
  );
  const midpoints = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      midpoints[i * 3 + axis] =
        0.5 *
        (candidates.positions[i * 6 + axis]! +
          candidates.positions[i * 6 + 3 + axis]!);
    }
  }
  const start = lines.geometry.getAttribute(
    'instanceStart'
  ) as THREE.InterleavedBufferAttribute;
  lines[SILHOUETTE_STATE] = {
    candidates,
    midpoints,
    drawn: start.data.array as Float32Array,
    buffer: start.data,
    lastEye: new Float64Array(3),
    lastPerspective: null
  };
  // Nothing is outlined until a view has picked the outline. The bounds
  // `setPositions` measured over every candidate stay, so frustum culling
  // still sees the whole surface.
  lines.geometry.instanceCount = 0;
  lines.name = 'body-edge-silhouette';
  lines.raycast = () => undefined;
  return lines;
}

const inverseWorld = new THREE.Matrix4();
const eye = new THREE.Vector3();

/**
 * Picks the outline of `lines` for `camera`: the candidates whose two
 * neighbours face opposite ways along the eye ray (towards the camera for a
 * perspective view, along the view axis for an orthographic one). The test
 * runs in the batch's own space, where a normal dotted with a direction is
 * unchanged by any affine placement of the body.
 *
 * @returns Whether the drawn outline was picked again.
 */
export function updateSilhouette(
  lines: LineSegments2,
  camera: THREE.Camera
): boolean {
  const state = (lines as SilhouetteLines)[SILHOUETTE_STATE];
  if (!state) return false;
  inverseWorld.copy(lines.matrixWorld).invert();
  const perspective =
    (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
  if (perspective) {
    eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverseWorld);
  } else {
    // Towards the viewer: the camera looks down its local -Z.
    eye
      .setFromMatrixColumn(camera.matrixWorld, 2)
      .transformDirection(inverseWorld);
  }
  if (
    state.lastPerspective === perspective &&
    state.lastEye[0] === eye.x &&
    state.lastEye[1] === eye.y &&
    state.lastEye[2] === eye.z
  ) {
    return false;
  }
  state.lastPerspective = perspective;
  state.lastEye[0] = eye.x;
  state.lastEye[1] = eye.y;
  state.lastEye[2] = eye.z;

  const { positions, normalsA, normalsB } = state.candidates;
  const { midpoints, drawn } = state;
  const count = midpoints.length / 3;
  const { x, y, z } = eye;
  let toX = x;
  let toY = y;
  let toZ = z;
  let kept = 0;
  for (let i = 0; i < count; i += 1) {
    const n = i * 3;
    if (perspective) {
      toX = x - midpoints[n]!;
      toY = y - midpoints[n + 1]!;
      toZ = z - midpoints[n + 2]!;
    }
    const facingA =
      normalsA[n]! * toX + normalsA[n + 1]! * toY + normalsA[n + 2]! * toZ;
    const facingB =
      normalsB[n]! * toX + normalsB[n + 1]! * toY + normalsB[n + 2]! * toZ;
    if (facingA * facingB > 0) continue;
    const from = i * 6;
    const to = kept * 6;
    for (let k = 0; k < 6; k += 1) drawn[to + k] = positions[from + k]!;
    kept += 1;
  }
  lines.geometry.instanceCount = kept;
  state.buffer.clearUpdateRanges();
  if (kept > 0) {
    state.buffer.addUpdateRange(0, kept * 6);
    state.buffer.needsUpdate = true;
  }
  return true;
}

/**
 * Picks every visible outline under `root` for `camera`. Called from the
 * scene's `onBeforeRender`, which three runs after the scene's matrices
 * update and before it uploads any buffer, so the outline drawn always
 * belongs to the camera drawing it, captures from another camera included.
 */
export function updateSilhouettes(root: THREE.Object3D, camera: THREE.Camera) {
  root.traverseVisible((child) => {
    if (SILHOUETTE_STATE in child) {
      updateSilhouette(child as unknown as LineSegments2, camera);
    }
  });
}

/**
 * Keeps the outlines in `scene` picked for whichever camera renders it,
 * chaining any `onBeforeRender` the scene already has.
 */
export function installSilhouetteUpdates(scene: THREE.Scene) {
  const previous = scene.onBeforeRender;
  scene.onBeforeRender = function (...args) {
    // For a scene three passes (renderer, scene, camera, render target).
    updateSilhouettes(args[1], args[2]);
    previous.apply(this, args);
  };
}
