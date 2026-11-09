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

/**
 * Collects the interior edges of every curved face of `mesh`. Vertices are
 * matched by position, quantized to a millionth of the mesh's extent, so a
 * face whose tessellation splits vertices along a periodic seam still joins
 * across it.
 *
 * It runs on the main thread whenever a body is built (opening a part, each
 * edit, each exact frame of a drag), so it allocates per mesh, not per
 * vertex or edge: on a slow tablet CPU the per-vertex string keys and
 * per-edge objects it used to create cost about a second on a 125k-triangle
 * body (docs/plans/viewport-lookdev-plan-2026-11-08.md, frame timing).
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
  // One weld id per vertex, so edges key on two small integers.
  const quantum = Math.max((max - min) * 1e-6, 1e-9);
  const vertexCount = Math.floor(vertices.length / 3);
  const weld = weldByPosition(vertices, vertexCount, quantum);

  const normals = new Float32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t += 1) {
    const a = indices[t * 3]! * 3;
    const b = indices[t * 3 + 1]! * 3;
    const c = indices[t * 3 + 2]! * 3;
    const abx = vertices[b]! - vertices[a]!;
    const aby = vertices[b + 1]! - vertices[a + 1]!;
    const abz = vertices[b + 2]! - vertices[a + 2]!;
    const bcx = vertices[c]! - vertices[b]!;
    const bcy = vertices[c + 1]! - vertices[b + 1]!;
    const bcz = vertices[c + 2]! - vertices[b + 2]!;
    let nx = aby * bcz - abz * bcy;
    let ny = abz * bcx - abx * bcz;
    let nz = abx * bcy - aby * bcx;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (length > 0) {
      // As THREE.Vector3.divideScalar does it, so the normals are unchanged
      // to the bit.
      const inverse = 1 / length;
      nx *= inverse;
      ny *= inverse;
      nz *= inverse;
    }
    normals[t * 3] = nx;
    normals[t * 3 + 1] = ny;
    normals[t * 3 + 2] = nz;
  }

  // Every triangle side is at most one edge, and one past the cap is enough
  // to know the cap was passed.
  const capacity = Math.min(triangleCount * 3, MAX_SILHOUETTE_CANDIDATES + 1);
  const positions = new Float32Array(capacity * 6);
  const normalsA = new Float32Array(capacity * 3);
  const normalsB = new Float32Array(capacity * 3);
  let count = 0;

  // One face's open edges, in first-seen order; reused face to face.
  const slots = triangleCount * 3;
  const edgeFrom = new Uint32Array(slots);
  const edgeTo = new Uint32Array(slots);
  const edgeFirst = new Uint32Array(slots);
  /** The second triangle sharing the edge, or -1 while there is none. */
  const edgeOther = new Int32Array(slots);
  /** Shared by more than two triangles: not a manifold interior edge. */
  const edgeOverused = new Uint8Array(slots);
  /** The edge's welded end ids, lower first: its key. */
  const edgeLow = new Uint32Array(slots);
  const edgeHigh = new Uint32Array(slots);
  // Open-addressed slot lookup by key, sized per face and cleared per face.
  let tableSize = 16;
  while (tableSize < slots * 2) tableSize *= 2;
  const table = new Int32Array(tableSize);

  for (const face of faces) {
    const start = Math.max(face.triangleStart, 0);
    const end = Math.min(start + face.triangleCount, triangleCount);
    if (end - start < 2 || isPlanar(normals, start, end)) continue;
    let faceTable = 16;
    while (faceTable < (end - start) * 6) faceTable *= 2;
    const mask = faceTable - 1;
    table.fill(-1, 0, faceTable);
    let used = 0;
    for (let t = start; t < end; t += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const from = indices[t * 3 + corner]!;
        const to = indices[t * 3 + ((corner + 1) % 3)]!;
        const fromId = weld[from]!;
        const toId = weld[to]!;
        if (fromId === toId) continue;
        const low = fromId < toId ? fromId : toId;
        const high = fromId < toId ? toId : fromId;
        let h = (Math.imul(low, 73856093) ^ Math.imul(high, 19349663)) & mask;
        let slot = table[h]!;
        while (
          slot !== -1 &&
          (edgeLow[slot] !== low || edgeHigh[slot] !== high)
        ) {
          h = (h + 1) & mask;
          slot = table[h]!;
        }
        if (slot === -1) {
          edgeFrom[used] = from;
          edgeTo[used] = to;
          edgeFirst[used] = t;
          edgeOther[used] = -1;
          edgeOverused[used] = 0;
          edgeLow[used] = low;
          edgeHigh[used] = high;
          table[h] = used;
          used += 1;
        } else if (edgeOther[slot] === -1) {
          edgeOther[slot] = t;
        } else {
          edgeOverused[slot] = 1;
        }
      }
    }
    for (let slot = 0; slot < used; slot += 1) {
      const other = edgeOther[slot]!;
      if (other === -1 || edgeOverused[slot]) continue;
      const first = edgeFirst[slot]!;
      if (dotNormals(normals, first, other) > COPLANAR_DOT) continue;
      const a = edgeFrom[slot]! * 3;
      const b = edgeTo[slot]! * 3;
      const p = count * 6;
      positions[p] = vertices[a]!;
      positions[p + 1] = vertices[a + 1]!;
      positions[p + 2] = vertices[a + 2]!;
      positions[p + 3] = vertices[b]!;
      positions[p + 4] = vertices[b + 1]!;
      positions[p + 5] = vertices[b + 2]!;
      const n = count * 3;
      normalsA[n] = normals[first * 3]!;
      normalsA[n + 1] = normals[first * 3 + 1]!;
      normalsA[n + 2] = normals[first * 3 + 2]!;
      normalsB[n] = normals[other * 3]!;
      normalsB[n + 1] = normals[other * 3 + 1]!;
      normalsB[n + 2] = normals[other * 3 + 2]!;
      count += 1;
      if (count > MAX_SILHOUETTE_CANDIDATES) return null;
    }
  }
  if (count === 0) return null;
  return {
    positions: positions.slice(0, count * 6),
    normalsA: normalsA.slice(0, count * 3),
    normalsB: normalsB.slice(0, count * 3)
  };
}

