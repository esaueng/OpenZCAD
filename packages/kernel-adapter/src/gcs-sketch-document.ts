import { getParameterScope, resolveParamValue } from '@openzcad/document-core';
import type {
  ParamValue,
  ProjectDocument,
  SketchNode,
  SketchObjectData
} from '@openzcad/shared';
import {
  solveSketchWithGcs,
  type GcsKernelSurface,
  type ResolvedSketchObject,
  type SketchSolveAnchor,
  type SketchSolveOutcome,
  type SolvedSketchObject
} from './gcs-sketch';

/** Shared document/units mapping for interactive solves and history projections. */
export function solveDocumentSketchWithGcs(
  kernel: GcsKernelSurface,
  document: ProjectDocument,
  sketch: SketchNode,
  options: { anchor?: SketchSolveAnchor } = {}
): SketchSolveOutcome {
  const { scope, errors } = getParameterScope(document);
  if (errors.length > 0) {
    throw new Error(`Parameters failed to evaluate: ${errors.join('; ')}`);
  }
  const objects: ResolvedSketchObject[] = [];
  for (const objectId of sketch.objectIds) {
    const node = document.nodes[objectId];
    if (!node || node.kind !== 'sketch-object') {
      continue;
    }
    const data = node.data;
    // Rectangles, polygons, and text are not solvable geometry;
    // document validation refuses constraints that reference them, so
    // skipping them here cannot orphan a constraint.
    if (data.objectKind === 'line') {
      objects.push({
        objectId,
        kind: 'line',
        x1: resolveParamValue(data.x1, scope, 'x1', document.units),
        y1: resolveParamValue(data.y1, scope, 'y1', document.units),
        x2: resolveParamValue(data.x2, scope, 'x2', document.units),
        y2: resolveParamValue(data.y2, scope, 'y2', document.units)
      });
    } else if (data.objectKind === 'circle') {
      objects.push({
        objectId,
        kind: 'circle',
        centerX: resolveParamValue(
          data.centerX,
          scope,
          'centerX',
          document.units
        ),
        centerY: resolveParamValue(
          data.centerY,
          scope,
          'centerY',
          document.units
        ),
        radius: resolveParamValue(data.radius, scope, 'radius', document.units)
      });
    } else if (data.objectKind === 'arc') {
      objects.push({
        objectId,
        kind: 'arc',
        centerX: resolveParamValue(
          data.centerX,
          scope,
          'centerX',
          document.units
        ),
        centerY: resolveParamValue(
          data.centerY,
          scope,
          'centerY',
          document.units
        ),
        radius: resolveParamValue(data.radius, scope, 'radius', document.units),
        startAngleDeg: resolveParamValue(
          data.startAngleDeg,
          scope,
          'startAngleDeg',
          document.units
        ),
        endAngleDeg: resolveParamValue(
          data.endAngleDeg,
          scope,
          'endAngleDeg',
          document.units
        )
      });
    } else if (data.objectKind === 'ellipse') {
      const value = (field: ParamValue, label: string) =>
        resolveParamValue(field, scope, label, document.units);
      objects.push({
        objectId,
        kind: 'ellipse',
        centerX: value(data.centerX, 'centerX'),
        centerY: value(data.centerY, 'centerY'),
        radiusX: value(data.radiusX, 'radiusX'),
        radiusY: value(data.radiusY, 'radiusY'),
        rotationDeg: value(data.rotationDeg, 'rotationDeg')
      });
    } else if (data.objectKind === 'spline') {
      objects.push({
        objectId,
        kind: 'spline',
        points: data.points.map((point) => ({
          x: resolveParamValue(point.x, scope, 'spline x', document.units),
          y: resolveParamValue(point.y, scope, 'spline y', document.units)
        })),
        closed: data.closed === true
      });
    }
  }
  // I01: a linked projection is its model edge's shadow, not free
  // geometry, so the solver holds it where the edge put it.
  const linked = sketch.objectIds.filter((objectId) => {
    const node = document.nodes[objectId];
    return (
      node?.kind === 'sketch-object' && node.data.projection?.mode === 'linked'
    );
  });
  const anchor =
    linked.length > 0
      ? {
          ...options.anchor,
          objectIds: [...(options.anchor?.objectIds ?? []), ...linked]
        }
      : options.anchor;
  return solveSketchWithGcs(
    kernel,
    objects,
    sketch.constraints ?? [],
    (value, label) => resolveParamValue(value, scope, label, document.units),
    anchor ? { ...options, anchor } : options
  );
}

/** Change geometry only; retain metadata and expressions the solve left alone. */
export function sketchDataFromSolvedObject(
  stored: SketchObjectData,
  solved: SolvedSketchObject,
  resolve: (value: ParamValue, label: string) => number
): SketchObjectData {
  if (stored.objectKind !== solved.kind)
    throw new Error('Sketch solve returned a different entity kind.');
  const before = stored as unknown as Record<string, unknown>;
  const next = { ...stored } as unknown as Record<string, unknown>;
  let changed = false;
  for (const [key, value] of Object.entries(solved)) {
    if (key === 'objectId' || key === 'kind' || key === 'closed') continue;
    if (
      key === 'points' &&
      stored.objectKind === 'spline' &&
      solved.kind === 'spline'
    ) {
      if (stored.points.length !== solved.points.length)
        throw new Error('Sketch solve changed the spline point count.');
      const points = stored.points.map((point, index) => {
        const at = solved.points[index]!;
        const x = resolve(point.x, 'spline x') === at.x ? point.x : at.x;
        const y = resolve(point.y, 'spline y') === at.y ? point.y : at.y;
        if (x === point.x && y === point.y) return point;
        changed = true;
        return { ...point, x, y };
      });
      if (points.some((point, index) => point !== stored.points[index]))
        next.points = points;
      continue;
    }
    const previous = before[key];
    if (
      typeof value !== 'number' ||
      (typeof previous !== 'number' && typeof previous !== 'string')
    )
      throw new Error('Sketch solve returned unsupported entity geometry.');
    if (resolve(previous, key) !== value) {
      next[key] = value;
      changed = true;
    }
  }
  return changed ? (next as unknown as SketchObjectData) : stored;
}
