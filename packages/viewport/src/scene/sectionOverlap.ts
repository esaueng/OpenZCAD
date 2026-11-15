import * as THREE from 'three';
import { findBodyId, type ViewerMesh } from '../pick/meshes';
import { sectionCapGeometry } from './sectionCaps';

/**
 * M09 first slice: where two bodies overlap inside the section cut, drawn
 * over the cut and reported per pair. DISPLAY EVIDENCE ONLY. It intersects
 * the same disposable tessellation the section caps fill (`sectionCaps.ts`),
 * clipped triangle against triangle in the cutting plane, so it can miss an
 * overlap thinner than the display deflection or flag a near-touch that the
 * mesh rounds into one. It never feeds the exact clash query, a document, an
 * export or a pick; the exact answer is the kernel's (`exact-body-clash.ts`,
 * which AS04 runs on assembly components).
 */

/** Raster-only overlay; never a document face or a picking target. */
export const SECTION_OVERLAP = 'viewport-section-overlap';
/** The overlay's colour: a warning red that reads over any cut fill. */
export const SECTION_OVERLAP_COLOR = 0xd83a3a;

export interface SectionOverlapPair {
  /** Body ids, in first-drawn order. */
  readonly a: string;
  readonly b: string;
  /** Overlap area in the cutting plane, in model units², from display meshes. */
  readonly area: number;
}

interface Region2d {
  /** Flat 2D triangles: x0, y0, x1, y1, x2, y2 per triangle. */
  readonly triangles: Float64Array;
  /** Per-triangle box: minX, minY, maxX, maxY. */
  readonly boxes: Float64Array;
  readonly box: readonly [number, number, number, number];
}

type Point = readonly [number, number];

/** An orthonormal frame in the plane, shared by every body. */
function planeFrame(plane: THREE.Plane) {
  const normal = plane.normal.clone().normalize();
  const u = new THREE.Vector3(
    Math.abs(normal.x) < 0.9 ? 1 : 0,
    Math.abs(normal.x) < 0.9 ? 0 : 1,
    0
  )
    .cross(normal)
    .normalize();
  const v = normal.clone().cross(u);
  const origin = plane.coplanarPoint(new THREE.Vector3());
  return { normal, u, v, origin };
}

type Frame = ReturnType<typeof planeFrame>;

interface FlatCache {
  geometry: THREE.BufferGeometry;
  positionVersion: number;
  indexVersion: number;
  matrix: THREE.Matrix4;
  plane: THREE.Plane;
  coordinates: number[];
}
const flatCaps = new WeakMap<ViewerMesh, FlatCache>();

function attributeVersion(
  attribute:
    THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined
): number {
  if (!attribute) return -1;
  return attribute instanceof THREE.InterleavedBufferAttribute
    ? attribute.data.version
    : attribute.version;
}

/**
 * One mesh's display cap in world space, flattened into the plane frame.
 * Cached per mesh: a slider drag re-applies the cut every frame, and only
 * the plane or the mesh changing changes its cap.
 */
function flatCap(
  mesh: ViewerMesh,
  worldPlane: THREE.Plane,
  frame: Frame
): number[] {
  const geometry = mesh.geometry;
  const positionVersion = attributeVersion(geometry.getAttribute('position'));
  const indexVersion = geometry.index?.version ?? -1;
  const cached = flatCaps.get(mesh);
  if (
    cached &&
    cached.geometry === geometry &&
    cached.positionVersion === positionVersion &&
    cached.indexVersion === indexVersion &&
    cached.matrix.equals(mesh.matrixWorld) &&
    cached.plane.equals(worldPlane)
  ) {
    return cached.coordinates;
  }
  const coordinates: number[] = [];
  const local = worldPlane
    .clone()
    .applyMatrix4(mesh.matrixWorld.clone().invert());
  const cap = sectionCapGeometry(geometry, local);
  if (cap) {
    const point = new THREE.Vector3();
    const positions = cap.getAttribute('position');
    for (let i = 0; i < positions.count; i += 1) {
      point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
      point.sub(frame.origin);
      coordinates.push(point.dot(frame.u), point.dot(frame.v));
    }
    cap.dispose();
  }
  flatCaps.set(mesh, {
    geometry,
    positionVersion,
    indexVersion,
    matrix: mesh.matrixWorld.clone(),
    plane: worldPlane.clone(),
    coordinates
  });
  return coordinates;
}

