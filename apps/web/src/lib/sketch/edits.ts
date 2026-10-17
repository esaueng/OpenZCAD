/**
 * Pure logic behind the sketch rail's modify tools — fillet, chamfer and
 * offset on the kernel's 2D operations, plus the app-side Trim, Mirror and
 * patterns in `./modify`. What each tool needs picked, which picks it refuses and why, and
 * how a kernel answer becomes the one transaction that replaces the geometry
 * and re-states what the solver knows about it.
 *
 * No React, no kernel, no document mutation: App owns the picking flow and
 * the worker call, tests own this file. The geometry itself comes from
 * `@openzcad/kernel-adapter`'s 2D sketch operations.
 */
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import type {
  Sketch2dPoint,
  SketchChamferGeometry,
  SketchFilletGeometry,
  SketchOffsetCurve,
  SketchPlanarOperation,
  SketchPlanarResult
} from '@openzcad/kernel-adapter/exact';
import type { SketchEditToolKind } from '../interaction/machine';
import {
  planSketchCircularPattern,
  planSketchLinearPattern,
  planSketchMirror,
  planSketchTrim,
  resolvePatternPivot,
  type Point2,
  type SketchModifyPlan
} from './modify';
import {
  createId,
  toEntityId,
  type EntityId,
  type ParamValue,
  type ProjectDocument,
  type SketchConstraintId,
  type SketchId,
  type SketchNode,
  type SketchObjectData,
  type SketchPointRef
} from '@openzcad/shared';

export type { SketchEditToolKind };

/** What a keypad step measures; a count is a plain whole number. */
export type SketchEditValueUnit = 'length' | 'angle' | 'count';

export interface SketchEditToolSpec {
  kind: SketchEditToolKind;
  label: string;
  /** How many picks complete the tool. */
  picks: 1 | 2;
  /** Instruction shown while the tool is armed. */
  hint: string;
  /** What the keypad asks for once the picks are in (kernel tools). */
  valueLabel?: string;
}

export const SKETCH_EDIT_TOOL_SPECS: readonly SketchEditToolSpec[] = [
  {
    kind: 'fillet',
    label: 'Fillet',
    picks: 2,
    hint: 'Click two lines that meet, then enter the radius.',
    valueLabel: 'Fillet radius'
  },
  {
    kind: 'chamfer',
    label: 'Chamfer',
    picks: 2,
    hint: 'Click two lines that meet, then enter the setback.',
    valueLabel: 'Chamfer distance'
  },
  {
    kind: 'offset',
    label: 'Offset',
    picks: 1,
    hint: 'Click one line of a closed loop, then enter the distance.',
    valueLabel: 'Offset distance'
  },
  {
    kind: 'trim',
    label: 'Trim',
    picks: 1,
    hint: 'Click the part of a line, arc or circle to remove. It is cut back to the nearest crossings; Escape finishes.'
  },
  {
    kind: 'mirror',
    label: 'Mirror',
    picks: 2,
    hint: 'Click a line, arc or circle, then the line to mirror it about.'
  },
  {
    kind: 'linear-pattern',
    label: 'Linear pattern',
    picks: 2,
    hint: 'Click the entity to repeat, then a line for the direction. Then enter the spacing and the count.'
  },
  {
    kind: 'circular-pattern',
    label: 'Circular pattern',
    picks: 2,
    hint: 'Click the entity to repeat, then a circle or arc (or snap to a line end) for the pivot. Then enter the count and the angle.'
  }
] as const;

/** The modify tools that run on the kernel's 2D operations. */
function kernelTool(
  kind: SketchEditToolKind
): kind is 'fillet' | 'chamfer' | 'offset' {
  return kind === 'fillet' || kind === 'chamfer' || kind === 'offset';
}

export function sketchEditToolSpec(
  kind: SketchEditToolKind
): SketchEditToolSpec {
  const spec = SKETCH_EDIT_TOOL_SPECS.find((entry) => entry.kind === kind);
  if (!spec) {
    throw new Error(`Unknown sketch modify tool "${kind}".`);
  }
  return spec;
}

/** Resolves a `ParamValue`, or undefined when its expression does not. */
export type ResolveParam = (value: ParamValue) => number | undefined;

/**
 * Matching tolerance for "these two entities share this point", in model
 * units. Sketch endpoints that meet were snapped together or solved together,
 * so they agree to far better than this; a micron of slack only keeps a
 * solved-then-rounded joint from reading as a gap.
 */
const JOINT_TOLERANCE = 1e-6;

function sketchObjectData(
  document: ProjectDocument,
  sketch: SketchNode,
  objectId: string
): SketchObjectData | null {
  if (!sketch.objectIds.includes(objectId as EntityId)) {
    return null;
  }
  const node = document.nodes[objectId as EntityId];
  return node?.kind === 'sketch-object' ? node.data : null;
}

