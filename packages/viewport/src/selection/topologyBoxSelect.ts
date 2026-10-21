import * as THREE from 'three';
import type { BodyTopology, TopologySelection } from '@openzcad/shared';
import { shouldRenderTopologyEdge } from '../scene/objects';
import { sectionCapGeometry } from '../scene/sectionCaps';
import {
  pointInRect,
  triangleIntersectsRect,
  type BoxSelectMode,
  type BoxSelectOptions,
  type ProjectedPoint,
  type ScreenRect
} from './boxSelect';

/**
 * Box selection of faces and edges.
 *
 * The rule for what a rectangle takes is the body rule (`bodiesInBox`) applied
 * per entity: a window takes a face or edge only when all of it is inside, a
 * crossing anything the rectangle touches — so an edge the rectangle only
 * partly covers is taken by a crossing and left by a window.
 *
 * What the user can see is the second question. A sweep over a shaded part
 * means the faces and edges in front of the user, not the floor and back wall
 * hidden behind them, so without select-through an entity must also have some
 * visible part. Visibility comes from a small software depth buffer over the
 * rectangle: every body triangle there is rasterized at cell centres, and each
 * cell keeps the nearest triangle. A face is visible when it owns a cell; an
 * edge sample is visible when it is not behind the triangles that own the
 * cells around it, with each triangle's depth evaluated exactly at the sample
 * rather than at the cell centre (a concave crease is the farthest point of
 * both faces meeting at it, so cell-centre depths would always hide it). In
 * X-ray the faces hide nothing, so select-through skips the test.
 */
export interface TopologyBoxCandidate {
  bodyId: string;
  /** XYZ-interleaved world positions, as the mesh already stores them. */
  positions: ArrayLike<number>;
  /** Triangle vertex indices into `positions`. */
  indices: ArrayLike<number>;
  topology: Pick<BodyTopology, 'faces' | 'edges'> | undefined;
  /**
   * False for a body drawn without depth writes (translucent appearance):
   * what lies behind it stays drawn, so it hides nothing. Defaults to true.
   */
  occludes?: boolean;
}

export interface TopologyBoxOptions extends BoxSelectOptions {
  kind: 'face' | 'edge';
  /** X-ray: hidden faces and edges are taken too. */
  selectThrough?: boolean;
  /** The rendered section: points with negative signed distance are clipped. */
  clippingPlane?: THREE.Plane | null;
}

/** Cells along the rectangle's longer side, at most. */
const MAX_GRID_CELLS = 256;
/** Relative depth slack for an edge lying on the surface it bounds. */
const EDGE_DEPTH_RELATIVE_TOLERANCE = 1e-3;
/** A projected triangle thinner than this, in pixels, is seen edge-on. */
const MIN_FACING_THICKNESS_PX = 1;
/** Edge samples per segment, at most; enough for a cell-sized step. */
const MAX_SAMPLES_PER_SEGMENT = 32;

interface ProjectedBody {
  candidate: TopologyBoxCandidate;
  /** Screen x, y and depth key per vertex. */
  points: ProjectedPoint[];
  keys: Float64Array;
  /** Triangle index → face index in `topology.faces`, or -1. */
  faceOfTriangle: Int32Array;
}

/**
 * A depth key that is affine in screen space: the view depth for an
 * orthographic camera, and −1/depth for a perspective one (1/depth is what
 * interpolates linearly across a projected triangle). Both increase with
 * distance, so "nearer" is always "smaller".
 */
function depthKey(viewDepth: number, perspective: boolean): number {
  return perspective ? -1 / Math.max(viewDepth, 1e-9) : viewDepth;
}

/** Retain the same half-space the renderer keeps, including crossing segments. */
function clipSegment(
  a: THREE.Vector3,
  b: THREE.Vector3,
  plane?: THREE.Plane | null
): [THREE.Vector3, THREE.Vector3] | null {
  if (!plane) return [a, b];
  const da = plane.distanceToPoint(a);
  const db = plane.distanceToPoint(b);
  if (da < 0 && db < 0) return null;
  if (da < 0) a = a.clone().lerp(b, da / (da - db));
  else if (db < 0) b = a.clone().lerp(b, da / (da - db));
  return [a, b];
}

