import type {
  AxisProjection,
  CubeCorner,
  StandardView
} from '@openzcad/viewport';

/**
 * The view cube's geometry and its projection through the live camera.
 *
 * Two things draw from this: the SVG in OrientationWidget, which is the
 * cube's click, focus and accessibility surface, and the overlay the viewer
 * paints into its own WebGL canvas (orientationCubeOverlay.ts). Sharing one
 * projection is what keeps every facet you can see on top of the element
 * that answers for it.
 */

/**
 * SVG size, center and pixels per cube half-edge. The box hugs the cube: its
 * silhouette reaches at most sqrt(3) half-edges (~36 px) from the center, and
 * the triad tips that reach past the box overhang with `overflow: visible`
 * rather than earning padding on every side.
 */
export const CUBE_SIZE = 88;
const CX = CUBE_SIZE / 2;
const CY = CUBE_SIZE / 2;
const SCALE = 21;
/** Fraction of a half-edge cut off each corner for the isometric facets. */
const BEVEL = 0.42;
/**
 * The same cut, taken deeper, for the corners' invisible click target.
 *
 * A drawn bevel facet is tiny: measured on the running widget the corner
 * turned most toward the camera covers ~67 px² and the glancing ones ~21 px²,
 * against ~960 px² for a face — a 14:1 ratio, so the isometric views are the
 * hardest thing on the cube to hit and the easiest to miss. Growing the drawn
 * bevel to fix that would restyle the cube, so only the target grows: it is
 * the part of the cube's surface this deeper cut takes off the corner — the
 * facet plus a triangle on each adjacent face that shows. Deeper cuts stay
 * disjoint between corners for any bevel below 1, so no two corners can ever
 * compete for the same pixel; the area comes off the faces instead, which
 * can spare it.
 *
 * The depth is set by the 24 px minimum pointer target: the corner turned
 * toward the camera spans 1.5 cut-depths of foreshortened edge vertically,
 * so at 0.8 it measured 24×20 px in the isometric view. At 0.96 it is
 * 28×25, and every face keeps the diamond between its edge midpoints —
 * just over half its area, its label at the centre.
 */
const CORNER_HIT_BEVEL = 0.96;
/**
 * How far, in px, a corner's target reaches past the cube's silhouette.
 *
 * A corner on the silhouette has a face turned away, so its target is the
 * surface you can see on one side of the apex and nothing on the other: in
 * the isometric view those targets measured 10×17 and 20×6 px. The target
 * runs out through the apex into the empty margin instead, so it keeps at
 * least 24 px on both axes there (17×21 at a 6 px reach). The silhouette
 * corners' apexes stand at least a cube edge apart on screen, so the reaches
 * never meet; the SVG draws overflow, so a reach past its box still hits.
 */
const CORNER_HIT_OVERHANG = 12;
/**
 * The triad is anchored on the cube corner the model origin projects to, and
 * its arms run along the cube edges — through the far corners at 2 half-edges
 * — before overhanging into free space, letters at the tips.
 */
const TRIAD_ORIGIN: Vec3 = [-1, -1, -1];
const ARM_TO = 2.5;
const ARM_LABEL_AT = 2.85;

/** Below this facing ratio a facet is a sliver not worth drawing or clicking. */
const FACING_EPSILON = 0.03;
/** Above this the face is head-on, and clicking it flips to the far side. */
const HEAD_ON = 0.999;

type Vec3 = readonly [number, number, number];

/** A point in the cube's SVG user space, which is CSS pixels. */
export interface CubePoint {
  x: number;
  y: number;
}

/**
 * One cube face: its outward normal and the in-plane frame its label is drawn
 * in. `u`/`v` are screen-right/screen-up when the face is viewed head-on in
 * its own standard view, so the label reads upright exactly when you arrive.
 */
export interface FaceSpec {
  view: StandardView;
  opposite: StandardView;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
}

