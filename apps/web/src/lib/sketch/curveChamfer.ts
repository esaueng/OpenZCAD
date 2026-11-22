/**
 * S05: Chamfer where an arc meets a line or another arc, app-side and exact.
 *
 * The kernel's `chamfer2d` cuts polygons, so a corner with a curved leg is
 * built here. Each leg is cut back by the same setback measured as a
 * straight distance from the corner — along a line, and as a chord of an arc
 * (the arc point whose distance from its end is the setback, at central
 * angle 2·asin(d / 2r)) — and a bevel line joins the two cuts. That is one
 * transaction: the corner's coincidence released, both legs trimmed, the
 * bevel added and joined at both ends, exactly as the straight Chamfer
 * writes it.
 */
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import { resolvedSketchDocument } from '@openzcad/document-core';
import {
  createId,
  toEntityId,
  type EntityId,
  type ProjectDocument,
  type SketchId,
  type SketchNode,
  type SketchObjectData,
  type SketchPointRef
} from '@openzcad/shared';
import {
  deleteCornerCoincidenceCommands,
  JOINT_TOLERANCE,
  lineEnds,
  movedLine,
  sameSketchPoint,
  type ResolveParam
} from './cornerEditCommands';

interface Point {
  x: number;
  y: number;
}

type ArcData = Extract<SketchObjectData, { objectKind: 'arc' }>;
type LineData = Extract<SketchObjectData, { objectKind: 'line' }>;

/** One leg of a curved corner, at the end that meets the other. */
type Leg =
  | {
      kind: 'line';
      objectId: EntityId;
      data: LineData;
      end: 'start' | 'end';
      at: Point;
      far: Point;
    }
  | {
      kind: 'arc';
      objectId: EntityId;
      data: ArcData;
      end: 'start' | 'end';
      at: Point;
      center: Point;
      radius: number;
      startRad: number;
      sweepRad: number;
      /** A circle standing in as a leg: never trimmed, held by on-curve. */
      circle?: true;
    };

const TAU = Math.PI * 2;

function sketchObject(
  document: ProjectDocument,
  sketch: SketchNode,
  objectId: string
): SketchObjectData | null {
  if (!sketch.objectIds.includes(objectId as EntityId)) return null;
  const node = resolvedSketchDocument(document).nodes[objectId as EntityId];
  return node?.kind === 'sketch-object' ? node.data : null;
}

function legEnds(
  objectId: string,
  data: SketchObjectData,
  resolve: ResolveParam
): Leg[] | null {
  if (data.objectKind === 'line') {
    const ends = lineEnds(data, resolve);
    if (!ends) return null;
    return (['start', 'end'] as const).map((end) => ({
      kind: 'line',
      objectId: objectId as EntityId,
      data,
      end,
      at: ends[end],
      far: ends[end === 'start' ? 'end' : 'start']
    }));
  }
  if (data.objectKind !== 'arc') return null;
  const cx = resolve(data.centerX);
  const cy = resolve(data.centerY);
  const r = resolve(data.radius);
  const startDeg = resolve(data.startAngleDeg);
  const endDeg = resolve(data.endAngleDeg);
  if (
    [cx, cy, r, startDeg, endDeg].some(
      (value) => value === undefined || !Number.isFinite(value)
    ) ||
    !(r! > 0)
  ) {
    return null;
  }
  const startRad = (startDeg! * Math.PI) / 180;
  let sweepRad = ((endDeg! - startDeg!) * Math.PI) / 180;
  sweepRad = ((sweepRad % TAU) + TAU) % TAU;
  if (sweepRad <= 0) return null;
  const center = { x: cx!, y: cy! };
  const point = (angle: number) => ({
    x: center.x + r! * Math.cos(angle),
    y: center.y + r! * Math.sin(angle)
  });
  return (['start', 'end'] as const).map((end) => ({
    kind: 'arc',
    objectId: objectId as EntityId,
    data,
    end,
    at: point(end === 'start' ? startRad : startRad + sweepRad),
    center,
    radius: r!,
    startRad,
    sweepRad
  }));
}

