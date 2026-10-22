import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  findSketch,
  getParameterScope,
  resolvedSketchDocument,
  resolveParamValue
} from '@openzcad/document-core';
import type {
  ParamValue,
  ProjectDocument,
  SketchId,
  SketchObjectData
} from '@openzcad/shared';
import { sketchSolveAngleMoved, sketchSolveValueMoved } from './applySolve';

/** A stale channel still marks a sketch whose authored coordinates are seeds. */
export function sketchUsesProjectionGeometry(
  document: ProjectDocument,
  sketchId: SketchId
): boolean {
  const sketch = findSketch(document, sketchId);
  return (
    sketch?.objectIds.some((id) => {
      const node = document.nodes[id];
      return (
        (node?.kind === 'sketch-object' &&
          node.data.projection?.mode === 'linked') ||
        document.derived.sketchGeometry?.objects[id] !== undefined
      );
    }) ?? false
  );
}

const angleFields = new Set([
  'rotation',
  'rotationDeg',
  'startAngleDeg',
  'endAngleDeg',
  'startParamDeg',
  'endParamDeg'
]);

/** The existing solve-application comparison also keeps release noise from replacing expressions. */
function releasedData(
  authored: SketchObjectData,
  solved: SketchObjectData,
  resolve: (value: ParamValue) => number
): SketchObjectData {
  const next = { ...solved } as unknown as Record<string, unknown>;
  for (const [key, before] of Object.entries(authored)) {
    const after = next[key];
    if (
      (typeof before === 'number' || typeof before === 'string') &&
      typeof after === 'number'
    ) {
      const moved = angleFields.has(key)
        ? sketchSolveAngleMoved
        : sketchSolveValueMoved;
      if (!moved(before, after, resolve)) next[key] = before;
    }
  }
  if (authored.objectKind === 'spline' && solved.objectKind === 'spline') {
    next.points = solved.points.map((point, index) => {
      const before = authored.points[index];
      if (!before) return point;
      return {
        ...point,
        x:
          typeof point.x === 'number' &&
          !sketchSolveValueMoved(before.x, point.x, resolve)
            ? before.x
            : point.x,
        y:
          typeof point.y === 'number' &&
          !sketchSolveValueMoved(before.y, point.y, resolve)
            ? before.y
            : point.y
      };
    });
  }
  return next as unknown as SketchObjectData;
}

/**
 * Explicitly releasing a driver keeps the physical geometry at release time.
 * Prefix these writes to that release in the same validated transaction; a
 * removed relation or last linked projection must not restore authored seeds.
 */
export function retainSketchGeometryCommands(
  document: ProjectDocument,
  sketchId: SketchId,
  excludedObjectIds: readonly string[] = []
): AnyCommand[] {
  const view = resolvedSketchDocument(document);
  const sketch = findSketch(document, sketchId);
  if (view === document || !sketch) return [];
  const { scope } = getParameterScope(document);
  const resolve = (value: ParamValue): number => {
    try {
      return resolveParamValue(
        value,
        scope,
        'released sketch value',
        document.units
      );
    } catch {
      return Number.NaN;
    }
  };
  const excluded = new Set(excludedObjectIds);
  return sketch.objectIds.flatMap((objectId) => {
    if (excluded.has(objectId)) return [];
    const authored = document.nodes[objectId];
    const solved = view.nodes[objectId];
    if (authored?.kind !== 'sketch-object' || solved?.kind !== 'sketch-object')
      return [];
    const data = releasedData(authored.data, solved.data, resolve);
    if (JSON.stringify(authored.data) === JSON.stringify(data)) return [];
    return [
      commandFactories.updateSketchObject(
        { sketchId, objectId, data },
        'Keep released sketch geometry'
      )
    ];
  });
}