export const FACES: FaceSpec[] = [
  {
    view: 'right',
    opposite: 'left',
    normal: [1, 0, 0],
    u: [0, 1, 0],
    v: [0, 0, 1]
  },
  {
    view: 'left',
    opposite: 'right',
    normal: [-1, 0, 0],
    u: [0, -1, 0],
    v: [0, 0, 1]
  },
  {
    view: 'back',
    opposite: 'front',
    normal: [0, 1, 0],
    u: [-1, 0, 0],
    v: [0, 0, 1]
  },
  {
    view: 'front',
    opposite: 'back',
    normal: [0, -1, 0],
    u: [1, 0, 0],
    v: [0, 0, 1]
  },
  {
    view: 'top',
    opposite: 'bottom',
    normal: [0, 0, 1],
    u: [1, 0, 0],
    v: [0, 1, 0]
  },
  // Bottom mirrors top left-to-right: both poles share screen-up +Y (the
  // cameraUpForDirection convention), and looking up flips only screen-right.
  {
    view: 'bottom',
    opposite: 'top',
    normal: [0, 0, -1],
    u: [-1, 0, 0],
    v: [0, 1, 0]
  }
];

/**
 * Face outline with its corners cut for the bevel facets, in the face's
 * `(u, v)` plane. Each square corner is replaced by the two points `BEVEL`
 * short of it, so the octagons and corner triangles tile the cube exactly.
 */
const FACE_OUTLINE: readonly (readonly [number, number])[] = (() => {
  const b = 1 - BEVEL;
  return [
    [b, 1],
    [-b, 1],
    [-1, b],
    [-1, -b],
    [-b, -1],
    [b, -1],
    [1, -b],
    [1, b]
  ];
})();

/**
 * One bevelled corner facet: a large click target for the isometric view out
 * of that octant. The triangle's vertices sit `BEVEL` short of the corner
 * along each of its three edges, splicing into the faces' cut corners.
 */
export interface CornerSpec {
  corner: CubeCorner;
  normal: Vec3;
  points: readonly Vec3[];
  /**
   * Where the deeper cut crosses each of the corner's three edges, by axis:
   * the click target's outline, never painted. Edge `i` runs along axis `i`.
   */
  hitPoints: readonly [Vec3, Vec3, Vec3];
  /**
   * The outward normal of the face between edges `i` and `i + 1` (mod 3),
   * which is the face across the third axis.
   */
  faceNormals: readonly [Vec3, Vec3, Vec3];
  label: string;
}

/** The triangle left when `bevel` of each half-edge is cut off one corner. */
function cornerFacet(
  sx: number,
  sy: number,
  sz: number,
  bevel: number
): readonly [Vec3, Vec3, Vec3] {
  const b = 1 - bevel;
  return [
    [sx * b, sy, sz],
    [sx, sy * b, sz],
    [sx, sy, sz * b]
  ];
}

export const CORNERS: CornerSpec[] = ([-1, 1] as const).flatMap((sx) =>
  ([-1, 1] as const).flatMap((sy) =>
    ([-1, 1] as const).map((sz): CornerSpec => {
      const n = 1 / Math.sqrt(3);
      return {
        corner: [sx, sy, sz],
        normal: [sx * n, sy * n, sz * n],
        points: cornerFacet(sx, sy, sz, BEVEL),
        hitPoints: cornerFacet(sx, sy, sz, CORNER_HIT_BEVEL),
        faceNormals: [
          [0, 0, sz],
          [sx, 0, 0],
          [0, sy, 0]
        ],
        // "isometric" between the octant and "view" keeps every corner name
        // distinct from the face names under substring accessible-name
        // matching: "top front right view" would otherwise contain "right
        // view".
        label: `${sz > 0 ? 'Top' : 'Bottom'} ${sy > 0 ? 'back' : 'front'} ${
          sx > 0 ? 'right' : 'left'
        } isometric view`
      };
    })
  )
);

export const AXIS_KEYS = ['x', 'y', 'z'] as const;
export type AxisKey = (typeof AXIS_KEYS)[number];

/**
 * Which two cube faces each triad arm's edge belongs to. An arm is drawn over
 * the cube while either face shows — the edge is then on the visible surface
 * — and drops behind the opaque faces otherwise, so the silhouette clips it
 * and only its overhang past the cube stays visible.
 */
