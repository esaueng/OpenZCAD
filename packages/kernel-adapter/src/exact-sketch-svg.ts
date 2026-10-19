/**
 * Whole-sketch → SVG (I07, export half).
 *
 * Serializes the entities `sketchDxfEntities` already lowers — the exact
 * analytic subset LINE, CIRCLE, ARC in sketch-local (u, v) coordinates — as
 * SVG `<line>`, `<circle>` and `<path>` arc elements. Nothing is sampled: an
 * arc is an SVG elliptical-arc command with equal radii, so a viewer draws the
 * same circle the sketch stores.
 *
 * Coordinates stay in DOCUMENT units: one SVG user unit is one document unit,
 * the viewBox is the drawing's bounds in those units, and `width`/`height`
 * carry the physical size so the file opens at 1:1. SVG has no metre unit, so
 * a metre document states its size in millimetres over the same viewBox.
 *
 * Sketch v points up and SVG y points down, so every v is negated. That
 * mirrors the drawing back the right way round, and turns the sketch's
 * counter-clockwise arcs into SVG's negative-angle direction (sweep flag 0).
 */

import { formatDxfNumber, type DxfEntity } from '@openzcad/io-dxf';
import type { UnitSystem } from '@openzcad/shared';

export interface SketchSvgOptions {
  readonly units: UnitSystem;
  /** Written as the drawing's `<title>`, escaped. */
  readonly title?: string;
  /**
   * False fills the viewBox with white behind the strokes. The default keeps
   * the background transparent, which is what an SVG with no fill already is.
   */
  readonly transparent?: boolean;
}

/** Stroke width on paper, in millimetres: a fine pen, visible at 1:1. */
const STROKE_MM = 0.25;

const MM_PER_UNIT: Record<UnitSystem, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  inch: 25.4
};

/** The physical unit `width`/`height` are stated in, and its size in document units. */
const SVG_LENGTH: Record<UnitSystem, { suffix: string; perUnit: number }> = {
  mm: { suffix: 'mm', perUnit: 1 },
  cm: { suffix: 'cm', perUnit: 1 },
  inch: { suffix: 'in', perUnit: 1 },
  m: { suffix: 'mm', perUnit: 1000 }
};

/** Same fixed-point form as the DXF writer: no exponents, nanometre-exact. */
const num = formatDxfNumber;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Counter-clockwise sweep in degrees, in (0, 360]. */
function arcSweep(entity: Extract<DxfEntity, { kind: 'arc' }>): number {
  const sweep = (entity.endAngleDeg - entity.startAngleDeg) % 360;
  return sweep <= 0 ? sweep + 360 : sweep;
}

function pointAt(
  center: readonly [number, number],
  radius: number,
  degrees: number
): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [
    center[0] + radius * Math.cos(radians),
    center[1] + radius * Math.sin(radians)
  ];
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function include(bounds: Bounds, x: number, y: number): void {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
}

/**
 * The exact extent of the curves in sketch coordinates: an arc contributes
 * its endpoints and every axis extreme its sweep passes, never a sampled
 * hull.
 */
export function sketchSvgBounds(entities: readonly DxfEntity[]): Bounds {
  const bounds: Bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity
  };
  for (const entity of entities) {
    switch (entity.kind) {
      case 'line':
        include(bounds, ...entity.start);
        include(bounds, ...entity.end);
        break;
      case 'polyline':
        for (const point of entity.points) include(bounds, ...point);
        break;
      case 'circle':
        include(
          bounds,
          entity.center[0] - entity.radius,
          entity.center[1] - entity.radius
        );
        include(
          bounds,
          entity.center[0] + entity.radius,
          entity.center[1] + entity.radius
        );
        break;
      case 'arc': {
        const sweep = arcSweep(entity);
        include(
          bounds,
          ...pointAt(entity.center, entity.radius, entity.startAngleDeg)
        );
        include(
          bounds,
          ...pointAt(entity.center, entity.radius, entity.startAngleDeg + sweep)
        );
        // Each multiple of 90° the sweep crosses is an axis extreme.
        const first = Math.ceil(entity.startAngleDeg / 90) * 90;
        for (
          let angle = first;
          angle < entity.startAngleDeg + sweep;
          angle += 90
        ) {
          const quadrant = (((angle / 90) % 4) + 4) % 4;
          const [cx, cy] = entity.center;
          const r = entity.radius;
          include(
            bounds,
            quadrant === 0 ? cx + r : quadrant === 2 ? cx - r : cx,
            quadrant === 1 ? cy + r : quadrant === 3 ? cy - r : cy
          );
        }
        break;
      }
    }
  }
  return bounds;
}