/** The point a leg is cut back to, `distance` from the corner, or why not. */
function cutPoint(leg: Leg, distance: number): Point | string {
  if (leg.kind === 'line') {
    const dx = leg.far.x - leg.at.x;
    const dy = leg.far.y - leg.at.y;
    const length = Math.hypot(dx, dy);
    if (distance >= length - JOINT_TOLERANCE) {
      return `A ${fmt(distance)} setback does not fit a ${fmt(length)} line.`;
    }
    return {
      x: leg.at.x + (dx / length) * distance,
      y: leg.at.y + (dy / length) * distance
    };
  }
  if (distance >= 2 * leg.radius) {
    return `A ${fmt(distance)} setback is longer than a radius-${fmt(leg.radius)} arc's diameter.`;
  }
  const turn = 2 * Math.asin(distance / (2 * leg.radius));
  if (turn >= leg.sweepRad - 1e-9) {
    return `A ${fmt(distance)} setback runs past the far end of the arc.`;
  }
  const angle =
    leg.end === 'start'
      ? leg.startRad + turn
      : leg.startRad + leg.sweepRad - turn;
  return {
    x: leg.center.x + leg.radius * Math.cos(angle),
    y: leg.center.y + leg.radius * Math.sin(angle)
  };
}

function fmt(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** The leg's data with the corner end moved to `to`. */
function trimmedData(leg: Leg, to: Point): SketchObjectData {
  if (leg.kind === 'line') {
    return movedLine(leg.data, leg.end, to);
  }
  const angleDeg =
    (Math.atan2(to.y - leg.center.y, to.x - leg.center.x) * 180) / Math.PI;
  const startDeg = (leg.startRad * 180) / Math.PI;
  const endDeg = ((leg.startRad + leg.sweepRad) * 180) / Math.PI;
  // Keep the angles in the arc's own turn, so it still sweeps
  // counter-clockwise from start to end.
  const unwrap = (angle: number, near: number) =>
    angle + 360 * Math.round((near - angle) / 360);
  return leg.end === 'start'
    ? {
        ...leg.data,
        startAngleDeg: unwrap(angleDeg, startDeg),
        endAngleDeg: endDeg
      }
    : {
        ...leg.data,
        startAngleDeg: startDeg,
        endAngleDeg: unwrap(angleDeg, endDeg)
      };
}

export type CurveChamferPlan =
  | { status: 'refuse'; reason: string }
  | {
      status: 'commands';
      label: string;
      message: string;
      commands: AnyCommand[];
    };

/** A Chamfer pick: an entity id, and for a circle where it was clicked. */
function parsePick(pick: string): { id: string; at: Point | null } {
  const [id, at] = pick.split('@') as [string, string | undefined];
  if (!at) return { id, at: null };
  const [x, y] = at.split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y)
    ? { id, at: { x: x!, y: y! } }
    : { id, at: null };
}

/** True when a chamfer of these two picks takes this module's route. */
export function chamferHasCurvedLeg(
  document: ProjectDocument,
  sketch: SketchNode,
  aId: string,
  bId: string
): boolean {
  return [aId, bId].some((pick) => {
    const kind = sketchObject(document, sketch, parsePick(pick).id)?.objectKind;
    return kind === 'arc' || kind === 'circle';
  });
}

/**
 * A circle as a corner leg: a (nearly) whole turn leaving the joint the way
 * the click lies from it, so the bevel cuts in on the clicked side.
 */
