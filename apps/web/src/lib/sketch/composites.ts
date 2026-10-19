/**
 * S04 composite drawing: the rectangle (corner, centre and three-point) and
 * regular-polygon tools draw real lines held by persisted relations, and
 * name those lines as one object with a `SketchComposite` record. The shape
 * is pure arithmetic on picked points; the commands commit it as one
 * undoable transaction, so the shape's corners, sides and intent all replay
 * from the document after a reload.
 *
 * Corner order is counter-clockwise from corner 0: the bottom-left corner
 * of an axis-aligned rectangle, the first click of a three-point rectangle,
 * and the vertex under the pointer for a polygon.
 */
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import { createSketchFeatureIds } from '@openzcad/document-core';
import {
  MAX_SKETCH_POLYGON_SIDES,
  createId,
  createSketchCompositeId,
  sketchCompositeCornerRef,
  toEntityId,
  type EntityId,
  type ParamValue,
  type SketchComposite,
  type SketchCompositeData,
  type SketchConstraintData,
  type SketchId,
  type SketchObjectData,
  type SketchPlaneRef
} from '@openzcad/shared';

export interface CompositePoint {
  x: number;
  y: number;
}

/** Side counts the polygon tool accepts; the cap is the document's. */
export const POLYGON_SIDE_LIMITS = {
  min: 3,
  max: MAX_SKETCH_POLYGON_SIDES
} as const;

/** The smallest side a drawn shape may have; the circle tool uses the same. */
export const MIN_COMPOSITE_SIZE = 0.5;

/** A placed composite's geometry, before it has any document identity. */
export interface CompositeShape {
  composite: SketchCompositeData;
  /** Corner `i` is the start of side `i`; counter-clockwise. */
  corners: CompositePoint[];
  /** The polygon's circumcircle; absent for rectangles. */
  circle?: { center: CompositePoint; radius: number };
}

function axisAlignedCorners(
  a: CompositePoint,
  b: CompositePoint
): CompositePoint[] | null {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  if (maxX - minX < MIN_COMPOSITE_SIZE || maxY - minY < MIN_COMPOSITE_SIZE) {
    return null;
  }
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY }
  ];
}

/** A rectangle from two opposite corners, or null while it is too small. */
export function cornerRectangleShape(
  first: CompositePoint,
  opposite: CompositePoint
): CompositeShape | null {
  const corners = axisAlignedCorners(first, opposite);
  return corners
    ? { composite: { compositeKind: 'rectangle', method: 'corner' }, corners }
    : null;
}

/**
 * A rectangle centred on `center` with `corner` as one of its corners, or
 * null while it is too small. The centre is where the press landed and
 * stays there: the opposite corner mirrors the pointer through it.
 */
export function centerRectangleShape(
  center: CompositePoint,
  corner: CompositePoint
): CompositeShape | null {
  const corners = axisAlignedCorners(
    { x: 2 * center.x - corner.x, y: 2 * center.y - corner.y },
    corner
  );
  return corners
    ? { composite: { compositeKind: 'rectangle', method: 'center' }, corners }
    : null;
}

/**
 * A rectangle from a drag with one or both sizes typed. A typed size is the
 * whole side; a side not typed keeps the size the drag is showing, which
 * for a centre rectangle is twice the pointer's distance from the centre.
 * The rectangle keeps the corner the drag is heading toward, so an exact
 * 40 × 20 typed while dragging up and left does not flip down and right.
 */
export function typedRectangleShape(
  mode: 'corner' | 'center',
  start: CompositePoint,
  live: CompositePoint,
  typed: { width?: number | null; height?: number | null }
): CompositeShape | null {
  const span = mode === 'center' ? 2 : 1;
  const width = typed.width ?? Math.abs(live.x - start.x) * span;
  const height = typed.height ?? Math.abs(live.y - start.y) * span;
  const reach = 1 / span;
  const corner = {
    x: start.x + (live.x < start.x ? -1 : 1) * width * reach,
    y: start.y + (live.y < start.y ? -1 : 1) * height * reach
  };
  return mode === 'center'
    ? centerRectangleShape(start, corner)
    : cornerRectangleShape(start, corner);
}

/** Why a third point cannot finish a three-point rectangle. */
export const THREE_POINT_COLLINEAR_REFUSAL =
  'Pick the third point off the first side: it sets the rectangle’s height.';

