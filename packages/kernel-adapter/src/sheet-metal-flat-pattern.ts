/**
 * M16 slice 4: the sheet-metal flat pattern as files — a layered DXF R12
 * for the laser or punch and the brake, and an SVG of the same drawing.
 *
 * Pure: both read the adapter's {@link SheetMetalFlatPattern} (sketch-local
 * 2D in document units) and never touch the kernel, so the lazy flat-pattern
 * dialog reaches this module as a leaf without pulling the exact kernel into
 * its chunk.
 *
 * Layers (spec "Outputs"): `0` holds the cut outline, holes included, exactly
 * as the face-outline export writes it, so an existing CAM setup that reads
 * layer 0 keeps working; `BEND_UP` and `BEND_DOWN` hold the bend centre
 * lines, dashed and in distinct colours; `BEND_NOTES` holds one TEXT per
 * bend line such as `UP 90° R1.5`, beside its line and turned along it.
 */

import {
  writeDxf,
  type DxfEntity,
  type DxfLayer,
  type DxfText
} from '@openzcad/io-dxf';
import { millimetresPerUnit, type UnitSystem } from '@openzcad/shared';
import type {
  SheetMetalFlatPattern,
  SheetMetalFlatPatternBend
} from './exact-sheet-metal';
import { sketchSvgBounds, sketchSvgElement } from './exact-sketch-svg';

export type { SheetMetalFlatPattern, SheetMetalFlatPatternBend };

export const FLAT_PATTERN_OUTLINE_LAYER = '0';
export const FLAT_PATTERN_BEND_UP_LAYER = 'BEND_UP';
export const FLAT_PATTERN_BEND_DOWN_LAYER = 'BEND_DOWN';
export const FLAT_PATTERN_NOTES_LAYER = 'BEND_NOTES';

/**
 * The layer table every flat-pattern DXF declares, whether or not a layer
 * has entities, so a CAM template can map the names once. ACI colours: 7
 * (white/black) for the cut, 5 blue for up, 1 red for down, 7 for notes.
 */
export const FLAT_PATTERN_DXF_LAYERS: readonly DxfLayer[] = [
  { name: FLAT_PATTERN_OUTLINE_LAYER, color: 7 },
  { name: FLAT_PATTERN_BEND_UP_LAYER, color: 5, lineType: 'DASHED' },
  { name: FLAT_PATTERN_BEND_DOWN_LAYER, color: 1, lineType: 'DASHED' },
  { name: FLAT_PATTERN_NOTES_LAYER, color: 7 }
];

/** Bend-note text height on paper at 1:1, in millimetres. */
const NOTE_HEIGHT_MM = 2.5;
/** The average glyph advance the SVG bounds also allow, × height. */
const GLYPH_ADVANCE = 0.6;
/** Gap between a bend line and its note's baseline, × height. */
const NOTE_GAP = 0.5;

/**
 * A flat-pattern value as the notes, the bend table and the size readout all
 * write it: the app's three decimals, trailing zeros dropped (`1.5`,
 * `96.524`), but never fewer than four significant digits, so a small value
 * in a large unit (a 0.0004 m radius) keeps its size instead of rounding to
 * `0`. Non-finite values read `—`.
 */
export function formatFlatPatternNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1e7) return value.toExponential(3);
  const decimals = Math.min(15, Math.max(3, 3 - Math.floor(Math.log10(abs))));
  const fixed = value.toFixed(decimals).replace(/\.?0+$/, '');
  return fixed === '-0' || fixed === '' ? '0' : fixed;
}

/** `UP 90° R1.5`: direction, angle and inside radius of one bend line. */
export function flatPatternBendNote(bend: SheetMetalFlatPatternBend): string {
  return `${bend.direction === 'up' ? 'UP' : 'DOWN'} ${formatFlatPatternNumber(bend.angleDeg)}° R${formatFlatPatternNumber(bend.insideRadius)}`;
}

/**
 * Each bend line's number in the bend table: bends count from 1 in the
 * pattern's order, and a bend whose line crosses the sheet in several pieces
 * numbers them `2.1`, `2.2`, … along its line.
 */