/** Parameter interval of a projected segment inside the drag rectangle. */
function screenInterval(
  a: ProjectedPoint,
  b: ProjectedPoint,
  rect: ScreenRect
): [number, number] | null {
  let from = 0;
  let to = 1;
  for (const [origin, delta, low, high] of [
    [a.x, b.x - a.x, rect.left, rect.right],
    [a.y, b.y - a.y, rect.top, rect.bottom]
  ] as const) {
    if (delta === 0) {
      if (origin < low || origin > high) return null;
      continue;
    }
    const first = (low - origin) / delta;
    const second = (high - origin) / delta;
    from = Math.max(from, Math.min(first, second));
    to = Math.min(to, Math.max(first, second));
    if (from > to) return null;
  }
  return [from, to];
}

/**
 * The camera's near and far planes in world space, positive on the side
 * WebGL draws. Topology outside them is clipped away on screen, so a sweep
 * must not take it, and a triangle crossing one keeps only its drawn part.
 */
function depthClippingPlanes(camera: THREE.Camera): THREE.Plane[] {
  const { near, far } = camera as
    THREE.PerspectiveCamera | THREE.OrthographicCamera;
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const origin = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  return [
    new THREE.Plane().setFromNormalAndCoplanarPoint(
      forward,
      origin.clone().addScaledVector(forward, near)
    ),
    new THREE.Plane().setFromNormalAndCoplanarPoint(
      forward.clone().negate(),
      origin.clone().addScaledVector(forward, far)
    )
  ];
}

/** Whether any vertex lies on the clipped side, so clipping can change it. */
function crossesPlane(
  candidate: TopologyBoxCandidate,
  plane: THREE.Plane
): boolean {
  const point = new THREE.Vector3();
  for (let index = 0; index + 2 < candidate.positions.length; index += 3) {
    point.set(
      candidate.positions[index] ?? 0,
      candidate.positions[index + 1] ?? 0,
      candidate.positions[index + 2] ?? 0
    );
    if (plane.distanceToPoint(point) < 0) return true;
  }
  return false;
}

/**
 * Clip triangles before projection and depth tests. Keep each face's range
 * mapped to its surviving triangles. A section adds its caps, which only
 * occlude and own no face; the camera's depth planes draw none.
 */
function clipBody(
  candidate: TopologyBoxCandidate,
  plane: THREE.Plane,
  withCaps = true
): TopologyBoxCandidate {
  const positions: number[] = [];
  const indices: number[] = [];
  const count = Math.floor(candidate.indices.length / 3);
  const offsets = new Uint32Array(count + 1);
  const vertex = (index: number) =>
    new THREE.Vector3(
      candidate.positions[index * 3],
      candidate.positions[index * 3 + 1],
      candidate.positions[index * 3 + 2]
    );
  const appendTriangle = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3
  ) => {
    for (const point of [a, b, c]) {
      indices.push(positions.length / 3);
      positions.push(point.x, point.y, point.z);
    }
  };
  for (let triangle = 0; triangle < count; triangle += 1) {
    const polygon = [0, 1, 2].map((corner) =>
      vertex(candidate.indices[triangle * 3 + corner]!)
    );
    const kept: THREE.Vector3[] = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const a = polygon[corner]!;
      const b = polygon[(corner + 1) % 3]!;
      const da = plane.distanceToPoint(a);
      const db = plane.distanceToPoint(b);
      if (da >= 0) kept.push(a);
      if (da < 0 !== db < 0) kept.push(a.clone().lerp(b, da / (da - db)));
    }
    for (let corner = 1; corner + 1 < kept.length; corner += 1) {
      appendTriangle(kept[0]!, kept[corner]!, kept[corner + 1]!);
    }
    offsets[triangle + 1] = indices.length / 3;
  }
  const faces = candidate.topology!.faces.map((face) => {
    const start = offsets[Math.min(face.triangleStart, count)]!;
    const end =
      offsets[Math.min(face.triangleStart + face.triangleCount, count)]!;
    return { ...face, triangleStart: start, triangleCount: end - start };
  });
  if (!withCaps) {
    return {
      ...candidate,
      positions,
      indices,
      topology: { ...candidate.topology!, faces }
    };
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(Array.from(candidate.positions), 3)
  );
  geometry.setIndex(Array.from(candidate.indices));
  const cap = sectionCapGeometry(geometry, plane);
  if (cap) {
    const points = cap.getAttribute('position');
    const capIndices = cap.index;
    const size = capIndices?.count ?? points.count;
    for (let index = 0; index < size; index += 3) {
      appendTriangle(
        ...([0, 1, 2].map((corner) =>
          new THREE.Vector3().fromBufferAttribute(
            points,
            capIndices ? capIndices.getX(index + corner) : index + corner
          )
        ) as [THREE.Vector3, THREE.Vector3, THREE.Vector3])
      );
    }
    cap.dispose();
  }
  geometry.dispose();
  return {
    ...candidate,
    positions,
    indices,
    topology: { ...candidate.topology!, faces }
  };
}

