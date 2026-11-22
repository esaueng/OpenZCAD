import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import { resolvedSketchDocument } from '@openzcad/document-core';
import {
  filletSketchCorner,
  type Sketch2dPoint,
  type SketchCorner,
  type SketchFilletGeometry
} from '@openzcad/kernel-adapter/sketch-2d-ops';
import {
  displayLengthName,
  type EntityId,
  type ParamValue,
  type ProjectDocument,
  type SketchId,
  type SketchNode,
  type SketchPointRef
} from '@openzcad/shared';
import { solveStatusLabel, solvedSketchCommands } from './applySolve';
import { filletCurvedCorner, type FilletLeg } from './curvedFillet';
import {
  addFilletCornerCommands,
  deleteCornerCoincidenceCommands,
  JOINT_TOLERANCE,
  lineEnds,
  movedLine,
  sameSketchPoint,
  type LineData,
  type LineEndRef,
  type LineEnds,
  type ResolveParam
} from './cornerEditCommands';

export interface SketchFilletCorner {
  id: string;
  point: Sketch2dPoint;
  a: LineEndRef;
  b: LineEndRef;
}

export interface SketchFilletBatchLine extends LineEnds {
  objectId: EntityId;
  startCornerId?: string;
  endCornerId?: string;
}

export interface SketchFilletBatchArc extends SketchFilletGeometry {
  corner: SketchFilletCorner;
  /** S05: the circle the fillet touches at `b`, which stays whole. */
  circleLeg?: EntityId;
}

/** S05: an arc leg cut back to its fillet tangency, as it will be stored. */
export interface SketchFilletBatchArcTrim {
  objectId: EntityId;
  center: Sketch2dPoint;
  radius: number;
  startAngleDeg: number;
  endAngleDeg: number;
  startCornerId?: string;
  endCornerId?: string;
}

export interface ReadySketchFilletBatchPlan {
  status: 'ready';
  lines: readonly SketchFilletBatchLine[];
  arcs: readonly SketchFilletBatchArc[];
  /** Arc legs the fillets cut back; none for a sketch of lines. */
  trimmedArcs: readonly SketchFilletBatchArcTrim[];
}

export type SketchFilletBatchPlan =
  | ReadySketchFilletBatchPlan
  | {
      status: 'refuse';
      reason: string;
      lineIds: readonly EntityId[];
      cornerIds: readonly string[];
    };

interface SourceLine extends LineEnds {
  length: number;
  linked: boolean;
}

interface Endpoint {
  ref: LineEndRef;
  position: Sketch2dPoint;
  /**
   * A point the leg runs towards from here: a line's far end, or one step
   * along an arc's tangent, so a smooth line-to-arc joint reads as a
   * straight continuation with nothing to round.
   */
  far: Sketch2dPoint;
  linked: boolean;
  leg: FilletLeg;
}

interface SourceCircle {
  center: Sketch2dPoint;
  radius: number;
  linked: boolean;
}

/** S05: the circles a fillet may meet, resolved like the lines. */
function sourceCircles(
  document: ProjectDocument,
  sketch: SketchNode,
  resolve: ResolveParam
): Map<EntityId, SourceCircle> {
  const nodes = resolvedSketchDocument(document).nodes;
  const circles = new Map<EntityId, SourceCircle>();
  for (const objectId of sketch.objectIds) {
    const node = nodes[objectId];
    if (node?.kind !== 'sketch-object' || node.data.construction) continue;
    const data = node.data;
    if (data.objectKind !== 'circle') continue;
    const cx = resolve(data.centerX);
    const cy = resolve(data.centerY);
    const radius = resolve(data.radius);
    if (
      cx === undefined ||
      cy === undefined ||
      radius === undefined ||
      ![cx, cy, radius].every(Number.isFinite) ||
      !(radius > JOINT_TOLERANCE)
    )
      continue;
    circles.set(objectId, {
      center: { x: cx, y: cy },
      radius,
      linked: data.projection?.mode === 'linked'
    });
  }
  return circles;
}

interface SourceArc {
  center: Sketch2dPoint;
  radius: number;
  startRad: number;
  sweepRad: number;
  linked: boolean;
}

const TAU = Math.PI * 2;

