/**
 * Pure logic behind the sketch rail's modify tools — fillet and chamfer on
 * the kernel's 2D operations, plus the app-side Trim, Mirror and patterns in
 * `./modify` and Offset in `./offset`. What each tool needs picked, which picks it refuses and why, and
 * how a kernel answer becomes the one transaction that replaces the geometry
 * and re-states what the solver knows about it.
 *
 * No React, no kernel, no document mutation: App owns the picking flow and
 * the worker call, tests own this file. The geometry itself comes from
 * `@openzcad/kernel-adapter`'s 2D sketch operations.
 */
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import { resolvedSketchDocument } from '@openzcad/document-core';
import { retainSketchGeometryCommands } from './releaseGeometry';
import {
  addFilletCornerCommands,
  deleteCornerCoincidenceCommands,
  lineEnds,
  movedLine,
  sameSketchPoint,
  type ResolveParam
} from './cornerEditCommands';
import type {
  Sketch2dPoint,
  SketchChamferGeometry,
  SketchFilletGeometry,
  SketchPlanarOperation,
  SketchPlanarResult
} from '@openzcad/kernel-adapter/exact';
import type {
  SketchEditToolKind,
  SketchModifyOptions,
  SketchOffsetOptions,
  SketchPatternOrientation,
  SketchPatternSpacing
} from '../interaction/machine';
import {
  planSketchCircularPattern,
  planSketchLinearPattern,
  planSketchExtend,
  planSketchMirror,
  planSketchMirrorSet,
  planSketchPatternSet,
  planSketchTrim,
  resolvePatternPivot,
  settleOptionalRelations,
  type Point2,
  type SketchModifyPlan,
  type SketchRankProbe
} from './modify';
import {
  chamferHasCurvedLeg,
  curvedCornerPrefill,
  planCurvedChamfer,
  resolveCurvedCorner
} from './curveChamfer';
import {
  DEFAULT_SKETCH_OFFSET_OPTIONS,
  offsetClickSide,
  offsetFollowsClick,
  planSketchOffset,
  resolveOffsetSource,
  type SketchOffsetPick
} from './offset';
import {
  createId,
  toEntityId,
  type EntityId,
  type ParamValue,
  type ProjectDocument,
  type SketchId,
  type SketchNode,
  type SketchObjectData,
  type SketchPointRef
} from '@openzcad/shared';

export type {
  SketchEditToolKind,
  SketchModifyOptions,
  SketchOffsetOptions,
  SketchOffsetPick
};

/**
 * The pattern settings in force when a pattern's picks completed, carried to
 * its value steps and its plan so a change mid-entry cannot reinterpret the
 * values already typed.
 */
export interface SketchPatternOptions {
  spacing: SketchPatternSpacing;
  orientation: SketchPatternOrientation;
}

function patternOptions(
  options: SketchModifyOptions | undefined
): SketchPatternOptions {
  return {
    spacing: options?.patternSpacing ?? 'spacing',
    orientation: options?.patternOrientation ?? 'rotate'
  };
}

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
    hint: 'Click two lines or arcs that meet, then enter the setback.',
    valueLabel: 'Chamfer distance'
  },
  {
    kind: 'offset',
    label: 'Offset',
    picks: 1,
    hint: 'Click a line, arc or circle on the side to offset towards, then enter the distance. Chain follows the curves joined to it.',
    valueLabel: 'Offset distance'
  },
  {
    kind: 'trim',
    label: 'Trim',
    picks: 1,
    hint: 'Click the part of a line, arc or circle to remove. It is cut back to the nearest crossings; Escape finishes.'
  },
  {
    kind: 'extend',
    label: 'Extend',
    picks: 1,
    hint: 'Click a line or arc near the end to lengthen. It runs on to the first curve in its way; Escape finishes.'
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
    hint: 'Click the entity to repeat, then a line for the direction. Then enter the spacing (or the extent) and the count.'
  },
  {
    kind: 'circular-pattern',
    label: 'Circular pattern',
    picks: 2,
    hint: 'Click the entity to repeat, then a circle or arc (or snap to a line end) for the pivot. Then enter the count and the angle.'
  }
] as const;

