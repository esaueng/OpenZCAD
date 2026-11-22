import type {
  EntityId,
  SketchConstraint,
  SketchConstraintData,
  SketchPointRef
} from '@openzcad/shared';
import type { ResolvedSketchObject } from './gcs-sketch';

/**
 * S05 pattern placement, closed form: where a `pattern` relation puts each
 * instance given the source, the direction line or pivot, and the step. The
 * solver's equations admit mirror branches (a copy on the source's other
 * side, a reversed line, the opposite ray from the pivot), so a solve seeds
 * free instances here and reads every instance back against it.
 */

type PatternData = Extract<SketchConstraintData, { constraintKind: 'pattern' }>;
type Point = { x: number; y: number };

const RADIANS_PER_DEGREE = Math.PI / 180;

export function pointOfObject(
  objects: readonly ResolvedSketchObject[],
  ref: SketchPointRef
): Point | null {
  const object = objects.find((entry) => entry.objectId === ref.objectId);
  if (object?.kind === 'line') {
    return ref.point === 'end'
      ? { x: object.x2, y: object.y2 }
      : { x: object.x1, y: object.y1 };
  }
  if (object?.kind === 'arc' && ref.point !== 'center') {
    const angle =
      (ref.point === 'start' ? object.startAngleDeg : object.endAngleDeg) *
      RADIANS_PER_DEGREE;
    return {
      x: object.centerX + object.radius * Math.cos(angle),
      y: object.centerY + object.radius * Math.sin(angle)
    };
  }
  if (object && 'centerX' in object) {
    return { x: object.centerX, y: object.centerY };
  }
  if (object?.kind === 'point') return { x: object.x, y: object.y };
  return null;
}

/** The source carried to `step`, or null when the layout does not resolve. */
export function patternInstanceAt(
  objects: readonly ResolvedSketchObject[],
  data: PatternData,
  step: number,
  resolveValue: (value: number | string, label: string) => number,
  objectId: EntityId
): ResolvedSketchObject | null {
  const source = objects.find((entry) => entry.objectId === data.source);
  if (
    source?.kind !== 'line' &&
    source?.kind !== 'circle' &&
    source?.kind !== 'arc'
  ) {
    return null;
  }
  const layout = data.layout;
  let map: (p: Point) => Point;
  let turnDeg = 0;
  if (layout.kind === 'linear') {
    const line = objects.find((entry) => entry.objectId === layout.direction);
    if (line?.kind !== 'line') return null;
    const length = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
    if (!(length > 0)) return null;
    const offset = resolveValue(layout.spacing, 'distance') * step;
    const dx = ((line.x2 - line.x1) / length) * offset;
    const dy = ((line.y2 - line.y1) / length) * offset;
    map = (p) => ({ x: p.x + dx, y: p.y + dy });
  } else {
    const pivot = pointOfObject(objects, layout.pivot);
    if (!pivot) return null;
    const angle =
      resolveValue(layout.stepDeg, 'angle') * RADIANS_PER_DEGREE * step;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const turn = (p: Point): Point => ({
      x: pivot.x + (p.x - pivot.x) * cos - (p.y - pivot.y) * sin,
      y: pivot.y + (p.x - pivot.x) * sin + (p.y - pivot.y) * cos
    });
    if (layout.orientation === 'rotate') {
      map = turn;
      turnDeg = angle / RADIANS_PER_DEGREE;
    } else {
      // Kept in orientation, carried by a line's midpoint or a centre.
      const anchor =
        source.kind === 'line'
          ? { x: (source.x1 + source.x2) / 2, y: (source.y1 + source.y2) / 2 }
          : { x: source.centerX, y: source.centerY };
      const moved = turn(anchor);
      const dx = moved.x - anchor.x;
      const dy = moved.y - anchor.y;
      map = (p) => ({ x: p.x + dx, y: p.y + dy });
    }
  }
  if (source.kind === 'line') {
    const a = map({ x: source.x1, y: source.y1 });
    const b = map({ x: source.x2, y: source.y2 });
    return { objectId, kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }
  const c = map({ x: source.centerX, y: source.centerY });
  if (source.kind === 'circle') {
    return {
      objectId,
      kind: 'circle',
      centerX: c.x,
      centerY: c.y,
      radius: source.radius
    };
  }
  return {
    objectId,
    kind: 'arc',
    centerX: c.x,
    centerY: c.y,
    radius: source.radius,
    startAngleDeg: source.startAngleDeg + turnDeg,
    endAngleDeg: source.endAngleDeg + turnDeg
  };
}

/** The points that pin an entity, for comparing two of one kind. */
function keyPoints(object: ResolvedSketchObject): Point[] {
  if (object.kind === 'line') {
    return [
      { x: object.x1, y: object.y1 },
      { x: object.x2, y: object.y2 }
    ];
  }
  if (object.kind === 'circle') {
    return [
      { x: object.centerX, y: object.centerY },
      { x: object.centerX + object.radius, y: object.centerY }
    ];
  }
  if (object.kind === 'arc') {
    return (['center', 'start', 'end'] as const).map(
      (point) =>
        pointOfObject([object], { objectId: object.objectId, point }) ?? {
          x: NaN,
          y: NaN
        }
    );
  }
  return [];
}

/** How far `actual` lies from `expected`, worst key point. */
export function placementMiss(
  expected: ResolvedSketchObject,
  actual: ResolvedSketchObject
): number {
  const want = keyPoints(expected);
  const have = keyPoints(actual);
  if (want.length === 0 || want.length !== have.length) return Infinity;
  return Math.max(
    ...want.map((p, index) =>
      Math.hypot(p.x - have[index]!.x, p.y - have[index]!.y)
    )
  );
}

/**
 * The objects with every free pattern instance started at its step, so the
 * solver begins on the right branch. Held instances keep their geometry.
 */
export function seedPatternInstances(
  objects: readonly ResolvedSketchObject[],
  constraints: readonly SketchConstraint[],
  resolveValue: (value: number | string, label: string) => number,
  isHeld: (objectId: string) => boolean
): ResolvedSketchObject[] {
  let seeded = [...objects];
  const replace = (placed: ResolvedSketchObject | null) => {
    if (!placed) return;
    const index = seeded.findIndex(
      (entry) => entry.objectId === placed.objectId
    );
    if (index < 0 || seeded[index]!.kind !== placed.kind) return;
    seeded = seeded.map((entry, at) => (at === index ? placed : entry));
  };
  const attempt = (place: () => ResolvedSketchObject | null) => {
    try {
      return place();
    } catch {
      return null;
    }
  };
  for (const { data } of constraints) {
    if (data.constraintKind !== 'pattern') continue;
    // A held instance with a free source (an instance dragged on its
    // own): start the source one step back from it, so the source follows
    // to the side the instance was put on.
    const heldInstance = data.instances.find(({ objectId }) =>
      isHeld(objectId)
    );
    if (heldInstance && !isHeld(data.source)) {
      replace(
        attempt(() =>
          patternInstanceAt(
            seeded,
            { ...data, source: heldInstance.objectId },
            -heldInstance.step,
            resolveValue,
            data.source
          )
        )
      );
    }
    for (const { objectId, step } of data.instances) {
      if (isHeld(objectId)) continue;
      replace(
        attempt(() =>
          patternInstanceAt(seeded, data, step, resolveValue, objectId)
        )
      );
    }
  }
  return seeded;
}

/**
 * The miss a solved instance may show: a millionth of its own size or
 * offset (never of how far the sketch sits from the origin), with a
 * floating-point floor for coordinates far out.
 */
export function placementTolerance(
  expected: ResolvedSketchObject,
  source: ResolvedSketchObject
): number {
  const want = keyPoints(expected);
  const from = keyPoints(source);
  const spread = Math.max(
    0,
    ...want.flatMap((p) => want.map((q) => Math.hypot(p.x - q.x, p.y - q.y))),
    ...want.map((p, index) => {
      const q = from[index];
      return q ? Math.hypot(p.x - q.x, p.y - q.y) : 0;
    })
  );
  const far = Math.max(
    0,
    ...want.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)])
  );
  return Math.max(1e-7 * Math.max(1, spread), 1024 * Number.EPSILON * far);
}