/** S05: the arcs a fillet may round, resolved like the lines. */
function sourceArcs(
  document: ProjectDocument,
  sketch: SketchNode,
  resolve: ResolveParam
): Map<EntityId, SourceArc> {
  const nodes = resolvedSketchDocument(document).nodes;
  const arcs = new Map<EntityId, SourceArc>();
  for (const objectId of sketch.objectIds) {
    const node = nodes[objectId];
    if (node?.kind !== 'sketch-object' || node.data.construction) continue;
    const data = node.data;
    if (data.objectKind !== 'arc') continue;
    const values = [
      data.centerX,
      data.centerY,
      data.radius,
      data.startAngleDeg,
      data.endAngleDeg
    ].map((value) => resolve(value));
    if (!values.every((value) => value !== undefined && Number.isFinite(value)))
      continue;
    const [cx, cy, radius, startDeg, endDeg] = values as number[];
    const sweepRad =
      (((((endDeg! - startDeg!) * Math.PI) / 180) % TAU) + TAU) % TAU;
    if (!(radius! > JOINT_TOLERANCE) || sweepRad <= 1e-9) continue;
    arcs.set(objectId, {
      center: { x: cx!, y: cy! },
      radius: radius!,
      startRad: (startDeg! * Math.PI) / 180,
      sweepRad,
      linked: data.projection?.mode === 'linked'
    });
  }
  return arcs;
}

function arcPoint(arc: SourceArc, angle: number): Sketch2dPoint {
  return {
    x: arc.center.x + arc.radius * Math.cos(angle),
    y: arc.center.y + arc.radius * Math.sin(angle)
  };
}

function sourceLines(
  document: ProjectDocument,
  sketch: SketchNode,
  resolve: ResolveParam
): Map<EntityId, SourceLine> {
  const nodes = resolvedSketchDocument(document).nodes;
  const lines = new Map<EntityId, SourceLine>();
  for (const objectId of sketch.objectIds) {
    const node = nodes[objectId];
    if (node?.kind !== 'sketch-object' || node.data.construction) continue;
    const ends = lineEnds(node.data, resolve);
    if (!ends) continue;
    const length = Math.hypot(
      ends.end.x - ends.start.x,
      ends.end.y - ends.start.y
    );
    if (Number.isFinite(length) && length > JOINT_TOLERANCE) {
      lines.set(objectId, {
        ...ends,
        length,
        linked: node.data.projection?.mode === 'linked'
      });
    }
  }
  return lines;
}

function endpointKey(ref: SketchPointRef): string {
  return JSON.stringify([ref.objectId, ref.point]);
}

function cross(a: Sketch2dPoint, b: Sketch2dPoint): number {
  return a.x * b.y - a.y * b.x;
}

function subtract(a: Sketch2dPoint, b: Sketch2dPoint): Sketch2dPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

/** Intersect the two supporting lines so a rounded or solved joint stays tangent on both legs. */
function jointPoint(a: Endpoint, b: Endpoint): Sketch2dPoint | null {
  const u = subtract(a.far, a.position);
  const v = subtract(b.far, b.position);
  const turn = cross(u, v);
  if (
    Math.abs(turn) <=
    Number.EPSILON * Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y)
  ) {
    return null;
  }
  const offset = cross(subtract(b.position, a.position), v) / turn;
  return { x: a.position.x + offset * u.x, y: a.position.y + offset * u.y };
}

interface CatalogCorner {
  corner: SketchFilletCorner;
  geometry: SketchCorner;
  /** Both legs at the joint; an arc in either makes the corner curved. */
  legs: [FilletLeg, FilletLeg];
  curved: boolean;
  /** A circle the corner's second leg runs round; it is never trimmed. */
  circleLeg?: EntityId;
}

