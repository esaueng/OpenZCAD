import type {
  BodyRepresentation,
  FaceTopology,
  Vector3
} from '@openzcad/shared';
import {
  stepPreviewKey,
  stepPreviewNeighbourKeys,
  STEP_PREVIEW_GRID,
  type StepPreviewPlanarFace,
  type StepPreviewProfile
} from '@openzcad/viewport';

/** Bodies above this many display triangles keep the exact-only preview. */
const MAX_TRIANGLES = 600_000;
/** A triangle is parallel to the drag when its normal is this close to ⊥. */
const PARALLEL_COSINE = 2e-3;

/**
 * Disposable whole-body preview of a planar push/pull on any body.
 *
 * Moving a planar face drags its blends with it and stretches the walls they
 * meet. So the preview translates the picked face together with every curved
 * or sloped face reachable from it through such faces (its rounds, chamfers
 * and corner blends), and lets each face that region touches stretch: only
 * the vertices it shares with the region move. That is exact for a stretching
 * face that is ruled along the drag, a side wall or a cylinder whose axis
 * follows the drag, because every one of its triangles stays on its surface.
 *
 * It declines when a blend reaches past the picked face's plane (the move
 * would have to trim something this cannot), when a stretching face is not
 * ruled along the drag, when the region is most of the body, or on an
 * imported compound. `span` and
 * `reach` bound the push and pull before a stretched curved triangle would
 * fold; a stretched planar face is triangulated afresh past its own folds.
 * This is display recognition only: it never authorizes an edit, and the
 * exact kernel still decides the result on release.
 */