function projectBody(
  candidate: TopologyBoxCandidate,
  options: BoxSelectOptions,
  perspective: boolean
): ProjectedBody {
  const { camera, width, height } = options;
  const count = Math.floor(candidate.positions.length / 3);
  const points = new Array<ProjectedPoint>(count);
  const keys = new Float64Array(count);
  const world = new THREE.Vector3();
  const view = new THREE.Vector3();
  for (let index = 0; index < count; index += 1) {
    world.set(
      candidate.positions[index * 3] ?? 0,
      candidate.positions[index * 3 + 1] ?? 0,
      candidate.positions[index * 3 + 2] ?? 0
    );
    view.copy(world).applyMatrix4(camera.matrixWorldInverse);
    const viewDepth = -view.z;
    world.project(camera);
    points[index] = {
      x: ((world.x + 1) / 2) * width,
      y: ((1 - world.y) / 2) * height,
      behind: world.z > 1 || (perspective && viewDepth <= 0)
    };
    keys[index] = depthKey(viewDepth, perspective);
  }
  const triangleCount = Math.floor(candidate.indices.length / 3);
  const faceOfTriangle = new Int32Array(triangleCount).fill(-1);
  candidate.topology?.faces.forEach((face, faceIndex) => {
    const end = Math.min(
      face.triangleStart + face.triangleCount,
      triangleCount
    );
    for (let triangle = face.triangleStart; triangle < end; triangle += 1) {
      faceOfTriangle[triangle] = faceIndex;
    }
  });
  return { candidate, points, keys, faceOfTriangle };
}

/**
 * How thick a projected triangle is on screen — its least altitude, in
 * pixels — when it faces the camera, and 0 when it faces away. Screen y runs
 * down, so a triangle wound counter-clockwise from outside, as exact kernels
 * wind every face, faces the camera when its signed area is negative. When
 * bodies draw both sides (a section is active), either winding counts.
 */
function facingThickness(
  a: ProjectedPoint,
  b: ProjectedPoint,
  c: ProjectedPoint,
  doubleSided = false
): number {
  const doubled = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const longest = Math.max(
    Math.hypot(b.x - a.x, b.y - a.y),
    Math.hypot(c.x - b.x, c.y - b.y),
    Math.hypot(a.x - c.x, a.y - c.y)
  );
  const facing = doubleSided ? Math.abs(doubled) : -doubled;
  return facing > 0 && longest > 0 ? facing / longest : 0;
}

/** Barycentric weights of (x, y) in a screen triangle; null if degenerate. */
function barycentric(
  x: number,
  y: number,
  a: ProjectedPoint,
  b: ProjectedPoint,
  c: ProjectedPoint
): [number, number, number] | null {
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area) < 1e-12) {
    return null;
  }
  const wa = ((b.x - x) * (c.y - y) - (b.y - y) * (c.x - x)) / area;
  const wb = ((c.x - x) * (a.y - y) - (c.y - y) * (a.x - x)) / area;
  return [wa, wb, 1 - wa - wb];
}