function catalogCorners(
  lines: ReadonlyMap<EntityId, SourceLine>,
  arcs: ReadonlyMap<EntityId, SourceArc> = new Map(),
  circles: ReadonlyMap<EntityId, SourceCircle> = new Map()
): Map<string, CatalogCorner> {
  const endpoints: Endpoint[] = [];
  for (const [objectId, line] of lines) {
    endpoints.push(
      {
        ref: { objectId, point: 'start' },
        position: line.start,
        far: line.end,
        linked: line.linked,
        leg: { kind: 'line', at: line.start, far: line.end }
      },
      {
        ref: { objectId, point: 'end' },
        position: line.end,
        far: line.start,
        linked: line.linked,
        leg: { kind: 'line', at: line.end, far: line.start }
      }
    );
  }
  for (const [objectId, arc] of arcs) {
    for (const end of ['start', 'end'] as const) {
      const angle =
        end === 'start' ? arc.startRad : arc.startRad + arc.sweepRad;
      const at = arcPoint(arc, angle);
      // Into the arc from this end: counter-clockwise from the start,
      // clockwise from the end.
      const sign = end === 'start' ? 1 : -1;
      endpoints.push({
        ref: { objectId, point: end },
        position: at,
        far: {
          x: at.x - Math.sin(angle) * sign * arc.radius,
          y: at.y + Math.cos(angle) * sign * arc.radius
        },
        linked: arc.linked,
        leg: {
          kind: 'arc',
          at,
          center: arc.center,
          radius: arc.radius,
          startRad: arc.startRad,
          sweepRad: arc.sweepRad,
          end
        }
      });
    }
  }
  endpoints.sort((a, b) => a.position.x - b.position.x);
  const neighbors = new Map<Endpoint, Endpoint[]>(
    endpoints.map((endpoint) => [endpoint, []])
  );
  for (const [index, a] of endpoints.entries()) {
    for (let next = index + 1; next < endpoints.length; next += 1) {
      const b = endpoints[next]!;
      if (b.position.x - a.position.x > JOINT_TOLERANCE) break;
      if (
        a.ref.objectId === b.ref.objectId ||
        !sameSketchPoint(a.position, b.position)
      )
        continue;
      neighbors.get(a)!.push(b);
      neighbors.get(b)!.push(a);
    }
  }

  const corners = new Map<string, CatalogCorner>();
  for (const [a, adjacent] of neighbors) {
    if (a.linked || adjacent.length !== 1) continue;
    const b = adjacent[0]!;
    if (b.linked || neighbors.get(b)!.length !== 1) continue;
    if (endpointKey(a.ref) >= endpointKey(b.ref)) continue;
    const curved = a.leg.kind === 'arc' || b.leg.kind === 'arc';
    // Two lines meet where their supporting lines cross, so a rounded or
    // solved joint stays tangent on both; a curved joint is its endpoint.
    const straightPoint = jointPoint(a, b);
    if (!straightPoint) continue;
    const point = curved ? a.position : straightPoint;
    const id = JSON.stringify([
      [a.ref.objectId, a.ref.point],
      [b.ref.objectId, b.ref.point]
    ]);
    corners.set(id, {
      corner: { id, point, a: a.ref, b: b.ref },
      geometry: { corner: point, farA: a.far, farB: b.far },
      legs: [
        { ...a.leg, at: point },
        { ...b.leg, at: point }
      ],
      curved
    });
  }
  // S05 circle inputs: a free line or arc end lying on a circle meets it in
  // two corners, one each way round. The circle is a leg that runs (almost)
  // a whole turn from the joint, and is never trimmed.
  for (const [circleId, circle] of circles) {
    if (circle.linked) continue;
    for (const [end, adjacent] of neighbors) {
      if (end.linked || adjacent.length !== 0) continue;
      const reach = Math.hypot(
        end.position.x - circle.center.x,
        end.position.y - circle.center.y
      );
      if (Math.abs(reach - circle.radius) > JOINT_TOLERANCE) continue;
      const angle = Math.atan2(
        end.position.y - circle.center.y,
        end.position.x - circle.center.x
      );
      const sweep = TAU - 1e-6;
      for (const way of ['ccw', 'cw'] as const) {
        const leg: FilletLeg = {
          kind: 'arc',
          at: end.position,
          center: circle.center,
          radius: circle.radius,
          startRad: way === 'ccw' ? angle : angle - sweep,
          sweepRad: sweep,
          end: way === 'ccw' ? 'start' : 'end'
        };
        // The two corners share their joint; each marker sits a little way
        // into its own corner so either can be picked.
        const along = way === 'ccw' ? 1 : -1;
        const tangent = {
          x: -Math.sin(angle) * along,
          y: Math.cos(angle) * along
        };
        const toFar = subtract(end.far, end.position);
        const farLength = Math.hypot(toFar.x, toFar.y) || 1;
        const bisector = {
          x: tangent.x + toFar.x / farLength,
          y: tangent.y + toFar.y / farLength
        };
        const size = Math.hypot(bisector.x, bisector.y);
        if (size <= 1e-9) continue;
        // Far enough apart that the two markers never cover each other.
        const nudge = 0.45 * Math.min(circle.radius, farLength);
        const point = {
          x: end.position.x + (bisector.x / size) * nudge,
          y: end.position.y + (bisector.y / size) * nudge
        };
        const ref = {
          objectId: circleId,
          point: way === 'ccw' ? 'start' : 'end'
        } as LineEndRef;
        const id = JSON.stringify([
          [end.ref.objectId, end.ref.point],
          [circleId, way]
        ]);
        corners.set(id, {
          corner: { id, point, a: end.ref, b: ref },
          geometry: { corner: end.position, farA: end.far, farB: point },
          legs: [{ ...end.leg, at: end.position }, leg],
          curved: true,
          circleLeg: circleId
        });
      }
    }
  }
  return corners;
}