export function stepPreviewProfile(
  body: BodyRepresentation | undefined,
  face: FaceTopology | undefined
): StepPreviewProfile | null {
  const faces = body?.topology?.faces;
  const geometry = face?.geometry;
  if (
    !body ||
    !faces ||
    !face ||
    !faces.includes(face) ||
    geometry?.surfaceType !== 'plane' ||
    !geometry.normal ||
    body.mesh.indices.length > MAX_TRIANGLES * 3 ||
    // Solids of an imported compound can touch flush and share display
    // vertices, which would carry the move across into a sibling.
    (body.importedStepDeclaredSolidCount ?? 1) > 1
  )
    return null;
  const magnitude = Math.hypot(
    geometry.normal.x,
    geometry.normal.y,
    geometry.normal.z
  );
  if (!Number.isFinite(magnitude) || magnitude < 1e-9) return null;
  const normal: Vector3 = {
    x: geometry.normal.x / magnitude,
    y: geometry.normal.y / magnitude,
    z: geometry.normal.z / magnitude
  };
  const prepared = prepare(body);
  if (!prepared) return null;
  const { infos, facesAtKey, keyOf, origin, quantum, tolerance } = prepared;
  const { vertices } = body.mesh;
  const along = (index: number) =>
    vertices[index * 3]! * normal.x +
    vertices[index * 3 + 1]! * normal.y +
    vertices[index * 3 + 2]! * normal.z;

  const picked = infos.find((info) => info.face === face);
  if (!picked) return null;
  let level = 0;
  for (const index of picked.vertices) level += along(index);
  level /= picked.vertices.length;
  for (const index of picked.vertices)
    if (Math.abs(along(index) - level) > tolerance * 10) return null;

  // Grow the rigid region through the faces that are not ruled along the drag.
  const ruled = new Map<FaceInfo, boolean>();
  const isRuled = (info: FaceInfo) => {
    let known = ruled.get(info);
    if (known === undefined) {
      known = ruledAlong(body, info.face, normal);
      ruled.set(info, known);
    }
    return known;
  };
  const depthOf = (info: FaceInfo) => {
    let low = Infinity,
      high = -Infinity;
    for (const index of info.vertices) {
      const s = along(index);
      if (s < low) low = s;
      if (s > high) high = s;
    }
    return { low, high };
  };
  // The blends on the face's own edges set how deep the region may reach;
  // corner blends between them stay inside that band. A blend deeper than it
  // belongs to some other edge the move does not carry.
  let band = 0;
  for (const key of picked.keys)
    for (const neighbour of facesAtKey.get(key)!)
      if (neighbour !== picked && !isRuled(neighbour))
        band = Math.max(band, level - depthOf(neighbour).low);
  const moving = new Set<FaceInfo>([picked]);
  const stretching = new Set<FaceInfo>();
  const queue = [picked];
  while (queue.length) {
    const current = queue.pop()!;
    for (const key of current.keys) {
      for (const neighbour of facesAtKey.get(key)!) {
        if (moving.has(neighbour) || stretching.has(neighbour)) continue;
        if (isRuled(neighbour)) {
          stretching.add(neighbour);
          continue;
        }
        // A blend that reaches past the face's plane meets something the
        // move would trim, and one deeper than the band would be stretched
        // off its own surface.
        const { low, high } = depthOf(neighbour);
        if (
          high > level + tolerance * 10 ||
          low < level - band - tolerance * 10
        )
          return null;
        moving.add(neighbour);
        queue.push(neighbour);
      }
    }
    if (moving.size > infos.length / 2) return null;
  }

  const movingKeys = new Set<number>();
  for (const info of moving) for (const key of info.keys) movingKeys.add(key);
  // Unless some wall keeps a vertex where it is, nothing stretches and the
  // whole solid would simply translate.
  if (
    ![...stretching].some((info) =>
      [...info.keys].some((key) => !movingKeys.has(key))
    )
  )
    return null;
  // Each stretching triangle's normal is linear in the drag distance d:
  // N(d) = N0 + d·N1. It folds where N(d)·N0 reaches zero, which bounds the
  // push (`span`) and the pull (`reach`) the preview can show.
  const { indices } = body.mesh;
  const moves = (index: number) => (movingKeys.has(keyOf(index)) ? 1 : 0);
  let span = Infinity,
    reach = Infinity;
  const planarFaces: StepPreviewPlanarFace[] = [];
  for (const info of stretching) {
    let push = Infinity,
      pull = Infinity;
    const end = (info.face.triangleStart + info.face.triangleCount) * 3;
    for (let t = info.face.triangleStart * 3; t < end; t += 3) {
      const a = indices[t]!,
        b = indices[t + 1]!,
        c = indices[t + 2]!;
      const ma = moves(a),
        mb = moves(b),
        mc = moves(c);
      if (ma === mb && mb === mc) continue;
      const ux = vertices[b * 3]! - vertices[a * 3]!,
        uy = vertices[b * 3 + 1]! - vertices[a * 3 + 1]!,
        uz = vertices[b * 3 + 2]! - vertices[a * 3 + 2]!;
      const vx = vertices[c * 3]! - vertices[a * 3]!,
        vy = vertices[c * 3 + 1]! - vertices[a * 3 + 1]!,
        vz = vertices[c * 3 + 2]! - vertices[a * 3 + 2]!;
      const n0x = uy * vz - uz * vy,
        n0y = uz * vx - ux * vz,
        n0z = ux * vy - uy * vx;
      const area = n0x * n0x + n0y * n0y + n0z * n0z;
      if (!(area > 1e-24)) continue;
      // u and v grow by (mb - ma)·n·d and (mc - ma)·n·d.
      const alpha = mb - ma,
        beta = mc - ma;
      const n1x =
          beta * (uy * normal.z - uz * normal.y) -
          alpha * (vy * normal.z - vz * normal.y),
        n1y =
          beta * (uz * normal.x - ux * normal.z) -
          alpha * (vz * normal.x - vx * normal.z),
        n1z =
          beta * (ux * normal.y - uy * normal.x) -
          alpha * (vx * normal.y - vy * normal.x);
      const rate = n1x * n0x + n1y * n0y + n1z * n0z;
      if (Math.abs(rate) < 1e-30) continue;
      const fold = -area / rate;
      if (fold > 0) pull = Math.min(pull, fold);
      else push = Math.min(push, -fold);
    }
    const plane = info.face.geometry;
    if (plane?.surfaceType === 'plane' && plane.normal) {
      // A planar face can be triangulated afresh from its moved outline, so
      // its own folds only say when the viewport has to do that.
      if (push < Infinity || pull < Infinity)
        planarFaces.push({
          triangleStart: info.face.triangleStart,
          triangleCount: info.face.triangleCount,
          normal: plane.normal,
          push,
          pull
        });
    } else {
      span = Math.min(span, push);
      reach = Math.min(reach, pull);
    }
  }
  if (!(span > tolerance) || !(reach > tolerance)) return null;
  return { normal, origin, quantum, movingKeys, span, reach, planarFaces };
}

interface FaceInfo {
  face: FaceTopology;
  /** Distinct vertex indices, one per welded position. */
  vertices: number[];
  keys: Set<number>;
}

interface Prepared {
  infos: FaceInfo[];
  facesAtKey: Map<number, FaceInfo[]>;
  keyOf(index: number): number;
  origin: Vector3;
  quantum: number;
  tolerance: number;
}

/** Face adjacency by welded position depends only on the body's mesh. */
const preparedByMesh = new WeakMap<object, Prepared | null>();

