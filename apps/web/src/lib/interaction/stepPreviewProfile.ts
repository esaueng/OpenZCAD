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
 * A proven blend that rises past the picked face's plane into such a wall
 * (a box top rounded into a taller cylinder) moves too. It declines when any
 * other face reaches past that plane (the move would have to trim something
 * this cannot), when a stretching face is not ruled along the drag, when the
 * region is most of the body, or on an imported compound. `span` and `reach`
 * bound the push and pull before a stretched curved wall's moving outline
 * would cross its fixed one (see `wallStretchBounds`); a stretched planar
 * face is triangulated afresh past its own folds.
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
  const depths = new Map<FaceInfo, { low: number; high: number }>();
  const depthOf = (info: FaceInfo) => {
    const known = depths.get(info);
    if (known) return known;
    let low = Infinity,
      high = -Infinity;
    for (const index of info.vertices) {
      const s = along(index);
      if (s < low) low = s;
      if (s > high) high = s;
    }
    const depth = { low, high };
    depths.set(info, depth);
    return depth;
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
        // A blend deeper than the band would be stretched off its own
        // surface. Only a proven rolling-ball blend may rise past the face's
        // plane: a concave round into a wall the drag runs along (a box top
        // filleted into a taller cylinder) rides with the face while that
        // wall stretches, and anything it would reach instead is either
        // another rising face checked here or a fold `reach` stops short of.
        // A rising plane or unrecognized surface is something the move would
        // trim.
        const { low, high } = depthOf(neighbour);
        if (low < level - band - tolerance * 10) return null;
        if (
          high > level + tolerance * 10 &&
          neighbour.face.geometry?.featureType !== 'blend'
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
  // push (`span`) and the pull (`reach`) the preview can show; a curved
  // wall is bounded by its outline instead (`wallStretchBounds`).
  const { indices } = body.mesh;
  const moves = (index: number) => (movingKeys.has(keyOf(index)) ? 1 : 0);
  let span = Infinity,
    reach = Infinity;
  const planarFaces: StepPreviewPlanarFace[] = [];
  for (const info of stretching) {
    const plane = info.face.geometry;
    if (plane?.surfaceType !== 'plane' || !plane.normal) {
      const wall = wallStretchBounds(
        body,
        info,
        keyOf,
        movingKeys,
        normal,
        along,
        tolerance
      );
      span = Math.min(span, wall.push);
      reach = Math.min(reach, wall.pull);
      continue;
    }
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
  }
  if (!(span > tolerance) || !(reach > tolerance)) return null;
  // Edge polylines and face triangles sample curved boundaries independently.
  // Every sample on an edge of the rigid region must travel with that region,
  // including the selected rim's samples absent from the triangle mesh.
  const movingFaces = new Set([...moving].map((info) => info.face.hash));
  for (const edge of body.topology!.edges) {
    if (!edge.adjacentFaceHashes?.some((hash) => movingFaces.has(hash)))
      continue;
    for (let i = 0; i + 2 < edge.points.length; i += 3) {
      const key = stepPreviewKey(
        edge.points[i]!,
        edge.points[i + 1]!,
        edge.points[i + 2]!,
        origin,
        quantum
      );
      if (key >= 0) movingKeys.add(key);
    }
  }
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

/**
 * How far a curved wall ruled along the drag can stretch each way before
 * its moving outline crosses its fixed outline on some ruling. Every point
 * of such a wall stays on its surface wherever it slides along the drag, and
 * so does its normal, so a triangle inside the wall that folds is only a
 * culled back face over a wall its neighbours still cover; the wall itself
 * fails only where the moved seam would pass the wall's other boundary (a
 * concave round lifted past the cylinder's rim). Faces sample the curve they
 * share independently, so per-triangle folds would also stop the preview at
 * the first sliver beside the seam.
 *
 * Projected along the drag, each outline sample is compared with the
 * outline segments of the other kind that span its ruling. A chord of a
 * curved outline lies off the curve by its sag, so a segment counts when the
 * sample is within half the segment's length of it: generous, which only
 * ever finds a crossing that is not there and shortens the preview.
 */
function wallStretchBounds(
  body: BodyRepresentation,
  info: FaceInfo,
  keyOf: (index: number) => number,
  movingKeys: ReadonlySet<number>,
  normal: Vector3,
  along: (index: number) => number,
  tolerance: number
): { push: number; pull: number } {
  const { vertices, indices } = body.mesh;
  const end = (info.face.triangleStart + info.face.triangleCount) * 3;
  // Count each welded side of the face's triangles; a side used once is
  // on its outline. Local ids keep the side keys small integers.
  const local = new Map<number, number>();
  const idOf = (key: number) => {
    let id = local.get(key);
    if (id === undefined) local.set(key, (id = local.size));
    return id;
  };
  const stride = info.face.triangleCount * 3 + 1;
  const sides = new Map<number, [number, number, number]>();
  for (let t = info.face.triangleStart * 3; t < end; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k]!,
        b = indices[t + ((k + 1) % 3)]!;
      const ia = idOf(keyOf(a)),
        ib = idOf(keyOf(b));
      if (ia === ib) continue;
      const side = ia < ib ? ia * stride + ib : ib * stride + ia;
      const known = sides.get(side);
      if (known) known[2] += 1;
      else sides.set(side, [a, b, 1]);
    }
  }
  // A basis across the drag; every ruling projects to one point.
  const helper =
    Math.abs(normal.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const dot = (u: Vector3, v: Vector3) => u.x * v.x + u.y * v.y + u.z * v.z;
  const e1x = helper.y * normal.z - helper.z * normal.y,
    e1y = helper.z * normal.x - helper.x * normal.z,
    e1z = helper.x * normal.y - helper.y * normal.x;
  const e1Length = Math.hypot(e1x, e1y, e1z);
  const e1 = { x: e1x / e1Length, y: e1y / e1Length, z: e1z / e1Length };
  const e2 = {
    x: normal.y * e1.z - normal.z * e1.y,
    y: normal.z * e1.x - normal.x * e1.z,
    z: normal.x * e1.y - normal.y * e1.x
  };
  const point = (index: number) => {
    const p = {
      x: vertices[index * 3]!,
      y: vertices[index * 3 + 1]!,
      z: vertices[index * 3 + 2]!
    };
    return { u: dot(p, e1), v: dot(p, e2), s: along(index) };
  };
  type Sample = ReturnType<typeof point>;
  const samples: [Sample[], Sample[]] = [[], []];
  const segments: [[Sample, Sample][], [Sample, Sample][]] = [[], []];
  const seen = new Set<number>();
  for (const [a, b, count] of sides.values()) {
    if (count !== 1) continue;
    const ma = movingKeys.has(keyOf(a)) ? 1 : 0,
      mb = movingKeys.has(keyOf(b)) ? 1 : 0;
    const pa = point(a),
      pb = point(b);
    for (const [index, p, m] of [
      [a, pa, ma],
      [b, pb, mb]
    ] as const) {
      const key = keyOf(index);
      if (seen.has(key)) continue;
      seen.add(key);
      samples[m].push(p);
    }
    if (ma === mb) segments[ma].push([pa, pb]);
  }
  const near = tolerance * 10;
  let push = Infinity,
    pull = Infinity;
  const gap = (fixed: number, moved: number) => {
    const difference = fixed - moved;
    if (difference >= 0) pull = Math.min(pull, difference);
    else push = Math.min(push, -difference);
  };
  for (const kind of [0, 1] as const) {
    const candidates = segmentGrid(segments[1 - kind]!, near);
    for (const sample of samples[kind]) {
      for (const [a, b] of candidates(sample.u, sample.v)) {
        const du = b.u - a.u,
          dv = b.v - a.v;
        const length2 = du * du + dv * dv;
        if (length2 <= near * near) {
          // A segment along the ruling itself: each end is on it.
          if (Math.hypot(sample.u - a.u, sample.v - a.v) > near) continue;
          for (const end of [a, b])
            if (kind === 1) gap(end.s, sample.s);
            else gap(sample.s, end.s);
          continue;
        }
        const t = ((sample.u - a.u) * du + (sample.v - a.v) * dv) / length2;
        if (t < 0 || t > 1) continue;
        const off = Math.hypot(
          sample.u - (a.u + t * du),
          sample.v - (a.v + t * dv)
        );
        if (off > Math.max(near, Math.sqrt(length2) / 2)) continue;
        const s = a.s + t * (b.s - a.s);
        if (kind === 1) gap(s, sample.s);
        else gap(sample.s, s);
      }
    }
  }
  return { push, pull };
}

/**
 * Buckets projected segments by the cells their reach covers (their own
 * extent grown by half their length, the sag allowance), so each sample is
 * tested against nearby segments only.
 */
function segmentGrid<T extends { u: number; v: number }>(
  segments: readonly [T, T][],
  near: number
): (u: number, v: number) => readonly [T, T][] {
  if (segments.length < 64) return () => segments;
  let minU = Infinity,
    minV = Infinity,
    maxU = -Infinity,
    maxV = -Infinity;
  for (const [a, b] of segments)
    for (const p of [a, b]) {
      minU = Math.min(minU, p.u);
      minV = Math.min(minV, p.v);
      maxU = Math.max(maxU, p.u);
      maxV = Math.max(maxV, p.v);
    }
  const cells = Math.max(
    1,
    Math.min(256, Math.ceil(Math.sqrt(segments.length)))
  );
  const size = Math.max(maxU - minU, maxV - minV, near) / cells;
  const cell = (value: number, min: number) =>
    Math.min(cells - 1, Math.max(0, Math.floor((value - min) / size)));
  const buckets = new Map<number, [T, T][]>();
  for (const segment of segments) {
    const [a, b] = segment;
    const grow = Math.max(near, Math.hypot(b.u - a.u, b.v - a.v) / 2) + near;
    const u0 = cell(Math.min(a.u, b.u) - grow, minU),
      u1 = cell(Math.max(a.u, b.u) + grow, minU),
      v0 = cell(Math.min(a.v, b.v) - grow, minV),
      v1 = cell(Math.max(a.v, b.v) + grow, minV);
    for (let i = u0; i <= u1; i++)
      for (let j = v0; j <= v1; j++) {
        const key = i * cells + j;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(segment);
        else buckets.set(key, [segment]);
      }
  }
  const empty: [T, T][] = [];
  return (u, v) => {
    if (
      u < minU - size ||
      v < minV - size ||
      u > maxU + size ||
      v > maxV + size
    )
      return empty;
    return buckets.get(cell(u, minU) * cells + cell(v, minV)) ?? empty;
  };
}

/** The face's carrier contains the drag direction. */
function ruledAlong(
  body: BodyRepresentation,
  face: FaceTopology,
  normal: Vector3
): boolean {
  const geometry = face.geometry;
  // Use the exact carrier before sampled triangle normals. Float32 slivers
  // beside a trimmed round can point away from its cylinder's true normal;
  // treating that ruled wall as a moving blend then reaches the unrelated
  // junction and incorrectly disables the whole immediate preview.
  if (geometry?.surfaceType === 'plane' && geometry.normal) {
    const n = geometry.normal;
    const length = Math.hypot(n.x, n.y, n.z);
    return (
      length > 1e-9 &&
      Math.abs(n.x * normal.x + n.y * normal.y + n.z * normal.z) / length < 1e-6
    );
  }
  if (
    geometry?.surfaceType === 'cylinder' &&
    geometry.axisStart &&
    geometry.axisEnd
  ) {
    const x = geometry.axisEnd.x - geometry.axisStart.x;
    const y = geometry.axisEnd.y - geometry.axisStart.y;
    const z = geometry.axisEnd.z - geometry.axisStart.z;
    const length = Math.hypot(x, y, z);
    return (
      length > 1e-9 &&
      Math.hypot(
        y * normal.z - z * normal.y,
        z * normal.x - x * normal.z,
        x * normal.y - y * normal.x
      ) /
        length <
        1e-6
    );
  }
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