/**
 * Finds the selectable, unbranched corners of the resolved sketch: where two
 * lines, a line and an arc, or two arcs meet end to end (S05 arc inputs),
 * leaving out smooth continuations.
 */
export function listSketchFilletCorners(
  document: ProjectDocument,
  sketch: SketchNode,
  resolve: ResolveParam
): SketchFilletCorner[] {
  return [
    ...catalogCorners(
      sourceLines(document, sketch, resolve),
      sourceArcs(document, sketch, resolve),
      sourceCircles(document, sketch, resolve)
    ).values()
  ].map(({ corner }) => corner);
}

function remainingSpan(source: SourceLine, line: LineEnds): number {
  const axis = subtract(source.end, source.start);
  const remaining = subtract(line.end, line.start);
  return (
    (axis.x / source.length) * remaining.x +
    (axis.y / source.length) * remaining.y
  );
}

function trim(
  lines: Map<EntityId, SketchFilletBatchLine>,
  base: ReadonlyMap<EntityId, SourceLine>,
  ref: LineEndRef,
  point: Sketch2dPoint,
  cornerId: string
): void {
  const line = lines.get(ref.objectId) ?? {
    objectId: ref.objectId,
    start: base.get(ref.objectId)!.start,
    end: base.get(ref.objectId)!.end
  };
  line[ref.point] = point;
  if (ref.point === 'start') line.startCornerId = cornerId;
  else line.endCornerId = cornerId;
  lines.set(ref.objectId, line);
}