function circleLeg(
  objectId: string,
  data: Extract<SketchObjectData, { objectKind: 'circle' }>,
  joint: Point,
  click: Point | null,
  resolve: ResolveParam
): Leg | null {
  const cx = resolve(data.centerX);
  const cy = resolve(data.centerY);
  const r = resolve(data.radius);
  if (cx === undefined || cy === undefined || r === undefined || !(r > 0)) {
    return null;
  }
  const center = { x: cx, y: cy };
  const jointAngle = Math.atan2(joint.y - cy, joint.x - cx);
  const clickAngle = click
    ? Math.atan2(click.y - cy, click.x - cx)
    : jointAngle + Math.PI / 2;
  const ccw = (((clickAngle - jointAngle) % TAU) + TAU) % TAU < Math.PI;
  const sweepRad = TAU - 1e-6;
  return {
    kind: 'arc',
    objectId: objectId as EntityId,
    data: data as unknown as ArcData,
    end: ccw ? 'start' : 'end',
    at: joint,
    center,
    radius: r,
    startRad: ccw ? jointAngle : jointAngle - sweepRad,
    sweepRad,
    circle: true
  };
}

/** Where an arc meets a line or another arc: the two legs at their joint. */
export function resolveCurvedCorner(
  document: ProjectDocument,
  sketch: SketchNode,
  aId: string,
  bId: string,
  resolve: ResolveParam
): { legs: [Leg, Leg] } | { error: string } {
  const aPick = parsePick(aId);
  const bPick = parsePick(bId);
  const aData = sketchObject(document, sketch, aPick.id);
  const bData = sketchObject(document, sketch, bPick.id);
  if (!aData || !bData) {
    return { error: 'That object is not part of this sketch.' };
  }
  if (aData.objectKind === 'circle' || bData.objectKind === 'circle') {
    if (aData.objectKind === 'circle' && bData.objectKind === 'circle') {
      return { error: 'Two circles share no corner. Pick a line or an arc.' };
    }
    const [circlePick, circleData, otherPick, otherData] =
      aData.objectKind === 'circle'
        ? [aPick, aData, bPick, bData]
        : [bPick, bData as typeof aData, aPick, aData];
    const others = legEnds(otherPick.id, otherData, resolve);
    const cx = resolve((circleData as { centerX: number }).centerX);
    const cy = resolve((circleData as { centerY: number }).centerY);
    const r = resolve((circleData as { radius: number }).radius);
    const onCircle = (others ?? []).filter(
      (leg) =>
        cx !== undefined &&
        cy !== undefined &&
        r !== undefined &&
        Math.abs(Math.hypot(leg.at.x - cx, leg.at.y - cy) - r) <=
          JOINT_TOLERANCE
    );
    if (onCircle.length !== 1) {
      return {
        error:
          onCircle.length === 0
            ? 'That line or arc does not end on the circle. Join it to the circle first.'
            : 'Both ends lie on the circle, so the corner to cut is ambiguous. Split it first.'
      };
    }
    const other = onCircle[0]!;
    const leg = circleLeg(
      circlePick.id,
      circleData as Extract<SketchObjectData, { objectKind: 'circle' }>,
      other.at,
      circlePick.at,
      resolve
    );
    if (!leg) {
      return { error: 'That circle has a dimension that does not evaluate.' };
    }
    return {
      legs: aData.objectKind === 'circle' ? [leg, other] : [other, leg]
    };
  }
  const aLegs = legEnds(aId, aData, resolve);
  const bLegs = legEnds(bId, bData, resolve);
  if (!aLegs || !bLegs) {
    return {
      error:
        'Chamfer takes lines and arcs whose dimensions evaluate. Pick a line or an arc.'
    };
  }
  const joints = aLegs.flatMap((a) =>
    bLegs
      .filter((b) => sameSketchPoint(a.at, b.at))
      .map((b) => [a, b] as [Leg, Leg])
  );
  if (joints.length === 0) {
    return {
      error:
        'Those two do not meet at an endpoint. Join them first — this tool does not extend geometry.'
    };
  }
  if (joints.length > 1) {
    return {
      error:
        'Those two meet at both ends, so the corner to cut is ambiguous. Split one first.'
    };
  }
  return { legs: joints[0]! };
}