/**
 * Composite sketch objects have no stable point identity: a rectangle's
 * corners, a polygon's vertices, and a glyph's outline are derived from the
 * object's own parameters every rebuild, so nothing in them can carry a
 * constraint. Modifying one of their corners would produce geometry the
 * solver could never hold together, so the tools refuse them by name.
 */
const COMPOSITE_REFUSALS: Partial<
  Record<SketchObjectData['objectKind'], string>
> = {
  rectangle:
    'A rectangle is one object, and its corners carry no constraints. Draw the profile as lines to modify a corner.',
  polygon:
    'A polygon is one object, and its corners carry no constraints. Draw the profile as lines to modify a corner.',
  text: 'Text is one object with no constrainable outline points.'
};

/**
 * Validate one pick against the armed modify tool before it joins the pending
 * sequence. Returns the refusal to show, or null when the pick is legal.
 */
export function refuseEditPick(
  document: ProjectDocument,
  sketch: SketchNode,
  kind: SketchEditToolKind,
  existing: readonly string[],
  objectId: string,
  pivotSnapped = false
): string | null {
  const spec = sketchEditToolSpec(kind);
  if (existing.length >= spec.picks) {
    return `${spec.label} already has all of its picks.`;
  }
  // A circular pattern may turn an entity about its own snapped end.
  if (
    existing.includes(objectId) &&
    !(kind === 'circular-pattern' && existing.length === 1 && pivotSnapped)
  ) {
    return 'That entity is already part of this operation.';
  }
  const data = sketchObjectData(document, sketch, objectId);
  if (!data) {
    return 'That object is not part of this sketch.';
  }
  const composite = COMPOSITE_REFUSALS[data.objectKind];
  if (composite) {
    return composite;
  }
  if (!kernelTool(kind)) {
    if (
      existing.length === 1 &&
      (kind === 'mirror' || kind === 'linear-pattern') &&
      data.objectKind !== 'line'
    ) {
      return kind === 'mirror'
        ? 'Mirror reflects about a line. Pick a line as the mirror.'
        : 'A linear pattern runs along a line. Pick a line for its direction.';
    }
    return null;
  }
  if (data.objectKind === 'line') {
    return null;
  }
  if (data.objectKind === 'arc') {
    return kind === 'offset'
      ? 'Offset works on a closed loop of lines; this loop contains an arc.'
      : `${spec.label} between an arc and another entity is not available yet. Pick two lines.`;
  }
  return kind === 'offset'
    ? 'Offset works on a closed loop of lines. Pick one of its lines.'
    : `${spec.label} needs two lines that meet at a corner.`;
}

interface LineEnds {
  start: Sketch2dPoint;
  end: Sketch2dPoint;
}

function lineEnds(
  data: SketchObjectData,
  resolve: ResolveParam
): LineEnds | null {
  if (data.objectKind !== 'line') {
    return null;
  }
  const x1 = resolve(data.x1);
  const y1 = resolve(data.y1);
  const x2 = resolve(data.x2);
  const y2 = resolve(data.y2);
  if (
    x1 === undefined ||
    y1 === undefined ||
    x2 === undefined ||
    y2 === undefined
  ) {
    return null;
  }
  return { start: { x: x1, y: y1 }, end: { x: x2, y: y2 } };
}

function samePoint(a: Sketch2dPoint, b: Sketch2dPoint): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= JOINT_TOLERANCE;
}

/** The corner two picked lines share, in the shape the kernel operations take. */
export interface SketchCornerResolution {
  corner: Sketch2dPoint;
  farA: Sketch2dPoint;
  farB: Sketch2dPoint;
  /** Which endpoint of the first line sits at the corner. */
  aPoint: 'start' | 'end';
  bPoint: 'start' | 'end';
}

export type SketchCornerResult =
  { corner: SketchCornerResolution } | { error: string };

/** Find the endpoint two picked lines share, or say why there is not one. */
export function resolveSketchCorner(
  document: ProjectDocument,
  sketch: SketchNode,
  aId: string,
  bId: string,
  resolve: ResolveParam
): SketchCornerResult {
  const aData = sketchObjectData(document, sketch, aId);
  const bData = sketchObjectData(document, sketch, bId);
  if (!aData || !bData) {
    return { error: 'That object is not part of this sketch.' };
  }
  const a = lineEnds(aData, resolve);
  const b = lineEnds(bData, resolve);
  if (!a || !b) {
    return {
      error: 'The selected lines have a dimension that does not evaluate.'
    };
  }
  const pairs = [
    ['start', 'start'],
    ['start', 'end'],
    ['end', 'start'],
    ['end', 'end']
  ] as const;
  const match = pairs.find(([aEnd, bEnd]) => samePoint(a[aEnd], b[bEnd]));
  if (!match) {
    return {
      error:
        'Those two lines do not meet at an endpoint. Join them first — this tool does not extend geometry.'
    };
  }
  const [aPoint, bPoint] = match;
  return {
    corner: {
      corner: a[aPoint],
      farA: a[aPoint === 'start' ? 'end' : 'start'],
      farB: b[bPoint === 'start' ? 'end' : 'start'],
      aPoint,
      bPoint
    }
  };
}