/** Computes the combined trim and arc geometry before issuing any commands or IDs. */
export function planSketchFilletBatch(
  document: ProjectDocument,
  sketch: SketchNode,
  corners: readonly string[],
  radius: number,
  resolve: ResolveParam
): SketchFilletBatchPlan {
  const cornerIds = [...new Set(corners)].sort();
  if (cornerIds.length === 0) {
    return {
      status: 'refuse',
      reason: 'Select at least one fillet corner.',
      lineIds: [],
      cornerIds
    };
  }
  const unit = displayLengthName(document.units);
  const lengthLabel = (length: number) =>
    `${Number(length.toPrecision(6))} ${unit}`;
  if (!Number.isFinite(radius) || radius <= 0) {
    return {
      status: 'refuse',
      reason: `Enter a positive fillet radius in ${unit}.`,
      lineIds: [],
      cornerIds
    };
  }
  const base = sourceLines(document, sketch, resolve);
  const baseArcs = sourceArcs(document, sketch, resolve);
  const catalog = catalogCorners(
    base,
    baseArcs,
    sourceCircles(document, sketch, resolve)
  );
  const circleCorners = new Map<string, EntityId>();
  const lines = new Map<EntityId, SketchFilletBatchLine>();
  const trimmedArcs = new Map<
    EntityId,
    { start: number; end: number; startCornerId?: string; endCornerId?: string }
  >();
  const trimEnd = (ref: LineEndRef, point: Sketch2dPoint, cornerId: string) => {
    if (base.has(ref.objectId)) {
      trim(lines, base, ref, point, cornerId);
      return;
    }
    const arc = baseArcs.get(ref.objectId)!;
    const entry = trimmedArcs.get(ref.objectId) ?? {
      start: arc.startRad,
      end: arc.startRad + arc.sweepRad
    };
    const angle = Math.atan2(point.y - arc.center.y, point.x - arc.center.x);
    // Measure each cut as how far it runs into the arc from its own end, so
    // two cuts on a long arc are compared along the arc itself, never across
    // an angle wrap: what is left is the sweep less both cuts.
    if (ref.point === 'start') {
      entry.start =
        arc.startRad + ((((angle - arc.startRad) % TAU) + TAU) % TAU);
      entry.startCornerId = cornerId;
    } else {
      const end = arc.startRad + arc.sweepRad;
      entry.end = end - ((((end - angle) % TAU) + TAU) % TAU);
      entry.endCornerId = cornerId;
    }
    trimmedArcs.set(ref.objectId, entry);
  };
  const arcs: SketchFilletBatchArc[] = [];
  // One fillet per curve end: a joint on a circle offers a corner each way
  // round, and rounding both would cut the same end twice.
  const usedEnds = new Map<string, string>();
  for (const id of cornerIds) {
    const entry = catalog.get(id);
    for (const ref of entry ? [entry.corner.a, entry.corner.b] : []) {
      if (entry?.circleLeg === ref.objectId) continue;
      const key = endpointKey(ref);
      const other = usedEnds.get(key);
      if (other !== undefined) {
        return {
          status: 'refuse',
          reason:
            'Two selected corners round the same end. Pick one side of the joint.',
          lineIds: [ref.objectId],
          cornerIds: [other, id]
        };
      }
      usedEnds.set(key, id);
    }
    if (!entry) {
      return {
        status: 'refuse',
        reason: 'A selected corner no longer joins two sketch curves.',
        lineIds: [],
        cornerIds: [id]
      };
    }
    const { corner, geometry, legs, curved, circleLeg } = entry;
    if (circleLeg) circleCorners.set(id, circleLeg);
    let fillet: SketchFilletGeometry;
    try {
      fillet = curved
        ? filletCurvedCorner(legs[0], legs[1], radius)
        : filletSketchCorner(geometry, radius);
      const sweep = fillet.endAngleDeg - fillet.startAngleDeg;
      if (!(sweep > 0 && sweep < 180)) {
        throw new Error('The arc is too small to resolve at this corner.');
      }
    } catch (error) {
      return {
        status: 'refuse',
        reason:
          `Radius ${lengthLabel(radius)} does not fit this corner. ${error instanceof Error ? error.message : ''}`.trim(),
        lineIds: [corner.a.objectId, corner.b.objectId],
        cornerIds: [id]
      };
    }
    trimEnd(corner.a, fillet.a, id);
    // A circle is never cut: the fillet only comes to touch it.
    if (!circleLeg) trimEnd(corner.b, fillet.b, id);
    arcs.push({ corner, ...fillet, ...(circleLeg ? { circleLeg } : {}) });
  }
  // An arc cut back from both ends must keep some of its sweep.
  for (const [objectId, trimmed] of trimmedArcs) {
    if (trimmed.end - trimmed.start <= 1e-9) {
      return {
        status: 'refuse',
        reason: `Radius ${lengthLabel(radius)} uses up a whole arc. Use a smaller radius.`,
        lineIds: [objectId],
        cornerIds: [trimmed.startCornerId, trimmed.endCornerId].filter(
          (id): id is string => id !== undefined
        )
      };
    }
  }

  const conflicts = [...lines.values()].flatMap((line) => {
    const source = base.get(line.objectId)!;
    const span = remainingSpan(source, line);
    return span <= JOINT_TOLERANCE
      ? [{ line, span, length: source.length }]
      : [];
  });
  if (conflicts.length > 0) {
    const worst = conflicts.reduce((a, b) => (a.span <= b.span ? a : b));
    const length = lengthLabel(worst.length);
    const detail =
      worst.span < -JOINT_TOLERANCE
        ? `overlaps the trims by ${lengthLabel(-worst.span)} on a ${length} line`
        : `leaves no straight segment on a ${length} line`;
    return {
      status: 'refuse',
      reason: `Radius ${lengthLabel(radius)} ${detail}. Use a smaller radius.`,
      lineIds: conflicts.map(({ line }) => line.objectId),
      cornerIds: [
        ...new Set(
          conflicts.flatMap(({ line }) =>
            [line.startCornerId, line.endCornerId].filter(
              (id) => id !== undefined
            )
          )
        )
      ]
    };
  }
  for (const { data } of sketch.constraints ?? []) {
    if (data.constraintKind === 'lock') {
      const line = lines.get(data.point.objectId);
      const end = data.point.point;
      if (!line || (end !== 'start' && end !== 'end')) continue;
      const cornerId = end === 'start' ? line.startCornerId : line.endCornerId;
      if (cornerId && !sameSketchPoint(line[end], data)) {
        return {
          status: 'refuse',
          reason:
            'A selected corner has a locked endpoint. Unlock it before applying the fillet.',
          lineIds: [line.objectId],
          cornerIds: [cornerId]
        };
      }
    }
    if (
      data.constraintKind === 'distance' &&
      data.a.objectId === data.b.objectId &&
      ((data.a.point === 'start' && data.b.point === 'end') ||
        (data.a.point === 'end' && data.b.point === 'start'))
    ) {
      const line = lines.get(data.a.objectId);
      const wanted = resolve(data.value);
      if (!line || wanted === undefined || !Number.isFinite(wanted)) continue;
      const length = Math.hypot(
        line.end.x - line.start.x,
        line.end.y - line.start.y
      );
      if (Math.abs(length - wanted) > JOINT_TOLERANCE) {
        return {
          status: 'refuse',
          reason: `A driving dimension holds this line at ${lengthLabel(wanted)}. Change or remove the dimension before applying the fillet.`,
          lineIds: [line.objectId],
          cornerIds: [line.startCornerId, line.endCornerId].filter(
            (id) => id !== undefined
          )
        };
      }
    }
  }
  for (const { data } of sketch.constraints ?? []) {
    if (data.constraintKind !== 'lock') continue;
    const trimmed = trimmedArcs.get(data.point.objectId);
    const cornerId =
      data.point.point === 'start'
        ? trimmed?.startCornerId
        : data.point.point === 'end'
          ? trimmed?.endCornerId
          : undefined;
    if (cornerId) {
      return {
        status: 'refuse',
        reason:
          'A selected corner has a locked endpoint. Unlock it before applying the fillet.',
        lineIds: [data.point.objectId],
        cornerIds: [cornerId]
      };
    }
  }
  return {
    status: 'ready',
    lines: [...lines.values()],
    arcs,
    trimmedArcs: [...trimmedArcs].map(([objectId, trimmed]) => {
      const arc = baseArcs.get(objectId)!;
      return {
        objectId,
        center: arc.center,
        radius: arc.radius,
        startAngleDeg: (trimmed.start * 180) / Math.PI,
        endAngleDeg: (trimmed.end * 180) / Math.PI,
        ...(trimmed.startCornerId
          ? { startCornerId: trimmed.startCornerId }
          : {}),
        ...(trimmed.endCornerId ? { endCornerId: trimmed.endCornerId } : {})
      };
    })
  };
}