/**
 * A rotated rectangle: `first` to `second` is one whole side, and `third`
 * sets the height as its distance from that side's line, on whichever side
 * it lies. A third point on (or nearly on) the first side's line refuses,
 * as does a first side shorter than the minimum.
 */
export function threePointRectangleShape(
  first: CompositePoint,
  second: CompositePoint,
  third: CompositePoint
): CompositeShape | { refusal: string } {
  const length = Math.hypot(second.x - first.x, second.y - first.y);
  if (length < MIN_COMPOSITE_SIZE) {
    return { refusal: 'Pick a second point further from the first.' };
  }
  const u = {
    x: (second.x - first.x) / length,
    y: (second.y - first.y) / length
  };
  // Signed height along the side's left normal.
  const height = u.x * (third.y - first.y) - u.y * (third.x - first.x);
  if (Math.abs(height) < MIN_COMPOSITE_SIZE) {
    return { refusal: THREE_POINT_COLLINEAR_REFUSAL };
  }
  const offset = { x: -u.y * height, y: u.x * height };
  const far = { x: second.x + offset.x, y: second.y + offset.y };
  const near = { x: first.x + offset.x, y: first.y + offset.y };
  // Side 0 is always the picked side, so the card's Width is its length and
  // Height the third point's distance. The walk stays counter-clockwise, so
  // when the third point falls on the clockwise side the picked side runs
  // second click to first and corner 0 is the second click.
  const corners =
    height > 0 ? [first, second, far, near] : [second, first, near, far];
  return {
    composite: { compositeKind: 'rectangle', method: 'three-point' },
    corners: corners.map((corner) => ({ x: corner.x, y: corner.y }))
  };
}

/** Whether a three-point result is a shape rather than a refusal. */
export function isCompositeShape(
  value: CompositeShape | { refusal: string } | null
): value is CompositeShape {
  return value !== null && 'corners' in value;
}

/**
 * A regular polygon inscribed in the circle about `center` through
 * `vertex`: the radius is the circumradius, and vertex 0 sits under the
 * pointer, so the drag sets the polygon's rotation too.
 */
export function inscribedPolygonShape(
  center: CompositePoint,
  vertex: CompositePoint,
  sides: number
): CompositeShape | null {
  if (
    !Number.isInteger(sides) ||
    sides < POLYGON_SIDE_LIMITS.min ||
    sides > POLYGON_SIDE_LIMITS.max
  ) {
    return null;
  }
  const radius = Math.hypot(vertex.x - center.x, vertex.y - center.y);
  // The side, not the radius, is what must not be degenerate.
  if (2 * radius * Math.sin(Math.PI / sides) < MIN_COMPOSITE_SIZE) {
    return null;
  }
  const phase = Math.atan2(vertex.y - center.y, vertex.x - center.x);
  const corners = Array.from({ length: sides }, (_, index) => {
    const angle = phase + (index * 2 * Math.PI) / sides;
    return index === 0
      ? { x: vertex.x, y: vertex.y }
      : {
          x: center.x + radius * Math.cos(angle),
          y: center.y + radius * Math.sin(angle)
        };
  });
  return {
    composite: { compositeKind: 'polygon', method: 'inscribed' },
    corners,
    circle: { center: { ...center }, radius }
  };
}

/**
 * The shape a press-and-drag (or click, click) describes for the drag-placed
 * tools: a corner or centre rectangle, or a polygon from its centre to a
 * vertex. The three-point rectangle is click-placed and never comes here.
 */
export function dragCompositeShape(
  tool: 'rectangle' | 'polygon',
  rectangleMode: 'corner' | 'center' | 'three-point',
  polygonSides: number,
  start: CompositePoint,
  point: CompositePoint
): CompositeShape | null {
  if (tool === 'polygon') {
    return inscribedPolygonShape(start, point, polygonSides);
  }
  return rectangleMode === 'center'
    ? centerRectangleShape(start, point)
    : rectangleMode === 'corner'
      ? cornerRectangleShape(start, point)
      : null;
}

const roundTenth = (value: number) => Math.round(value * 10) / 10;

