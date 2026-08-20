import type {
  EntityId,
  SketchConstraint,
  SketchPointRef
} from '@openzcad/shared';

/**
 * Document sketch → kernel GCS mapping.
 *
 * The kernel's constraint solver works on points, lines, circles, and arcs
 * addressed by dense per-sketch handles; the document stores self-contained
 * parametric objects addressed by `EntityId`. This module owns the mapping
 * between the two — deterministic per solve (objects are added in the
 * caller-supplied order), so constraint references never dangle within a
 * call, and rebuilt from scratch on every solve, so nothing here persists.
 *
 * Kept free of any kernel import so it can be exercised against a stub,
 * like `body-properties.ts`.
 */

/** The kernel surface a solve needs, narrowed for stubbing. */
export interface GcsKernelSurface {
  gcsNew(): number;
  gcsAddPoint(sketch: number, x: number, y: number, fixed: boolean): number;
  gcsAddLine(sketch: number, p1: number, p2: number): number;
  gcsAddCircle(sketch: number, center: number, radius: number): number;
  gcsAddArc(
    sketch: number,
    center: number,
    start: number,
    end: number
  ): number;
  gcsAddConstraint(sketch: number, json: string): number;
  gcsSolveDetailed(
    sketch: number,
    maxIterations: number,
    tolerance: number
  ): unknown;
  gcsPointPosition(sketch: number, point: number): Float64Array;
  gcsCircleRadius(sketch: number, circle: number): number;
  gcsDof(sketch: number): unknown;
}

/** A sketch object with every dimension resolved to a number. */
export type ResolvedSketchObject =
  | {
      objectId: EntityId;
      kind: 'line';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | {
      objectId: EntityId;
      kind: 'circle';
      centerX: number;
      centerY: number;
      radius: number;
    }
  | {
      objectId: EntityId;
      kind: 'arc';
      centerX: number;
      centerY: number;
      radius: number;
      startAngleDeg: number;
      endAngleDeg: number;
    };

/** Solved geometry read back from the kernel, same shapes as the input. */
export type SolvedSketchObject = ResolvedSketchObject;

export interface SketchDofSummary {
  dof: number;
  rank: number;
  numParams: number;
  numEquations: number;
}

export interface SketchSolveOutcome {
  classification: 'solved' | 'underConstrained' | 'redundant' | 'unsatisfied';
  converged: boolean;
  iterations: number;
  maxResidual: number;
  /** True when the kernel restored pre-solve geometry after a failed solve. */
  rolledBack: boolean;
  dof: SketchDofSummary;
  /** Worst residual per document constraint after the solve. */
  constraintResiduals: { constraintId: string; maxResidual: number }[];
  /**
   * Solved geometry, one entry per input object, in sketch-plane
   * coordinates. Meaningful when the solve converged; on a rolled-back
   * solve this reads back the restored pre-solve geometry.
   */
  objects: SolvedSketchObject[];
}

interface ObjectHandles {
  kind: 'line' | 'circle' | 'arc';
  entity: number;
  points: Partial<Record<'start' | 'end' | 'center', number>>;
}

const RADIANS_PER_DEGREE = Math.PI / 180;

function parseKernelJson(raw: unknown, what: string): Record<string, unknown> {
  let payload: unknown = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`The kernel returned an unreadable ${what} result.`);
  }
  return payload as Record<string, unknown>;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`The kernel solve result is missing a numeric "${key}".`);
  }
  return value;
}

/**
 * Runs one full add-solve-read cycle against a fresh kernel GCS sketch.
 *
 * `resolveValue` turns a constraint's `ParamValue` into a number against the
 * document's parameter scope — expressions stay in the document, only their
 * resolved values cross into the solver.
 */