function movedLine(
  data: Extract<SketchObjectData, { objectKind: 'line' }>,
  point: 'start' | 'end',
  to: Sketch2dPoint
): SketchObjectData {
  return point === 'start'
    ? { ...data, x1: to.x, y1: to.y }
    : { ...data, x2: to.x, y2: to.y };
}

function requireLine(
  document: ProjectDocument,
  sketch: SketchNode,
  objectId: string
): Extract<SketchObjectData, { objectKind: 'line' }> {
  const data = sketchObjectData(document, sketch, objectId);
  if (!data || data.objectKind !== 'line') {
    throw new Error('That object is no longer a line in this sketch.');
  }
  return data;
}

/**
 * Constraints that tied the two trimmed endpoints straight to each other. The
 * corner they described is gone, so they go with it; the new arc or bevel
 * re-states the joint as two coincidences at its own ends.
 */
function cornerCoincidenceIds(
  sketch: SketchNode,
  a: SketchPointRef,
  b: SketchPointRef
): SketchConstraintId[] {
  const matches = (ref: SketchPointRef, target: SketchPointRef) =>
    ref.objectId === target.objectId && ref.point === target.point;
  return (sketch.constraints ?? [])
    .filter((constraint) => {
      const data = constraint.data;
      return (
        data.constraintKind === 'coincident' &&
        ((matches(data.a, a) && matches(data.b, b)) ||
          (matches(data.a, b) && matches(data.b, a)))
      );
    })
    .map((constraint) => constraint.constraintId);
}

function newEntityId(): EntityId {
  return toEntityId(createId('ent'));
}

/**
 * The one transaction a sketch fillet is: both lines trimmed back to their
 * tangent points, the arc added, the joint restated.
 *
 * The arc is not loose geometry that happens to sit in the gap. It gets point
 * identity in the constraint graph — a coincidence at each end and a tangency
 * to each line at that same point, plus the radius the user asked for — so
 * the next solve moves it with the lines instead of leaving it behind.
 */
export function sketchFilletCommands(
  document: ProjectDocument,
  sketch: SketchNode,
  sketchId: SketchId,
  picks: { a: string; b: string },
  resolution: SketchCornerResolution,
  fillet: SketchFilletGeometry,
  radius: ParamValue
): AnyCommand[] {
  const aData = requireLine(document, sketch, picks.a);
  const bData = requireLine(document, sketch, picks.b);
  const arcId = newEntityId();
  const aRef: SketchPointRef = {
    objectId: picks.a as EntityId,
    point: resolution.aPoint
  };
  const bRef: SketchPointRef = {
    objectId: picks.b as EntityId,
    point: resolution.bPoint
  };
  const arcPointForA = fillet.startsAt === 'a' ? 'start' : 'end';
  const arcPointForB = fillet.startsAt === 'a' ? 'end' : 'start';
  const arcRefA: SketchPointRef = { objectId: arcId, point: arcPointForA };
  const arcRefB: SketchPointRef = { objectId: arcId, point: arcPointForB };
  return [
    ...cornerCoincidenceIds(sketch, aRef, bRef).map((constraintId) =>
      commandFactories.deleteSketchConstraint(
        { sketchId, constraintId },
        'Release the filleted corner'
      )
    ),
    commandFactories.updateSketchObject(
      {
        sketchId,
        objectId: picks.a as EntityId,
        data: movedLine(aData, resolution.aPoint, fillet.a)
      },
      'Trim line to fillet'
    ),
    commandFactories.updateSketchObject(
      {
        sketchId,
        objectId: picks.b as EntityId,
        data: movedLine(bData, resolution.bPoint, fillet.b)
      },
      'Trim line to fillet'
    ),
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
    commandFactories.addSketchConstraint(
      {
        sketchId,
        constraint: { constraintKind: 'coincident', a: aRef, b: arcRefA }
      },
      'Join fillet to line'
    ),
    commandFactories.addSketchConstraint(
      {
        sketchId,
        constraint: { constraintKind: 'coincident', a: bRef, b: arcRefB }
      },
      'Join fillet to line'
    ),
    commandFactories.addSketchConstraint(
      {
        sketchId,
        constraint: {
          constraintKind: 'tangent',
          a: picks.a as EntityId,
          b: arcId,
          at: arcRefA
        }
      },
      'Hold the fillet tangent'
    ),
    commandFactories.addSketchConstraint(
      {
        sketchId,
        constraint: {
          constraintKind: 'tangent',
          a: picks.b as EntityId,
          b: arcId,
          at: arcRefB
        }
      },
      'Hold the fillet tangent'
    ),
    commandFactories.addSketchConstraint(
      {
        sketchId,
        constraint: {
          constraintKind: 'radius',
          objectId: arcId,
          value: radius
        }
      },
      'Drive the fillet radius'
    )
  ];
}

