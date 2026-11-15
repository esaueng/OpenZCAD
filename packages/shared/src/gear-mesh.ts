import type { GearType, Vector3 } from './index';
import type { AssemblyFrame } from './assembly';
import {
  composeTransforms,
  cross3,
  dot3,
  frameInWorld,
  frameToTransform,
  invertTransform,
  type RigidTransform
} from './assembly-kinematics';
import type {
  GearMeshGear,
  GearMeshRefusal,
  GearMeshRefusalCode,
  GearMeshSolution
} from './gear-mesh-types';
import { GEAR_PLACEMENT_UNUSABLE, gearPlacementFrame } from './gear-mesh-types';
import { ownEntry } from './document-validation';

/**
 * M14 meshing-pair helper: where a second gear goes so that it meshes with a
 * first. Pure math over resolved gear parameters (document units), shared by
 * the Assemble card and the tests.
 *
 * Covered: parallel-axis pairs — two external spur or helical gears, an
 * external gear inside an internal (ring) gear, and a spur pinion on a rack.
 * The centre distance is the working one: with profile shift it follows the
 * working pressure angle (ISO 21771, `inv α_wt = inv α_t + 2 tan α_n Σx / Σz`,
 * `a = a₀ cos α_t / cos α_wt`). Backlash is the kernel's tooth thinning, so
 * it does not move the centres: the pair sits at the zero-backlash distance
 * of the unthinned teeth and the play (the sum of both thinnings) is split
 * evenly either side of each tooth.
 *
 * The phase is exact for the kernel's tooth placement: tooth 0 of an
 * external or internal gear is centred on its x direction turned `phase`
 * about the axis (a helical tooth then turns `h·tan β / r` about the axis by
 * height `h`, counter-clockwise for a right hand); a rack's teeth stand at
 * `(k + ½)·p` along its x direction with its pitch line through its origin.
 * Mid-face planes coincide. Bevel and worm pairs mesh on intersecting or
 * crossed axes and are refused here.
 */

const DEG = Math.PI / 180;
/** Relative tolerance for "the same module / angle". */
const MATCH_TOLERANCE = 1e-9;

/** The involute function, `tan α − α`. */
export function involute(angle: number): number {
  return Math.tan(angle) - angle;
}

/** The angle in (0, π/2) whose involute is `value` (> 0). */
export function inverseInvolute(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return Number.NaN;
  // Cubic start (inv α ≈ α³/3), then Newton: d(inv α)/dα = tan² α.
  let angle = Math.min(Math.cbrt(3 * value), 1.5);
  for (let i = 0; i < 60; i += 1) {
    const tan = Math.tan(angle);
    const next = angle - (tan - angle - value) / (tan * tan);
    const clamped = next <= 0 ? angle / 2 : Math.min(next, Math.PI / 2 - 1e-12);
    if (Math.abs(clamped - angle) <= 1e-16) return clamped;
    angle = clamped;
  }
  return angle;
}

function same(a: number, b: number): boolean {
  return (
    Math.abs(a - b) <= MATCH_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b))
  );
}

function format(value: number): string {
  return String(Number(value.toPrecision(6)));
}

const UNSUPPORTED: Partial<Record<GearType, string>> = {
  bevel:
    'Bevel gears mesh on intersecting axes about a shared cone apex; the pair helper places parallel-axis gears only so far.',
  worm: 'A worm meshes with its wheel on crossed axes; the pair helper places parallel-axis gears only so far.',
  'worm-wheel':
    'A worm wheel meshes with its worm on crossed axes; the pair helper places parallel-axis gears only so far.',
  'enveloping-worm':
    'An enveloping worm meshes with its wheel on crossed axes; the pair helper places parallel-axis gears only so far.',
  'enveloping-wheel':
    'An enveloping wheel meshes with its worm on crossed axes; the pair helper places parallel-axis gears only so far.'
};

function refusal(code: GearMeshRefusalCode, message: string): GearMeshRefusal {
  return { code, message };
}