/** One body's cap (all its meshes), flattened into the shared plane frame. */
function capRegion(
  meshes: readonly ViewerMesh[],
  worldPlane: THREE.Plane,
  frame: Frame
): Region2d | null {
  const coordinates = meshes.flatMap((mesh) =>
    flatCap(mesh, worldPlane, frame)
  );
  const count = Math.floor(coordinates.length / 6);
  if (count === 0) return null;
  const triangles = Float64Array.from(coordinates.slice(0, count * 6));
  const boxes = new Float64Array(count * 4);
  const box: [number, number, number, number] = [
    Infinity,
    Infinity,
    -Infinity,
    -Infinity
  ];
  for (let t = 0; t < count; t += 1) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < 3; k += 1) {
      const x = triangles[t * 6 + k * 2]!;
      const y = triangles[t * 6 + k * 2 + 1]!;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    boxes.set([minX, minY, maxX, maxY], t * 4);
    box[0] = Math.min(box[0], minX);
    box[1] = Math.min(box[1], minY);
    box[2] = Math.max(box[2], maxX);
    box[3] = Math.max(box[3], maxY);
  }
  return { triangles, boxes, box };
}

/** Shown on screen: the mesh and every ancestor visible. */
function shown(object: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) {
    if (!o.visible) return false;
  }
  return true;
}

function signedArea(polygon: readonly Point[]): number {
  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += polygon[j]![0] * polygon[i]![1] - polygon[i]![0] * polygon[j]![1];
  }
  return area / 2;
}

function triangleAt(region: Region2d, t: number): Point[] {
  const p = region.triangles;
  const tri: Point[] = [
    [p[t * 6]!, p[t * 6 + 1]!],
    [p[t * 6 + 2]!, p[t * 6 + 3]!],
    [p[t * 6 + 4]!, p[t * 6 + 5]!]
  ];
  // Clipping wants counter-clockwise clip edges.
  return signedArea(tri) < 0 ? [tri[0]!, tri[2]!, tri[1]!] : tri;
}

/** Sutherland–Hodgman: `subject` clipped to the convex CCW `clip`. */
export function clipConvex(
  subject: readonly Point[],
  clip: readonly Point[]
): Point[] {
  let output: Point[] = [...subject];
  for (let i = 0; i < clip.length && output.length > 0; i += 1) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const side = (p: Point) =>
      (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j += 1) {
      const current = input[j]!;
      const previous = input[(j + input.length - 1) % input.length]!;
      const sc = side(current);
      const sp = side(previous);
      if (sc >= 0) {
        if (sp < 0) {
          const t = sp / (sp - sc);
          output.push([
            previous[0] + (current[0] - previous[0]) * t,
            previous[1] + (current[1] - previous[1]) * t
          ]);
        }
        output.push(current);
      } else if (sp >= 0) {
        const t = sp / (sp - sc);
        output.push([
          previous[0] + (current[0] - previous[0]) * t,
          previous[1] + (current[1] - previous[1]) * t
        ]);
      }
    }
  }
  return output;
}

function boxesOverlap(
  a: ArrayLike<number>,
  ai: number,
  b: ArrayLike<number>,
  bi: number
): boolean {
  return (
    a[ai]! < b[bi + 2]! &&
    b[bi]! < a[ai + 2]! &&
    a[ai + 1]! < b[bi + 3]! &&
    b[bi + 1]! < a[ai + 3]!
  );
}

/**
 * The overlap of two cap regions: polygons in the plane frame, and their
 * total area. Each region's triangles tile it without overlapping, so the
 * pieces clipped triangle against triangle tile the shared area exactly.
 * Pieces at or below `minArea` (a shared edge, a rounding sliver) are not
 * overlap: touching is not interference.
 */
function overlapOf(a: Region2d, b: Region2d, minArea: number) {
  const pieces: Point[][] = [];
  let area = 0;
  if (!boxesOverlap(a.box, 0, b.box, 0)) return { pieces, area };
  const countA = a.triangles.length / 6;
  const countB = b.triangles.length / 6;
  for (let i = 0; i < countA; i += 1) {
    if (!boxesOverlap(a.boxes, i * 4, b.box, 0)) continue;
    let subject: Point[] | null = null;
    for (let j = 0; j < countB; j += 1) {
      if (!boxesOverlap(a.boxes, i * 4, b.boxes, j * 4)) continue;
      subject ??= triangleAt(a, i);
      const piece = clipConvex(subject, triangleAt(b, j));
      if (piece.length < 3) continue;
      const pieceArea = Math.abs(signedArea(piece));
      if (pieceArea <= minArea) continue;
      pieces.push(piece);
      area += pieceArea;
    }
  }
  return { pieces, area };
}