function element(entity: DxfEntity): string {
  switch (entity.kind) {
    case 'line':
      return `<line x1="${num(entity.start[0])}" y1="${num(-entity.start[1])}" x2="${num(entity.end[0])}" y2="${num(-entity.end[1])}"/>`;
    case 'circle':
      return `<circle cx="${num(entity.center[0])}" cy="${num(-entity.center[1])}" r="${num(entity.radius)}"/>`;
    case 'polyline': {
      const [first, ...rest] = entity.points;
      if (!first) return '';
      const segments = rest.map((p) => `L${num(p[0])} ${num(-p[1])}`);
      return `<path d="M${num(first[0])} ${num(-first[1])}${segments.length > 0 ? ' ' : ''}${segments.join(' ')}${entity.closed ? ' Z' : ''}"/>`;
    }
    case 'arc': {
      const sweep = arcSweep(entity);
      const [x0, y0] = pointAt(
        entity.center,
        entity.radius,
        entity.startAngleDeg
      );
      const [x1, y1] = pointAt(
        entity.center,
        entity.radius,
        entity.startAngleDeg + sweep
      );
      const r = num(entity.radius);
      // y is negated, so counter-clockwise in the sketch is sweep flag 0.
      return `<path d="M${num(x0)} ${num(-y0)} A${r} ${r} 0 ${sweep > 180 ? 1 : 0} 0 ${num(x1)} ${num(-y1)}"/>`;
    }
  }
}

/**
 * Write sketch-local entities, in document units, as a standalone SVG 1.1
 * document. Throws on an empty or non-finite drawing — the caller has already
 * refused both by name, so reaching here with either is a bug.
 */
export function writeSketchSvg(
  entities: readonly DxfEntity[],
  options: SketchSvgOptions
): string {
  if (entities.length === 0) {
    throw new Error('An SVG export needs at least one curve.');
  }
  const bounds = sketchSvgBounds(entities);
  if (
    ![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
  ) {
    throw new Error('The sketch extent is not finite.');
  }
  const stroke = STROKE_MM / MM_PER_UNIT[options.units];
  // Half a stroke of margin each side, so the outermost curves are not
  // clipped down the middle of their pen line.
  const pad = stroke / 2;
  const minX = bounds.minX - pad;
  // Negated v: the top of the drawing is the largest sketch v.
  const minY = -bounds.maxY - pad;
  const width = bounds.maxX - bounds.minX + 2 * pad;
  const height = bounds.maxY - bounds.minY + 2 * pad;
  const length = SVG_LENGTH[options.units];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${num(width * length.perUnit)}${length.suffix}" height="${num(height * length.perUnit)}${length.suffix}" viewBox="${num(minX)} ${num(minY)} ${num(width)} ${num(height)}">`
  ];
  if (options.title) {
    lines.push(`<title>${escapeXml(options.title)}</title>`);
  }
  if (options.transparent === false) {
    lines.push(
      `<rect x="${num(minX)}" y="${num(minY)}" width="${num(width)}" height="${num(height)}" fill="#ffffff"/>`
    );
  }
  lines.push(
    `<g fill="none" stroke="#000000" stroke-width="${num(stroke)}" stroke-linecap="round" stroke-linejoin="round">`
  );
  for (const entity of entities) {
    lines.push(element(entity));
  }
  lines.push('</g>', '</svg>', '');
  return lines.join('\n');
}
