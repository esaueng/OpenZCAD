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
}

export interface ReadySketchFilletBatchPlan {
  status: 'ready';
  lines: readonly SketchFilletBatchLine[];
  arcs: readonly SketchFilletBatchArc[];
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
  far: Sketch2dPoint;
  linked: boolean;
}

// A narrow x band can still contain a whole sketch's endpoints, including
// ones far apart in y. Bound candidate work as well as stored neighbors.
const MAX_ENDPOINT_PAIR_CHECKS = 1_000_000;

class SketchFilletCatalogLimitError extends Error {
  constructor() {
    super(
      'This sketch has too many nearby endpoints to check safely. Split it into smaller sketches before using Sketch Fillet.'
    );
  }
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

function catalogCorners(lines: ReadonlyMap<EntityId, SourceLine>): Map<
  string,
  {
    corner: SketchFilletCorner;
    geometry: SketchCorner;
  }
> {
  const endpoints: Endpoint[] = [];
  for (const [objectId, line] of lines) {
    endpoints.push(
      {
        ref: { objectId, point: 'start' },
        position: line.start,
        far: line.end,
        linked: line.linked
      },
      {
        ref: { objectId, point: 'end' },
        position: line.end,
        far: line.start,
        linked: line.linked
      }
    );
  }
  endpoints.sort((a, b) => a.position.x - b.position.x);
  // Only a unique neighbor can form a corner. Keep that one, or null once
  // the endpoint is branched; retaining the entire branch is unnecessary.
  const neighbors = new Map<Endpoint, Endpoint | null>();
  let pairChecks = 0;
  for (const [index, a] of endpoints.entries()) {
    for (let next = index + 1; next < endpoints.length; next += 1) {
      const b = endpoints[next]!;
      if (b.position.x - a.position.x > JOINT_TOLERANCE) break;
      if (++pairChecks > MAX_ENDPOINT_PAIR_CHECKS) {
        throw new SketchFilletCatalogLimitError();
      }
      if (
        a.ref.objectId === b.ref.objectId ||
        !sameSketchPoint(a.position, b.position)
      )
        continue;
      neighbors.set(a, neighbors.has(a) ? null : b);
      neighbors.set(b, neighbors.has(b) ? null : a);
    }
  }

  const corners = new Map<
    string,
    { corner: SketchFilletCorner; geometry: SketchCorner }
  >();
  for (const a of endpoints) {
    const b = neighbors.get(a);
    if (a.linked || !b || b.linked || neighbors.get(b) !== a) continue;
    if (endpointKey(a.ref) >= endpointKey(b.ref)) continue;
    const point = jointPoint(a, b);
    if (!point) continue;
    const id = JSON.stringify([
      [a.ref.objectId, a.ref.point],
      [b.ref.objectId, b.ref.point]
    ]);
    corners.set(id, {
      corner: { id, point, a: a.ref, b: b.ref },
      geometry: { corner: point, farA: a.far, farB: b.far }
    });
  }
  return corners;
}

/**
 * Finds the selectable, unbranched line-to-line corners of the resolved
 * sketch. Refuses excessive candidate work rather than returning a partial
 * catalog that could reinterpret a branched endpoint as a corner.
 */
export function listSketchFilletCorners(
  document: ProjectDocument,
  sketch: SketchNode,
  resolve: ResolveParam
): SketchFilletCorner[] {
  return [
    ...catalogCorners(sourceLines(document, sketch, resolve)).values()
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
  let catalog: ReturnType<typeof catalogCorners>;
  try {
    catalog = catalogCorners(base);
  } catch (error) {
    if (!(error instanceof SketchFilletCatalogLimitError)) throw error;
    return {
      status: 'refuse',
      reason: error.message,
      lineIds: [],
      cornerIds
    };
  }
  const lines = new Map<EntityId, SketchFilletBatchLine>();
  const arcs: SketchFilletBatchArc[] = [];
  for (const id of cornerIds) {
    const entry = catalog.get(id);
    if (!entry) {
      return {
        status: 'refuse',
        reason: 'A selected corner no longer joins two sketch lines.',
        lineIds: [],
        cornerIds: [id]
      };
    }
    const { corner, geometry } = entry;
    let fillet: SketchFilletGeometry;
    try {
      fillet = filletSketchCorner(geometry, radius);
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
    trim(lines, base, corner.a, fillet.a, id);
    trim(lines, base, corner.b, fillet.b, id);
    arcs.push({ corner, ...fillet });
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
  return { status: 'ready', lines: [...lines.values()], arcs };
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
  return [
    ...readyPlan.arcs.flatMap(({ corner: { a, b } }) =>
      deleteCornerCoincidenceCommands(
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
    ...readyPlan.arcs.flatMap((arc) =>
      addFilletCornerCommands(
        sketchId,
        arc.corner.a,
        arc.corner.b,
        arc,
        storedRadius
      )
    )
  ];
}
