/**
 * Screens a STEP file for a cylindrical face whose seam runs through one of
 * its own windows.
 *
 * A closed cylindrical face carries a seam: one axial EDGE_CURVE used twice in
 * the face, once each way. When a boolean opens a window in that wall (another
 * cylinder cut through it), the window's inner bound must lie in the angular
 * gap the seam leaves free. Remus 2026.1.129 and older wrote the seam where
 * the source had it, straight through the window (OpenZCAD #1243): the file
 * read back as a valid closed solid with the right volume in Remus and in
 * OCCT, yet OCCT classified points inside the solid as outside and its mesh
 * had boundary and non-manifold edges. Remus 2026.1.130 (esaueng/remus#1624)
 * moves the seam into a free gap.
 *
 * This reads the exchange text, not the imported topology, for the same
 * reason as `test/parity/step-inner-loop-winding.ts`: the defect is in the
 * FILE, and a kernel that re-seams on import would hide it.
 *
 * Deliberately narrow. A face is screened when it sits on a
 * CYLINDRICAL_SURFACE, has exactly one seam (an axial LINE edge used twice in
 * the face), and every edge of its other loops is an axial LINE or a CIRCLE
 * coaxial with the cylinder, possibly behind a SURFACE_CURVE or TRIMMED_CURVE
 * wrapper. Anything else is counted as unscreened, never as clean.
 */
import {
  type Entity,
  entityRefs,
  parseStepEntities,
  sense,
  splitArgs
} from '../parity/step-inner-loop-winding';

type Vec3 = readonly [number, number, number];

export interface SeamWindowFinding {
  /** `#id` of the offending ADVANCED_FACE. */
  readonly faceId: number;
  /** Seam angle about the cylinder's axis, from its reference direction. */
  readonly seamAngle: number;
  /** `#id` of the EDGE_LOOP whose angular span contains the seam. */
  readonly loopId: number;
}

export interface StepSeamWindowScreen {
  readonly findings: readonly SeamWindowFinding[];
  /** Seamed cylindrical faces with at least one window this screen judged. */
  readonly screened: number;
  /** Cylindrical faces it could not judge: several seams, other curves. */
  readonly unscreened: number;
}

const TAU = Math.PI * 2;
/** Angular tolerance, in radians. Generous next to written precision. */
const ANGLE_TOLERANCE = 1e-7;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const length = (a: Vec3) => Math.sqrt(dot(a, a));
const unit = (a: Vec3): Vec3 => {
  const size = length(a);
  return [a[0] / size, a[1] / size, a[2] / size];
};
/** `angle` reduced to [0, 2π). */
const wrap = (angle: number) => ((angle % TAU) + TAU) % TAU;

function triple(
  entities: Map<number, Entity>,
  id: number | undefined
): Vec3 | null {
  const entity = id === undefined ? undefined : entities.get(id);
  if (entity?.type !== 'CARTESIAN_POINT' && entity?.type !== 'DIRECTION') {
    return null;
  }
  const numbers = [
    ...(splitArgs(entity.args)[1] ?? '').matchAll(
      /-?\d+\.?\d*(?:[eE][-+]?\d+)?/g
    )
  ].map((match) => Number(match[0]));
  return numbers.length >= 3 ? [numbers[0]!, numbers[1]!, numbers[2]!] : null;
}

interface Placement {
  readonly origin: Vec3;
  readonly axis: Vec3;
  readonly reference: Vec3;
}

function placement(
  entities: Map<number, Entity>,
  id: number | undefined
): Placement | null {
  const entity = id === undefined ? undefined : entities.get(id);
  if (entity?.type !== 'AXIS2_PLACEMENT_3D') return null;
  const [originId, axisId, referenceId] = entityRefs(entity.args);
  const origin = triple(entities, originId);
  const axis = triple(entities, axisId);
  const reference = triple(entities, referenceId);
  if (!origin || !axis || !reference) return null;
  const z = unit(axis);
  // Gram-Schmidt the reference against the axis, as ISO 10303-42 does.
  const x = unit(
    sub(reference, [
      z[0] * dot(reference, z),
      z[1] * dot(reference, z),
      z[2] * dot(reference, z)
    ])
  );
  return { origin, axis: z, reference: x };
}

interface Edge {
  readonly id: number;
  readonly start: Vec3;
  readonly end: Vec3;
  /** The 3D curve, with SURFACE_CURVE and TRIMMED_CURVE seen through. */
  readonly curve: Entity;
  /** Edge sense composed with any TRIMMED_CURVE sense. */
  readonly sense: number;
}

function vertexPoint(entities: Map<number, Entity>, id: number | undefined) {
  const vertex = id === undefined ? undefined : entities.get(id);
  return vertex?.type === 'VERTEX_POINT'
    ? triple(entities, entityRefs(vertex.args)[0])
    : null;
}

function edgeCurve(entities: Map<number, Entity>, id: number): Edge | null {
  const edge = entities.get(id);
  if (edge?.type !== 'EDGE_CURVE') return null;
  const args = splitArgs(edge.args);
  const start = vertexPoint(entities, entityRefs(args[1] ?? '')[0]);
  const end = vertexPoint(entities, entityRefs(args[2] ?? '')[0]);
  let edgeSense = sense(args[4] ?? '');
  let curve = entities.get(entityRefs(args[3] ?? '')[0] ?? -1);
  while (
    curve &&
    edgeSense !== null &&
    (curve.type === 'SURFACE_CURVE' ||
      curve.type === 'SEAM_CURVE' ||
      curve.type === 'TRIMMED_CURVE')
  ) {
    const wrapper = splitArgs(curve.args);
    if (curve.type === 'TRIMMED_CURVE') {
      const agreement = sense(wrapper[4] ?? '');
      edgeSense = agreement === null ? null : edgeSense * agreement;
    }
    curve = entities.get(entityRefs(wrapper[1] ?? '')[0] ?? -1);
  }
  if (!start || !end || !curve || edgeSense === null) return null;
  return { id, start, end, curve, sense: edgeSense };
}

