import type { GeometryBodyRepresentation } from '@openzcad/shared';
import * as THREE from 'three';

interface PlanarPatch {
  normal: THREE.Vector3;
  offset: number;
  bounds: THREE.Box3;
  ranges: { start: number; end: number }[];
}

// A few depth-buffer units separate independently rasterized, coincident
// triangles. Reuse the same slots for unrelated bodies: assigning one slot
// per scene object makes the bias grow with assembly size and can hide thin
// geometry. Neither vertices nor raycast geometry are displaced.
const COPLANAR_DEPTH_STEP = 8;
export const COPLANAR_DEPTH_ATTRIBUTE = 'coplanarDepth';
const depthSteps = new WeakMap<THREE.WebGLRenderer, number>();

/** Shift clip Z only; leave model/view positions, clipping and shadows exact. */
export function withCoplanarDepth(
  material: THREE.MeshPhongMaterial
): THREE.MeshPhongMaterial {
  const enabled = { value: 1 };
  const depthStep = { value: 2 / (2 ** 24 - 1) };
  material.onBeforeCompile = (shader) => {
    const anchor = '#include <project_vertex>';
    if (!shader.vertexShader.includes(anchor))
      throw new Error('Body shader changed: coplanar depth anchor missing.');
    shader.uniforms.coplanarDepthEnabled = enabled;
    shader.uniforms.coplanarDepthStep = depthStep;
    shader.vertexShader =
      `attribute float ${COPLANAR_DEPTH_ATTRIBUTE};\nuniform float coplanarDepthEnabled;\nuniform float coplanarDepthStep;\n${shader.vertexShader}`.replace(
        anchor,
        `#include <project_vertex>
        gl_Position.z += coplanarDepthEnabled * ${COPLANAR_DEPTH_ATTRIBUTE} * coplanarDepthStep * gl_Position.w;`
      );
  };
  material.onBeforeRender = (renderer) => {
    let step = depthSteps.get(renderer);
    if (step === undefined) {
      const gl = renderer.getContext();
      const bits = gl.getParameter(gl.DEPTH_BITS) as number;
      step = 2 / (2 ** (bits || 24) - 1);
      depthSteps.set(renderer, step);
    }
    depthStep.value = step;
    enabled.value = material.depthWrite && material.opacity >= 1 ? 1 : 0;
  };
  material.customProgramCacheKey = () => 'coplanar-body-face-depth-v1';
  return material;
}
const planesByMesh = new WeakMap<
  GeometryBodyRepresentation['mesh'],
  {
    topology: GeometryBodyRepresentation['topology'];
    patches: PlanarPatch[];
    index: Map<string, PlanarPatch[]>;
  }
>();

const normalCell = (normal: THREE.Vector3) =>
  [normal.x, normal.y, normal.z].map((n) => Math.round(n * 1e4));

/** Only nearby plane equations are candidates, including rounding boundaries. */
function* candidates(
  body: GeometryBodyRepresentation,
  patch: PlanarPatch
): Generator<PlanarPatch> {
  planarPatches(body);
  const index = planesByMesh.get(body.mesh)!.index;
  const [x, y, z] = normalCell(patch.normal) as [number, number, number];
  const tolerance = Math.max(1, Math.abs(patch.offset)) * 2e-10;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = index.get(`${x + dx},${y + dy},${z + dz}`);
        if (!bucket) continue;
        let low = 0,
          high = bucket.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (bucket[middle]!.offset < patch.offset - tolerance)
            low = middle + 1;
          else high = middle;
        }
        for (
          let i = low;
          i < bucket.length && bucket[i]!.offset <= patch.offset + tolerance;
          i++
        )
          yield bucket[i]!;
      }
}