/**
 * The software depth buffer: one cell per `cell` pixels over the rectangle
 * and a one-cell margin, each holding the nearest triangle's depth key at the
 * cell centre and which body triangle that was.
 */
class DepthGrid {
  readonly columns: number;
  readonly rows: number;
  readonly cell: number;
  readonly originX: number;
  readonly originY: number;
  readonly depth: Float64Array;
  /** Body index, or -1 for an empty cell. */
  readonly body: Int32Array;
  readonly triangle: Int32Array;

  constructor(rect: ScreenRect) {
    const span = Math.max(rect.right - rect.left, rect.bottom - rect.top, 1);
    this.cell = Math.max(1, span / MAX_GRID_CELLS);
    this.originX = rect.left - this.cell;
    this.originY = rect.top - this.cell;
    this.columns = Math.ceil((rect.right - rect.left) / this.cell) + 3;
    this.rows = Math.ceil((rect.bottom - rect.top) / this.cell) + 3;
    const size = this.columns * this.rows;
    this.depth = new Float64Array(size).fill(Infinity);
    this.body = new Int32Array(size).fill(-1);
    this.triangle = new Int32Array(size).fill(-1);
  }

  centreX(column: number) {
    return this.originX + (column + 0.5) * this.cell;
  }

  centreY(row: number) {
    return this.originY + (row + 0.5) * this.cell;
  }

  /**
   * `cullBackFaces` follows the renderer: bodies draw front faces only
   * unless a section switches them to both sides, so without one a wall seen
   * from inside (past a near plane that cuts the body) hides nothing.
   */
  rasterize(bodies: ProjectedBody[], cullBackFaces: boolean) {
    bodies.forEach((projected, bodyIndex) => {
      const { candidate, points, keys } = projected;
      if (candidate.occludes === false) return;
      const triangleCount = Math.floor(candidate.indices.length / 3);
      for (let triangle = 0; triangle < triangleCount; triangle += 1) {
        const ia = candidate.indices[triangle * 3] ?? -1;
        const ib = candidate.indices[triangle * 3 + 1] ?? -1;
        const ic = candidate.indices[triangle * 3 + 2] ?? -1;
        const a = points[ia];
        const b = points[ib];
        const c = points[ic];
        // Near-plane clipping is not represented here, as in bodiesInBox.
        if (!a || !b || !c || a.behind || b.behind || c.behind) {
          continue;
        }
        // Screen y runs down, so a front face has a negative signed area.
        if (
          cullBackFaces &&
          (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) >= 0
        ) {
          continue;
        }
        const minColumn = Math.max(
          0,
          Math.ceil((Math.min(a.x, b.x, c.x) - this.originX) / this.cell - 0.5)
        );
        const maxColumn = Math.min(
          this.columns - 1,
          Math.floor((Math.max(a.x, b.x, c.x) - this.originX) / this.cell - 0.5)
        );
        const minRow = Math.max(
          0,
          Math.ceil((Math.min(a.y, b.y, c.y) - this.originY) / this.cell - 0.5)
        );
        const maxRow = Math.min(
          this.rows - 1,
          Math.floor((Math.max(a.y, b.y, c.y) - this.originY) / this.cell - 0.5)
        );
        if (minColumn > maxColumn || minRow > maxRow) {
          continue;
        }
        const ka = keys[ia]!;
        const kb = keys[ib]!;
        const kc = keys[ic]!;
        for (let row = minRow; row <= maxRow; row += 1) {
          const y = this.centreY(row);
          for (let column = minColumn; column <= maxColumn; column += 1) {
            const weights = barycentric(this.centreX(column), y, a, b, c);
            if (
              !weights ||
              weights[0] < -1e-9 ||
              weights[1] < -1e-9 ||
              weights[2] < -1e-9
            ) {
              continue;
            }
            const key = weights[0] * ka + weights[1] * kb + weights[2] * kc;
            const at = row * this.columns + column;
            if (key < this.depth[at]!) {
              this.depth[at] = key;
              this.body[at] = bodyIndex;
              this.triangle[at] = triangle;
            }
          }
        }
      }
    });
  }