/** The EDGE_CURVE ids of one EDGE_LOOP, in loop order. */
function loopEdgeIds(entities: Map<number, Entity>, loop: Entity): number[] {
  return entityRefs(splitArgs(loop.args)[1] ?? '').flatMap((orientedId) => {
    const oriented = entities.get(orientedId);
    if (oriented?.type !== 'ORIENTED_EDGE') return [];
    const edgeId = entityRefs(splitArgs(oriented.args)[3] ?? '')[0];
    return edgeId === undefined ? [] : [edgeId];
  });
}

/** Whether `angle` lies in the CCW interval from `from` to `to`, inclusive. */
function within(angle: number, from: number, to: number): boolean {
  const span = wrap(to - from);
  const offset = wrap(angle - from);
  return offset <= span + ANGLE_TOLERANCE || offset >= TAU - ANGLE_TOLERANCE;
}

export function screenStepSeamWindows(text: string): StepSeamWindowScreen {
  const entities = parseStepEntities(text);
  const findings: SeamWindowFinding[] = [];
  let screened = 0;
  let unscreened = 0;

  for (const [faceId, face] of entities) {
    if (face.type !== 'ADVANCED_FACE') continue;
    const faceArgs = splitArgs(face.args);
    const surface = entities.get(entityRefs(faceArgs[2] ?? '')[0] ?? -1);
    if (surface?.type !== 'CYLINDRICAL_SURFACE') continue;
    const frame = placement(entities, entityRefs(surface.args)[0]);
    if (!frame) {
      unscreened += 1;
      continue;
    }
    const y = cross(frame.axis, frame.reference);
    const angleOf = (point: Vec3) => {
      const offset = sub(point, frame.origin);
      return wrap(Math.atan2(dot(offset, y), dot(offset, frame.reference)));
    };
    const isAxialLine = (edge: Edge) =>
      edge.curve.type === 'LINE' &&
      Math.abs(angleOf(edge.start) - angleOf(edge.end)) < ANGLE_TOLERANCE;

    const loops = entityRefs(faceArgs[1] ?? '').flatMap((boundId) => {
      const bound = entities.get(boundId);
      const loopId = entityRefs(splitArgs(bound?.args ?? '')[1] ?? '')[0];
      const loop = loopId === undefined ? undefined : entities.get(loopId);
      return loop?.type === 'EDGE_LOOP'
        ? [{ loopId: loopId!, edgeIds: loopEdgeIds(entities, loop) }]
        : [];
    });
    const uses = new Map<number, number>();
    for (const { edgeIds } of loops) {
      for (const edgeId of edgeIds)
        uses.set(edgeId, (uses.get(edgeId) ?? 0) + 1);
    }
    const seams = [...uses]
      .filter(([, count]) => count === 2)
      .map(([edgeId]) => edgeCurve(entities, edgeId));
    if (seams.length === 0) continue; // A partial wall: no seam to misplace.
    const seam = seams[0];
    if (seams.length !== 1 || !seam || !isAxialLine(seam)) {
      unscreened += 1;
      continue;
    }
    const seamAngle = angleOf(seam.start);

    const windows = loops.filter(({ edgeIds }) => !edgeIds.includes(seam.id));
    if (windows.length === 0) continue; // A plain wall, nothing to cross.
    let judgeable = true;
    const offending: number[] = [];
    for (const { loopId, edgeIds } of windows) {
      let crosses = false;
      for (const edgeId of edgeIds) {
        const edge = edgeCurve(entities, edgeId);
        if (!edge) {
          judgeable = false;
          break;
        }
        if (isAxialLine(edge)) {
          crosses ||= within(
            seamAngle,
            angleOf(edge.start),
            angleOf(edge.start)
          );
          continue;
        }
        const circle =
          edge.curve.type === 'CIRCLE'
            ? placement(entities, entityRefs(edge.curve.args)[0])
            : null;
        const alignment = circle ? dot(circle.axis, frame.axis) : 0;
        const radial = circle ? sub(circle.origin, frame.origin) : null;
        const offAxis = radial
          ? length(
              sub(radial, [
                frame.axis[0] * dot(radial, frame.axis),
                frame.axis[1] * dot(radial, frame.axis),
                frame.axis[2] * dot(radial, frame.axis)
              ])
            )
          : Infinity;
        if (Math.abs(Math.abs(alignment) - 1) > 1e-9 || offAxis > 1e-7) {
          judgeable = false;
          break;
        }
        // A CIRCLE runs CCW about its own axis. The arc an edge covers is the
        // same set whichever way an ORIENTED_EDGE then walks it.
        const ccw = Math.sign(alignment) * edge.sense > 0;
        const from = angleOf(ccw ? edge.start : edge.end);
        const to = angleOf(ccw ? edge.end : edge.start);
        const fullCircle = length(sub(edge.start, edge.end)) < 1e-9;
        crosses ||= fullCircle || within(seamAngle, from, to);
      }
      if (!judgeable) break;
      if (crosses) offending.push(loopId);
    }
    if (!judgeable) {
      unscreened += 1;
      continue;
    }
    screened += 1;
    for (const loopId of offending)
      findings.push({ faceId, seamAngle, loopId });
  }

  return { findings, screened, unscreened };
}