export function solveSketchWithGcs(
  kernel: GcsKernelSurface,
  objects: ResolvedSketchObject[],
  constraints: SketchConstraint[],
  resolveValue: (value: number | string, label: string) => number,
  options: { maxIterations?: number; tolerance?: number } = {}
): SketchSolveOutcome {
  const sketch = kernel.gcsNew();
  const handles = new Map<EntityId, ObjectHandles>();

  for (const object of objects) {
    if (handles.has(object.objectId)) {
      throw new Error(`Sketch object ${object.objectId} appears twice.`);
    }
    if (object.kind === 'line') {
      const start = kernel.gcsAddPoint(sketch, object.x1, object.y1, false);
      const end = kernel.gcsAddPoint(sketch, object.x2, object.y2, false);
      handles.set(object.objectId, {
        kind: 'line',
        entity: kernel.gcsAddLine(sketch, start, end),
        points: { start, end }
      });
    } else if (object.kind === 'circle') {
      const center = kernel.gcsAddPoint(
        sketch,
        object.centerX,
        object.centerY,
        false
      );
      handles.set(object.objectId, {
        kind: 'circle',
        entity: kernel.gcsAddCircle(sketch, center, object.radius),
        points: { center }
      });
    } else {
      const startAngle = object.startAngleDeg * RADIANS_PER_DEGREE;
      const endAngle = object.endAngleDeg * RADIANS_PER_DEGREE;
      const center = kernel.gcsAddPoint(
        sketch,
        object.centerX,
        object.centerY,
        false
      );
      const start = kernel.gcsAddPoint(
        sketch,
        object.centerX + object.radius * Math.cos(startAngle),
        object.centerY + object.radius * Math.sin(startAngle),
        false
      );
      const end = kernel.gcsAddPoint(
        sketch,
        object.centerX + object.radius * Math.cos(endAngle),
        object.centerY + object.radius * Math.sin(endAngle),
        false
      );
      handles.set(object.objectId, {
        kind: 'arc',
        entity: kernel.gcsAddArc(sketch, center, start, end),
        points: { center, start, end }
      });
    }
  }

  const objectHandles = (objectId: EntityId): ObjectHandles => {
    const entry = handles.get(objectId);
    if (!entry) {
      throw new Error(
        `Constraint references object ${objectId}, which is not solvable sketch geometry.`
      );
    }
    return entry;
  };
  const pointHandle = (ref: SketchPointRef): number => {
    const handle = objectHandles(ref.objectId).points[ref.point];
    if (handle === undefined) {
      throw new Error(
        `Object ${ref.objectId} has no '${ref.point}' point to constrain.`
      );
    }
    return handle;
  };

  // One kernel constraint handle per document constraint, in order, so the
  // residual read-back below can be keyed by document constraint id.
  const kernelHandles: { constraintId: string; handle: number }[] = [];
  const add = (constraintId: string, payload: Record<string, unknown>) => {
    kernelHandles.push({
      constraintId,
      handle: kernel.gcsAddConstraint(sketch, JSON.stringify(payload))
    });
  };

  for (const constraint of constraints) {
    const data = constraint.data;
    const id = constraint.constraintId;
    switch (data.constraintKind) {
      case 'coincident':
        add(id, {
          type: 'coincident',
          a: pointHandle(data.a),
          b: pointHandle(data.b)
        });
        break;
      case 'horizontal':
        add(id, {
          type: 'horizontal',
          line: objectHandles(data.objectId).entity
        });
        break;
      case 'vertical':
        add(id, {
          type: 'vertical',
          line: objectHandles(data.objectId).entity
        });
        break;
      case 'parallel':
        add(id, {
          type: 'parallel',
          l1: objectHandles(data.a).entity,
          l2: objectHandles(data.b).entity
        });
        break;
      case 'perpendicular':
        add(id, {
          type: 'perpendicular',
          l1: objectHandles(data.a).entity,
          l2: objectHandles(data.b).entity
        });
        break;
      case 'equal': {
        const a = objectHandles(data.a);
        const b = objectHandles(data.b);
        if (a.kind === 'line' && b.kind === 'line') {
          add(id, { type: 'equalLength', l1: a.entity, l2: b.entity });
        } else if (a.kind === 'circle' && b.kind === 'circle') {
          add(id, {
            type: 'equalRadiusCircleCircle',
            circle1: a.entity,
            circle2: b.entity
          });
        } else if (a.kind === 'arc' && b.kind === 'arc') {
          add(id, {
            type: 'equalRadiusArcArc',
            arc1: a.entity,
            arc2: b.entity
          });
        } else {
          const [arc, circle] = a.kind === 'arc' ? [a, b] : [b, a];
          add(id, {
            type: 'equalRadiusArcCircle',
            arc: arc.entity,
            circle: circle.entity
          });
        }
        break;
      }
      case 'tangent': {
        // Document validation guarantees one line and one circle, in either
        // order; the kernel constraint names its sides.
        const a = objectHandles(data.a);
        const b = objectHandles(data.b);
        const [line, circle] = a.kind === 'line' ? [a, b] : [b, a];
        add(id, {
          type: 'tangentLineCircle',
          line: line.entity,
          circle: circle.entity
        });
        break;
      }
      case 'concentric': {
        const a = objectHandles(data.a);
        const b = objectHandles(data.b);
        if (a.kind === 'arc' && b.kind === 'arc') {
          add(id, {
            type: 'concentricArcArc',
            arc1: a.entity,
            arc2: b.entity
          });
        } else if (a.kind === 'circle' && b.kind === 'circle') {
          // The kernel has no circle-circle concentricity; coincident
          // centers is the same statement.
          add(id, {
            type: 'coincident',
            a: pointHandle({ objectId: data.a, point: 'center' }),
            b: pointHandle({ objectId: data.b, point: 'center' })
          });
        } else {
          const [arc, circle] =
            a.kind === 'arc' ? [data.a, data.b] : [data.b, data.a];
          add(id, {
            type: 'concentricArcCircle',
            arc: objectHandles(arc).entity,
            circle: objectHandles(circle).entity
          });
        }
        break;
      }
      case 'midpoint':
        add(id, {
          type: 'midpoint',
          point: pointHandle(data.point),
          line: objectHandles(data.line).entity
        });
        break;
      case 'distance':
        add(id, {
          type: 'distance',
          a: pointHandle(data.a),
          b: pointHandle(data.b),
          value: resolveValue(data.value, 'distance')
        });
        break;
      case 'radius': {
        const target = objectHandles(data.objectId);
        const value = resolveValue(data.value, 'radius');
        if (target.kind === 'circle') {
          add(id, { type: 'circleRadius', circle: target.entity, value });
        } else {
          // An arc's radius is its center-to-start distance; the kernel has
          // no direct arc-radius constraint.
          add(id, {
            type: 'distance',
            a: pointHandle({ objectId: data.objectId, point: 'center' }),
            b: pointHandle({ objectId: data.objectId, point: 'start' }),
            value
          });
        }
        break;
      }
      case 'angle':
        add(id, {
          type: 'angle',
          l1: objectHandles(data.a).entity,
          l2: objectHandles(data.b).entity,
          // The kernel residual is trigonometric in the raw value: radians.
          value:
            resolveValue(data.valueDeg, 'angle') * RADIANS_PER_DEGREE
        });
        break;
    }
  }

  const diagnostics = parseKernelJson(
    kernel.gcsSolveDetailed(
      sketch,
      options.maxIterations ?? 100,
      options.tolerance ?? 1e-10
    ),
    'sketch solve'
  );
  const dofRecord = parseKernelJson(kernel.gcsDof(sketch), 'sketch DOF');

  const classificationRaw = diagnostics.classification;
  const classification =
    classificationRaw === 'solved' ||
    classificationRaw === 'underConstrained' ||
    classificationRaw === 'redundant' ||
    classificationRaw === 'unsatisfied'
      ? classificationRaw
      : 'unsatisfied';

  const residualByHandle = new Map<number, number>();
  if (Array.isArray(diagnostics.constraintResiduals)) {
    for (const entry of diagnostics.constraintResiduals) {
      if (typeof entry === 'object' && entry !== null) {
        const record = entry as Record<string, unknown>;
        if (
          typeof record.constraint === 'number' &&
          typeof record.maxResidual === 'number'
        ) {
          residualByHandle.set(record.constraint, record.maxResidual);
        }
      }
    }
  }

  const readPoint = (handle: number): { x: number; y: number } => {
    const position = kernel.gcsPointPosition(sketch, handle);
    return { x: position[0] ?? 0, y: position[1] ?? 0 };
  };

  const solvedObjects: SolvedSketchObject[] = objects.map((object) => {
    const entry = objectHandles(object.objectId);
    if (entry.kind === 'line') {
      const start = readPoint(entry.points.start!);
      const end = readPoint(entry.points.end!);
      return {
        objectId: object.objectId,
        kind: 'line',
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y
      };
    }
    if (entry.kind === 'circle') {
      const center = readPoint(entry.points.center!);
      return {
        objectId: object.objectId,
        kind: 'circle',
        centerX: center.x,
        centerY: center.y,
        radius: kernel.gcsCircleRadius(sketch, entry.entity)
      };
    }
    const center = readPoint(entry.points.center!);
    const start = readPoint(entry.points.start!);
    const end = readPoint(entry.points.end!);
    const startAngleDeg =
      Math.atan2(start.y - center.y, start.x - center.x) / RADIANS_PER_DEGREE;
    let endAngleDeg =
      Math.atan2(end.y - center.y, end.x - center.x) / RADIANS_PER_DEGREE;
    // Document arcs sweep counter-clockwise from start to end.
    while (endAngleDeg <= startAngleDeg) {
      endAngleDeg += 360;
    }
    return {
      objectId: object.objectId,
      kind: 'arc',
      centerX: center.x,
      centerY: center.y,
      radius: Math.hypot(start.x - center.x, start.y - center.y),
      startAngleDeg,
      endAngleDeg
    };
  });

  return {
    classification,
    converged: diagnostics.converged === true,
    iterations: requireNumber(diagnostics, 'iterations'),
    maxResidual: requireNumber(diagnostics, 'maxResidual'),
    rolledBack: diagnostics.rolledBack === true,
    dof: {
      dof: requireNumber(dofRecord, 'dof'),
      rank: requireNumber(dofRecord, 'rank'),
      numParams: requireNumber(dofRecord, 'numParams'),
      numEquations: requireNumber(dofRecord, 'numEquations')
    },
    constraintResiduals: kernelHandles.map(({ constraintId, handle }) => ({
      constraintId,
      maxResidual: residualByHandle.get(handle) ?? 0
    })),
    objects: solvedObjects
  };
}
