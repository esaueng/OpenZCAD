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

import { splineBezierSegments } from '@openzcad/geometry';
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

function normalizedAngle(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
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

type EllipseEntity = Extract<DxfEntity, { kind: 'ellipse' }>;
type SplineEntity = Extract<DxfEntity, { kind: 'spline' }>;

/** The point at ellipse parameter `t`. */
function ellipseAt(entity: EllipseEntity, t: number): [number, number] {
  const [mx, my] = entity.majorAxis;
  const cos = Math.cos(t);
  // The minor axis is the major turned a quarter counter-clockwise.
  const sin = Math.sin(t) * entity.ratio;
  return [
    entity.center[0] + mx * cos - my * sin,
    entity.center[1] + my * cos + mx * sin
  ];
}

/** The spline's exact Bézier spans, control points as tuples. */
function splineSegments(entity: SplineEntity): [number, number][][] {
  return splineBezierSegments({
    degree: entity.degree,
    knots: [...entity.knots],
    controls: entity.controls.map(([x, y]) => ({ x, y })),
    closed: false
  }).map((segment) => segment.map((point) => [point.x, point.y]));
}

/** Bernstein value of one coordinate of a Bézier span at `t`. */
function bezierValue(values: readonly number[], t: number): number {
  let row = [...values];
  while (row.length > 1) {
    row = row
      .slice(1)
      .map((value, index) => row[index]! + (value - row[index]!) * t);
  }
  return row[0]!;
}

/** Interior parameters where one coordinate of a Bézier span is extreme. */
function bezierExtremes(values: readonly number[]): number[] {
  const degree = values.length - 1;
  // Derivative coefficients in the power basis of t.
  const d = values
    .slice(1)
    .map((value, index) => degree * (value - values[index]!));
  let roots: number[];
  if (d.length === 1) {
    roots = [];
  } else if (d.length === 2) {
    // Linear derivative d0(1 − t) + d1 t.
    const slope = d[1]! - d[0]!;
    roots = slope === 0 ? [] : [-d[0]! / slope];
  } else {
    // Quadratic derivative in Bernstein form d0, d1, d2.
    const a = d[0]! - 2 * d[1]! + d[2]!;
    const b = 2 * (d[1]! - d[0]!);
    const c = d[0]!;
    if (Math.abs(a) < 1e-15) {
      roots = b === 0 ? [] : [-c / b];
    } else {
      const disc = b * b - 4 * a * c;
      roots =
        disc < 0
          ? []
          : [
              (-b + Math.sqrt(disc)) / (2 * a),
              (-b - Math.sqrt(disc)) / (2 * a)
            ];
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
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
        const start = normalizedAngle(entity.startAngleDeg);
        include(bounds, ...pointAt(entity.center, entity.radius, start));
        include(
          bounds,
          ...pointAt(entity.center, entity.radius, start + sweep)
        );
        // Each multiple of 90° the sweep crosses is an axis extreme.
        // Work in one turn and visit each quadrant once. At a large finite
        // starting angle, adding 90 can round back to the same number.
        for (let quadrant = 0; quadrant < 4; quadrant += 1) {
          if (normalizedAngle(quadrant * 90 - start) > sweep) continue;
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
      case 'ellipse': {
        include(bounds, ...ellipseAt(entity, entity.startParam));
        include(bounds, ...ellipseAt(entity, entity.endParam));
        // dx/dt = 0 and dy/dt = 0 each hold at two opposite parameters.
        const [mx, my] = entity.majorAxis;
        const r = entity.ratio;
        const extremes = [
          Math.atan2(-my * r, mx),
          Math.atan2(mx * r, my)
        ].flatMap((t) => [t, t + Math.PI]);
        const sweep = entity.endParam - entity.startParam;
        for (const t of extremes) {
          const offset =
            (((t - entity.startParam) % (2 * Math.PI)) + 2 * Math.PI) %
            (2 * Math.PI);
          if (offset <= sweep) {
            include(bounds, ...ellipseAt(entity, t));
          }
        }
        break;
      }
      case 'spline':
        for (const segment of splineSegments(entity)) {
          include(bounds, ...segment[0]!);
          include(bounds, ...segment[segment.length - 1]!);
          for (const axis of [0, 1] as const) {
            const values = segment.map((point) => point[axis]);
            for (const t of bezierExtremes(values)) {
              include(
                bounds,
                bezierValue(
                  segment.map((point) => point[0]),
                  t
                ),
                bezierValue(
                  segment.map((point) => point[1]),
                  t
                )
              );
            }
          }
        }
        break;
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
      const start = normalizedAngle(entity.startAngleDeg);
      const [x0, y0] = pointAt(entity.center, entity.radius, start);
      const [x1, y1] = pointAt(entity.center, entity.radius, start + sweep);
      const r = num(entity.radius);
      // A nearly full turn can round to coincident SVG endpoints. One SVG
      // arc then draws nothing; two arcs retain the circle at our precision.
      if (sweep > 180 && num(x0) === num(x1) && num(y0) === num(y1)) {
        const [xm, ym] = pointAt(
          entity.center,
          entity.radius,
          start + sweep / 2
        );
        return `<path d="M${num(x0)} ${num(-y0)} A${r} ${r} 0 0 0 ${num(xm)} ${num(-ym)} A${r} ${r} 0 0 0 ${num(x1)} ${num(-y1)}"/>`;
      }
      // y is negated, so counter-clockwise in the sketch is sweep flag 0.
      return `<path d="M${num(x0)} ${num(-y0)} A${r} ${r} 0 ${sweep > 180 ? 1 : 0} 0 ${num(x1)} ${num(-y1)}"/>`;
    }
    case 'ellipse': {
      // Exact elliptical-arc commands, at most a half turn each so no
      // command's endpoints can coincide. With v negated, the major axis
      // at θ in the sketch sits at −θ in SVG, and counter-clockwise is
      // still sweep flag 0.
      const [mx, my] = entity.majorAxis;
      const rx = num(Math.hypot(mx, my));
      const ry = num(Math.hypot(mx, my) * entity.ratio);
      const tilt = num((-Math.atan2(my, mx) * 180) / Math.PI);
      const sweep = entity.endParam - entity.startParam;
      const pieces = Math.max(1, Math.ceil(sweep / Math.PI - 1e-12));
      const [x0, y0] = ellipseAt(entity, entity.startParam);
      const commands = [`M${num(x0)} ${num(-y0)}`];
      for (let piece = 1; piece <= pieces; piece += 1) {
        const [x, y] = ellipseAt(
          entity,
          entity.startParam + (sweep * piece) / pieces
        );
        commands.push(`A${rx} ${ry} ${tilt} 0 0 ${num(x)} ${num(-y)}`);
      }
      return `<path d="${commands.join(' ')}"/>`;
    }
    case 'spline': {
      // One exact Bézier command per knot span: Q for a quadratic, C for a
      // cubic. Nothing is sampled.
      const segments = splineSegments(entity);
      const first = segments[0]?.[0];
      if (!first) return '';
      const commands = [`M${num(first[0])} ${num(-first[1])}`];
      for (const segment of segments) {
        const rest = segment
          .slice(1)
          .map(([x, y]) => `${num(x)} ${num(-y)}`)
          .join(' ');
        if (segment.length === 4) {
          commands.push(`C${rest}`);
        } else if (segment.length === 3) {
          commands.push(`Q${rest}`);
        } else if (segment.length === 2) {
          commands.push(`L${rest}`);
        } else {
          throw new Error(
            `An SVG path has no degree-${segment.length - 1} curve command.`
          );
        }
      }
      return `<path d="${commands.join(' ')}"/>`;
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
