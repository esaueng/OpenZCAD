import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import type {
  Sketch2dPoint,
  SketchFilletGeometry
} from '@openzcad/kernel-adapter/sketch-2d-ops';
import {
  createId,
  toEntityId,
  type ParamValue,
  type SketchId,
  type SketchNode,
  type SketchObjectData,
  type SketchPointRef
} from '@openzcad/shared';

/** Resolves a `ParamValue`, or undefined when its expression does not. */
export type ResolveParam = (value: ParamValue) => number | undefined;

/** Slack for solved endpoints that agree to within one millionth of a model unit. */
export const JOINT_TOLERANCE = 1e-6;

export type LineData = Extract<SketchObjectData, { objectKind: 'line' }>;
export type LineEnd = 'start' | 'end';
export type LineEndRef = SketchPointRef & { point: LineEnd };

export interface LineEnds {
  start: Sketch2dPoint;
  end: Sketch2dPoint;
}

export function lineEnds(
  data: SketchObjectData,
  resolve: ResolveParam
): LineEnds | null {
  if (data.objectKind !== 'line') return null;
  const x1 = resolve(data.x1);
  const y1 = resolve(data.y1);
  const x2 = resolve(data.x2);
  const y2 = resolve(data.y2);
  if (
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined ||
    ![x1, y1, x2, y2].every(Number.isFinite)
  )
    return null;
  return { start: { x: x1, y: y1 }, end: { x: x2, y: y2 } };
}

export function sameSketchPoint(a: Sketch2dPoint, b: Sketch2dPoint): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= JOINT_TOLERANCE;
}

export function movedLine(
  data: LineData,
  point: LineEnd,
  to: Sketch2dPoint
): LineData {
  return point === 'start'
    ? { ...data, x1: to.x, y1: to.y }
    : { ...data, x2: to.x, y2: to.y };
}

/** Release only the coincidence directly tying the two endpoints to each other. */
export function deleteCornerCoincidenceCommands(
  sketch: SketchNode,
  sketchId: SketchId,
  a: SketchPointRef,
  b: SketchPointRef,
  label: string
): AnyCommand[] {
  const matches = (ref: SketchPointRef, target: SketchPointRef) =>
    ref.objectId === target.objectId && ref.point === target.point;
  return (sketch.constraints ?? []).flatMap(({ constraintId, data }) =>
    data.constraintKind === 'coincident' &&
    ((matches(data.a, a) && matches(data.b, b)) ||
      (matches(data.a, b) && matches(data.b, a)))
      ? [
          commandFactories.deleteSketchConstraint(
            { sketchId, constraintId },
            label
          )
        ]
      : []
  );
}

/** Add the exact arc and the five relations that hold it in the sketch. */
export function addFilletCornerCommands(
  sketchId: SketchId,
  a: SketchPointRef,
  b: SketchPointRef,
  fillet: SketchFilletGeometry,
  radius: ParamValue
): AnyCommand[] {
  const arcId = toEntityId(createId('ent'));
  const arcRefA: SketchPointRef = {
    objectId: arcId,
    point: fillet.startsAt === 'a' ? 'start' : 'end'
  };
  const arcRefB: SketchPointRef = {
    objectId: arcId,
    point: fillet.startsAt === 'a' ? 'end' : 'start'
  };
  const contacts = [
    [a, arcRefA],
    [b, arcRefB]
  ] as const;
  return [
    commandFactories.addSketchObjects(
      {
        sketchId,
        objects: [
          {
            objectKind: 'arc',
            centerX: fillet.center.x,
            centerY: fillet.center.y,
            radius: fillet.radius,
            startAngleDeg: fillet.startAngleDeg,
            endAngleDeg: fillet.endAngleDeg
          }
        ],
        ids: { objectNodeIds: [arcId] }
      },
      'Add fillet arc'
    ),
    ...contacts.map(([line, arc]) =>
      commandFactories.addSketchConstraint(
        {
          sketchId,
          constraint: { constraintKind: 'coincident', a: line, b: arc }
        },
        'Join fillet to line'
      )
    ),
    ...contacts.map(([line, arc]) =>
      commandFactories.addSketchConstraint(
        {
          sketchId,
          constraint: {
            constraintKind: 'tangent',
            a: line.objectId,
            b: arcId,
            at: arc
          }
        },
        'Hold the fillet tangent'
      )
    ),
    commandFactories.addSketchConstraint(
      {
        sketchId,
        constraint: { constraintKind: 'radius', objectId: arcId, value: radius }
      },
      'Drive the fillet radius'
    )
  ];
}