/** Preserve the planned sketch up to the same slack used to recognize joints. */
export function sketchFilletCandidateRefusal(
  candidate: ProjectDocument,
  sketchId: SketchId,
  outcome: Parameters<typeof solvedSketchCommands>[2]
): string | null {
  if (!outcome.converged || outcome.rolledBack)
    return solveStatusLabel(outcome);
  return solvedSketchCommands(candidate, sketchId, outcome, JOINT_TOLERANCE)
    .length
    ? 'A constraint would move the rounded sketch. Edit the conflicting constraints before applying the fillet.'
    : null;
}

function lineData(document: ProjectDocument, objectId: EntityId): LineData {
  const node = document.nodes[objectId];
  if (node?.kind !== 'sketch-object' || node.data.objectKind !== 'line') {
    throw new Error('A filleted object is no longer a line in this sketch.');
  }
  return node.data;
}

function trimmedLineData(
  document: ProjectDocument,
  { objectId, start, end, startCornerId, endCornerId }: SketchFilletBatchLine
): LineData {
  const data = lineData(document, objectId);
  return {
    ...data,
    x1: startCornerId || typeof data.x1 === 'number' ? start.x : data.x1,
    y1: startCornerId || typeof data.y1 === 'number' ? start.y : data.y1,
    x2: endCornerId || typeof data.x2 === 'number' ? end.x : data.x2,
    y2: endCornerId || typeof data.y2 === 'number' ? end.y : data.y2
  };
}

