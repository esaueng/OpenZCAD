/**
 * Copy and paste of sketch entities. A copy is the selected entities' data,
 * taken in sketch order; a paste adds them again as new, unrelated entities,
 * moved clear of the originals so they do not land on top of them. Each
 * paste of the same copy steps one span further, so repeated pastes line up
 * rather than stack.
 *
 * Relations are not copied: a copy is free geometry, as in a drawing. A
 * linked projection pastes as ordinary geometry, since its copy has no model
 * edge of its own to follow. Dimensions are evaluated when copied, so a paste
 * into another project, or after a parameter changes, draws what was copied.
 */
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  createId,
  toEntityId,
  type SketchId,
  type SketchObjectData
} from '@openzcad/shared';
import { objectPolylines } from '../objectPolyline';
import { translateSketchObject } from './session';

type Resolve = (value: unknown) => number;

/** Every dimensional field a sketch entity can carry. */
const DIMENSION_FIELDS = [
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'centerX',
  'centerY',
  'width',
  'height',
  'radius',
  'radiusX',
  'radiusY',
  'sides',
  'startAngleDeg',
  'endAngleDeg',
  'rotationDeg',
  'startParamDeg',
  'endParamDeg',
  'size',
  'rotation'
] as const;

/** The entity with every dimension evaluated to a plain number. */
function evaluatedSketchObject(
  data: SketchObjectData,
  resolve: Resolve
): SketchObjectData {
  const next = { ...data } as Record<string, unknown>;
  for (const field of DIMENSION_FIELDS) {
    if (next[field] !== undefined) {
      next[field] = resolve(next[field]);
    }
  }
  if (data.objectKind === 'spline') {
    next.points = data.points.map((point) => ({
      x: resolve(point.x),
      y: resolve(point.y)
    }));
  }
  delete next.projection;
  return next as unknown as SketchObjectData;
}

export interface SketchClipboard {
  objects: readonly SketchObjectData[];
  /** The copy's extent, so a paste can step clear of it. */
  span: { x: number; y: number };
  /** Pastes made from this copy so far. */
  pastes: number;
}

/** The selected entities as a copy, or null when nothing drawable is selected. */
export function copySketchObjects(
  objects: readonly { id: string; data: SketchObjectData }[],
  selectedIds: readonly string[],
  resolve: Resolve
): SketchClipboard | null {
  const wanted = new Set(selectedIds);
  const taken = objects.filter((object) => wanted.has(object.id));
  if (taken.length === 0) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { data } of taken) {
    let runs: { points: { x: number; y: number }[] }[];
    try {
      runs =
        data.objectKind === 'point'
          ? [{ points: [{ x: resolve(data.x), y: resolve(data.y) }] }]
          : objectPolylines(data, resolve);
    } catch {
      continue;
    }
    for (const point of runs.flatMap((run) => run.points)) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  return {
    objects: taken.map(({ data }) => evaluatedSketchObject(data, resolve)),
    span: Number.isFinite(minX)
      ? { x: maxX - minX, y: maxY - minY }
      : { x: 0, y: 0 },
    pastes: 0
  };
}

/**
 * The commands that paste `clipboard` into a sketch, as one transaction,
 * and the new entities' ids. Advances the clipboard's paste count.
 */
export function pasteSketchObjectsCommands(
  clipboard: SketchClipboard,
  sketchId: SketchId,
  resolve: Resolve
): { commands: AnyCommand[]; objectIds: string[] } {
  clipboard.pastes += 1;
  const { x, y } = clipboard.span;
  // One span to the right plus a tenth of a gap; a single point (no span)
  // steps by a fixed ten units.
  const step = x > 0 || y > 0 ? x + Math.max(x, y) * 0.1 : 10;
  const dx = step * clipboard.pastes;
  const objects = clipboard.objects.map((data) =>
    translateSketchObject(data, dx, 0, resolve)
  );
  const ids = objects.map(() => toEntityId(createId('ent')));
  return {
    commands: [
      commandFactories.addSketchObjects(
        { sketchId, objects, ids: { objectNodeIds: ids } },
        'Paste sketch geometry'
      )
    ],
    objectIds: ids.map(String)
  };
}
