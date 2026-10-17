import type { PlaneBasis } from './index';
import { GEOMETRY_RELATIVE_TOLERANCE, geometryTolerance } from './tolerance';

/**
 * Pure construction rules for R01 datum planes. Both the production kernel
 * build and the parity reference resolve source frames first and then call
 * these, so a datum means the same plane wherever it is rebuilt.
 *
 * Frames are right-handed: u × v = normal.
 */

type V = PlaneBasis['origin'];

const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: V, s: number): V => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V, b: V): V => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});
const length = (a: V): number => Math.sqrt(dot(a, a));

function requireFrame(frame: PlaneBasis, role: string): void {
  const values = [frame.origin, frame.u, frame.v, frame.normal].flatMap(
    (vector) => [vector.x, vector.y, vector.z]
  );
  if (!values.every(Number.isFinite)) {
    throw new Error(`The ${role} plane has a non-finite frame.`);
  }
  if (Math.abs(length(frame.normal) - 1) > 1e-9) {
    throw new Error(`The ${role} plane has no unit normal.`);
  }
}

/** Reverses the result normal and v, keeping the origin and a right-handed frame. */
function flipped(frame: PlaneBasis): PlaneBasis {
  return {
    origin: frame.origin,
    u: frame.u,
    v: scale(frame.v, -1),
    normal: scale(frame.normal, -1)
  };
}

/**
 * The source plane moved `offset` along its own normal: positive follows the
 * visible source normal, zero is the source itself. `reverseNormal` flips the
 * result's orientation without moving it.
 */
export function offsetDatumPlane(
  source: PlaneBasis,
  offset: number,
  reverseNormal = false
): PlaneBasis {
  requireFrame(source, 'source');
  if (!Number.isFinite(offset)) {
    throw new Error('The plane offset must be a finite distance.');
  }
  const frame: PlaneBasis = {
    origin: add(source.origin, scale(source.normal, offset)),
    u: source.u,
    v: source.v,
    normal: source.normal
  };
  return reverseNormal ? flipped(frame) : frame;
}

/**
 * The plane halfway between two parallel planes A and B (normals may oppose),
 * keeping A's in-plane origin and axes so that sliding B along itself does
 * not move the result. Nonparallel or coincident sources are refused; no
 * angular bisector is guessed.
 */
export function midDatumPlane(
  a: PlaneBasis,
  b: PlaneBasis,
  reverseNormal = false
): PlaneBasis {
  requireFrame(a, 'first');
  requireFrame(b, 'second');
  if (length(cross(a.normal, b.normal)) > GEOMETRY_RELATIVE_TOLERANCE) {
    throw new Error(
      'A midplane needs two parallel planes; these are not parallel.'
    );
  }
  const separation = dot(sub(b.origin, a.origin), a.normal);
  if (
    Math.abs(separation) <=
    geometryTolerance(Math.max(length(a.origin), length(b.origin)))
  ) {
    throw new Error('A midplane needs two separate planes; these coincide.');
  }
  const frame: PlaneBasis = {
    origin: add(a.origin, scale(a.normal, separation / 2)),
    u: a.u,
    v: a.v,
    normal: a.normal
  };
  return reverseNormal ? flipped(frame) : frame;
}