/** The modify tools that run on the kernel's 2D operations. */
function kernelTool(kind: SketchEditToolKind): kind is 'fillet' | 'chamfer' {
  return kind === 'fillet' || kind === 'chamfer';
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

export type { ResolveParam } from './cornerEditCommands';

function sketchObjectData(
  document: ProjectDocument,
  sketch: SketchNode,
  objectId: string
): SketchObjectData | null {
  if (!sketch.objectIds.includes(objectId as EntityId)) {
    return null;
  }
  const node = resolvedSketchDocument(document).nodes[objectId as EntityId];
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
  text: 'Text is one object with no constrainable outline points.',
  ellipse:
    'Modify tools work on lines, arcs and circles; they do not take an ellipse yet.',
  spline:
    'Modify tools work on lines, arcs and circles; they do not take a spline yet.',
  point: 'Modify tools work on lines, arcs and circles; a point has no curve.'
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
  // A circular pattern may turn an entity about its own snapped end, and a
  // line may run a linear pattern along itself.
  if (
    existing.includes(objectId) &&
    !(
      existing.length === 1 &&
      ((kind === 'circular-pattern' && pivotSnapped) ||
        kind === 'linear-pattern')
    )
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
  // A fillet or chamfer cuts back the picked lines themselves.
  if (kernelTool(kind) && data.projection?.mode === 'linked') {
    return `A linked projection follows its model edge; unlink it to ${spec.label.toLowerCase()} it.`;
  }
  if (kind === 'offset') {
    return data.objectKind === 'line' ||
      data.objectKind === 'arc' ||
      data.objectKind === 'circle'
      ? null
      : 'Offset works on lines, arcs and circles.';
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
  // S05: Chamfer cuts arcs and meets circles here. The Fillet tool rounds
  // them from its corner markers; this kernel path takes lines only.
  if (
    kind === 'chamfer' &&
    (data.objectKind === 'arc' || data.objectKind === 'circle')
  ) {
    return null;
  }
  if (data.objectKind === 'arc') {
    return `${spec.label} between an arc and another entity is not available yet. Pick two lines.`;
  }
  return `${spec.label} needs two lines that meet at a corner.`;
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
  const match = pairs.find(([aEnd, bEnd]) => sameSketchPoint(a[aEnd], b[bEnd]));
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
  const aRef: SketchPointRef = {
    objectId: picks.a as EntityId,
    point: resolution.aPoint
  };
  const bRef: SketchPointRef = {
    objectId: picks.b as EntityId,
    point: resolution.bPoint
  };
  return [
    ...deleteCornerCoincidenceCommands(
      sketch,
      sketchId,
      aRef,
      bRef,
      'Release the filleted corner'
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
    ...addFilletCornerCommands(sketchId, aRef, bRef, fillet, radius)
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
    ...deleteCornerCoincidenceCommands(
      sketch,
      sketchId,
      aRef,
      bRef,
      'Release the chamfered corner'
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
  /** The modify tools' settings when the click landed; absent is the default. */
  options?: SketchModifyOptions;
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
  | ({
      status: 'value';
      picks: string[];
      /** What an Offset pick carries to its value step. */
      offset?: SketchOffsetPick;
      /** What a pattern's picks carry to its value steps. */
      pattern?: SketchPatternOptions;
    } & SketchEditValueStep)
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
  resolve: ResolveParam,
  offset?: SketchOffsetPick,
  pattern?: SketchPatternOptions
): SketchEditValueStep[] | { error: string } {
  const spec = sketchEditToolSpec(kind);
  switch (kind) {
    case 'trim':
    case 'extend':
    case 'mirror':
      return [];
    case 'linear-pattern': {
      const length = lineLength(document, sketch, picks[1]!, resolve);
      if (length === null || length === 0) {
        return {
          error: 'The direction line has a dimension that does not evaluate.'
        };
      }
      // An extent prefilled with the line's length spreads the instances
      // along it; a spacing prefilled with it steps them a line apart.
      return [
        pattern?.spacing === 'extent'
          ? {
              label: 'Pattern extent',
              unitKind: 'length',
              initial: roundPrefill(length),
              message: `${spec.label}: enter the distance from the source to the last instance, along the line start to end.`
            }
          : {
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
      const resolved = resolveOffsetSource(
        document,
        sketch,
        picks[0]!,
        (offset ?? DEFAULT_SKETCH_OFFSET_OPTIONS).chain,
        resolve
      );
      if ('error' in resolved) {
        return { error: resolved.error };
      }
      return [
        {
          label: spec.valueLabel!,
          unitKind: 'length',
          initial: 1,
          message: `${spec.label}: enter the distance. ${
            offsetFollowsClick(resolved.source)
              ? 'Positive goes to the side you clicked.'
              : 'Positive is outward.'
          }`
        }
      ];
    }
    default: {
      if (
        kind === 'chamfer' &&
        chamferHasCurvedLeg(document, sketch, picks[0]!, picks[1]!)
      ) {
        const curved = resolveCurvedCorner(
          document,
          sketch,
          picks[0]!,
          picks[1]!,
          resolve
        );
        if ('error' in curved) {
          return { error: curved.error };
        }
        return [
          {
            label: spec.valueLabel!,
            unitKind: 'length',
            initial: roundPrefill(curvedCornerPrefill(curved.legs)),
            message: `${spec.label}: enter the value.`
          }
        ];
      }
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
  // The pivot is a point, so the active snap names it, over whatever curve
  // the click also hit: a centre is not on its drawn curve at all, and a
  // line crossing a centre would otherwise win the pick.
  if (
    kind === 'circular-pattern' &&
    existing.length === 1 &&
    context.snapPoint
  ) {
    objectId = context.snapPoint.objectId;
  }
  if (!objectId || ((kind === 'trim' || kind === 'extend') && !context.at)) {
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
  // S05: a circle a Chamfer meets is kept whole, so which way round the
  // bevel goes is the side of the joint that was clicked.
  const circleSide =
    kind === 'chamfer' &&
    context.at &&
    sketchObjectData(document, sketch, objectId)?.objectKind === 'circle'
      ? `${objectId}@${context.at.x},${context.at.y}`
      : null;
  const picks = [
    ...existing,
    pivotPick ? `${objectId}#${snapped}` : (circleSide ?? objectId)
  ];
  if (picks.length < spec.picks) {
    return {
      status: 'pick',
      message: `${spec.label}: pick ${picks.length + 1} of ${spec.picks}.`
    };
  }
  const join = context.options?.join ?? DEFAULT_SKETCH_OFFSET_OPTIONS.join;
  const chain = context.options?.chain ?? DEFAULT_SKETCH_OFFSET_OPTIONS.chain;
  const offset: SketchOffsetPick | undefined =
    kind === 'offset'
      ? {
          join,
          chain,
          side: offsetClickSide(document, sketch, objectId, context.at, resolve)
        }
      : undefined;
  const pattern =
    kind === 'linear-pattern' || kind === 'circular-pattern'
      ? patternOptions(context.options)
      : undefined;
  const steps = sketchEditValueSteps(
    document,
    sketch,
    kind,
    picks,
    resolve,
    offset,
    pattern
  );
  if ('error' in steps) {
    return { status: 'refuse', reason: steps.error };
  }
  const first = steps[0];
  return first
    ? {
        status: 'value',
        picks,
        ...first,
        ...(offset ? { offset } : {}),
        ...(pattern ? { pattern } : {})
      }
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
  at?: Point2,
  offset?: SketchOffsetPick,
  pattern?: SketchPatternOptions,
  sources?: readonly string[]
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
  if (kind === 'extend') {
    return at
      ? planSketchExtend(document, sketch, sketchId, picks[0]!, at, resolve)
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
  if (
    (kind === 'linear-pattern' || kind === 'circular-pattern') &&
    sources?.length
  ) {
    const pivot =
      kind === 'circular-pattern'
        ? resolvePatternPivot(document, sketch, picks[1]!, resolve)
        : null;
    if (pivot && 'error' in pivot) {
      return { status: 'refuse', reason: pivot.error };
    }
    return planSketchPatternSet(
      document,
      sketch,
      sketchId,
      sources,
      kind === 'linear-pattern'
        ? {
            kind,
            directionId: picks[1]!,
            distance: values[0]!,
            count: values[1]!,
            spacingMode: pattern?.spacing ?? 'spacing'
          }
        : {
            kind,
            pivot: pivot!.pivot,
            pivotRef: pivot!.ref,
            count: values[0]!,
            totalDeg: values[1]!,
            orientation: pattern?.orientation ?? 'rotate'
          },
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
      resolve,
      pattern?.spacing
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
      resolve,
      pattern?.orientation,
      pivot.ref
    );
  }
  const amount = values[0]!;
  if (kind === 'offset') {
    return planSketchOffset(
      document,
      sketch,
      sketchId,
      picks[0]!,
      amount,
      offset ?? { ...DEFAULT_SKETCH_OFFSET_OPTIONS, side: 1 },
      resolve
    );
  }
  if (
    kind === 'chamfer' &&
    chamferHasCurvedLeg(document, sketch, picks[0]!, picks[1]!)
  ) {
    return planCurvedChamfer(
      document,
      sketch,
      sketchId,
      picks[0]!,
      picks[1]!,
      amount,
      resolve
    );
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
  /** The Offset pick's settings and side, carried to its value step. */
  offset?: SketchOffsetPick;
  /** A pattern's settings when its picks completed, carried to its steps. */
  pattern?: SketchPatternOptions;
  /** A pattern armed over a selection: every entity it repeats. */
  sources?: readonly string[];
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
  /** Solve a prospective document's sketch; judges optional relations. */
  solveSketch(
    document: ProjectDocument,
    sketchId: SketchId
  ): Promise<SketchRankProbe>;
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
  pending: {
    kind: SketchEditToolKind;
    picks: string[];
    sources?: readonly string[];
  },
  objectId: string | null,
  context: SketchEditPickContext = {}
): void {
  if (pending.kind === 'mirror' && pending.sources?.length) {
    // Armed over a selection: this one pick is the axis.
    if (!objectId) {
      host.setStatus(sketchMirrorSetHint(pending.sources.length));
      return;
    }
    host.disarm();
    void commitSketchEditPlan(
      host,
      document,
      sketch,
      'mirror',
      planSketchMirrorSet(
        document,
        sketch,
        sketch.sketchId,
        pending.sources,
        objectId,
        host.resolve
      )
    );
    return;
  }
  // A pattern armed over a selection takes only its direction or pivot: the
  // first selected entity that is still there stands in as the source pick,
  // and the whole selection rides along to the plan.
  const patternSet =
    (pending.kind === 'linear-pattern' ||
      pending.kind === 'circular-pattern') &&
    pending.sources?.length
      ? pending.sources.filter((id) =>
          sketch.objectIds.includes(id as EntityId)
        )
      : null;
  if (patternSet && patternSet.length === 0) {
    host.disarm();
    host.setStatus(
      'The selected entities are no longer in the sketch. Select what to repeat, then pick the tool again.'
    );
    return;
  }
  // The stand-in is a selected entity other than the one this click names
  // (directly or by its snapped point), so a selected circle can still be
  // the pivot the rest of the selection turns about.
  const clicked = new Set([objectId, context.snapPoint?.objectId ?? null]);
  const standIn = patternSet
    ? (patternSet.find((id) => !clicked.has(id)) ?? patternSet[0]!)
    : null;
  const outcome = advanceSketchEditPick(
    document,
    sketch,
    pending.kind,
    standIn ? [standIn] : pending.picks,
    objectId,
    host.resolve,
    context
  );
  if (outcome.status === 'hint' && patternSet) {
    host.setStatus(
      sketchPatternSetHint(
        pending.kind as 'linear-pattern' | 'circular-pattern',
        patternSet.length
      )
    );
    return;
  }
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
    // Trim and Extend stay armed: each click is its own edit, and Escape
    // puts them down. Mirror is one operation, like the kernel tools.
    if (pending.kind !== 'trim' && pending.kind !== 'extend') {
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
    {
      unitKind: outcome.unitKind,
      values: [],
      raws: [],
      ...(outcome.offset ? { offset: outcome.offset } : {}),
      ...(outcome.pattern ? { pattern: outcome.pattern } : {}),
      ...(patternSet ? { sources: patternSet } : {})
    }
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
  const offset = earlier?.offset;
  const pattern = earlier?.pattern;
  const sources = earlier?.sources;
  const steps = sketchEditValueSteps(
    document,
    sketch,
    kind,
    picks,
    host.resolve,
    offset,
    pattern
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
      raws,
      ...(offset ? { offset } : {}),
      ...(pattern ? { pattern } : {}),
      ...(sources ? { sources } : {})
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
    at,
    offset,
    pattern,
    sources
  );
  await commitSketchEditPlan(host, document, sketch, kind, plan);
}

/** What a pattern asks for once it is armed over `count` selected entities. */
export function sketchPatternSetHint(
  kind: 'linear-pattern' | 'circular-pattern',
  count: number
): string {
  const what =
    count === 1 ? 'the selected entity' : `${count} selected entities`;
  return kind === 'linear-pattern'
    ? `Linear pattern: click a line for the direction to repeat ${what} along. Then enter the spacing (or the extent) and the count.`
    : `Circular pattern: click a circle or arc (or snap to a line end) for the pivot to repeat ${what} about. Then enter the count and the angle.`;
}

/** What Mirror asks for once it is armed over `count` selected entities. */
export function sketchMirrorSetHint(count: number): string {
  return `Mirror: click the line to mirror the ${count === 1 ? 'selected entity' : `${count} selected entities`} about.`;
}

/** Commit one planned modify tool as a single transaction, or say why not. */
async function commitSketchEditPlan(
  host: SketchEditHost,
  document: ProjectDocument,
  sketch: SketchNode,
  kind: SketchEditToolKind,
  plan: SketchEditPlan
): Promise<void> {
  if (plan.status === 'refuse') {
    host.setStatus(plan.reason);
    return;
  }
  host.setBusy(true);
  host.setError(null);
  host.setStatus(`Building the ${plan.label.toLowerCase()}…`);
  try {
    if (plan.status === 'commands') {
      const commands = await settleOptionalRelations(
        document,
        sketch.sketchId,
        kind === 'trim' || kind === 'extend'
          ? [
              ...retainSketchGeometryCommands(document, sketch.sketchId),
              ...plan.commands
            ]
          : plan.commands,
        plan.optional ?? [],
        host.solveSketch
      );
      if (await host.commit(sketch.sketchId, commands, plan.label)) {
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
