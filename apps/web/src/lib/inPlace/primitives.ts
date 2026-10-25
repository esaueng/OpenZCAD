import type {
  ParamValue,
  ParametricVector3,
  PrimitiveKind,
  Vector3
} from '@openzcad/shared';

/**
 * Where an in-place primitive (U09) stands, and what it builds there.
 *
 * A primitive is placed by a press-drag: the press lands on the ground or a
 * flat face, the drag draws its footprint in that plane (a box's rectangle
 * from corner to corner, a round primitive's circle from its centre), and a
 * height arrow stands along the plane's normal. The kernel still builds every
 * primitive at a fixed pose of its own (a box from its lowest corner, round
 * ones about +Z), so a placement ends as the same primitive feature the card
 * made plus a placement Move. On the ground, or on any face square to X, Y
 * or Z, a box needs no turn at all; a round primitive turns only when its
 * axis is not along Z.
 */

/** A placement plane's axes: right-handed, `u × v = normal`. */
export interface PlacementFrame {
  u: Vector3;
  v: Vector3;
  normal: Vector3;
}

/**
 * Where a footprint was drawn: its plane, and which way it was dragged along
 * the plane's axes (a box grows from the pressed corner in those senses).
 * The pressed point itself is the command's position values.
 */
export interface PlacementPick {
  frame: PlacementFrame;
  signU: 1 | -1;
  signV: 1 | -1;
  /**
   * The world axis a box square to the world hangs along, from a face
   * looking down it (a bottom face, say): its top stays on that face.
   */
  hangs?: 'x' | 'y' | 'z';
}

export interface PrimitiveBuild {
  /** By the kernel's keys (`width` is X, `height` Y, `depth` Z for a box). */
  dimensions: Record<string, ParamValue>;
  /** Where the kernel's own anchor point lands: the placement's translation. */
  position: ParametricVector3;
  /** The placement's turn, absent when the primitive needs none. */
  rotationDeg?: Vector3;
}

/** The ground plane, where a primitive stands before any drag. */
export const GROUND_FRAME: PlacementFrame = {
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 }
};

/** A box's footprint is a rectangle; every other primitive's a circle. */
export function footprintShape(kind: PrimitiveKind): 'rectangle' | 'circle' {
  return kind === 'box' ? 'rectangle' : 'circle';
}

function clean(value: number): number {
  if (Math.abs(value) < 1e-12) return 0;
  if (Math.abs(value - 1) < 1e-12) return 1;
  if (Math.abs(value + 1) < 1e-12) return -1;
  return value;
}

function cleaned(vector: Vector3): Vector3 {
  return { x: clean(vector.x), y: clean(vector.y), z: clean(vector.z) };
}