/**
 * One id per distinct quantized position, numbered in first-seen order: an
 * open-addressed hash over the rounded coordinates, so no key is allocated
 * per vertex.
 */
function weldByPosition(
  vertices: ArrayLike<number>,
  vertexCount: number,
  quantum: number
) {
  const weld = new Uint32Array(vertexCount);
  let size = 16;
  while (size < vertexCount * 2) size *= 2;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const welded = new Float64Array(vertexCount * 3);
  let weldCount = 0;
  for (let v = 0; v < vertexCount; v += 1) {
    const x = Math.round(vertices[v * 3]! / quantum);
    const y = Math.round(vertices[v * 3 + 1]! / quantum);
    const z = Math.round(vertices[v * 3 + 2]! / quantum);
    let h =
      (Math.imul(x | 0, 73856093) ^
        Math.imul(y | 0, 19349663) ^
        Math.imul(z | 0, 83492791)) &
      mask;
    for (;;) {
      const id = table[h]!;
      if (id === -1) {
        table[h] = weldCount;
        welded[weldCount * 3] = x;
        welded[weldCount * 3 + 1] = y;
        welded[weldCount * 3 + 2] = z;
        weld[v] = weldCount;
        weldCount += 1;
        break;
      }
      if (
        welded[id * 3] === x &&
        welded[id * 3 + 1] === y &&
        welded[id * 3 + 2] === z
      ) {
        weld[v] = id;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  return weld;
}

/** The User Timing mark each body's candidate build leaves behind. */
export const SILHOUETTE_BUILD_MARK = 'oz:viewer.silhouettes';

/**
 * Collects `silhouetteCandidates` and leaves a User Timing mark with how long
 * it took, so the cost shows in a browser's performance timeline (Safari's
 * Web Inspector on an iPad included) and in the frame-timing probe
 * (test/e2e/perf-frame-timing.spec.ts). It runs once per body build, on the
 * main thread, and scales with the curved faces' triangles.
 */
export function timedSilhouetteCandidates(
  mesh: Pick<MeshGeometry, 'vertices' | 'indices'>,
  faces: readonly FaceRange[]
): SilhouetteCandidates | null {
  const started = performance.now();
  const candidates = silhouetteCandidates(mesh, faces);
  try {
    performance.mark(SILHOUETTE_BUILD_MARK, {
      detail: {
        ms: performance.now() - started,
        triangles: Math.floor(mesh.indices.length / 3),
        candidates: candidates ? candidates.normalsA.length / 3 : 0
      }
    });
  } catch {
    // Instrumentation never breaks the build it measures.
  }
  return candidates;
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