/**
 * S05: the objects with every free offset copy started where its relation
 * puts it — a round concentric with its source at the offset radius, a
 * line moved square onto the offset carrier — so a solve after the source
 * or the distance changes begins on the copy's recorded side, and the
 * helper points the relation adds are seeded from there too.
 */
export function seedOffsetCopies(
  objects: readonly ResolvedSketchObject[],
  constraints: readonly SketchConstraint[],
  resolveValue: (value: number | string, label: string) => number,
  isHeld: (objectId: string) => boolean
): ResolvedSketchObject[] {
  let seeded = [...objects];
  const at = (objectId: EntityId) =>
    seeded.findIndex((entry) => entry.objectId === objectId);
  for (const { data } of constraints) {
    if (data.constraintKind !== 'offset') continue;
    let value: number;
    try {
      value = resolveValue(data.value, 'distance');
    } catch {
      continue;
    }
    if (!(value > 0)) continue;
    for (const { source, copy, side } of data.pairs) {
      if (isHeld(copy)) continue;
      const from = seeded[at(source)];
      const index = at(copy);
      const to = seeded[index];
      if (!from || !to) continue;
      let placed: ResolvedSketchObject | null = null;
      if (from.kind === 'line' && to.kind === 'line') {
        const length = Math.hypot(from.x2 - from.x1, from.y2 - from.y1);
        if (!(length > 0)) continue;
        // The left normal of the source's stored direction.
        const nx = -(from.y2 - from.y1) / length;
        const ny = (from.x2 - from.x1) / length;
        const onto = (x: number, y: number) => {
          const off = (x - from.x1) * nx + (y - from.y1) * ny - side * value;
          return { x: x - off * nx, y: y - off * ny };
        };
        const a = onto(to.x1, to.y1);
        const b = onto(to.x2, to.y2);
        placed = { ...to, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      } else if (
        (from.kind === 'circle' || from.kind === 'arc') &&
        (to.kind === 'circle' || to.kind === 'arc')
      ) {
        const radius = from.radius + side * value;
        if (!(radius > 0)) continue;
        placed = {
          ...to,
          centerX: from.centerX,
          centerY: from.centerY,
          radius
        };
      }
      if (!placed) continue;
      const kept = placed;
      seeded = seeded.map((entry, position) =>
        position === index ? kept : entry
      );
    }
  }
  return seeded;
}