/**
 * Keep a centered rectangle's own diagonals on their retained coincidence
 * targets. Starting the solver from the old diagonals can pull the entire
 * underconstrained outline away from the fillet preview.
 */
function seedRectangleDiagonals(
  document: ProjectDocument,
  sketch: SketchNode,
  plan: ReadySketchFilletBatchPlan,
  updates: Map<EntityId, LineData>
): void {
  const helpers = new Set(
    (sketch.composites ?? []).flatMap((composite) =>
      composite.compositeKind === 'rectangle' && composite.method === 'center'
        ? (composite.helperIds ?? [])
        : []
    )
  );
  if (helpers.size === 0) return;
  const trimmed = new Map(
    plan.arcs.flatMap(
      (arc) =>
        [
          [endpointKey(arc.corner.a), arc.a],
          [endpointKey(arc.corner.b), arc.b]
        ] as const
    )
  );
  for (const { data } of sketch.constraints ?? []) {
    if (data.constraintKind !== 'coincident') continue;
    const [helper, edge] = helpers.has(data.a.objectId)
      ? [data.a, data.b]
      : [data.b, data.a];
    if (
      !helpers.has(helper.objectId) ||
      helper.point === 'center' ||
      edge.point === 'center'
    )
      continue;
    const target = trimmed.get(endpointKey(edge));
    if (!target) continue;
    const seed =
      updates.get(helper.objectId) ?? lineData(document, helper.objectId);
    updates.set(helper.objectId, movedLine(seed, helper.point, target));
  }
}

/** Builds one atomic command list for a ready plan on its original document. */
export function sketchFilletBatchCommands(
  document: ProjectDocument,
  sketch: SketchNode,
  readyPlan: ReadySketchFilletBatchPlan,
  storedRadius: ParamValue
): AnyCommand[] {
  const { sketchId } = sketch;
  const updates = new Map(
    readyPlan.lines.map((line) => [
      line.objectId,
      trimmedLineData(document, line)
    ])
  );
  seedRectangleDiagonals(document, sketch, readyPlan, updates);
  const arcUpdates = readyPlan.trimmedArcs.map((trimmed) => {
    const node = document.nodes[trimmed.objectId];
    if (node?.kind !== 'sketch-object' || node.data.objectKind !== 'arc') {
      throw new Error('A filleted object is no longer an arc in this sketch.');
    }
    return commandFactories.updateSketchObject(
      {
        sketchId,
        objectId: trimmed.objectId,
        data: {
          ...node.data,
          startAngleDeg: trimmed.startCornerId
            ? trimmed.startAngleDeg
            : node.data.startAngleDeg,
          endAngleDeg: trimmed.endCornerId
            ? trimmed.endAngleDeg
            : node.data.endAngleDeg
        }
      },
      'Trim arc to fillet'
    );
  });
  return [
    ...readyPlan.arcs.flatMap(({ corner: { a, b }, circleLeg }) =>
      circleLeg
        ? // The end leaves the circle for its tangency: what held it on
          // the circle goes.
          (sketch.constraints ?? []).flatMap(({ constraintId, data }) =>
            data.constraintKind === 'point-on-object' &&
            data.objectId === circleLeg &&
            data.point.objectId === a.objectId &&
            data.point.point === a.point
              ? [
                  commandFactories.deleteSketchConstraint(
                    { sketchId, constraintId },
                    'Release the filleted corner'
                  )
                ]
              : []
          )
        : deleteCornerCoincidenceCommands(
            sketch,
            sketchId,
            a,
            b,
            'Release the filleted corner'
          )
    ),
    ...[...updates].map(([objectId, data]) =>
      commandFactories.updateSketchObject(
        { sketchId, objectId, data },
        data.construction ? 'Align rectangle diagonal' : 'Trim line to fillet'
      )
    ),
    ...arcUpdates,
    ...readyPlan.arcs.flatMap((arc) =>
      addFilletCornerCommands(
        sketchId,
        arc.corner.a,
        arc.corner.b,
        arc,
        storedRadius,
        arc.circleLeg !== undefined
      )
    )
  ];
}
