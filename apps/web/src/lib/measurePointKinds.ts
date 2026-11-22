import type { EdgeTopology } from '@openzcad/shared';

/*
 * M13: the point kinds a Distance pick can ask for. Its own small module so
 * the workspace can scope the viewport's snaps without loading the
 * measurement library, which stays a deferred chunk.
 */

/**
 * M13: the kind of point a Distance pick is asked for. `auto` keeps the
 * selection's own derivation (a snapped point when a glyph named one);
 * the others record that kind of notable point of whatever is picked, or
 * refuse when it has none.
 */
export type MeasurePointKind =
  'auto' | 'endpoint' | 'midpoint' | 'center' | 'centroid';

export const MEASURE_POINT_KINDS: readonly MeasurePointKind[] = [
  'auto',
  'endpoint',
  'midpoint',
  'center',
  'centroid'
];

/**
 * The snap kinds a pick for `kind` may lock onto, or null for every kind.
 * A centroid is never an edge snap, so it offers none: the click takes the
 * face under the pointer.
 */
export function measureSnapKindsFor(
  kind: MeasurePointKind
): readonly ('endpoint' | 'midpoint' | 'center')[] | null {
  switch (kind) {
    case 'auto':
      return null;
    case 'endpoint':
      return ['endpoint'];
    case 'midpoint':
      return ['midpoint'];
    case 'center':
      return ['center'];
    case 'centroid':
      return [];
  }
}

/**
 * M13: whether a snap of `kind` on `edge` names a point Measure records
 * exactly. Ends of an open edge, midpoints of lines and arcs, and centres of
 * circles and arcs do; a spline's sampled midpoint does not, so a pick that
 * asks for a kind never shows a glyph its click would refuse.
 */
export function snapRecordsExactly(
  kind: string,
  edge: Pick<EdgeTopology, 'curve' | 'points'>
): boolean {
  const n = edge.points.length;
  const closed =
    n >= 6 &&
    edge.points[0] === edge.points[n - 3] &&
    edge.points[1] === edge.points[n - 2] &&
    edge.points[2] === edge.points[n - 1];
  if (kind === 'endpoint') return !closed;
  if (kind === 'midpoint')
    return !closed && (edge.curve?.type === 'LINE' || !!edge.curve?.circle);
  if (kind === 'center') return !!edge.curve?.circle;
  return false;
}
