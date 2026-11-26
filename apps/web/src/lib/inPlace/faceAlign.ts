import type { ParametricVector3, Vector3 } from '@openzcad/shared';
import { eulerDegrees } from './primitives';
import type {
  FacePick,
  InPlaceContext,
  InPlaceRequest,
  InPlaceToolSpec
} from './tools';

/**
 * M10 (slice 5b): Align, face to face. The body of the first picked flat
 * face is placed so that face lies flush on the second, a flat face of
 * another body. It is a one-time rigid placement, stored as the Move that
 * Move itself writes (rotation, pivot and translation, all numbers): nothing
 * links it to the target face, so editing the target later does not move
 * the aligned body.
 *
 * The contract:
 * - Rotation: the smallest turn taking the moving face's outward normal
 *   onto the opposite of the target's (onto the target's own normal with
 *   Flip). Already there: no turn. Exactly the wrong way round: half a turn
 *   about {@link halfTurnAxis}, an axis in the moving face's plane.
 * - The turn is about the moving face's centroid, so that point stays put.
 * - Translation: along the target normal only, by the signed distance that
 *   lands the moving face's plane on the target's, plus `offset` (a gap
 *   measured out of the target face along its normal). The in-plane
 *   position is where the turn left it.
 */

/** Why a pick cannot be aligned; each code has one plain sentence. */
export type FaceAlignRefusal =
  'not-planar' | 'same-body' | 'not-live' | 'no-normal';

export const FACE_ALIGN_REFUSALS: Record<FaceAlignRefusal, string> = {
  'not-planar': 'Align takes flat faces only · pick a flat face.',
  'same-body':
    'Both faces are on the same body · pick the target face on another body.',
  'not-live':
    'That body is used up by a later feature · pick a face of a body in the model.',
  'no-normal':
    'This flat face has no measured direction · pick another flat face.'
};

/**
 * Below this sine of the angle between the two normals (about 1e-9 rad),
 * they count as parallel: no turn when they already point the wanted way,
 * the deterministic half turn when they point exactly against it. Between
 * that and a real turn the axis of the smallest turn is still well defined
 * to within 1e-7 rad.
 */
export const FACE_ALIGN_PARALLEL_SINE = 1e-9;

export interface FaceAlignInput {
  /** The moving face's outward unit normal and a point on it (its centroid). */
  moving: { normal: Vector3; point: Vector3 };
  /** The target face's outward unit normal and a point on it. */
  target: { normal: Vector3; point: Vector3 };
  /** Make the faces point the same way instead of face to face. */
  flip?: boolean;
  /** Gap out of the target face along its normal; 0 is flush. */
  offset?: number;
}

export interface FaceAlignPlacement {
  /** The turn, as Move stores it: `Rz · Ry · Rx`, in degrees. */
  rotationDeg: Vector3;
  /** The point the turn is about: the moving face's point. */
  pivot: Vector3;
  translation: Vector3;
  /** The 3×3 turn itself, rows first, for checks and the preview. */
  rotation: readonly [Vector3, Vector3, Vector3];
}

const IDENTITY: readonly [Vector3, Vector3, Vector3] = [
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: 1 }
];

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

function scaled(a: Vector3, by: number): Vector3 {
  return { x: a.x * by, y: a.y * by, z: a.z * by };
}