const ARM_FACES: Record<AxisKey, readonly [Vec3, Vec3]> = {
  x: [
    [0, -1, 0],
    [0, 0, -1]
  ],
  y: [
    [-1, 0, 0],
    [0, 0, -1]
  ],
  z: [
    [-1, 0, 0],
    [0, -1, 0]
  ]
};

const AXIS_VECTORS: Record<AxisKey, Vec3> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1]
};

/**
 * A 2D affine map, SVG `matrix(a, b, c, d, e, f)` order: a point `(x, y)`
 * lands at `(a·x + c·y + e, b·x + d·y + f)`.
 */
export type CubeAffine = readonly [
  number,
  number,
  number,
  number,
  number,
  number
];

export interface ProjectedFace {
  /** 0 glancing, 1 head-on; the fill mixes between the theme's two ends. */
  facing: number;
  outline: CubePoint[];
  /** Places the face's label on it, centred on the face. */
  label: CubeAffine;
  /** What clicking the face does: its own view, or the far side head-on. */
  action: StandardView;
}

export interface ProjectedCorner {
  facing: number;
  outline: CubePoint[];
  /** The deeper cut that widens the click target; never painted. */
  target: CubePoint[];
}

export interface ProjectedArm {
  /** Drawn over the facets while the arm's edge is on the visible surface. */
  onSurface: boolean;
  from: CubePoint;
  to: CubePoint;
  /** The letter's anchor: centred on x, alphabetic baseline on y. */
  letter: CubePoint;
  opacity: number;
}

export interface CubeProjection {
  /** By `FACES` index; null while the face is turned away. */
  faces: (ProjectedFace | null)[];
  /** By `CORNERS` index; null while the corner is turned away. */
  corners: (ProjectedCorner | null)[];
  arms: Record<AxisKey, ProjectedArm>;
}

/**
 * Where everything on the cube lands for one camera orientation, in the SVG's
 * user space. The camera is orthographic for the cube, so this is a 3×2
 * projection of each vertex and nothing more.
 */