export function flatPatternBendLabels(
  pattern: Pick<SheetMetalFlatPattern, 'bends'>
): string[] {
  const order = new Map<string, number>();
  const pieces = new Map<string, number>();
  for (const bend of pattern.bends) {
    if (!order.has(bend.bendId)) order.set(bend.bendId, order.size + 1);
    pieces.set(bend.bendId, (pieces.get(bend.bendId) ?? 0) + 1);
  }
  return pattern.bends.map((bend) => {
    const number = order.get(bend.bendId)!;
    return pieces.get(bend.bendId)! > 1
      ? `${number}.${bend.piece + 1}`
      : String(number);
  });
}

/**
 * The note for one bend line: centred on the line, its baseline half a text
 * height to the line's left as read, turned along the line and kept
 * readable (never upside down). A short line gets smaller text, so the note
 * stays within the line's length.
 */
function bendNoteEntity(
  bend: SheetMetalFlatPatternBend,
  units: UnitSystem
): DxfText | null {
  const [[x0, y0], [x1, y1]] = bend.segment;
  const length = Math.hypot(x1 - x0, y1 - y0);
  if (!(length > 0)) return null;
  const text = flatPatternBendNote(bend);
  const nominal = NOTE_HEIGHT_MM / millimetresPerUnit(units);
  const fit = (0.9 * length) / (GLYPH_ADVANCE * [...text].length);
  const height = Math.min(nominal, fit);
  let angle = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
  if (angle > 90 + 1e-9) angle -= 180;
  else if (angle <= -90 + 1e-9) angle += 180;
  const radians = (angle * Math.PI) / 180;
  const offset = NOTE_GAP * height;
  return {
    kind: 'text',
    layer: FLAT_PATTERN_NOTES_LAYER,
    position: [
      (x0 + x1) / 2 - Math.sin(radians) * offset,
      (y0 + y1) / 2 + Math.cos(radians) * offset
    ],
    height,
    text,
    rotationDeg: Math.abs(angle) < 5e-4 ? 0 : angle,
    align: 'center'
  };
}

/** The outline entities on layer 0, outer loop first. */
function outlineEntities(pattern: SheetMetalFlatPattern): DxfEntity[] {
  return pattern.loops.flatMap((loop) =>
    loop.entities.map((entity): DxfEntity => ({
      ...entity,
      layer: FLAT_PATTERN_OUTLINE_LAYER
    }))
  );
}

/** The bend centre lines, each on its direction's layer. */
function bendLineEntities(pattern: SheetMetalFlatPattern): DxfEntity[] {
  return pattern.bends.map((bend) => ({
    kind: 'line',
    layer:
      bend.direction === 'up'
        ? FLAT_PATTERN_BEND_UP_LAYER
        : FLAT_PATTERN_BEND_DOWN_LAYER,
    start: bend.segment[0],
    end: bend.segment[1]
  }));
}

/**
 * Every entity of the flat-pattern drawing, in document units: the outline
 * on layer 0, then the bend lines, then their notes.
 */
export function flatPatternDxfEntities(
  pattern: SheetMetalFlatPattern,
  units: UnitSystem
): DxfEntity[] {
  return [
    ...outlineEntities(pattern),
    ...bendLineEntities(pattern),
    ...pattern.bends.flatMap((bend) => bendNoteEntity(bend, units) ?? [])
  ];
}

/**
 * The flat pattern as a DXF R12 document in the document's units, which
 * `$INSUNITS` states. Outline arcs and circles stay exact ARC and CIRCLE
 * entities, as the face-outline export writes them.
 */
export function flatPatternDxf(
  pattern: SheetMetalFlatPattern,
  units: UnitSystem
): string {
  return writeDxf(flatPatternDxfEntities(pattern, units), {
    units,
    layers: FLAT_PATTERN_DXF_LAYERS
  });
}

/** The outline's exact extent in sketch coordinates (document units). */
export function flatPatternExtents(pattern: SheetMetalFlatPattern): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  const bounds = sketchSvgBounds(outlineEntities(pattern));
  return {
    ...bounds,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY
  };
}

export interface FlatPatternSvgOptions {
  /** The document's units: one SVG user unit is one of them. */
  readonly units: UnitSystem;
  /** Written as the drawing's `<title>`, escaped. */
  readonly title?: string;
  /** False paints white behind the drawing; absent keeps it transparent. */
  readonly transparent?: boolean;
}