export interface SectionOverlapResult {
  /** Each overlapping pair, with its overlap as world-space triangles. */
  readonly pairs: (SectionOverlapPair & { readonly positions: Float32Array })[];
}

/**
 * Display overlap of every pair of bodies cut by `worldPlane`, from the
 * meshes' display tessellation. Bodies are grouped by their body id, so a
 * body drawn as several meshes is one region; hidden meshes take no part.
 */
export function sectionOverlaps(
  meshes: readonly ViewerMesh[],
  worldPlane: THREE.Plane
): SectionOverlapResult {
  const byBody = new Map<string, ViewerMesh[]>();
  for (const mesh of meshes) {
    const bodyId = findBodyId(mesh);
    if (!bodyId || !shown(mesh)) continue;
    const list = byBody.get(bodyId) ?? [];
    list.push(mesh);
    byBody.set(bodyId, list);
  }
  if (byBody.size < 2) return { pairs: [] };
  const frame = planeFrame(worldPlane);
  const regions: { bodyId: string; region: Region2d }[] = [];
  for (const [bodyId, list] of byBody) {
    const region = capRegion(list, worldPlane, frame);
    if (region) regions.push({ bodyId, region });
  }
  if (regions.length < 2) return { pairs: [] };
  let extent = 0;
  for (const { region } of regions) {
    extent = Math.max(
      extent,
      region.box[2] - region.box[0],
      region.box[3] - region.box[1]
    );
  }
  // An area floor scaled to the model: display tessellation rounds cut
  // edges to about this, so less than it is a shared edge, not overlap.
  const minArea = (Math.max(extent, 1e-9) * 1e-6) ** 2;
  const pairs: (SectionOverlapPair & { positions: Float32Array })[] = [];
  const lift = (p: Point) =>
    frame.origin
      .clone()
      .addScaledVector(frame.u, p[0])
      .addScaledVector(frame.v, p[1]);
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      const { pieces, area } = overlapOf(
        regions[i]!.region,
        regions[j]!.region,
        minArea
      );
      if (pieces.length === 0) continue;
      const out: number[] = [];
      for (const piece of pieces) {
        const first = lift(piece[0]!);
        for (let k = 1; k + 1 < piece.length; k += 1) {
          const second = lift(piece[k]!);
          const third = lift(piece[k + 1]!);
          out.push(
            first.x,
            first.y,
            first.z,
            second.x,
            second.y,
            second.z,
            third.x,
            third.y,
            third.z
          );
        }
      }
      pairs.push({
        a: regions[i]!.bodyId,
        b: regions[j]!.bodyId,
        area,
        positions: Float32Array.from(out)
      });
    }
  }
  return { pairs };
}

/**
 * Replace every overlap overlay under `root` with these pairs'. Each pair's
 * overlay hangs on a mesh of its first body, as the section caps do, so it
 * moves with that body and never counts as a body of its own; its
 * positions are taken into that mesh's frame. Drawn over the cut fill,
 * which lies in the same plane, by depth offset; never clipped (it lies in
 * the cutting plane) and never picked.
 */
export function applySectionOverlapOverlay(
  root: THREE.Object3D,
  meshes: readonly ViewerMesh[],
  result: SectionOverlapResult | null
) {
  const previous: THREE.Object3D[] = [];
  root.traverse((child) => {
    if (child.userData.sectionOverlap === true) previous.push(child);
  });
  for (const child of previous) {
    child.parent?.remove(child);
    const mesh = child as THREE.Mesh;
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
  if (!result) return;
  for (const pair of result.pairs) {
    const host = meshes.find((mesh) => findBodyId(mesh) === pair.a);
    if (!host || pair.positions.length === 0) continue;
    const inverse = host.matrixWorld.clone().invert();
    const positions = pair.positions.slice();
    const point = new THREE.Vector3();
    for (let i = 0; i < positions.length; i += 3) {
      point
        .set(positions[i]!, positions[i + 1]!, positions[i + 2])
        .applyMatrix4(inverse);
      positions[i] = point.x;
      positions[i + 1] = point.y;
      positions[i + 2] = point.z;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.MeshBasicMaterial({
      color: SECTION_OVERLAP_COLOR,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      toneMapped: false
    });
    const overlay = new THREE.Mesh(geometry, material);
    overlay.name = SECTION_OVERLAP;
    overlay.userData.sectionOverlap = true;
    overlay.userData.sectionOverlapPair = [pair.a, pair.b];
    overlay.raycast = () => undefined;
    overlay.renderOrder = 30;
    host.add(overlay);
  }
}