/** The live size beside the pointer: width × height, or circumradius and side. */
export function compositeSizeLabel(shape: CompositeShape): string {
  if (shape.composite.compositeKind === 'polygon' && shape.circle) {
    const [a, b] = shape.corners as [CompositePoint, CompositePoint];
    return `R ${roundTenth(shape.circle.radius)} · side ${roundTenth(
      Math.hypot(b.x - a.x, b.y - a.y)
    )}`;
  }
  const { width, height } = rectangleSize(shape.corners);
  return `${roundTenth(width)} × ${roundTenth(height)}`;
}

/** Side `index` as line data, from corner `index` to the next. */
function sideObject(
  corners: readonly CompositePoint[],
  index: number
): SketchObjectData {
  const start = corners[index]!;
  const end = corners[(index + 1) % corners.length]!;
  return { objectKind: 'line', x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/**
 * The construction helpers a shape owns, in `helperIds` order: a centre
 * rectangle's two diagonals (corner 0 to 2, then 1 to 3), whose crossing is
 * the centre; a polygon's circumcircle.
 */
function helperObjects(shape: CompositeShape): SketchObjectData[] {
  const { composite, corners, circle } = shape;
  if (composite.compositeKind === 'polygon' && circle) {
    return [
      {
        objectKind: 'circle',
        centerX: circle.center.x,
        centerY: circle.center.y,
        radius: circle.radius,
        construction: true
      }
    ];
  }
  if (
    composite.compositeKind === 'rectangle' &&
    composite.method === 'center'
  ) {
    return [
      { ...diagonal(corners, 0), construction: true },
      { ...diagonal(corners, 1), construction: true }
    ];
  }
  return [];
}

function diagonal(
  corners: readonly CompositePoint[],
  from: 0 | 1
): SketchObjectData {
  const start = corners[from]!;
  const end = corners[from + 2]!;
  return { objectKind: 'line', x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

/**
 * The relations that hold the shape, written against its members' ids.
 * Each is independent of the others, so the solver reports none redundant:
 *
 * - every corner joins side `i - 1`'s end to side `i`'s start;
 * - an axis-aligned rectangle has horizontal sides 0 and 2 and vertical
 *   sides 1 and 3 (four degrees of freedom left: position and size);
 * - a three-point rectangle has side 1 perpendicular to side 0 and both
 *   pairs of opposite sides parallel (five left: rotation as well);
 * - a centre rectangle's diagonals end on their corners;
 * - a polygon's vertices lie on its circumcircle and every side equals
 *   side 0 (four left: centre, circumradius and rotation).
 */
export function compositeRelations(
  shape: CompositeShape,
  edgeIds: readonly EntityId[],
  helperIds: readonly EntityId[]
): SketchConstraintData[] {
  const composite = {
    ...shape.composite,
    compositeId: 'scmp_draft',
    edgeIds: [...edgeIds]
  } as SketchComposite;
  const corner = (index: number) => sketchCompositeCornerRef(composite, index);
  const count = edgeIds.length;
  const relations: SketchConstraintData[] = [];
  for (let index = 0; index < count; index += 1) {
    relations.push({
      constraintKind: 'coincident',
      a: { objectId: edgeIds[(index + count - 1) % count]!, point: 'end' },
      b: corner(index)
    });
  }
  const { compositeKind, method } = shape.composite;
  if (compositeKind === 'rectangle' && method === 'three-point') {
    relations.push(
      { constraintKind: 'perpendicular', a: edgeIds[0]!, b: edgeIds[1]! },
      { constraintKind: 'parallel', a: edgeIds[0]!, b: edgeIds[2]! },
      { constraintKind: 'parallel', a: edgeIds[1]!, b: edgeIds[3]! }
    );
  } else if (compositeKind === 'rectangle') {
    relations.push(
      { constraintKind: 'horizontal', objectId: edgeIds[0]! },
      { constraintKind: 'vertical', objectId: edgeIds[1]! },
      { constraintKind: 'horizontal', objectId: edgeIds[2]! },
      { constraintKind: 'vertical', objectId: edgeIds[3]! }
    );
  }
  if (compositeKind === 'rectangle' && method === 'center') {
    for (const [index, helper] of helperIds.entries()) {
      relations.push(
        {
          constraintKind: 'coincident',
          a: { objectId: helper, point: 'start' },
          b: corner(index)
        },
        {
          constraintKind: 'coincident',
          a: { objectId: helper, point: 'end' },
          b: corner(index + 2)
        }
      );
    }
  }
  if (compositeKind === 'polygon') {
    const circle = helperIds[0]!;
    for (let index = 0; index < count; index += 1) {
      relations.push({
        constraintKind: 'point-on-object',
        point: corner(index),
        objectId: circle
      });
    }
    for (let index = 1; index < count; index += 1) {
      relations.push({
        constraintKind: 'equal',
        a: edgeIds[0]!,
        b: edgeIds[index]!
      });
    }
  }
  return relations;
}

/** Where a composite lands: a new sketch, or one that already exists. */
export type CompositeTarget =
  | { kind: 'new-sketch'; name: string; planeRef: SketchPlaneRef }
  | { kind: 'sketch'; sketchId: SketchId };

export interface CompositeCommit {
  label: string;
  sketchId: SketchId;
  compositeId: SketchComposite['compositeId'];
  edgeIds: EntityId[];
  helperIds: EntityId[];
  commands: AnyCommand[];
}

/** The tool's name for a composite, as its transaction and status say it. */
export function compositeLabel(composite: SketchCompositeData): string {
  if (composite.compositeKind === 'polygon') return 'polygon';
  return composite.method === 'center'
    ? 'center rectangle'
    : composite.method === 'three-point'
      ? 'three-point rectangle'
      : 'rectangle';
}

/**
 * The commands that commit `shape`: its sides and helpers, the relations
 * that hold it, and the record that names it — one transaction with every
 * id assigned up front, so undo removes the whole shape and redo or replay
 * restores the same ids. `construction` draws the sides as construction
 * geometry, as the rail's construction toggle does for any tool.
 */
export function compositeCommands(
  shape: CompositeShape,
  target: CompositeTarget,
  options: { construction?: boolean } = {}
): CompositeCommit {
  const sides = shape.corners.map((_, index) => {
    const side = sideObject(shape.corners, index);
    return options.construction ? { ...side, construction: true } : side;
  });
  const helpers = helperObjects(shape);
  const edgeIds = sides.map(() => toEntityId(createId('ent')));
  const helperIds = helpers.map(() => toEntityId(createId('ent')));
  const objectNodeIds = [...edgeIds, ...helperIds];
  const objects = [...sides, ...helpers];
  const label = `Add ${compositeLabel(shape.composite)}`;
  const commands: AnyCommand[] = [];
  let sketchId: SketchId;
  if (target.kind === 'new-sketch') {
    const add = commandFactories.addSketch({
      name: target.name,
      planeRef: target.planeRef,
      objects,
      ids: {
        ...createSketchFeatureIds(0),
        objectNodeId: objectNodeIds[0]!,
        objectNodeIds
      }
    });
    sketchId = add.payload.ids!.sketchId;
    commands.push(add);
  } else {
    sketchId = target.sketchId;
    commands.push(
      commandFactories.addSketchObjects(
        { sketchId, objects, ids: { objectNodeIds } },
        label
      )
    );
  }
  for (const constraint of compositeRelations(shape, edgeIds, helperIds)) {
    commands.push(
      commandFactories.addSketchConstraint({ sketchId, constraint }, label)
    );
  }
  const compositeId = createSketchCompositeId();
  commands.push(
    commandFactories.addSketchComposite(
      {
        sketchId,
        composite: {
          ...shape.composite,
          edgeIds,
          ...(helperIds.length > 0 ? { helperIds } : {})
        },
        ids: { compositeId }
      },
      label
    )
  );
  return { label, sketchId, compositeId, edgeIds, helperIds, commands };
}

// ---------------------------------------------------------------------------
// Resize: one composite edit from its card

/** A rectangle's size as its card shows it: side 0's length and side 1's. */
export function rectangleSize(corners: readonly CompositePoint[]): {
  width: number;
  height: number;
} {
  const [c0, c1, , c3] = corners as [
    CompositePoint,
    CompositePoint,
    CompositePoint,
    CompositePoint
  ];
  return {
    width: Math.hypot(c1.x - c0.x, c1.y - c0.y),
    height: Math.hypot(c3.x - c0.x, c3.y - c0.y)
  };
}

/**
 * The corners of a rectangle resized to `width` × `height`, keeping its
 * rotation. A centre rectangle keeps its centre; the others keep corner 0.
 * Null for a size below the minimum side.
 */
export function resizedRectangleCorners(
  corners: readonly CompositePoint[],
  method: Extract<
    SketchCompositeData,
    { compositeKind: 'rectangle' }
  >['method'],
  width: number,
  height: number
): CompositePoint[] | null {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < MIN_COMPOSITE_SIZE ||
    height < MIN_COMPOSITE_SIZE
  ) {
    return null;
  }
  const [c0, c1, c2, c3] = corners as [
    CompositePoint,
    CompositePoint,
    CompositePoint,
    CompositePoint
  ];
  const current = rectangleSize(corners);
  const u = {
    x: (c1.x - c0.x) / current.width,
    y: (c1.y - c0.y) / current.width
  };
  const v = {
    x: (c3.x - c0.x) / current.height,
    y: (c3.y - c0.y) / current.height
  };
  const origin =
    method === 'center'
      ? {
          x: (c0.x + c2.x) / 2 - (u.x * width + v.x * height) / 2,
          y: (c0.y + c2.y) / 2 - (u.y * width + v.y * height) / 2
        }
      : c0;
  const at = (a: number, b: number) => ({
    x: origin.x + u.x * a + v.x * b,
    y: origin.y + u.y * a + v.y * b
  });
  return [at(0, 0), at(width, 0), at(width, height), at(0, height)];
}

/**
 * A polygon's corners and circle at a new circumradius, keeping its centre
 * and rotation. Null for a radius whose side falls below the minimum.
 */
export function resizedPolygon(
  corners: readonly CompositePoint[],
  center: CompositePoint,
  radius: number
): {
  center: CompositePoint;
  radius: number;
  corners: CompositePoint[];
} | null {
  const sides = corners.length;
  if (
    !Number.isFinite(radius) ||
    2 * radius * Math.sin(Math.PI / sides) < MIN_COMPOSITE_SIZE
  ) {
    return null;
  }
  const current = Math.hypot(
    corners[0]!.x - center.x,
    corners[0]!.y - center.y
  );
  const scale = radius / current;
  return {
    center: { ...center },
    radius,
    corners: corners.map((corner) => ({
      x: center.x + (corner.x - center.x) * scale,
      y: center.y + (corner.y - center.y) * scale
    }))
  };
}

/**
 * The object updates that move a resolved composite onto `corners` (and the
 * polygon onto `circle`): each side from its corner to the next, and each
 * helper to match. Members keep their ids and their construction flag, and
 * a coordinate the resize does not move keeps its stored value, so an
 * expression typed into a side still drives it afterwards. With `resolve`
 * absent every stored value is taken literally.
 */
export function compositeMemberUpdates(
  composite: SketchComposite,
  corners: readonly CompositePoint[],
  current: ReadonlyMap<string, SketchObjectData>,
  circle?: { center: CompositePoint; radius: number },
  resolve: (value: ParamValue) => number | undefined = (value) =>
    typeof value === 'number' ? value : undefined
): { objectId: EntityId; data: SketchObjectData }[] {
  /** `next`, with every field it would not move taken back from `existing`. */
  const settle = <T extends SketchObjectData>(
    objectId: EntityId,
    next: T
  ): SketchObjectData => {
    const existing = current.get(objectId);
    if (!existing || existing.objectKind !== next.objectKind) return next;
    const merged: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(next)) {
      const stored = (existing as Record<string, unknown>)[key];
      const unmoved =
        typeof value === 'number' &&
        (typeof stored === 'number' || typeof stored === 'string') &&
        Math.abs((resolve(stored) ?? NaN) - value) <= UNMOVED;
      merged[key] = unmoved ? stored : value;
    }
    return merged as SketchObjectData;
  };
  const updates = composite.edgeIds.map((objectId, index) => ({
    objectId,
    data: settle(objectId, sideObject(corners, index))
  }));
  for (const [index, objectId] of (composite.helperIds ?? []).entries()) {
    const existing = current.get(objectId);
    if (existing?.objectKind === 'circle' && circle) {
      updates.push({
        objectId,
        data: settle(objectId, {
          objectKind: 'circle',
          centerX: circle.center.x,
          centerY: circle.center.y,
          radius: circle.radius
        })
      });
    } else if (existing?.objectKind === 'line' && corners.length === 4) {
      updates.push({
        objectId,
        data: settle(objectId, diagonal(corners, index === 0 ? 0 : 1))
      });
    }
  }
  return updates;
}

/** How far a coordinate may differ and still count as not moved by a resize. */
const UNMOVED = 1e-9;