/**
 * Why two gears cannot mesh, or null when they can. `axisSense` is −1 when
 * the second gear's axis will run against the first's: a single helix keeps
 * its hand end for end, but a herringbone then meets the first gear with
 * its far half, whose hand is the other one.
 */
export function gearMeshPairError(
  a: GearMeshGear,
  b: GearMeshGear,
  axisSense: 1 | -1 = 1
): GearMeshRefusal | null {
  for (const gear of [a, b]) {
    const reason = ownEntry(UNSUPPORTED, gear.gearType);
    if (reason) return refusal('gear-mesh:unsupported-type', reason);
  }
  if (a.gearType === 'rack' && b.gearType === 'rack')
    return refusal(
      'gear-mesh:two-racks',
      'Two racks cannot mesh; pick a pinion for the rack.'
    );
  if (a.gearType === 'internal' && b.gearType === 'internal')
    return refusal(
      'gear-mesh:two-internal',
      'Two internal gears cannot mesh; an internal gear meshes with an external pinion inside it.'
    );
  if (
    (a.gearType === 'internal' && b.gearType === 'rack') ||
    (a.gearType === 'rack' && b.gearType === 'internal')
  )
    return refusal(
      'gear-mesh:internal-rack',
      'A rack meshes with an external pinion, not an internal gear.'
    );
  if (!same(a.module, b.module))
    return refusal(
      'gear-mesh:module-mismatch',
      `Their modules differ (${format(a.module)} and ${format(b.module)}); meshing gears need the same module or pitch.`
    );
  if (!same(a.pressureAngleDeg, b.pressureAngleDeg))
    return refusal(
      'gear-mesh:pressure-angle-mismatch',
      `Their pressure angles differ (${format(a.pressureAngleDeg)}° and ${format(b.pressureAngleDeg)}°); meshing gears need the same one.`
    );
  const rack = a.gearType === 'rack' || b.gearType === 'rack';
  if (rack && (a.helixAngleDeg !== 0 || b.helixAngleDeg !== 0))
    return refusal(
      'gear-mesh:helical-rack',
      'Racks are straight-toothed, so they mesh with a spur pinion only.'
    );
  if (!same(a.helixAngleDeg, b.helixAngleDeg))
    return refusal(
      'gear-mesh:helix-mismatch',
      a.helixAngleDeg === 0 || b.helixAngleDeg === 0
        ? 'A spur gear cannot mesh with a helical one on parallel axes.'
        : `Their helix angles differ (${format(a.helixAngleDeg)}° and ${format(b.helixAngleDeg)}°); parallel helical gears need the same one.`
    );
  if (a.helixAngleDeg !== 0) {
    if (a.herringbone !== b.herringbone)
      return refusal(
        'gear-mesh:herringbone-mismatch',
        'A herringbone gear meshes only with another herringbone gear.'
      );
    const internal = a.gearType === 'internal' || b.gearType === 'internal';
    // The hand b shows a's start half: a flipped herringbone's far half.
    const flipped = a.herringbone && axisSense < 0;
    const handB = flipped ? (b.hand === 'right' ? 'left' : 'right') : b.hand;
    const turned = flipped
      ? ' (turned end for end, a herringbone meets it with its other half)'
      : '';
    if (!internal && a.hand === handB)
      return refusal(
        'gear-mesh:same-hand',
        flipped
          ? `External herringbone gears facing opposite ways need the same stored hand${turned}.`
          : `Both gears are ${a.hand}-handed; external helical gears on parallel axes need opposite hands.`
      );
    if (internal && a.hand !== handB)
      return refusal(
        'gear-mesh:opposite-hand',
        flipped
          ? `A herringbone pinion facing against its internal gear needs the opposite stored hand${turned}.`
          : 'A helical pinion and its internal gear need the same hand.'
      );
  }
  const ring =
    a.gearType === 'internal' ? a : b.gearType === 'internal' ? b : null;
  const pinion = ring === a ? b : a;
  if (ring && ring.teeth <= pinion.teeth)
    return refusal(
      'gear-mesh:ring-too-small',
      `The internal gear needs more teeth than its pinion (${ring.teeth} against ${pinion.teeth}).`
    );
  return null;
}