function prepare(body: BodyRepresentation): Prepared | null {
  const cached = preparedByMesh.get(body.mesh);
  if (
    cached !== undefined &&
    cached?.infos[0]?.face === body.topology!.faces[0]
  )
    return cached;
  const { vertices, indices } = body.mesh;
  const vertexCount = Math.floor(vertices.length / 3);
  const faces = body.topology!.faces;
  if (vertexCount === 0) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertexCount; i++)
    for (let k = 0; k < 3; k++) {
      const value = vertices[i * 3 + k]!;
      if (value < min[k]!) min[k] = value;
      if (value > max[k]!) max[k] = value;
    }
  const size = Math.max(
    max[0]! - min[0]!,
    max[1]! - min[1]!,
    max[2]! - min[2]!
  );
  if (!Number.isFinite(size)) return null;
  // Display meshes are Float32; tolerances follow the body's own size. Two
  // faces sample a shared edge independently, so a vertex they share can
  // differ in its last bits and round into the next cell: weld it to a vertex
  // already seen in any neighbouring cell instead.
  const tolerance = Math.max(1, size) * 1e-5;
  const quantum = Math.max(size, 1) / (STEP_PREVIEW_GRID - 16);
  const origin = { x: min[0]!, y: min[1]!, z: min[2]! };
  const welded = new Map<number, number>();
  const seen = new Map<number, number>();
  const keyOf = (index: number) => {
    const known = welded.get(index);
    if (known !== undefined) return known;
    const x = vertices[index * 3]!,
      y = vertices[index * 3 + 1]!,
      z = vertices[index * 3 + 2]!;
    let key = stepPreviewKey(x, y, z, origin, quantum);
    found: for (const neighbour of stepPreviewNeighbourKeys(key)) {
      const other = seen.get(neighbour);
      if (other === undefined) continue;
      if (
        Math.abs(vertices[other * 3]! - x) <= quantum &&
        Math.abs(vertices[other * 3 + 1]! - y) <= quantum &&
        Math.abs(vertices[other * 3 + 2]! - z) <= quantum
      ) {
        key = neighbour;
        break found;
      }
    }
    if (!seen.has(key)) seen.set(key, index);
    welded.set(index, key);
    return key;
  };
  const infos: FaceInfo[] = [];
  const facesAtKey = new Map<number, FaceInfo[]>();
  for (const face of faces) {
    const start = face.triangleStart * 3;
    const end = start + face.triangleCount * 3;
    if (start < 0 || end > indices.length || face.triangleCount <= 0) {
      preparedByMesh.set(body.mesh, null);
      return null;
    }
    const keys = new Set<number>();
    const distinct: number[] = [];
    for (let t = start; t < end; t++) {
      const index = indices[t]!;
      if (index >= vertexCount) {
        preparedByMesh.set(body.mesh, null);
        return null;
      }
      const key = keyOf(index);
      if (keys.has(key)) continue;
      keys.add(key);
      distinct.push(index);
    }
    const info: FaceInfo = { face, vertices: distinct, keys };
    infos.push(info);
    for (const key of keys) {
      const list = facesAtKey.get(key);
      if (list) list.push(info);
      else facesAtKey.set(key, [info]);
    }
  }
  const prepared: Prepared = {
    infos,
    facesAtKey,
    keyOf,
    origin,
    quantum,
    tolerance
  };
  preparedByMesh.set(body.mesh, prepared);
  return prepared;
}

/** Every triangle of `face` contains the drag direction. */
function ruledAlong(
  body: BodyRepresentation,
  face: FaceTopology,
  normal: Vector3
): boolean {
  const { vertices, indices } = body.mesh;
  const end = (face.triangleStart + face.triangleCount) * 3;
  for (let t = face.triangleStart * 3; t < end; t += 3) {
    const a = indices[t]! * 3,
      b = indices[t + 1]! * 3,
      c = indices[t + 2]! * 3;
    const ux = vertices[b]! - vertices[a]!,
      uy = vertices[b + 1]! - vertices[a + 1]!,
      uz = vertices[b + 2]! - vertices[a + 2]!;
    const vx = vertices[c]! - vertices[a]!,
      vy = vertices[c + 1]! - vertices[a + 1]!,
      vz = vertices[c + 2]! - vertices[a + 2]!;
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    // Slivers carry no direction worth trusting either way.
    if (!(length > 1e-12)) continue;
    if (
      Math.abs(nx * normal.x + ny * normal.y + nz * normal.z) / length >
      PARALLEL_COSINE
    )
      return false;
  }
  return true;
}