/**
 * The one transaction a sketch chamfer is: both lines trimmed back to the
 * kernel's setback points and a bevel line between them, joined to each by a
 * coincidence so the corner stays a corner through the next solve.
 */
export function sketchChamferCommands(
  document: ProjectDocument,
  sketch: SketchNode,
  sketchId: SketchId,
  picks: { a: string; b: string },
  resolution: SketchCornerResolution,
  chamfer: SketchChamferGeometry
): AnyCommand[] {
  const aData = requireLine(document, sketch, picks.a);
  const bData = requireLine(document, sketch, picks.b);
  const bevelId = newEntityId();
  const aRef: SketchPointRef = {
    objectId: picks.a as EntityId,
    point: resolution.aPoint
  };
  const bRef: SketchPointRef = {
    objectId: picks.b as EntityId,
    point: resolution.bPoint
  };
  return [
    ...cornerCoincidenceIds(sketch, aRef, bRef).map((constraintId) =>
      commandFactories.deleteSketchConstraint(
        { sketchId, constraintId },
        'Release the chamfered corner'
      )
    ),
    commandFactories.updateSketchObject(
      {
        sketchId,
        objectId: picks.a as EntityId,
        data: movedLine(aData, resolution.aPoint, chamfer.a)
      },
      'Trim line to chamfer'
    ),
    commandFactories.updateSketchObject(
      {
        sketchId,
        objectId: picks.b as EntityId,
        data: movedLine(bData, resolution.bPoint, chamfer.b)
      },
      'Trim line to chamfer'
    ),
    commandFactories.addSketchObjects(
      {
        sketchId,
        objects: [
          {
            objectKind: 'line',
            x1: chamfer.a.x,
            y1: chamfer.a.y,
            x2: chamfer.b.x,
            y2: chamfer.b.y
          }
        ],
        ids: { objectNodeIds: [bevelId] }
      },
      'Add chamfer bevel'
    ),
    commandFactories.addSketchConstraint(
      {
        sketchId,
        constraint: {
          constraintKind: 'coincident',
          a: aRef,
          b: { objectId: bevelId, point: 'start' }
        }
      },
      'Join chamfer to line'
    ),
    commandFactories.addSketchConstraint(
      {
        sketchId,
        constraint: {
          constraintKind: 'coincident',
          a: bRef,
          b: { objectId: bevelId, point: 'end' }
        }
      },
      'Join chamfer to line'
    )
  ];
}

/** A closed run of sketch lines, in loop order. */
export interface SketchLoopResolution {
  objectIds: EntityId[];
  points: Sketch2dPoint[];
}

export type SketchLoopResult =
  { loop: SketchLoopResolution } | { error: string };

/**
 * Walk the closed loop of lines that contains the picked one.
 *
 * Straight-sided and closed, both deliberately: the kernel's planar wire
 * offset works on the wire's vertex polygon, so an arc anywhere in the source
 * would be silently straightened and an open chain silently closed. Both are
 * refused here rather than offset into something the user did not draw.
 */
export function resolveSketchLoop(
  document: ProjectDocument,
  sketch: SketchNode,
  seedId: string,
  resolve: ResolveParam
): SketchLoopResult {
  const seed = sketchObjectData(document, sketch, seedId);
  if (!seed) {
    return { error: 'That object is not part of this sketch.' };
  }
  if (seed.objectKind !== 'line') {
    return {
      error: 'Offset works on a closed loop of lines. Pick one of its lines.'
    };
  }
  const lines = new Map<EntityId, LineEnds>();
  for (const objectId of sketch.objectIds) {
    const data = sketchObjectData(document, sketch, objectId);
    if (!data) {
      continue;
    }
    const ends = lineEnds(data, resolve);
    if (ends) {
      lines.set(objectId, ends);
    }
  }
  const seedEnds = lines.get(seedId as EntityId);
  if (!seedEnds) {
    return {
      error: 'The selected line has a dimension that does not evaluate.'
    };
  }
  const objectIds: EntityId[] = [seedId as EntityId];
  const points: Sketch2dPoint[] = [seedEnds.start];
  let currentId = seedId as EntityId;
  let frontier = seedEnds.end;
  while (!samePoint(frontier, seedEnds.start)) {
    const joined = [...lines].filter(
      ([objectId, ends]) =>
        objectId !== currentId &&
        (samePoint(ends.start, frontier) || samePoint(ends.end, frontier))
    );
    if (joined.length === 0) {
      return {
        error:
          'That run of lines is not closed. Offset needs a closed loop; close the profile first.'
      };
    }
    if (joined.length > 1) {
      return {
        error:
          'More than two lines meet on that loop, so the offset has no single path to follow.'
      };
    }
    const [nextId, nextEnds] = joined[0]!;
    if (objectIds.includes(nextId)) {
      return {
        error:
          'That run of lines is not closed. Offset needs a closed loop; close the profile first.'
      };
    }
    objectIds.push(nextId);
    points.push(frontier);
    currentId = nextId;
    frontier = samePoint(nextEnds.start, frontier)
      ? nextEnds.end
      : nextEnds.start;
  }
  if (points.length < 3) {
    return { error: 'An offset needs a closed loop of at least three lines.' };
  }
  return { loop: { objectIds, points } };
}