/**
 * A gear's tip and root circles (transverse, document units) as the kernel
 * cuts them: the profile shift moves both outward by `x·m`, so an internal
 * gear's inner tip is `r − (h_a − x)·m` and its root `r + (h_f + x)·m`. A
 * rack's are its tip height above and root depth below its pitch line.
 */
export function gearToothCircles(gear: GearMeshGear): {
  pitch: number;
  tip: number;
  root: number;
} {
  const m = gear.module;
  if (gear.gearType === 'rack')
    return { pitch: 0, tip: gear.addendum * m, root: gear.dedendum * m };
  const pitch = (m / Math.cos(gear.helixAngleDeg * DEG)) * (gear.teeth / 2);
  const x = gear.profileShift;
  return gear.gearType === 'internal'
    ? {
        pitch,
        tip: pitch - (gear.addendum - x) * m,
        root: pitch + (gear.dedendum + x) * m
      }
    : {
        pitch,
        tip: pitch + (gear.addendum + x) * m,
        root: pitch - (gear.dedendum - x) * m
      };
}

/** How far each gear's tips reach past the other's root (≤ 0: clear). */
function tipOverlaps(
  a: GearMeshGear,
  b: GearMeshGear,
  distance: number
): [number, number] {
  const ca = gearToothCircles(a);
  const cb = gearToothCircles(b);
  if (a.gearType === 'rack')
    // Pinion b stands `distance` above the rack's pitch line.
    return [ca.tip - (distance - cb.root), cb.tip - distance - ca.root];
  if (b.gearType === 'rack') {
    const [rack, pinion] = tipOverlaps(b, a, distance);
    return [pinion, rack];
  }
  if (a.gearType === 'internal')
    return [distance + cb.root - ca.tip, distance + cb.tip - ca.root];
  if (b.gearType === 'internal')
    return [distance + ca.tip - cb.root, distance + ca.root - cb.tip];
  return [ca.tip - (distance - cb.root), cb.tip - (distance - ca.root)];
}

/** A refusal when either gear's tips would dig into the other's roots. */
function clearanceError(
  a: GearMeshGear,
  b: GearMeshGear,
  distance: number
): GearMeshRefusal | null {
  const [overA, overB] = tipOverlaps(a, b, distance);
  const tolerance = 1e-9 * Math.max(1, distance);
  const over = overA >= overB ? overA : overB;
  if (!(over > tolerance)) return null;
  const gear = overA >= overB ? 'base' : 'moving';
  const who =
    gear === 'base'
      ? 'The gear that stays put'
      : 'The gear that meshes with it';
  return {
    code: 'gear-mesh:tip-clearance',
    message: `${who} reaches past the other gear’s root circle at this centre distance; shorten its addendum, deepen the other’s dedendum or reduce the profile shift.`,
    clearance: { gear, overlap: over }
  };
}

/** A helical tooth's turn about the axis at height `h` (right hand: CCW). */
function toothAngle(
  gear: GearMeshGear,
  height: number,
  radius: number
): number {
  const phase = gear.phaseDeg * DEG;
  if (gear.helixAngleDeg === 0) return phase;
  const sign = gear.hand === 'right' ? 1 : -1;
  return phase + (sign * height * Math.tan(gear.helixAngleDeg * DEG)) / radius;
}

/** `d` (perpendicular to the unit `z`) turned `angle` about `z`. */
function rotateAbout(z: Vector3, d: Vector3, angle: number): Vector3 {
  const t = cross3(z, d);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: d.x * c + t.x * s, y: d.y * c + t.y * s, z: d.z * c + t.z * s };
}