  /**
   * Whether a point at (x, y) with depth `key` is not behind the surfaces
   * drawn around it. An empty neighbouring cell (background, a silhouette)
   * hides nothing.
   */
  visible(x: number, y: number, key: number, bodies: ProjectedBody[]) {
    const column = Math.floor((x - this.originX) / this.cell);
    const row = Math.floor((y - this.originY) / this.cell);
    const tolerance = Math.abs(key) * EDGE_DEPTH_RELATIVE_TOLERANCE + 1e-12;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const r = row + dy;
        const c = column + dx;
        if (r < 0 || c < 0 || r >= this.rows || c >= this.columns) {
          return true;
        }
        const at = r * this.columns + c;
        const bodyIndex = this.body[at]!;
        if (bodyIndex < 0) {
          return true;
        }
        const projected = bodies[bodyIndex]!;
        const triangle = this.triangle[at]!;
        const indices = projected.candidate.indices;
        const ia = indices[triangle * 3]!;
        const ib = indices[triangle * 3 + 1]!;
        const ic = indices[triangle * 3 + 2]!;
        const weights = barycentric(
          x,
          y,
          projected.points[ia]!,
          projected.points[ib]!,
          projected.points[ic]!
        );
        // The owning triangle's plane, extended to the sample point.
        const surface = weights
          ? weights[0] * projected.keys[ia]! +
            weights[1] * projected.keys[ib]! +
            weights[2] * projected.keys[ic]!
          : this.depth[at]!;
        if (key <= surface + tolerance) {
          return true;
        }
      }
    }
    return false;
  }

  /** Every (body, face) owning at least one cell inside the rectangle. */
  visibleFaces(rect: ScreenRect, bodies: ProjectedBody[]): Set<string> {
    const owned = new Set<string>();
    for (let row = 0; row < this.rows; row += 1) {
      const y = this.centreY(row);
      if (y < rect.top || y > rect.bottom) continue;
      for (let column = 0; column < this.columns; column += 1) {
        const x = this.centreX(column);
        if (x < rect.left || x > rect.right) continue;
        const at = row * this.columns + column;
        const bodyIndex = this.body[at]!;
        if (bodyIndex < 0) continue;
        const face = bodies[bodyIndex]!.faceOfTriangle[this.triangle[at]!]!;
        if (face >= 0) owned.add(`${bodyIndex}:${face}`);
      }
    }
    return owned;
  }
}

/** A point inside the convex triangle/rectangle intersection. */
function faceSampleInRect(
  a: ProjectedPoint,
  b: ProjectedPoint,
  c: ProjectedPoint,
  rect: ScreenRect
): { x: number; y: number } | null {
  let polygon = [a, b, c].map(({ x, y }) => ({ x, y }));
  for (const [axis, boundary, direction] of [
    ['x', rect.left, 1],
    ['x', rect.right, -1],
    ['y', rect.top, 1],
    ['y', rect.bottom, -1]
  ] as const) {
    const clipped: { x: number; y: number }[] = [];
    for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index]!;
      const end = polygon[(index + 1) % polygon.length]!;
      const insideStart = direction * (start[axis] - boundary) >= 0;
      const insideEnd = direction * (end[axis] - boundary) >= 0;
      if (insideStart) clipped.push(start);
      if (insideStart !== insideEnd) {
        const t = (boundary - start[axis]) / (end[axis] - start[axis]);
        clipped.push({
          x: start.x + (end.x - start.x) * t,
          y: start.y + (end.y - start.y) * t
        });
      }
    }
    polygon = clipped;
    if (polygon.length === 0) return null;
  }
  return {
    x: polygon.reduce((sum, point) => sum + point.x, 0) / polygon.length,
    y: polygon.reduce((sum, point) => sum + point.y, 0) / polygon.length
  };
}