function offsetCurveObject(curve: SketchOffsetCurve): SketchObjectData {
  return curve.kind === 'line'
    ? {
        objectKind: 'line',
        x1: curve.a.x,
        y1: curve.a.y,
        x2: curve.b.x,
        y2: curve.b.y
      }
    : {
        objectKind: 'arc',
        centerX: curve.center.x,
        centerY: curve.center.y,
        radius: curve.radius,
        startAngleDeg: curve.startAngleDeg,
        endAngleDeg: curve.endAngleDeg
      };
}

function offsetCurveEnds(curve: SketchOffsetCurve): LineEnds {
  if (curve.kind === 'line') {
    return { start: curve.a, end: curve.b };
  }
  const at = (angleDeg: number): Sketch2dPoint => {
    const angle = (angleDeg * Math.PI) / 180;
    return {
      x: curve.center.x + Math.cos(angle) * curve.radius,
      y: curve.center.y + Math.sin(angle) * curve.radius
    };
  };
  return { start: at(curve.startAngleDeg), end: at(curve.endAngleDeg) };
}

/**
 * The one transaction a sketch offset is: every offset curve added, then
 * chained end to end with coincidences so the new loop is a loop the solver
 * knows about rather than a set of curves that happen to touch.
 */
export function sketchOffsetCommands(
  sketchId: SketchId,
  curves: readonly SketchOffsetCurve[]
): AnyCommand[] {
  const ids = curves.map(() => newEntityId());
  const commands: AnyCommand[] = [
    commandFactories.addSketchObjects(
      {
        sketchId,
        objects: curves.map(offsetCurveObject),
        ids: { objectNodeIds: ids }
      },
      'Add offset geometry'
    )
  ];
  const ends = curves.map(offsetCurveEnds);
  for (let index = 0; index < curves.length; index += 1) {
    const nextIndex = (index + 1) % curves.length;
    const current = ends[index]!;
    const next = ends[nextIndex]!;
    const currentPoint = samePoint(current.end, next.start)
      ? ('end' as const)
      : samePoint(current.end, next.end)
        ? ('end' as const)
        : ('start' as const);
    const nextPoint = samePoint(current[currentPoint], next.start)
      ? ('start' as const)
      : ('end' as const);
    if (!samePoint(current[currentPoint], next[nextPoint])) {
      continue;
    }
    commands.push(
      commandFactories.addSketchConstraint(
        {
          sketchId,
          constraint: {
            constraintKind: 'coincident',
            a: { objectId: ids[index]!, point: currentPoint },
            b: { objectId: ids[nextIndex]!, point: nextPoint }
          }
        },
        'Join the offset loop'
      )
    );
  }
  return commands;
}

/** One value a finished pick sequence still needs from the keypad. */
export interface SketchEditValueStep {
  label: string;
  unitKind: SketchEditValueUnit;
  initial: number;
  message: string;
}

/** Where the click landed, for the tools that need more than an entity. */
export interface SketchEditPickContext {
  /** The click on the sketch plane, unsnapped. Trim cuts the segment here. */
  at?: Point2 | null;
  /** The named point the click snapped to, when it had one. */
  snapPoint?: { objectId: string; point: 'start' | 'end' | 'center' } | null;
}

/**
 * What one pick against an armed modify tool means, in the pieces the app has
 * to act on. Keeping the decision here rather than in `App` keeps the tools
 * out of the entry chunk, which has only a few hundred spare bytes.
 */
export type SketchEditPickOutcome =
  /** The pick is illegal; show the reason and change nothing. */
  | { status: 'refuse'; reason: string }
  /** The click hit nothing; re-state the hint and change nothing. */
  | { status: 'hint'; message: string }
  /** The pick is accepted and the tool wants more. */
  | { status: 'pick'; message: string }
  /** The picks are complete; ask for the value, prefilled with `initial`. */
  | ({ status: 'value'; picks: string[] } & SketchEditValueStep)
  /** The picks are complete and the tool needs no value: run it now. */
  | { status: 'run'; picks: string[] };