function planarPatches(body: GeometryBodyRepresentation): PlanarPatch[] {
  const cached = planesByMesh.get(body.mesh);
  if (cached && cached.topology === body.topology) return cached.patches;
  const { vertices, indices } = body.mesh;
  const patches: PlanarPatch[] = [];
  const grouped = new Map<string, PlanarPatch[]>();
  // Mesh-only references have no face ranges; each triangle is a patch.
  const faces = body.topology?.faces.length
    ? body.topology.faces
    : Array.from({ length: Math.floor(indices.length / 3) }, (_, index) => ({
        triangleStart: index,
        triangleCount: 1,
        geometry: undefined
      }));
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (const face of faces) {
    const start = Math.max(0, face.triangleStart * 3);
    const end = Math.min(indices.length, start + face.triangleCount * 3);
    if (end - start < 3) continue;
    const bounds = new THREE.Box3();
    for (let index = start; index < end; index++) {
      bounds.expandByPoint(a.fromArray(vertices, indices[index]! * 3));
    }
    const exact = face.geometry;
    let normal: THREE.Vector3;
    let offset: number;
    if (exact?.normal && Number.isFinite(exact.planeOffset)) {
      normal = new THREE.Vector3(
        exact.normal.x,
        exact.normal.y,
        exact.normal.z
      );
      const length = normal.length();
      if (!Number.isFinite(length) || length < 1e-12) continue;
      normal.divideScalar(length);
      offset = exact.planeOffset! / length;
    } else {
      normal = new THREE.Vector3();
      for (let index = start; index + 2 < end; index += 3) {
        a.fromArray(vertices, indices[index]! * 3);
        b.fromArray(vertices, indices[index + 1]! * 3).sub(a);
        c.fromArray(vertices, indices[index + 2]! * 3).sub(a);
        normal.crossVectors(b, c);
        if (normal.lengthSq() > 1e-20) break;
      }
      if (normal.lengthSq() <= 1e-20) continue;
      normal.normalize();
      offset = normal.dot(a);
      // Missing analytic metadata is not evidence of planarity. In
      // particular, never flatten the tessellation of a curved B-rep face.
      const tolerance =
        Math.max(1, bounds.min.length(), bounds.max.length()) *
        Number.EPSILON *
        64;
      let planar = true;
      for (let index = start; index < end; index++) {
        a.fromArray(vertices, indices[index]! * 3);
        if (Math.abs(normal.dot(a) - offset) > tolerance) {
          planar = false;
          break;
        }
      }
      if (!planar) continue;
    }
    if (!Number.isFinite(offset) || bounds.isEmpty()) continue;
    const patch = { normal, offset, bounds, ranges: [{ start, end }] };
    // A flat mesh reference can have tens of thousands of triangles. Merge
    // their plane/footprint tests while retaining the original index spans.
    // The key is just a bucket; samePlane still verifies the equation.
    const key = `${normal
      .toArray()
      .map((n) => n.toFixed(6))
      .join(',')}:${offset.toPrecision(9)}`;
    const group = grouped.get(key) ?? [];
    const existing = group.find((other) => samePlane(patch, other));
    if (existing) {
      existing.bounds.union(bounds);
      const last = existing.ranges[existing.ranges.length - 1]!;
      if (last.end === start) last.end = end;
      else existing.ranges.push({ start, end });
    } else {
      group.push(patch);
      grouped.set(key, group);
      patches.push(patch);
    }
  }
  const index = new Map<string, PlanarPatch[]>();
  for (const patch of patches) {
    const key = normalCell(patch.normal).join(',');
    const bucket = index.get(key) ?? [];
    bucket.push(patch);
    index.set(key, bucket);
  }
  for (const bucket of index.values())
    bucket.sort((a, b) => a.offset - b.offset);
  planesByMesh.set(body.mesh, { topology: body.topology, patches, index });
  return patches;
}

function samePlane(a: PlanarPatch, b: PlanarPatch): boolean {
  // Opposite outward normals are a solid-to-solid contact, not two visible
  // faces fighting for the same samples.
  if (a.normal.dot(b.normal) < 1 - 1e-12) return false;
  const tolerance = Math.max(1, Math.abs(a.offset), Math.abs(b.offset)) * 1e-10;
  return Math.abs(a.offset - b.offset) <= tolerance;
}

function overlaps(a: PlanarPatch, b: PlanarPatch): boolean {
  if (!samePlane(a, b)) return false;
  const tolerance = Math.max(1, Math.abs(a.offset), Math.abs(b.offset)) * 1e-10;
  // Drop the dominant normal axis to compare the faces' footprints. Mere
  // edge/vertex contact must not assign another body a depth slot.
  const n = a.normal;
  const drop =
    Math.abs(n.x) >= Math.max(Math.abs(n.y), Math.abs(n.z))
      ? 'x'
      : Math.abs(n.y) >= Math.abs(n.z)
        ? 'y'
        : 'z';
  return (['x', 'y', 'z'] as const).every(
    (axis) =>
      axis === drop ||
      Math.min(a.bounds.max[axis], b.bounds.max[axis]) -
        Math.max(a.bounds.min[axis], b.bounds.min[axis]) >
        tolerance
  );
}

/**
 * Stable, compact depth slots for opaque bodies with overlapping planar faces.
 * Sorting by persistent body identity keeps the winner through orbit, replay,
 * rename and a different scene insertion order. The greedy colouring reuses a
 * slot whenever two bodies do not compete; normal depth testing still handles
 * all non-coplanar geometry. Called on body publications, never per frame.
 */