function faceSelections(
  bodies: ProjectedBody[],
  rect: ScreenRect,
  mode: BoxSelectMode,
  grid: DepthGrid | null,
  doubleSided: boolean
): TopologySelection[] {
  const owned = grid?.visibleFaces(rect, bodies) ?? null;
  const selected: TopologySelection[] = [];
  bodies.forEach((projected, bodyIndex) => {
    const { candidate, points, keys } = projected;
    candidate.topology?.faces.forEach((face, faceIndex) => {
      let allInside = true;
      let touched = false;
      let anyTriangle = false;
      let sampleVisible = false;
      const end = Math.min(
        face.triangleStart + face.triangleCount,
        Math.floor(candidate.indices.length / 3)
      );
      for (let triangle = face.triangleStart; triangle < end; triangle += 1) {
        const ia = candidate.indices[triangle * 3] ?? -1;
        const ib = candidate.indices[triangle * 3 + 1] ?? -1;
        const ic = candidate.indices[triangle * 3 + 2] ?? -1;
        const a = points[ia];
        const b = points[ib];
        const c = points[ic];
        if (!a || !b || !c) continue;
        anyTriangle = true;
        if (a.behind || b.behind || c.behind) {
          allInside = false;
          continue;
        }
        if (
          allInside &&
          !(
            pointInRect(a, rect) &&
            pointInRect(b, rect) &&
            pointInRect(c, rect)
          )
        ) {
          allInside = false;
        }
        if (!touched && triangleIntersectsRect(a, b, c, rect)) {
          touched = true;
        }
        // A face too small to own a whole cell still shows itself through its
        // triangle/rectangle overlap, tested like an edge sample — but only where the
        // triangle faces the camera and is at least a pixel thick. A face seen
        // edge-on (a top view's sides, nudged off vertical) or from behind at
        // a silhouette has its centroid on the outline, beside empty cells,
        // and would read as visible when nothing of it is drawn.
        if (
          grid &&
          owned &&
          !sampleVisible &&
          !owned.has(`${bodyIndex}:${faceIndex}`) &&
          facingThickness(a, b, c, doubleSided) >= MIN_FACING_THICKNESS_PX
        ) {
          const sample = faceSampleInRect(a, b, c, rect);
          const weights = sample
            ? barycentric(sample.x, sample.y, a, b, c)
            : null;
          if (sample && weights) {
            const key =
              weights[0] * keys[ia]! +
              weights[1] * keys[ib]! +
              weights[2] * keys[ic]!;
            sampleVisible = grid.visible(sample.x, sample.y, key, bodies);
          }
        }
      }
      if (!anyTriangle) return;
      const inBox = mode === 'window' ? allInside : touched;
      const visible =
        !grid || owned!.has(`${bodyIndex}:${faceIndex}`) || sampleVisible;
      if (inBox && visible) {
        selected.push({
          bodyId: candidate.bodyId as TopologySelection['bodyId'],
          kind: 'face',
          topologyId: face.topologyId,
          hash: face.hash,
          ...(face.reference ? { reference: face.reference } : {})
        });
      }
    });
  });
  return selected;
}