function lineLength(
  document: ProjectDocument,
  sketch: SketchNode,
  objectId: string,
  resolve: ResolveParam
): number | null {
  const data = sketchObjectData(document, sketch, objectId);
  const ends = data ? lineEnds(data, resolve) : null;
  return ends
    ? Math.hypot(ends.end.x - ends.start.x, ends.end.y - ends.start.y)
    : null;
}

function roundPrefill(value: number): number {
  return Math.max(Math.round(value * 1000) / 1000, 0.001);
}

/**
 * The keypad steps a finished pick sequence asks for, in order, or why the
 * picks cannot be completed. The geometry precondition is checked here, so a
 * corner that does not exist or a loop that is not closed is refused before
 * the user types anything.
 */
export function sketchEditValueSteps(
  document: ProjectDocument,
  sketch: SketchNode,
  kind: SketchEditToolKind,
  picks: readonly string[],
  resolve: ResolveParam
): SketchEditValueStep[] | { error: string } {
  const spec = sketchEditToolSpec(kind);
  switch (kind) {
    case 'trim':
    case 'mirror':
      return [];
    case 'linear-pattern': {
      const length = lineLength(document, sketch, picks[1]!, resolve);
      if (length === null || length === 0) {
        return {
          error: 'The direction line has a dimension that does not evaluate.'
        };
      }
      return [
        {
          label: 'Pattern spacing',
          unitKind: 'length',
          initial: roundPrefill(length),
          message: `${spec.label}: enter the spacing along the line, start to end.`
        },
        {
          label: 'Pattern count',
          unitKind: 'count',
          initial: 3,
          message: `${spec.label}: enter how many instances, the source included.`
        }
      ];
    }
    case 'circular-pattern': {
      const pivot = resolvePatternPivot(document, sketch, picks[1]!, resolve);
      if ('error' in pivot) {
        return { error: pivot.error };
      }
      return [
        {
          label: 'Pattern count',
          unitKind: 'count',
          initial: 6,
          message: `${spec.label}: enter how many instances, the source included.`
        },
        {
          label: 'Pattern angle',
          unitKind: 'angle',
          initial: 360,
          message: `${spec.label}: enter the total angle. 360° spaces them evenly.`
        }
      ];
    }
    case 'offset': {
      const loop = resolveSketchLoop(document, sketch, picks[0]!, resolve);
      if ('error' in loop) {
        return { error: loop.error };
      }
      return [
        {
          label: spec.valueLabel!,
          unitKind: 'length',
          initial: 1,
          message: `${spec.label}: enter the distance. Positive is outward.`
        }
      ];
    }
    default: {
      const resolved = resolveSketchCorner(
        document,
        sketch,
        picks[0]!,
        picks[1]!,
        resolve
      );
      if ('error' in resolved) {
        return { error: resolved.error };
      }
      // A quarter of the shorter leg always fits, so the prefill is a value
      // the tool will accept rather than one it has to refuse.
      const { corner, farA, farB } = resolved.corner;
      const shortest = Math.min(
        Math.hypot(farA.x - corner.x, farA.y - corner.y),
        Math.hypot(farB.x - corner.x, farB.y - corner.y)
      );
      return [
        {
          label: spec.valueLabel!,
          unitKind: 'length',
          initial: roundPrefill(shortest / 4),
          message: `${spec.label}: enter the value.`
        }
      ];
    }
  }
}

/**
 * Validate one pick and say what it completes. A circular pattern's pivot
 * pick carries the snapped point as `objectId#point`, so a line end can be
 * the pivot.
 */
export function advanceSketchEditPick(
  document: ProjectDocument,
  sketch: SketchNode,
  kind: SketchEditToolKind,
  existing: readonly string[],
  objectId: string | null,
  resolve: ResolveParam,
  context: SketchEditPickContext = {}
): SketchEditPickOutcome {
  const spec = sketchEditToolSpec(kind);
  // A centre is not on its drawn curve, so a pivot snapped to one arrives
  // with no hit object; the snap names it instead.
  if (!objectId && kind === 'circular-pattern' && existing.length === 1) {
    objectId = context.snapPoint?.objectId ?? null;
  }
  if (!objectId || (kind === 'trim' && !context.at)) {
    return { status: 'hint', message: spec.hint };
  }
  const snapped =
    context.snapPoint?.objectId === objectId ? context.snapPoint.point : null;
  const pivotPick =
    kind === 'circular-pattern' && existing.length === 1 && snapped;
  const refusal = refuseEditPick(
    document,
    sketch,
    kind,
    existing,
    objectId,
    Boolean(pivotPick)
  );
  if (refusal) {
    return { status: 'refuse', reason: refusal };
  }
  const picks = [...existing, pivotPick ? `${objectId}#${snapped}` : objectId];
  if (picks.length < spec.picks) {
    return {
      status: 'pick',
      message: `${spec.label}: pick ${picks.length + 1} of ${spec.picks}.`
    };
  }
  const steps = sketchEditValueSteps(document, sketch, kind, picks, resolve);
  if ('error' in steps) {
    return { status: 'refuse', reason: steps.error };
  }
  const first = steps[0];
  return first
    ? { status: 'value', picks, ...first }
    : { status: 'run', picks };
}