function add(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(a: Vector3, s: number): Vector3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function normalized(a: Vector3): Vector3 | null {
  const length = Math.hypot(a.x, a.y, a.z);
  return length > 1e-12 ? scale(a, 1 / length) : null;
}

/**
 * A gear's frame as the kernel reads it: the axis made unit length and the
 * x direction made a unit vector perpendicular to it. Null without an axis.
 */
export function gearMeshFrame(frame: AssemblyFrame): AssemblyFrame | null {
  return gearPlacementFrame(frame.origin, frame.zAxis, frame.xAxis);
}

function angleIn(frame: AssemblyFrame, direction: Vector3): number {
  const y = cross3(frame.zAxis, frame.xAxis);
  return Math.atan2(dot3(direction, y), dot3(direction, frame.xAxis));
}

function placementFor(
  own: AssemblyFrame,
  target: AssemblyFrame
): RigidTransform {
  return composeTransforms(
    frameToTransform(target),
    invertTransform(frameToTransform(own))
  );
}

/**
 * Where `b` goes to mesh with `a`. `current` maps `b`'s modelled
 * coordinates into `a`'s as the two sit now: it picks the side `b` goes to
 * (towards where it is, else along `a`'s x direction), whether its axis
 * runs with or against `a`'s, and, on a rack, where along it the pinion
 * sits.
 */
export function meshGearPair(
  a: GearMeshGear,
  b: GearMeshGear,
  current: RigidTransform
): GearMeshSolution | GearMeshRefusal {
  const frameA = gearMeshFrame(a.frame);
  const frameB = gearMeshFrame(b.frame);
  if (!frameA || !frameB)
    return refusal(
      'gear-mesh:invalid-placement',
      `A gear cannot be placed: ${GEAR_PLACEMENT_UNUSABLE}.`
    );
  const sense =
    dot3(frameInWorld(current, frameB).zAxis, frameA.zAxis) < 0 ? -1 : 1;
  const error = gearMeshPairError(a, b, sense);
  if (error) return error;
  const gearA = { ...a, frame: frameA };
  const gearB = { ...b, frame: frameB };
  if (a.gearType === 'rack') return meshRack(gearA, gearB, current, true);
  if (b.gearType === 'rack')
    return meshRack(gearB, gearA, invertTransform(current), false);
  return meshGears(gearA, gearB, current);
}

function meshGears(
  a: GearMeshGear,
  b: GearMeshGear,
  current: RigidTransform
): GearMeshSolution | GearMeshRefusal {
  const internal = a.gearType === 'internal' || b.gearType === 'internal';
  const beta = a.helixAngleDeg * DEG;
  const alphaN = a.pressureAngleDeg * DEG;
  const alphaT = Math.atan(Math.tan(alphaN) / Math.cos(beta));
  const mt = a.module / Math.cos(beta);
  const rA = (mt * a.teeth) / 2;
  const rB = (mt * b.teeth) / 2;
  // Ring first in the internal formula: x₂ − x₁ over z₂ − z₁.
  const [ring, pinion] = a.gearType === 'internal' ? [a, b] : [b, a];
  const invW = internal
    ? involute(alphaT) +
      (2 * Math.tan(alphaN) * (ring.profileShift - pinion.profileShift)) /
        (ring.teeth - pinion.teeth)
    : involute(alphaT) +
      (2 * Math.tan(alphaN) * (a.profileShift + b.profileShift)) /
        (a.teeth + b.teeth);
  const alphaW = inverseInvolute(invW);
  if (!Number.isFinite(alphaW))
    return refusal(
      'gear-mesh:no-working-pressure-angle',
      'These profile shifts leave the pair no working pressure angle; reduce the negative shift.'
    );
  const standard = internal ? Math.abs(rA - rB) : rA + rB;
  const distance = (standard * Math.cos(alphaT)) / Math.cos(alphaW);
  const clearance = clearanceError(a, b, distance);
  if (clearance) return clearance;

  const zA = a.frame.zAxis;
  const oA = a.frame.origin;
  const nowB = frameInWorld(current, b.frame);
  const s = dot3(nowB.zAxis, zA) < 0 ? -1 : 1;
  const midB = add(nowB.origin, scale(nowB.zAxis, b.faceWidth / 2));
  const offset = sub(midB, oA);
  const u =
    normalized(sub(offset, scale(zA, dot3(offset, zA)))) ?? a.frame.xAxis;
  // Both mid-face planes on A's; B's centre a away along u.
  const centreA = add(oA, scale(zA, a.faceWidth / 2));
  const centreB = add(centreA, scale(u, distance));
  // Each gear's direction from its centre to the pitch point.
  const dA = internal && a.gearType !== 'internal' ? scale(u, -1) : u;
  const dB = internal ? dA : scale(u, -1);
  const zB = scale(zA, s);
  const tA = cross3(zA, dA);
  const tB = cross3(zB, dB);
  const sense = dot3(tA, tB) < 0 ? -1 : 1;
  // A's nearest tooth, in pitches along tA from the pitch point; B puts a
  // tooth half a pitch on, in A's space.
  const gA =
    (toothAngle(a, a.faceWidth / 2, rA) - angleIn(a.frame, dA)) /
    ((2 * Math.PI) / a.teeth);
  const thetaB = toothAngle(b, b.faceWidth / 2, rB);
  const psiB = thetaB - sense * (gA + 0.5) * ((2 * Math.PI) / b.teeth);
  const xB = rotateAbout(zB, dB, -psiB);
  const frame: AssemblyFrame = {
    origin: sub(centreB, scale(zB, b.faceWidth / 2)),
    zAxis: zB,
    xAxis: xB
  };
  return {
    pair: internal ? 'internal' : 'external',
    centerDistance: distance,
    standardCenterDistance: standard,
    workingPressureAngleDeg: alphaW / DEG,
    ratio: ((internal ? 1 : -1) * a.teeth) / b.teeth,
    travelPerTurn: null,
    backlash: a.backlash + b.backlash,
    frame,
    placement: placementFor(b.frame, frame)
  };
}

/**
 * A spur pinion on a rack. Works in the rack's coordinates (`current` maps
 * the pinion's into them); `pinionMoves` false returns the rack's placement
 * in the pinion's coordinates instead.
 */
function meshRack(
  rack: GearMeshGear,
  pinion: GearMeshGear,
  current: RigidTransform,
  pinionMoves: boolean
): GearMeshSolution | GearMeshRefusal {
  const m = rack.module;
  const pitch = Math.PI * m;
  const radius = (m * pinion.teeth) / 2;
  const distance = radius + pinion.profileShift * m;
  const clearance = pinionMoves
    ? clearanceError(rack, pinion, distance)
    : clearanceError(pinion, rack, distance);
  if (clearance) return clearance;
  const { origin: oR, zAxis: zR, xAxis: xR } = rack.frame;
  const n = cross3(zR, xR);
  const nowP = frameInWorld(current, pinion.frame);
  const s = dot3(nowP.zAxis, zR) < 0 ? -1 : 1;
  const midP = add(nowP.origin, scale(nowP.zAxis, pinion.faceWidth / 2));
  const length = rack.teeth * pitch;
  const along = Math.min(length, Math.max(0, dot3(sub(midP, oR), xR)));
  const centre = add(
    add(add(oR, scale(zR, rack.faceWidth / 2)), scale(n, distance)),
    scale(xR, along)
  );
  const zP = scale(zR, s);
  const dP = scale(n, -1);
  // Along the pinion's own tangent at the pitch point (s·xR), the rack's
  // tooth 0 at ½p sits gR pitches from the pitch point.
  const gR = (s * (pitch / 2 - along)) / pitch;
  const psi =
    toothAngle(pinion, 0, radius) - (gR + 0.5) * ((2 * Math.PI) / pinion.teeth);
  const frame: AssemblyFrame = {
    origin: sub(centre, scale(zP, pinion.faceWidth / 2)),
    zAxis: zP,
    xAxis: rotateAbout(zP, dP, -psi)
  };
  const pinionInRack = placementFor(pinion.frame, frame);
  const placement = pinionMoves ? pinionInRack : invertTransform(pinionInRack);
  return {
    pair: 'rack',
    centerDistance: distance,
    standardCenterDistance: radius,
    workingPressureAngleDeg: rack.pressureAngleDeg,
    ratio: null,
    travelPerTurn: 2 * Math.PI * radius,
    backlash: rack.backlash + pinion.backlash,
    frame: pinionMoves ? frame : frameInWorld(placement, rack.frame),
    placement
  };
}