/** SVG colours matching the DXF layers' ACI colours. */
export const FLAT_PATTERN_SVG_COLORS = {
  outline: '#000000',
  up: '#1f5fbf',
  down: '#c62828',
  notes: '#000000'
} as const;

/** Physical unit for width/height, as the sketch SVG export states them. */
const SVG_LENGTH: Record<UnitSystem, { suffix: string; perUnit: number }> = {
  mm: { suffix: 'mm', perUnit: 1 },
  cm: { suffix: 'cm', perUnit: 1 },
  inch: { suffix: 'in', perUnit: 1 },
  m: { suffix: 'mm', perUnit: 1000 }
};

function svgNumber(value: number): string {
  const fixed = value.toFixed(9).replace(/\.?0+$/, '');
  return fixed === '-0' || fixed === '' ? '0' : fixed;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The flat pattern as a standalone SVG at 1:1 in the document's units: the
 * outline solid, up bend lines dashed in blue, down bend lines dash-dotted
 * in red (so they differ in print too), and the notes. Each layer is one
 * `<g data-layer="…">` named as in the DXF.
 */
export function flatPatternSvg(
  pattern: SheetMetalFlatPattern,
  options: FlatPatternSvgOptions
): string {
  const outline = outlineEntities(pattern);
  if (outline.length === 0) {
    throw new Error('The flat pattern has no outline to draw.');
  }
  const up = bendLineEntities(pattern).filter(
    (entity) => entity.layer === FLAT_PATTERN_BEND_UP_LAYER
  );
  const down = bendLineEntities(pattern).filter(
    (entity) => entity.layer === FLAT_PATTERN_BEND_DOWN_LAYER
  );
  const notes = pattern.bends.flatMap(
    (bend) => bendNoteEntity(bend, options.units) ?? []
  );
  const bounds = sketchSvgBounds([...outline, ...up, ...down, ...notes]);
  if (
    ![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
  ) {
    throw new Error('The flat pattern extent is not finite.');
  }
  const mm = 1 / millimetresPerUnit(options.units);
  const stroke = 0.25 * mm;
  const pad = 1 * mm;
  const minX = bounds.minX - pad;
  const minY = -bounds.maxY - pad;
  const width = bounds.maxX - bounds.minX + 2 * pad;
  const height = bounds.maxY - bounds.minY + 2 * pad;
  const length = SVG_LENGTH[options.units];
  const n = svgNumber;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${n(width * length.perUnit)}${length.suffix}" height="${n(height * length.perUnit)}${length.suffix}" viewBox="${n(minX)} ${n(minY)} ${n(width)} ${n(height)}">`
  ];
  if (options.title) lines.push(`<title>${escapeXml(options.title)}</title>`);
  if (options.transparent === false) {
    lines.push(
      `<rect x="${n(minX)}" y="${n(minY)}" width="${n(width)}" height="${n(height)}" fill="#ffffff"/>`
    );
  }
  const group = (
    layer: string,
    color: string,
    dash: number[] | null,
    entities: DxfEntity[]
  ) => {
    if (entities.length === 0) return;
    const dashes = dash
      ? ` stroke-dasharray="${dash.map((value) => n(value * mm)).join(' ')}"`
      : '';
    lines.push(
      `<g data-layer="${layer}" fill="none" stroke="${color}" stroke-width="${n(stroke)}" stroke-linecap="round" stroke-linejoin="round"${dashes}>`,
      ...entities.map(sketchSvgElement),
      '</g>'
    );
  };
  group(
    FLAT_PATTERN_OUTLINE_LAYER,
    FLAT_PATTERN_SVG_COLORS.outline,
    null,
    outline
  );
  group(FLAT_PATTERN_BEND_UP_LAYER, FLAT_PATTERN_SVG_COLORS.up, [3, 1.5], up);
  group(
    FLAT_PATTERN_BEND_DOWN_LAYER,
    FLAT_PATTERN_SVG_COLORS.down,
    [3, 1, 0.5, 1],
    down
  );
  group(FLAT_PATTERN_NOTES_LAYER, FLAT_PATTERN_SVG_COLORS.notes, null, notes);
  lines.push('</svg>', '');
  return lines.join('\n');
}