/** A modify tool ready to run, or the reason it cannot. */
export type SketchEditPlan =
  | { status: 'refuse'; reason: string }
  | {
      status: 'operation';
      /** What to ask the kernel. */
      operation: SketchPlanarOperation;
      /** Transaction label, and the name the status line uses. */
      label: string;
      /** The kernel's answer, turned into the one transaction it becomes. */
      commit(result: SketchPlanarResult): AnyCommand[];
    }
  /** An app-side tool: the commands are already the whole transaction. */
  | Extract<SketchModifyPlan, { status: 'commands' }>;

/**
 * Turn a finished pick sequence plus its values into the kernel request and
 * the commands its answer becomes, or straight into commands for the
 * app-side tools. `values` and `raws` are the keypad steps in order.
 */
export function planSketchEdit(
  document: ProjectDocument,
  sketch: SketchNode,
  sketchId: SketchId,
  kind: SketchEditToolKind,
  picks: readonly string[],
  value: number | readonly number[],
  raw: string,
  resolve: ResolveParam,
  at?: Point2
): SketchEditPlan {
  const spec = sketchEditToolSpec(kind);
  const values = typeof value === 'number' ? [value] : value;
  if (picks.length !== spec.picks) {
    return {
      status: 'refuse',
      reason: `${spec.label} needs ${spec.picks} pick(s).`
    };
  }
  if (kind === 'trim') {
    return at
      ? planSketchTrim(document, sketch, sketchId, picks[0]!, at, resolve)
      : { status: 'refuse', reason: spec.hint };
  }
  if (kind === 'mirror') {
    return planSketchMirror(
      document,
      sketch,
      sketchId,
      picks[0]!,
      picks[1]!,
      resolve
    );
  }
  if (kind === 'linear-pattern') {
    return planSketchLinearPattern(
      document,
      sketch,
      sketchId,
      picks[0]!,
      picks[1]!,
      values[0]!,
      values[1]!,
      resolve
    );
  }
  if (kind === 'circular-pattern') {
    const pivot = resolvePatternPivot(document, sketch, picks[1]!, resolve);
    if ('error' in pivot) {
      return { status: 'refuse', reason: pivot.error };
    }
    return planSketchCircularPattern(
      document,
      sketch,
      sketchId,
      picks[0]!,
      pivot.pivot,
      values[0]!,
      values[1]!,
      resolve
    );
  }
  const amount = values[0]!;
  if (kind === 'offset') {
    const loop = resolveSketchLoop(document, sketch, picks[0]!, resolve);
    if ('error' in loop) {
      return { status: 'refuse', reason: loop.error };
    }
    return {
      status: 'operation',
      label: spec.label,
      operation: {
        kind: 'offset',
        loop: loop.loop.points,
        distance: amount,
        join: 'arc'
      },
      commit: (result) => {
        if (result.kind !== 'offset') {
          throw new Error('The kernel answered a different operation.');
        }
        return sketchOffsetCommands(sketchId, result.curves);
      }
    };
  }
  const resolved = resolveSketchCorner(
    document,
    sketch,
    picks[0]!,
    picks[1]!,
    resolve
  );
  if ('error' in resolved) {
    return { status: 'refuse', reason: resolved.error };
  }
  const corner = resolved.corner;
  const pair = { a: picks[0]!, b: picks[1]! };
  if (kind === 'chamfer') {
    return {
      status: 'operation',
      label: spec.label,
      operation: { kind: 'chamfer', corner, distance: amount },
      commit: (result) => {
        if (result.kind !== 'chamfer') {
          throw new Error('The kernel answered a different operation.');
        }
        return sketchChamferCommands(
          document,
          sketch,
          sketchId,
          pair,
          corner,
          result.chamfer
        );
      }
    };
  }
  // An expression stays parametric in the radius it drives.
  const storedRadius: ParamValue = Number.isFinite(Number(raw)) ? amount : raw;
  return {
    status: 'operation',
    label: spec.label,
    operation: { kind: 'fillet', corner, radius: amount },
    commit: (result) => {
      if (result.kind !== 'fillet') {
        throw new Error('The kernel answered a different operation.');
      }
      return sketchFilletCommands(
        document,
        sketch,
        sketchId,
        pair,
        corner,
        result.fillet,
        storedRadius
      );
    }
  };
}

/** The keypad steps already answered for a multi-value tool. */
export interface SketchEditAnswers {
  values: number[];
  raws: string[];
}