function edgeSelections(
  bodies: ProjectedBody[],
  rect: ScreenRect,
  mode: BoxSelectMode,
  options: TopologyBoxOptions,
  perspective: boolean,
  grid: DepthGrid | null
): TopologySelection[] {
  const { camera, width, height } = options;
  const depthPlanes = depthClippingPlanes(camera);
  const world = new THREE.Vector3();
  const view = new THREE.Vector3();
  const project = (x: number, y: number, z: number) => {
    world.set(x, y, z);
    view.copy(world).applyMatrix4(camera.matrixWorldInverse);
    const viewDepth = -view.z;
    world.project(camera);
    return {
      x: ((world.x + 1) / 2) * width,
      y: ((1 - world.y) / 2) * height,
      behind: world.z > 1 || (perspective && viewDepth <= 0),
      key: depthKey(viewDepth, perspective)
    };
  };
  const selected: TopologySelection[] = [];
  for (const projected of bodies) {
    const { candidate } = projected;
    for (const edge of candidate.topology?.edges ?? []) {
      if (!shouldRenderTopologyEdge(edge)) continue;
      const segments: [
        ReturnType<typeof project>,
        ReturnType<typeof project>
      ][] = [];
      for (let index = 0; index + 5 < edge.points.length; index += 3) {
        const a = new THREE.Vector3(
          edge.points[index],
          edge.points[index + 1],
          edge.points[index + 2]
        );
        const b = new THREE.Vector3(
          edge.points[index + 3],
          edge.points[index + 4],
          edge.points[index + 5]
        );
        let kept = clipSegment(a, b, options.clippingPlane);
        for (const plane of depthPlanes) {
          if (kept) kept = clipSegment(kept[0], kept[1], plane);
        }
        if (kept)
          segments.push(
            kept.map((point) => project(point.x, point.y, point.z)) as [
              ReturnType<typeof project>,
              ReturnType<typeof project>
            ]
          );
      }
      if (segments.length === 0) continue;
      const allInside = segments.every((points) =>
        points.every((point) => !point.behind && pointInRect(point, rect))
      );
      let touched = false;
      let visible = grid === null;
      for (const [a, b] of segments) {
        if (a.behind || b.behind) continue;
        const interval = screenInterval(a, b, rect);
        if (!interval) continue;
        touched = true;
        if (visible) break;
        const [from, to] = interval;
        const length = Math.hypot(b.x - a.x, b.y - a.y) * (to - from);
        const steps = Math.min(
          MAX_SAMPLES_PER_SEGMENT,
          Math.max(1, Math.ceil(length / grid!.cell))
        );
        for (let step = 0; step <= steps && !visible; step += 1) {
          const t = from + ((to - from) * step) / steps;
          const x = a.x + (b.x - a.x) * t;
          const y = a.y + (b.y - a.y) * t;
          if (!pointInRect({ x, y }, rect)) continue;
          // The key is affine in screen space, so it interpolates exactly.
          const key = a.key + (b.key - a.key) * t;
          visible = grid!.visible(x, y, key, bodies);
        }
      }
      const inBox = mode === 'window' ? allInside : touched;
      if (inBox && visible) {
        selected.push({
          bodyId: candidate.bodyId as TopologySelection['bodyId'],
          kind: 'edge',
          topologyId: edge.topologyId,
          hash: edge.hash,
          ...(edge.reference ? { reference: edge.reference } : {})
        });
      }
    }
  }
  return selected;
}

/**
 * The faces or edges a drag rectangle selects, in body order and then in
 * topology order.
 */
export function topologyInBox(
  candidates: TopologyBoxCandidate[],
  rect: ScreenRect,
  mode: BoxSelectMode,
  options: TopologyBoxOptions
): TopologySelection[] {
  const camera = options.camera;
  camera.updateMatrixWorld();
  const perspective =
    (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
  const depthPlanes = depthClippingPlanes(camera);
  const bodies = candidates
    .filter((candidate) => candidate.topology)
    .map((candidate) =>
      options.clippingPlane
        ? clipBody(candidate, options.clippingPlane)
        : candidate
    )
    .map((candidate) =>
      depthPlanes.reduce(
        (clipped, plane) =>
          crossesPlane(clipped, plane)
            ? clipBody(clipped, plane, false)
            : clipped,
        candidate
      )
    )
    .map((candidate) => projectBody(candidate, options, perspective));
  let grid: DepthGrid | null = null;
  if (!options.selectThrough) {
    grid = new DepthGrid(rect);
    grid.rasterize(bodies, !options.clippingPlane);
  }
  return options.kind === 'face'
    ? faceSelections(bodies, rect, mode, grid, Boolean(options.clippingPlane))
    : edgeSelections(bodies, rect, mode, options, perspective, grid);
}