function unit(vector: Vector3): Vector3 {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function scaled(vector: Vector3, by: number): Vector3 {
  return { x: vector.x * by, y: vector.y * by, z: vector.z * by };
}

function plus(...vectors: Vector3[]): Vector3 {
  return vectors.reduce(
    (sum, vector) => ({
      x: sum.x + vector.x,
      y: sum.y + vector.y,
      z: sum.z + vector.z
    }),
    { x: 0, y: 0, z: 0 }
  );
}

/**
 * The frame of a plane with this normal. `u` is world X laid into the plane
 * (world Y when X runs along the normal), so on the ground and on every face
 * square to an axis both footprint axes are world axes too.
 */
export function placementFrame(normal: Vector3): PlacementFrame {
  const n = cleaned(unit(normal));
  const seed =
    Math.abs(n.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const u = cleaned(unit(plus(seed, scaled(n, -dot(seed, n)))));
  return { u, v: cleaned(cross(n, u)), normal: n };
}

/**
 * A face normal read off its mesh, square to an axis when it is within
 * tessellation noise of one, so an imported flat face looking along Z
 * places an unturned box as an exact face does.
 */
export function meshNormal(normal: Vector3): Vector3 {
  const n = unit(normal);
  const snap = (value: number) =>
    Math.abs(value) < 1e-6 ? 0 : Math.abs(Math.abs(value) - 1) < 1e-6 ? Math.sign(value) : value;
  return cleaned(unit({ x: snap(n.x), y: snap(n.y), z: snap(n.z) }));
}

/**
 * The principal plane (through the origin) a press on empty space draws on,
 * for a view looking along `direction`: the ground, unless the view sees it
 * edge-on, then whichever upright plane faces the view most. Its normal
 * faces the viewer, so a primitive grows toward them.
 */
export function principalFrameFor(direction: Vector3): PlacementFrame {
  const d = unit(direction);
  if (Math.abs(d.z) >= 0.2) {
    return placementFrame({ x: 0, y: 0, z: d.z < 0 ? 1 : -1 });
  }
  return Math.abs(d.x) >= Math.abs(d.y)
    ? placementFrame({ x: d.x < 0 ? 1 : -1, y: 0, z: 0 })
    : placementFrame({ x: 0, y: d.y < 0 ? 1 : -1, z: 0 });
}

/**
 * Where a ray meets the plane through `on` with `frame`'s normal, or null
 * when it runs along the plane or meets it behind the eye.
 */
export function framePlaneHit(
  frame: PlacementFrame,
  on: Vector3,
  origin: Vector3,
  direction: Vector3
): Vector3 | null {
  const facing = dot(direction, frame.normal);
  if (Math.abs(facing) < 1e-9) return null;
  const t = dot(plus(on, scaled(origin, -1)), frame.normal) / facing;
  return t > 0 ? plus(origin, scaled(direction, t)) : null;
}

const ROUND_FOOTPRINT: Record<Exclude<PrimitiveKind, 'box'>, string> = {
  cylinder: 'radius',
  cone: 'bottomRadius',
  sphere: 'radius',
  torus: 'majorRadius'
};

/** The smallest size a primitive takes, as its value specs do. */
const MIN_SIZE = 0.001;

/** `value` on the snap grid; as it is (to 1e-9) with snapping off. */
function snapped(value: number, step: number | null): number {
  const on = step === null ? value : Math.round(value / step) * step;
  return Math.round(on * 1e9) / 1e9;
}

/**
 * What a footprint drag from `start` to `end` on `frame` sets: the position
 * values (the kernel's own anchor point, snapped in the plane but never off
 * it), the drag's senses, and the footprint's sizes. A press that never
 * travelled places the primitive at the press and leaves its sizes as they
 * were. `sizes` are the command's current sizes, which a box square to the
 * world needs to find its lowest corner.
 */
export function footprintPlacement(
  kind: PrimitiveKind,
  frame: PlacementFrame,
  start: Vector3,
  end: Vector3,
  moved: boolean,
  snap: number | null,
  sizes: Readonly<Record<string, number>> = {}
): {
  placement: PlacementPick;
  anchor: Vector3;
  values: Record<string, number>;
} {
  const step = snap && snap > 0 ? snap : null;
  const { u, v, normal } = frame;
  const anchor = cleaned(
    plus(
      scaled(u, snapped(dot(start, u), step)),
      scaled(v, snapped(dot(start, v), step)),
      scaled(normal, dot(start, normal))
    )
  );
  const rounded = {
    x: Math.round(anchor.x * 1e9) / 1e9,
    y: Math.round(anchor.y * 1e9) / 1e9,
    z: Math.round(anchor.z * 1e9) / 1e9
  };
  const delta = plus(end, scaled(start, -1));
  const along = moved ? dot(delta, u) : 0;
  const across = moved ? dot(delta, v) : 0;
  // At least one snap step when snapping, else the smallest size there is.
  const size = (value: number) =>
    Math.max(step ?? MIN_SIZE, snapped(Math.abs(value), step));
  const placement: PlacementPick = {
    frame,
    signU: along < 0 ? -1 : 1,
    signV: across < 0 ? -1 : 1
  };
  if (kind === 'box' && [u, v, normal].every(isAxis)) {
    // Square to the world, a box stands unturned from its lowest corner, as
    // the card placed it: that corner is its position, whichever way the
    // footprint was dragged and whichever way the face looks.
    const width = moved ? size(along) : (sizes.width ?? 30);
    const depth = moved ? size(across) : (sizes.depth ?? 18);
    const height = sizes.height ?? 24;
    const lowest = (axis: 'x' | 'y' | 'z') =>
      Math.round(
        (rounded[axis] +
          Math.min(0, placement.signU * width * u[axis]) +
          Math.min(0, placement.signV * depth * v[axis]) +
          Math.min(0, height * normal[axis])) *
          1e9
      ) / 1e9;
    const positive = (vector: Vector3): Vector3 => ({
      x: Math.abs(vector.x),
      y: Math.abs(vector.y),
      z: Math.abs(vector.z)
    });
    const hangs = AXES.find((axis) => normal[axis] < 0);
    return {
      placement: {
        frame: { u: positive(u), v: positive(v), normal: positive(normal) },
        signU: 1,
        signV: 1,
        ...(hangs ? { hangs } : {})
      },
      anchor: { x: lowest('x'), y: lowest('y'), z: lowest('z') },
      values: moved ? { width, depth } : {}
    };
  }
  if (!moved) {
    return { placement: { frame, signU: 1, signV: 1 }, anchor: rounded, values: {} };
  }
  if (kind === 'box') {
    return {
      placement,
      anchor: rounded,
      values: { width: size(along), depth: size(across) }
    };
  }
  return {
    placement,
    anchor: rounded,
    values: { [ROUND_FOOTPRINT[kind]]: size(Math.hypot(along, across)) }
  };
}

/**
 * The turn taking the kernel's own X, Y and Z onto `x`, `y` and `z`, as the
 * Move's rotation: the transform applies `Rz · Ry · Rx`.
 */
export function eulerDegrees(x: Vector3, y: Vector3, z: Vector3): Vector3 {
  const degrees = (radians: number) => {
    const value = Math.round(((radians * 180) / Math.PI) * 1e9) / 1e9;
    return value === 0 ? 0 : value;
  };
  const sinY = Math.max(-1, Math.min(1, -x.z));
  const ry = Math.asin(sinY);
  if (Math.cos(ry) > 1e-9) {
    return {
      x: degrees(Math.atan2(y.z, z.z)),
      y: degrees(ry),
      z: degrees(Math.atan2(x.y, x.x))
    };
  }
  // Pointing straight along ±X: only the sum of the X and Z turns matters.
  return { x: 0, y: degrees(ry), z: degrees(Math.atan2(-y.x, y.y)) };
}

function isAxis(vector: Vector3): boolean {
  const parts = [vector.x, vector.y, vector.z];
  return (
    parts.filter((part) => part === 0).length === 2 &&
    parts.some((part) => part === 1 || part === -1)
  );
}

function isPlusZ(vector: Vector3): boolean {
  return vector.x === 0 && vector.y === 0 && vector.z === 1;
}

function isMinusZ(vector: Vector3): boolean {
  return vector.x === 0 && vector.y === 0 && vector.z === -1;
}

const AXES = ['x', 'y', 'z'] as const;
/** A box's kernel key along each world axis (OCCT's makeBox(dx, dy, dz)). */
const BOX_KEYS = { x: 'width', y: 'height', z: 'depth' } as const;

/**
 * The primitive feature and placement a command's values build. `values` are
 * as stored (a typed expression stays one); `anchor` is the pressed point,
 * the position values.
 */
export function primitiveBuild(
  kind: PrimitiveKind,
  placement: PlacementPick | null | undefined,
  values: Record<string, ParamValue>,
  anchor: ParametricVector3
): PrimitiveBuild {
  const frame = placement?.frame ?? GROUND_FRAME;
  const signU = placement?.signU ?? 1;
  const signV = placement?.signV ?? 1;
  const { u, v, normal } = frame;
  const at = anchor;
  const turned = (x: Vector3, y: Vector3, z: Vector3): PrimitiveBuild => ({
    dimensions: {},
    position: { ...at },
    rotationDeg: eulerDegrees(x, y, z)
  });
  switch (kind) {
    case 'box': {
      const width = values.width ?? 30;
      const depth = values.depth ?? 18;
      const height = values.height ?? 24;
      const sides = [
        [scaled(u, signU), width],
        [scaled(v, signV), depth],
        [normal, height]
      ] as const;
      if (sides.every(([direction]) => isAxis(cleaned(direction)))) {
        // Square to the world: the same unturned box the card made, its
        // position its lowest corner (`footprintPlacement` finds it).
        const dimensions: Record<string, ParamValue> = {};
        for (const axis of AXES) {
          const [, size] = sides.find(
            ([candidate]) => clean(candidate[axis]) !== 0
          )!;
          dimensions[BOX_KEYS[axis]] = size;
        }
        return { dimensions, position: { ...at } };
      }
      // A tilted face: the box turns with it. Its own X and Y run along the
      // drag's senses, swapped when they would make a left-handed frame.
      const along = scaled(u, signU);
      const across = scaled(v, signV);
      if (signU * signV > 0) {
        return {
          ...turned(along, across, normal),
          dimensions: { width, height: depth, depth: height }
        };
      }
      return {
        ...turned(across, along, normal),
        dimensions: { width: depth, height: width, depth: height }
      };
    }
    case 'cylinder': {
      const dimensions = {
        radius: values.radius ?? 6,
        height: values.height ?? 28
      };
      if (isPlusZ(normal)) return { dimensions, position: { ...at } };
      // Under a face it turns over, so its base center stays on the face.
      return { ...turned(u, v, normal), dimensions };
    }
    case 'cone': {
      const dimensions = {
        bottomRadius: values.bottomRadius ?? 6,
        topRadius: values.topRadius ?? 2,
        height: values.height ?? 28
      };
      if (isPlusZ(normal)) return { dimensions, position: { ...at } };
      return { ...turned(u, v, normal), dimensions };
    }
    case 'sphere':
      return { dimensions: { radius: values.radius ?? 6 }, position: { ...at } };
    case 'torus': {
      const dimensions = {
        majorRadius: values.majorRadius ?? 6,
        minorRadius: values.minorRadius ?? 2
      };
      // A ring flat on either side of the ground is the same ring.
      if (isPlusZ(normal) || isMinusZ(normal)) {
        return { dimensions, position: { ...at } };
      }
      return { ...turned(u, v, normal), dimensions };
    }
  }
}