/**
 * What the app hands the modify tools so they can drive one operation.
 *
 * The driver below lives here rather than in `App` for a budget reason as
 * much as a design one: `App.tsx` is the entry chunk and has a few hundred
 * spare bytes, while everything in this module is reached only through the
 * lazily loaded sketch rail.
 */
export interface SketchEditHost {
  setStatus(message: string): void;
  setError(message: string | null): void;
  setBusy(busy: boolean): void;
  /** Resolve a stored dimension against the document's parameter scope. */
  resolve: ResolveParam;
  /** Take one more pick for the armed tool. */
  addPick(objectId: string): void;
  /**
   * The picks are in: ask for the next value and remember the sequence and
   * the steps already answered. Disarms the tool.
   */
  askValue(
    kind: SketchEditToolKind,
    picks: string[],
    label: string,
    initial: string,
    step?: { unitKind: SketchEditValueUnit } & SketchEditAnswers
  ): void;
  /** Put the armed tool down without asking for anything. */
  disarm(): void;
  runOperation(operation: SketchPlanarOperation): Promise<SketchPlanarResult>;
  /** Apply the commands as one undoable transaction; false if it was dropped. */
  commit(
    sketchId: SketchId,
    commands: AnyCommand[],
    label: string
  ): Promise<boolean>;
  describeFailure(error: unknown, fallback: string): string;
}

/** Route one viewport pick into the armed modify tool. */
export function advanceSketchEdit(
  host: SketchEditHost,
  document: ProjectDocument,
  sketch: SketchNode,
  pending: { kind: SketchEditToolKind; picks: string[] },
  objectId: string | null,
  context: SketchEditPickContext = {}
): void {
  const outcome = advanceSketchEditPick(
    document,
    sketch,
    pending.kind,
    pending.picks,
    objectId,
    host.resolve,
    context
  );
  if (outcome.status === 'refuse') {
    host.setStatus(outcome.reason);
    return;
  }
  if (outcome.status === 'hint') {
    host.setStatus(outcome.message);
    return;
  }
  if (outcome.status === 'pick') {
    host.addPick(objectId!);
    host.setStatus(outcome.message);
    return;
  }
  if (outcome.status === 'run') {
    // Trim stays armed: each click is its own trim, and Escape puts it
    // down. Mirror is one operation, like the kernel tools.
    if (pending.kind !== 'trim') {
      host.disarm();
    }
    void runSketchEdit(
      host,
      document,
      sketch,
      pending.kind,
      outcome.picks,
      0,
      '',
      undefined,
      context.at ?? undefined
    );
    return;
  }
  host.askValue(
    pending.kind,
    outcome.picks,
    outcome.label,
    String(outcome.initial),
    { unitKind: outcome.unitKind, values: [], raws: [] }
  );
  host.setStatus(outcome.message);
}

/**
 * Run one finished modify tool: ask for the next value if the tool has more
 * steps, else ask the kernel (for the kernel tools) and commit the answer as
 * one transaction.
 */
export async function runSketchEdit(
  host: SketchEditHost,
  document: ProjectDocument,
  sketch: SketchNode,
  kind: SketchEditToolKind,
  picks: readonly string[],
  value: number,
  raw: string,
  earlier?: Partial<SketchEditAnswers>,
  at?: Point2
): Promise<void> {
  const steps = sketchEditValueSteps(
    document,
    sketch,
    kind,
    picks,
    host.resolve
  );
  if ('error' in steps) {
    host.setStatus(steps.error);
    return;
  }
  const values = steps.length === 0 ? [] : [...(earlier?.values ?? []), value];
  const raws = steps.length === 0 ? [] : [...(earlier?.raws ?? []), raw];
  const next = steps[values.length];
  if (next) {
    host.askValue(kind, [...picks], next.label, String(next.initial), {
      unitKind: next.unitKind,
      values,
      raws
    });
    host.setStatus(next.message);
    return;
  }
  const plan = planSketchEdit(
    document,
    sketch,
    sketch.sketchId,
    kind,
    picks,
    values,
    raws[0] ?? raw,
    host.resolve,
    at
  );
  if (plan.status === 'refuse') {
    host.setStatus(plan.reason);
    return;
  }
  host.setBusy(true);
  host.setError(null);
  host.setStatus(`Building the ${plan.label.toLowerCase()}…`);
  try {
    if (plan.status === 'commands') {
      if (await host.commit(sketch.sketchId, plan.commands, plan.label)) {
        host.setStatus(plan.message);
      }
      return;
    }
    const result = await host.runOperation(plan.operation);
    if (await host.commit(sketch.sketchId, plan.commit(result), plan.label)) {
      host.setStatus(`${plan.label} applied.`);
    }
  } catch (error) {
    const message = host.describeFailure(
      error,
      `The ${plan.label.toLowerCase()} could not be built.`
    );
    host.setError(message);
    host.setStatus(message);
  } finally {
    host.setBusy(false);
  }
}