/** The shorter leg's reach from the corner, for a setback that always fits. */
export function curvedCornerPrefill(legs: readonly [Leg, Leg]): number {
  const reach = legs.map((leg) =>
    leg.kind === 'line'
      ? Math.hypot(leg.far.x - leg.at.x, leg.far.y - leg.at.y)
      : 2 * leg.radius * Math.sin(Math.min(leg.sweepRad, Math.PI) / 2)
  );
  return Math.min(...reach) / 4;
}

/** One chamfer at a corner with an arc in it, as one transaction. */
export function planCurvedChamfer(
  document: ProjectDocument,
  sketch: SketchNode,
  sketchId: SketchId,
  aId: string,
  bId: string,
  distance: number,
  resolve: ResolveParam
): CurveChamferPlan {
  if (!Number.isFinite(distance) || distance <= 0) {
    return {
      status: 'refuse',
      reason: 'A chamfer distance must be a positive number.'
    };
  }
  const corner = resolveCurvedCorner(document, sketch, aId, bId, resolve);
  if ('error' in corner) {
    return { status: 'refuse', reason: corner.error };
  }
  const [a, b] = corner.legs;
  const cutA = cutPoint(a, distance);
  if (typeof cutA === 'string') return { status: 'refuse', reason: cutA };
  const cutB = cutPoint(b, distance);
  if (typeof cutB === 'string') return { status: 'refuse', reason: cutB };
  const aRef: SketchPointRef = { objectId: a.objectId, point: a.end };
  const bRef: SketchPointRef = { objectId: b.objectId, point: b.end };
  const bevelId = toEntityId(createId('ent'));
  const isCircle = (leg: Leg) => leg.kind === 'arc' && leg.circle === true;
  const circle = [a, b].find(isCircle);
  // A leg's end joins the bevel; a circle, kept whole, holds the bevel's end
  // on it instead.
  const join = (leg: Leg, ref: SketchPointRef, point: 'start' | 'end') =>
    commandFactories.addSketchConstraint(
      {
        sketchId,
        constraint: isCircle(leg)
          ? {
              constraintKind: 'point-on-object',
              point: { objectId: bevelId, point },
              objectId: leg.objectId
            }
          : {
              constraintKind: 'coincident',
              a: ref,
              b: { objectId: bevelId, point }
            }
      },
      'Join chamfer to its leg'
    );
  const other = circle ? [a, b].find((leg) => !isCircle(leg))! : null;
  return {
    status: 'commands',
    label: 'Chamfer',
    message: `Chamfer cut both legs back ${fmt(distance)}.`,
    commands: [
      ...(circle && other
        ? // The cut end leaves the circle: what held it there goes.
          (sketch.constraints ?? []).flatMap(({ constraintId, data }) =>
            data.constraintKind === 'point-on-object' &&
            data.objectId === circle.objectId &&
            data.point.objectId === other.objectId &&
            data.point.point === other.end
              ? [
                  commandFactories.deleteSketchConstraint(
                    { sketchId, constraintId },
                    'Release the chamfered corner'
                  )
                ]
              : []
          )
        : deleteCornerCoincidenceCommands(
            sketch,
            sketchId,
            aRef,
            bRef,
            'Release the chamfered corner'
          )),
      ...[
        [a, cutA],
        [b, cutB]
      ].flatMap(([leg, cut]) =>
        isCircle(leg as Leg)
          ? []
          : [
              commandFactories.updateSketchObject(
                {
                  sketchId,
                  objectId: (leg as Leg).objectId,
                  data: trimmedData(leg as Leg, cut as Point)
                },
                'Trim to chamfer'
              )
            ]
      ),
      commandFactories.addSketchObjects(
        {
          sketchId,
          objects: [
            {
              objectKind: 'line',
              x1: cutA.x,
              y1: cutA.y,
              x2: cutB.x,
              y2: cutB.y,
              ...(a.data.construction && b.data.construction
                ? { construction: true }
                : {})
            }
          ],
          ids: { objectNodeIds: [bevelId] }
        },
        'Add chamfer bevel'
      ),
      join(a, aRef, 'start'),
      join(b, bRef, 'end')
    ]
  };
}
