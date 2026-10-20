import type {
  SketchConstraint,
  SketchConstraintKind,
  SketchObjectData,
  SketchPointRef,
  SketchRelationGlyphVisibility
} from '@openzcad/shared';
import { boundedArcSweepDegrees } from '@openzcad/geometry';
import { constraintReferencesObject } from './constraints';
import { sketchPointPosition } from './dimensionAnnotations';

type Point = { x: number; y: number };
type Resolve = (value: number | string) => number | undefined;

/** Relations drawn as glyphs; driving dimensions already have labels. */
export type SketchRelationGlyphKind = Exclude<
  SketchConstraintKind,
  'distance' | 'radius' | 'angle'
>;

// Every symbol must be drawn by a bundled face (test/glyph-coverage.test.ts).
export const SKETCH_RELATION_GLYPHS: Record<
  SketchRelationGlyphKind,
  { symbol: string; label: string }
> = {
  horizontal: { symbol: '—', label: 'Horizontal' },
  vertical: { symbol: '|', label: 'Vertical' },
  parallel: { symbol: '∥', label: 'Parallel' },
  perpendicular: { symbol: '⊥', label: 'Perpendicular' },
  equal: { symbol: '=', label: 'Equal' },
  tangent: { symbol: '○', label: 'Tangent' },
  concentric: { symbol: '◎', label: 'Concentric' },
  coincident: { symbol: '•', label: 'Coincident' },
  midpoint: { symbol: '△', label: 'Midpoint' },
  symmetric: { symbol: '↔', label: 'Symmetric' },
  'point-on-object': { symbol: '◇', label: 'Point on curve' },
  lock: { symbol: '▲', label: 'Lock' }
};

export interface SketchRelationGlyph {
  constraintId: string;
  kind: SketchRelationGlyphKind;
  symbol: string;
  label: string;
  /** Named by a measured non-zero residual in the last solve. */
  conflicted: boolean;
}

/** One cluster of glyphs drawn together at a plane-local anchor. */
export interface SketchRelationGlyphChip {
  key: string;
  /** On a curve (offset clear of the stroke) or on a point. */
  placement: 'object' | 'point';
  anchor: Point;
  glyphs: SketchRelationGlyph[];
}

export interface SketchRelationGlyphOptions {
  visibility: SketchRelationGlyphVisibility;
  /** With `selected`, only relations that mention this object are drawn. */
  selectedObjectId?: string | null;
  conflictingConstraintIds?: ReadonlySet<string>;
}

/**
 * Presentation-only layout of a sketch's relations: one glyph per relation
 * on each object or point it holds, gathered into one chip per curve and
 * per point so a corner's relations read as one cluster. Derived from
 * document geometry on every render; nothing here is persisted.
 */
export function sketchRelationGlyphs(
  objects: readonly { id: string; data: SketchObjectData }[],
  constraints: readonly SketchConstraint[],
  resolve: Resolve,
  options: SketchRelationGlyphOptions
): SketchRelationGlyphChip[] {
  if (options.visibility === 'hidden') return [];
  const selected = options.selectedObjectId ?? null;
  if (options.visibility === 'selected' && !selected) return [];
  const byId = new Map(objects.map((object) => [object.id, object.data]));
  const scalar = (value: number | string): number | undefined => {
    const result = resolve(value);
    return result !== undefined && Number.isFinite(result) ? result : undefined;
  };
  // Points that coincide after a solve agree to far better than this, so
  // they share one chip; the quantum scales with the sketch so large sketches
  // do not split a corner across chips.
  let extent = 1;
  for (const { data } of objects) {
    for (const value of Object.values(data)) {
      const number = typeof value === 'number' ? value : undefined;
      if (number !== undefined && Number.isFinite(number)) {
        extent = Math.max(extent, Math.abs(number));
      }
    }
  }
  const quantum = extent * 1e-6;
  const chips = new Map<string, SketchRelationGlyphChip>();
  const place = (
    key: string,
    placement: SketchRelationGlyphChip['placement'],
    anchor: Point,
    glyph: SketchRelationGlyph
  ) => {
    let chip = chips.get(key);
    if (!chip) {
      chip = { key, placement, anchor, glyphs: [] };
      chips.set(key, chip);
    }
    if (
      !chip.glyphs.some((entry) => entry.constraintId === glyph.constraintId)
    ) {
      chip.glyphs.push(glyph);
    }
  };
  const onObject = (objectId: string, glyph: SketchRelationGlyph) => {
    const anchor = objectAnchor(byId.get(objectId), scalar);
    if (anchor) place(`object:${objectId}`, 'object', anchor, glyph);
  };
  const onPoint = (ref: SketchPointRef, glyph: SketchRelationGlyph) => {
    const anchor = sketchPointPosition(
      byId.get(ref.objectId),
      ref.point,
      scalar
    );
    if (!anchor) return;
    const key = `point:${Math.round(anchor.x / quantum)},${Math.round(anchor.y / quantum)}`;
    place(key, 'point', anchor, glyph);
  };

  for (const constraint of constraints) {
    const data = constraint.data;
    if (
      data.constraintKind === 'distance' ||
      data.constraintKind === 'radius' ||
      data.constraintKind === 'angle'
    ) {
      continue;
    }
    if (
      options.visibility === 'selected' &&
      !constraintReferencesObject(data, selected!)
    ) {
      continue;
    }
    const constraintId = String(constraint.constraintId);
    const glyph: SketchRelationGlyph = {
      constraintId,
      kind: data.constraintKind,
      ...SKETCH_RELATION_GLYPHS[data.constraintKind],
      conflicted: options.conflictingConstraintIds?.has(constraintId) ?? false
    };
    switch (data.constraintKind) {
      case 'horizontal':
      case 'vertical':
        onObject(data.objectId, glyph);
        break;
      case 'parallel':
      case 'perpendicular':
      case 'equal':
      case 'tangent':
      case 'concentric':
        onObject(data.a, glyph);
        onObject(data.b, glyph);
        break;
      case 'coincident':
        onPoint(data.a, glyph);
        break;
      case 'midpoint':
      case 'point-on-object':
      case 'lock':
        onPoint(data.point, glyph);
        break;
      case 'symmetric':
        onPoint(data.a, glyph);
        onPoint(data.b, glyph);
        onObject(data.axis, glyph);
        break;
    }
  }
  return [...chips.values()];
}

/** Where a curve's own relations sit: a line's middle, a circle's 45°, an arc's mid-sweep. */
function objectAnchor(
  data: SketchObjectData | undefined,
  scalar: (value: number | string) => number | undefined
): Point | null {
  if (!data) return null;
  if (data.objectKind === 'line') {
    const x1 = scalar(data.x1);
    const y1 = scalar(data.y1);
    const x2 = scalar(data.x2);
    const y2 = scalar(data.y2);
    if (
      x1 === undefined ||
      y1 === undefined ||
      x2 === undefined ||
      y2 === undefined
    ) {
      return null;
    }
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }
  if (data.objectKind !== 'circle' && data.objectKind !== 'arc') return null;
  const cx = scalar(data.centerX);
  const cy = scalar(data.centerY);
  const radius = scalar(data.radius);
  if (cx === undefined || cy === undefined || radius === undefined) return null;
  let angleDeg = 45;
  if (data.objectKind === 'arc') {
    const start = scalar(data.startAngleDeg);
    const end = scalar(data.endAngleDeg);
    if (start === undefined || end === undefined) return null;
    try {
      angleDeg = start + boundedArcSweepDegrees(start, end) / 2;
    } catch {
      return null;
    }
  }
  const radians = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians)
  };
}