function depthPolicy(bodies: readonly GeometryBodyRepresentation[]): {
  slots: Map<string, number>;
  competing: Map<string, PlanarPatch[]>;
} {
  const opaque = bodies
    .filter((body) => !body.consumed && (body.opacity ?? 1) >= 1)
    .sort((a, b) => (a.bodyId < b.bodyId ? -1 : a.bodyId > b.bodyId ? 1 : 0));
  const slots = new Map<string, number>();
  const competing = new Map<string, PlanarPatch[]>();
  const mark = (id: string, patch: PlanarPatch) => {
    const patches = competing.get(id) ?? [];
    if (!patches.includes(patch)) patches.push(patch);
    competing.set(id, patches);
  };
  for (let index = 0; index < opaque.length; index++) {
    const body = opaque[index]!;
    const unavailable = new Set<number>();
    const bounds = new THREE.Box3(
      new THREE.Vector3(body.bbox.min.x, body.bbox.min.y, body.bbox.min.z),
      new THREE.Vector3(body.bbox.max.x, body.bbox.max.y, body.bbox.max.z)
    );
    for (let previous = 0; previous < index; previous++) {
      const other = opaque[previous]!;
      if (
        other.bbox.max.x < bounds.min.x ||
        other.bbox.min.x > bounds.max.x ||
        other.bbox.max.y < bounds.min.y ||
        other.bbox.min.y > bounds.max.y ||
        other.bbox.max.z < bounds.min.z ||
        other.bbox.min.z > bounds.max.z
      )
        continue;
      for (const a of planarPatches(body))
        for (const b of candidates(other, a)) {
          if (!overlaps(a, b)) continue;
          mark(body.bodyId, a);
          mark(other.bodyId, b);
          unavailable.add(slots.get(other.bodyId)!);
        }
    }
    let slot = 0;
    while (unavailable.has(slot)) slot++;
    slots.set(body.bodyId, slot);
  }
  return { slots, competing };
}

export function coplanarBodyDepthSlots(
  bodies: readonly GeometryBodyRepresentation[]
): Map<string, number> {
  return depthPolicy(bodies).slots;
}

/** Updates disposable face-depth attributes, leaving model coordinates alone. */
export function applyCoplanarBodyDepthSlots(
  bodies: readonly GeometryBodyRepresentation[],
  objects: ReadonlyMap<string, THREE.Object3D>
): void {
  const { slots, competing } = depthPolicy(bodies);
  for (const body of bodies) {
    const object = objects.get(body.bodyId);
    if (!(object instanceof THREE.Mesh)) continue;
    let geometry = object.geometry as THREE.BufferGeometry;
    let attribute = geometry.getAttribute(COPLANAR_DEPTH_ATTRIBUTE) as
      THREE.BufferAttribute | undefined;
    if (!attribute) continue;
    let values = attribute.array as Float32Array;
    values.fill(0);
    const slot = slots.get(body.bodyId) ?? 0;
    const competitors = competing.get(body.bodyId);
    const indices = geometry.getIndex();
    if (slot && competitors && indices) {
      const corners = new Float32Array(indices.count);
      for (const patch of planarPatches(body)) {
        // Include adjacent triangles on the same plane in a mesh-only input,
        // so a shared vertex cannot interpolate two depth slots on one face.
        if (!competitors.some((other) => samePlane(patch, other))) continue;
        for (const { start, end } of patch.ranges)
          for (let index = start; index < end; index++)
            corners[index] = slot * COPLANAR_DEPTH_STEP;
      }
      // Mesh-only smoothing can share a vertex between a planar triangle
      // and its shallow curved neighbour. Keep their depths separate while
      // preserving the smoothed normals and original triangle/pick order.
      const assigned = new Uint8Array(values.length);
      let sharedDepthConflict = false;
      for (let index = 0; index < indices.count; index++) {
        const vertex = indices.getX(index);
        if (assigned[vertex] && values[vertex] !== corners[index])
          sharedDepthConflict = true;
        values[vertex] = corners[index]!;
        assigned[vertex] = 1;
      }
      if (sharedDepthConflict) {
        const expanded = geometry.toNonIndexed();
        const identity = Uint32Array.from(
          { length: indices.count },
          (_, index) => index
        );
        expanded.setIndex(new THREE.BufferAttribute(identity, 1));
        expanded.boundingBox = geometry.boundingBox?.clone() ?? null;
        expanded.boundingSphere = geometry.boundingSphere?.clone() ?? null;
        geometry.dispose();
        object.geometry = geometry = expanded;
        attribute = geometry.getAttribute(
          COPLANAR_DEPTH_ATTRIBUTE
        ) as THREE.BufferAttribute;
        values = attribute.array as Float32Array;
        values.set(corners);
      }
    }
    attribute.needsUpdate = true;
  }
}