function minus(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function unit(a: Vector3): Vector3 | null {
  const length = Math.hypot(a.x, a.y, a.z);
  if (!Number.isFinite(length) || length < 1e-12) return null;
  return scaled(a, 1 / length);
}

/**
 * The axis of the half turn when the normals point exactly the wrong way:
 * `unit(n × X)`, or `unit(n × Y)` when the normal leans within about 26° of
 * ±X (|n·X| ≥ 0.9). It lies in the face's plane, and it does not jump for a
 * normal a hair off a principal direction. A face facing +Z turns about +Y,
 * one facing +X about +Z, one facing +Y about −Z.
 */
export function halfTurnAxis(normal: Vector3): Vector3 {
  const e: Vector3 =
    Math.abs(normal.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  return unit(cross(normal, e))!;
}

/** The turn by `angle` (given as its cosine and sine) about unit `k`. */
function turnAbout(
  k: Vector3,
  cos: number,
  sin: number
): [Vector3, Vector3, Vector3] {
  const t = 1 - cos;
  return [
    {
      x: cos + k.x * k.x * t,
      y: k.x * k.y * t - k.z * sin,
      z: k.x * k.z * t + k.y * sin
    },
    {
      x: k.y * k.x * t + k.z * sin,
      y: cos + k.y * k.y * t,
      z: k.y * k.z * t - k.x * sin
    },
    {
      x: k.z * k.x * t - k.y * sin,
      y: k.z * k.y * t + k.x * sin,
      z: cos + k.z * k.z * t
    }
  ];
}

/**
 * The smallest turn taking unit `from` onto unit `to`, per the contract
 * above. The turn's axis is the part of `to` across `from`, taken as a
 * unit vector in `from`'s plane, so `from`'s image is exact even when the
 * two are nearly opposite.
 */
export function smallestTurn(
  from: Vector3,
  to: Vector3
): readonly [Vector3, Vector3, Vector3] {
  const cos = Math.max(-1, Math.min(1, dot(from, to)));
  const across = minus(to, scaled(from, dot(from, to)));
  const sin = Math.hypot(across.x, across.y, across.z);
  if (sin < FACE_ALIGN_PARALLEL_SINE) {
    if (cos > 0) return IDENTITY;
    return turnAbout(halfTurnAxis(from), -1, 0);
  }
  const k = unit(cross(from, scaled(across, 1 / sin)))!;
  return turnAbout(k, cos, sin);
}

function apply(
  rotation: readonly [Vector3, Vector3, Vector3],
  v: Vector3
): Vector3 {
  return {
    x: dot(rotation[0], v),
    y: dot(rotation[1], v),
    z: dot(rotation[2], v)
  };
}

/** Columns of a rotation: where it takes X, Y and Z. */
function columns(rotation: readonly [Vector3, Vector3, Vector3]) {
  const [r0, r1, r2] = rotation;
  return {
    x: { x: r0.x, y: r1.x, z: r2.x },
    y: { x: r0.y, y: r1.y, z: r2.y },
    z: { x: r0.z, y: r1.z, z: r2.z }
  };
}

/** Same composition as the kernel's `transformMatrix`: `Rz · Ry · Rx`. */
export function rotationFromDegrees(deg: Vector3): [Vector3, Vector3, Vector3] {
  const [a, b, c] = [deg.x, deg.y, deg.z].map((v) => (v * Math.PI) / 180);
  const [ca, sa, cb, sb, cc, sc] = [
    Math.cos(a!),
    Math.sin(a!),
    Math.cos(b!),
    Math.sin(b!),
    Math.cos(c!),
    Math.sin(c!)
  ];
  return [
    { x: cc * cb, y: cc * sb * sa - sc * ca, z: cc * sb * ca + sc * sa },
    { x: sc * cb, y: sc * sb * sa + cc * ca, z: sc * sb * ca - cc * sa },
    { x: -sb, y: cb * sa, z: cb * ca }
  ];
}

/**
 * Where Align puts the moving body, or null when a normal is missing or
 * not a direction. The stored rotation is the Euler form of the turn; the
 * translation is measured with that stored form, so what the kernel
 * rebuilds is what this says.
 */
export function faceAlignPlacement(
  input: FaceAlignInput
): FaceAlignPlacement | null {
  const from = unit(input.moving.normal);
  const target = unit(input.target.normal);
  if (!from || !target) return null;
  const to = input.flip ? target : scaled(target, -1);
  const turn = smallestTurn(from, to);
  const cols = columns(turn);
  const rotationDeg = eulerDegrees(cols.x, cols.y, cols.z);
  const stored = rotationFromDegrees(rotationDeg);
  const pivot = input.moving.point;
  // The pivot stays put under the turn, so it is the point to bring onto
  // the target plane (plus the gap); the turned face's plane passes there.
  const gap = input.offset ?? 0;
  const distance = dot(minus(input.target.point, pivot), target) + gap;
  const translation = scaled(target, distance);
  return {
    rotationDeg,
    pivot: { ...pivot },
    translation: {
      x: translation.x || 0,
      y: translation.y || 0,
      z: translation.z || 0
    },
    rotation: stored
  };
}

/** A point of the moving body, where the placement puts it. */
export function placePoint(
  placement: Pick<FaceAlignPlacement, 'rotation' | 'pivot' | 'translation'>,
  point: Vector3
): Vector3 {
  const turned = apply(placement.rotation, minus(point, placement.pivot));
  return {
    x: turned.x + placement.pivot.x + placement.translation.x,
    y: turned.y + placement.pivot.y + placement.translation.y,
    z: turned.z + placement.pivot.z + placement.translation.z
  };
}

/** A direction of the moving body, where the placement turns it. */
export function placeDirection(
  placement: Pick<FaceAlignPlacement, 'rotation'>,
  direction: Vector3
): Vector3 {
  return apply(placement.rotation, direction);
}

/** Why these picks cannot be aligned, or null; the face itself first. */
export function faceAlignFaceRefusal(
  faces: readonly FacePick[],
  face: FacePick,
  ctx?: Pick<InPlaceContext, 'liveBodyIds'>
): FaceAlignRefusal | null {
  if (
    face.surfaceType !== undefined &&
    face.surfaceType.toLowerCase() !== 'plane'
  )
    return 'not-planar';
  if (face.surfaceType !== undefined && !face.normal) return 'no-normal';
  const live = ctx?.liveBodyIds?.();
  // Move moves only a body that is in the model now; so does Align, and
  // it lands only on such a body.
  if (live && live.length > 0 && !live.includes(face.bodyId)) return 'not-live';
  // The moving face clicked again is taken back, not refused.
  const moving = faces[0];
  if (moving && moving.bodyId === face.bodyId && moving.hash !== face.hash)
    return 'same-body';
  return null;
}

/** Why the two picked faces cannot be aligned, or null. */
export function faceAlignPairRefusal(
  faces: readonly FacePick[],
  ctx?: Pick<InPlaceContext, 'liveBodyIds'>
): FaceAlignRefusal | null {
  const [moving, target] = faces;
  if (!moving) return null;
  const first = faceAlignFaceRefusal([], moving, ctx);
  if (first || !target) return first;
  if (target.bodyId === moving.bodyId) return 'same-body';
  return faceAlignFaceRefusal([moving], target, ctx);
}

function anchor(face: FacePick): Vector3 | null {
  return face.centroid ?? face.center ?? face.point ?? null;
}

/** The placement two picked faces ask for, or null. */
export function faceAlignFromPicks(
  faces: readonly FacePick[],
  flip: boolean,
  offset: number
): FaceAlignPlacement | null {
  const [moving, target] = faces;
  if (!moving?.normal || !target?.normal) return null;
  const from = anchor(moving);
  const onto = anchor(target);
  if (!from || !onto) return null;
  return faceAlignPlacement({
    moving: { normal: moving.normal, point: from },
    target: { normal: target.normal, point: onto },
    flip,
    offset: Number.isFinite(offset) ? offset : 0
  });
}

const zeroTurn = (deg: Vector3) => deg.x === 0 && deg.y === 0 && deg.z === 0;

/**
 * Align (M10 slice 5b): a flat face on the body to move, then a flat face
 * on another body; Done stores the Move that puts the first flush on the
 * second. Two faces, in pick order: the first is the moving one.
 */
export const faceAlignSpec: InPlaceToolSpec = {
  id: 'align',
  title: 'Align',
  profileMode: 'none',
  faceMode: 'pair',
  wantsAxis: false,
  wantsPath: false,
  values: [
    {
      id: 'offset',
      label: 'Offset',
      unit: 'length',
      initial: 0,
      // Signed: a negative gap sinks the face into the target.
      note: 'Gap between the faces, out of the target face'
    }
  ],
  options: [
    {
      id: 'flip',
      label: 'Faces',
      choices: [
        { value: 'no', label: 'Face to face' },
        {
          value: 'yes',
          label: 'Flip',
          tip: 'The faces point the same way, flush in one plane'
        }
      ],
      initial: 'no'
    }
  ],
  refuseFace: (slots, face, ctx) => {
    const code = faceAlignFaceRefusal(slots.faces, face, ctx);
    return code ? FACE_ALIGN_REFUSALS[code] : null;
  },
  hint(slots, _options, ctx) {
    const code = faceAlignPairRefusal(slots.faces, ctx);
    if (code) return FACE_ALIGN_REFUSALS[code];
    if (slots.faces.length === 0)
      return 'Click a flat face on the body to move';
    if (slots.faces.length === 1) return 'Click a flat face on the target body';
    return 'Drag the offset, or tap it to type';
  },
  ready: (slots, _options, ctx) =>
    slots.faces.length === 2 && faceAlignPairRefusal(slots.faces, ctx) === null,
  request(slots, _values, options, ctx, numbers) {
    if (slots.faces.length !== 2) return null;
    if (faceAlignPairRefusal(slots.faces, ctx)) return null;
    const placement = faceAlignFromPicks(
      slots.faces,
      options.flip === 'yes',
      numbers?.offset ?? 0
    );
    if (!placement) return null;
    const turned = !zeroTurn(placement.rotationDeg);
    return {
      tool: 'transform',
      targetBodyId: slots.faces[0]!.bodyId,
      translation: placement.translation,
      ...(turned
        ? { rotationDeg: placement.rotationDeg, pivot: placement.pivot }
        : {})
    };
  },
  handles(slots) {
    const target = slots.faces[1];
    const origin = target ? anchor(target) : null;
    if (slots.faces.length !== 2 || !target?.normal || !origin) return [];
    const direction = unit(target.normal);
    if (!direction) return [];
    return [
      {
        valueId: 'offset',
        kind: 'linear',
        key: `${target.bodyId}:${target.hash}:align-offset`,
        params: { origin, direction }
      }
    ];
  }
};

/**
 * Where a face of a body an in-place Move is previewing stood before the
 * move: the previewed face's normal and a point on it, taken back through
 * the request's inverse. A click on the moved preview lands on faces the
 * committed body does not have (a rigid move renames every face), so this
 * is how such a click finds the committed face it came from. Null unless
 * the request moves this very body by numbers alone (a rotation, a pivot
 * and a translation, as Align stores them).
 */
export function unmovedFaceGeometry(
  request: InPlaceRequest | null | undefined,
  bodyId: string,
  normal: Vector3 | undefined,
  at: Vector3 | undefined
): { normal: Vector3; at: Vector3 } | null {
  if (
    !request ||
    request.tool !== 'transform' ||
    request.targetBodyId !== bodyId ||
    request.copy ||
    request.scale !== undefined ||
    request.axisRotation ||
    !normal ||
    !at
  )
    return null;
  const numbers = (v: ParametricVector3 | undefined): Vector3 | null => {
    if (!v) return { x: 0, y: 0, z: 0 };
    const { x, y, z } = v;
    return typeof x === 'number' &&
      typeof y === 'number' &&
      typeof z === 'number'
      ? { x, y, z }
      : null;
  };
  const translation = numbers(request.translation);
  const turn = numbers(request.rotationDeg);
  const pivot = numbers(request.pivot);
  if (!translation || !turn || !pivot) return null;
  const rotation = rotationFromDegrees(turn);
  // x' = R(x − p) + p + t, so x = Rᵀ(x' − p − t) + p; a normal turns by Rᵀ.
  const back = (v: Vector3): Vector3 => ({
    x: rotation[0].x * v.x + rotation[1].x * v.y + rotation[2].x * v.z,
    y: rotation[0].y * v.x + rotation[1].y * v.y + rotation[2].y * v.z,
    z: rotation[0].z * v.x + rotation[1].z * v.y + rotation[2].z * v.z
  });
  const local = back(minus(minus(at, pivot), translation));
  return {
    normal: back(normal),
    at: { x: local.x + pivot.x, y: local.y + pivot.y, z: local.z + pivot.z }
  };
}