export function projectCube(axes: AxisProjection): CubeProjection {
  const sx = (p: Vec3) => p[0] * axes.x.x + p[1] * axes.y.x + p[2] * axes.z.x;
  const sy = (p: Vec3) => p[0] * axes.x.y + p[1] * axes.y.y + p[2] * axes.z.y;
  const depth = (p: Vec3) =>
    p[0] * axes.x.z + p[1] * axes.y.z + p[2] * axes.z.z;
  const px = (p: Vec3) => CX + SCALE * sx(p);
  const py = (p: Vec3) => CY + SCALE * sy(p);
  const point = (p: Vec3): CubePoint => ({ x: px(p), y: py(p) });
  /**
   * The surface the deeper cut takes off a corner, as it shows: walking
   * the three edge crossings, a face that shows is crossed in a straight
   * line (its share is the triangle between the line and the corner),
   * and a face turned away is skipped by running out through the apex,
   * pushed `CORNER_HIT_OVERHANG` past the silhouette. An edge between
   * two turned-away faces points into the screen and adds nothing.
   */
  const cornerTarget = (corner: CornerSpec): CubePoint[] => {
    const shows = corner.faceNormals.map(
      (normal) => depth(normal) > FACING_EPSILON
    );
    const outX = sx(corner.normal);
    const outY = sy(corner.normal);
    const reach = Math.hypot(outX, outY);
    const push = reach > 1e-6 ? CORNER_HIT_OVERHANG / reach : 0;
    const apex: CubePoint = {
      x: px(corner.corner) + outX * push,
      y: py(corner.corner) + outY * push
    };
    const points: CubePoint[] = [];
    const isApex = (candidate: CubePoint | undefined) =>
      candidate?.x === apex.x && candidate.y === apex.y;
    corner.hitPoints.forEach((hitPoint, edge) => {
      const before = shows[(edge + 2) % 3];
      const after = shows[edge];
      if (before || after) {
        points.push(point(hitPoint));
      }
      if (!after && !isApex(points.at(-1))) {
        points.push(apex);
      }
    });
    const first = points[0];
    const last = points.at(-1);
    if (
      points.length > 1 &&
      first &&
      last &&
      first.x === last.x &&
      first.y === last.y
    ) {
      points.pop();
    }
    return points;
  };

  const faces = FACES.map((face): ProjectedFace | null => {
    const facing = depth(face.normal);
    if (facing < FACING_EPSILON) {
      return null;
    }
    const { normal: n, u, v } = face;
    return {
      facing,
      outline: FACE_OUTLINE.map(([a, b]) =>
        point([
          n[0] + a * u[0] + b * v[0],
          n[1] + a * u[1] + b * v[1],
          n[2] + a * u[2] + b * v[2]
        ])
      ),
      // An orthographic projection of a planar face is exactly a 2D affine
      // map, so the label lies on the face via a single matrix: text-right
      // along u, text-up along v (negated — SVG y grows downward).
      label: [sx(u), sy(u), -sx(v), -sy(v), px(n), py(n)],
      action: facing > HEAD_ON ? face.opposite : face.view
    };
  });

  const corners = CORNERS.map((corner): ProjectedCorner | null => {
    const facing = depth(corner.normal);
    // The target hides with its facet: an invisible triangle over a corner
    // that has turned away would swallow clicks meant for the face now
    // covering that ground.
    if (facing < FACING_EPSILON) {
      return null;
    }
    return {
      facing,
      outline: corner.points.map(point),
      target: cornerTarget(corner)
    };
  });

  const arm = (key: AxisKey): ProjectedArm => {
    const [faceA, faceB] = ARM_FACES[key];
    const axis = AXIS_VECTORS[key];
    const along = (distance: number): Vec3 => [
      TRIAD_ORIGIN[0] + axis[0] * distance,
      TRIAD_ORIGIN[1] + axis[1] * distance,
      TRIAD_ORIGIN[2] + axis[2] * distance
    ];
    const letter = point(along(ARM_LABEL_AT));
    // An axis pointing at the camera collapses its arm to a dot on the
    // corner; fade it out rather than leave a letter floating there.
    const dir = axes[key];
    const planar = Math.hypot(dir.x, dir.y);
    return {
      onSurface: depth(faceA) > FACING_EPSILON || depth(faceB) > FACING_EPSILON,
      from: point(TRIAD_ORIGIN),
      to: point(along(ARM_TO)),
      // +3 re-centers the letter vertically: text-anchor handles x, but
      // SVG has no dominant-baseline shorthand old enough to trust here.
      letter: { x: letter.x, y: letter.y + 3 },
      opacity: Math.min(Math.max((planar - 0.3) / 0.25, 0), 1)
    };
  };

  return {
    faces,
    corners,
    arms: { x: arm('x'), y: arm('y'), z: arm('z') }
  };
}

/** A facet the pointer or keyboard focus is on. */
export interface CubeFacet {
  kind: 'face' | 'corner';
  index: number;
}

export interface CubeHighlight {
  /** Under the pointer: a face, or a corner by either half of its target. */
  hovered: CubeFacet | null;
  /** Keyboard focus, which also strokes the facet in the focus colour. */
  focusVisible: CubeFacet | null;
}

/**
 * What the widget hands the viewer through `orientationRef`.
 *
 * The viewer pushes the camera's axes with `update` whenever it turns. Once it
 * also draws the cube itself (`attachOverlay`), the SVG stops painting and
 * becomes the cube's click, focus and accessibility surface only, refreshed
 * when the camera comes to rest or the pointer reaches it rather than on
 * every frame: Firefox repaints the whole page for any DOM change in a frame,
 * and under CPU contention that repaint was what cost an orbit its frame rate.
 */
export interface OrientationLink {
  update(axes: AxisProjection): void;
  /** The cube's SVG box, which the overlay draws over; null once unmounted. */
  readonly element: SVGSVGElement | null;
  readonly highlight: CubeHighlight;
  /**
   * The viewer draws the cube from now on. `onChange` asks it for a frame
   * when the hover, the focus or the cube's place on the page changes.
   * Returns the release, after which the SVG paints the cube again.
   */
  attachOverlay(onChange: () => void): () => void;
}
