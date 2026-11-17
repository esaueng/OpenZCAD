import type {
  DrawingGeometricCharacteristic,
  DrawingMaterialCondition
} from '@openzcad/shared';
import {
  sheetSafeText,
  textWidthMm,
  type SheetStroke,
  type SheetText
} from './sheetPage';

/**
 * D07 (schema v98): the page geometry of geometric tolerancing — feature
 * control frames and datum feature symbols — as the one page model's
 * strokes and text, so the preview, PDF, SVG and DXF draw the same thing.
 *
 * Sheet text is base-14 Helvetica (WinAnsi), which has none of the GD&T
 * characters (⌖, ⏥, ⌭, …), so every characteristic symbol and every
 * circled modifier (Ⓜ, Ⓛ) is drawn as strokes in its cell, proportioned
 * after ASME Y14.5-2018 figure 3-1 and ISO 1101 table 3. The Ø of a
 * cylindrical zone is text: Ø is in WinAnsi.
 */

type XY = [number, number];

export interface FrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameLayout {
  strokes: SheetStroke[];
  texts: SheetText[];
  box: FrameBox;
}

/** A resolved frame's compartments, already in the sheet's number format. */
export interface FrameCells {
  characteristic: DrawingGeometricCharacteristic;
  /** "0.1" or "0,1": the amount, with no Ø or modifier. */
  tolerance: string;
  diameterZone: boolean;
  material?: DrawingMaterialCondition;
  datums: { letter: string; material?: DrawingMaterialCondition }[];
}

/** Frame text height; the frame is twice as tall (Y14.5 3.4.1, ISO 1101). */
const FRAME_TEXT_MM = 3;
export const FRAME_HEIGHT_MM = 2 * FRAME_TEXT_MM;
const CELL_PAD_MM = 1.2;
/** A circled modifier's circle radius and its letter's height. */
const MODIFIER_RADIUS_MM = 1.6;
const MODIFIER_TEXT_MM = 2;
const MODIFIER_GAP_MM = 0.6;
const LEADER_ARROW_MM = 3;
const LEADER_ARROW_HALF_MM = 0.5;
/** The datum triangle's height and half base (Y14.5 fig. 3-1: 60°). */
const DATUM_TRIANGLE_MM = 2.6;
const DATUM_TRIANGLE_HALF_MM = DATUM_TRIANGLE_MM / Math.sqrt(3);

export const CHARACTERISTIC_LABELS: Readonly<
  Record<DrawingGeometricCharacteristic, string>
> = {
  straightness: 'Straightness',
  flatness: 'Flatness',
  circularity: 'Circularity',
  cylindricity: 'Cylindricity',
  'profile-line': 'Profile of a line',
  'profile-surface': 'Profile of a surface',
  parallelism: 'Parallelism',
  perpendicularity: 'Perpendicularity',
  angularity: 'Angularity',
  position: 'Position',
  concentricity: 'Concentricity',
  symmetry: 'Symmetry',
  'circular-runout': 'Circular runout',
  'total-runout': 'Total runout'
};

function stroke(points: number[], closed = false): SheetStroke {
  return { kind: 'dimension', points, ...(closed ? { closed: true } : {}) };
}

function circle(center: XY, radius: number, steps = 32): SheetStroke {
  const points: number[] = [];
  for (let i = 0; i < steps; i += 1) {
    const angle = (2 * Math.PI * i) / steps;
    points.push(
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle)
    );
  }
  return stroke(points, true);
}

function arc(
  center: XY,
  radius: number,
  from: number,
  to: number,
  steps = 16
): number[] {
  const points: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = from + ((to - from) * i) / steps;
    points.push(
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle)
    );
  }
  return points;
}

function filledArrow(
  tip: XY,
  direction: XY,
  length: number,
  halfWidth: number
): SheetStroke {
  const [dx, dy] = direction;
  const bx = tip[0] - dx * length;
  const by = tip[1] - dy * length;
  return {
    kind: 'dimension',
    filled: true,
    closed: true,
    points: [
      tip[0],
      tip[1],
      bx - dy * halfWidth,
      by + dx * halfWidth,
      bx + dy * halfWidth,
      by - dx * halfWidth
    ]
  };
}

/** A slanted runout arrow from `from` to `to`, its head filled. */
function runoutArrow(from: XY, to: XY): SheetStroke[] {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const d: XY = [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
  const head = Math.min(1.2, length / 2);
  return [
    stroke([from[0], from[1], to[0] - d[0] * head, to[1] - d[1] * head]),
    filledArrow(to, d, head, 0.45)
  ];
}

/**
 * A characteristic's symbol centred on `c`, fitting a square of half-size
 * `s`.
 */
export function characteristicSymbol(
  characteristic: DrawingGeometricCharacteristic,
  c: XY,
  s: number
): SheetStroke[] {
  const [x, y] = c;
  switch (characteristic) {
    case 'straightness':
      return [stroke([x - s, y, x + s, y])];
    case 'flatness':
      return [
        stroke(
          [
            x - s,
            y - 0.45 * s,
            x + 0.45 * s,
            y - 0.45 * s,
            x + s,
            y + 0.45 * s,
            x - 0.45 * s,
            y + 0.45 * s
          ],
          true
        )
      ];
    case 'circularity':
      return [circle(c, 0.8 * s)];
    case 'cylindricity': {
      const r = 0.6 * s;
      const angle = Math.PI / 3;
      const d: XY = [Math.cos(angle), Math.sin(angle)];
      const n: XY = [-d[1], d[0]];
      const run = 1.05 * s;
      const side = (sign: number) =>
        stroke([
          x + sign * n[0] * r - d[0] * run,
          y + sign * n[1] * r - d[1] * run,
          x + sign * n[0] * r + d[0] * run,
          y + sign * n[1] * r + d[1] * run
        ]);
      return [circle(c, r), side(1), side(-1)];
    }
    case 'profile-line':
      return [stroke(arc([x, y - 0.5 * s], s, 0, Math.PI))];
    case 'profile-surface':
      return [stroke(arc([x, y - 0.5 * s], s, 0, Math.PI), true)];
    case 'parallelism':
      return [
        stroke([x - 0.8 * s, y - s, x, y + s]),
        stroke([x, y - s, x + 0.8 * s, y + s])
      ];
    case 'perpendicularity':
      return [
        stroke([x - s, y - s, x + s, y - s]),
        stroke([x, y - s, x, y + s])
      ];
    case 'angularity': {
      const angle = Math.PI / 6;
      const run = 2 * s;
      return [
        stroke([
          x + s,
          y - s,
          x - s,
          y - s,
          x - s + run * Math.cos(angle),
          y - s + run * Math.sin(angle)
        ])
      ];
    }
    case 'position':
      return [
        circle(c, 0.6 * s),
        stroke([x - s, y, x + s, y]),
        stroke([x, y - s, x, y + s])
      ];
    case 'concentricity':
      return [circle(c, 0.4 * s), circle(c, 0.85 * s)];
    case 'symmetry':
      return [
        stroke([x - 0.6 * s, y + 0.55 * s, x + 0.6 * s, y + 0.55 * s]),
        stroke([x - s, y, x + s, y]),
        stroke([x - 0.6 * s, y - 0.55 * s, x + 0.6 * s, y - 0.55 * s])
      ];
    case 'circular-runout':
      return runoutArrow([x - 0.55 * s, y - s], [x + 0.55 * s, y + s]);
    case 'total-runout':
      return [
        stroke([x - s, y - s, x + 0.6 * s, y - s]),
        ...runoutArrow([x - s, y - s], [x - 0.1 * s, y + s]),
        ...runoutArrow([x - 0.1 * s, y - s], [x + 0.8 * s, y + s])
      ];
  }
}

/** A circled M or L, centred on `c`. */
function materialModifier(
  material: DrawingMaterialCondition,
  c: XY
): { strokes: SheetStroke[]; text: SheetText } {
  return {
    strokes: [circle(c, MODIFIER_RADIUS_MM, 24)],
    text: {
      x: c[0],
      y: c[1] - MODIFIER_TEXT_MM / 2,
      sizeMm: MODIFIER_TEXT_MM,
      text: material === 'mmc' ? 'M' : 'L',
      align: 'middle'
    }
  };
}

const MODIFIER_WIDTH_MM = MODIFIER_GAP_MM + 2 * MODIFIER_RADIUS_MM;

/**
 * A feature control frame with its top-left corner at `topLeft`: the
 * symbol's square cell, the tolerance cell (Ø, amount, modifier), then one
 * cell per datum reference, each a thin-ruled compartment.
 */
export function featureControlFrameLayout(
  cells: FrameCells,
  topLeft: XY
): FrameLayout {
  const h = FRAME_HEIGHT_MM;
  const [x0, top] = topLeft;
  const bottom = top - h;
  const middle = top - h / 2;
  const strokes: SheetStroke[] = [];
  const texts: SheetText[] = [];
  const baseline = middle - FRAME_TEXT_MM / 2;
  const dividers: number[] = [];
  // The symbol's cell is square.
  strokes.push(
    ...characteristicSymbol(cells.characteristic, [x0 + h / 2, middle], 0.3 * h)
  );
  let x = x0 + h;
  dividers.push(x);
  // The tolerance: Ø, the amount, a circled modifier.
  const amount = sheetSafeText(
    `${cells.diameterZone ? 'Ø' : ''}${cells.tolerance}`
  );
  const amountWidth = textWidthMm(amount, FRAME_TEXT_MM);
  texts.push({
    x: x + CELL_PAD_MM,
    y: baseline,
    sizeMm: FRAME_TEXT_MM,
    text: amount
  });
  let width = CELL_PAD_MM + amountWidth;
  if (cells.material) {
    const modifier = materialModifier(cells.material, [
      x + width + MODIFIER_GAP_MM + MODIFIER_RADIUS_MM,
      middle
    ]);
    strokes.push(...modifier.strokes);
    texts.push(modifier.text);
    width += MODIFIER_WIDTH_MM;
  }
  x += width + CELL_PAD_MM;
  for (const datum of cells.datums) {
    dividers.push(x);
    const letter = sheetSafeText(datum.letter);
    const letterWidth = textWidthMm(letter, FRAME_TEXT_MM);
    const inner = letterWidth + (datum.material ? MODIFIER_WIDTH_MM : 0);
    const cell = Math.max(h, inner + 2 * CELL_PAD_MM);
    const start = x + (cell - inner) / 2;
    texts.push({ x: start, y: baseline, sizeMm: FRAME_TEXT_MM, text: letter });
    if (datum.material) {
      const modifier = materialModifier(datum.material, [
        start + letterWidth + MODIFIER_GAP_MM + MODIFIER_RADIUS_MM,
        middle
      ]);
      strokes.push(...modifier.strokes);
      texts.push(modifier.text);
    }
    x += cell;
  }
  const total = x - x0;
  strokes.push(stroke([x0, top, x, top, x, bottom, x0, bottom], true));
  for (const divider of dividers)
    strokes.push(stroke([divider, top, divider, bottom]));
  return { strokes, texts, box: { x: x0, y: bottom, width: total, height: h } };
}

/** The point of a box's outline nearest `to` (on it when `to` is inside). */
export function nearestOnBox(box: FrameBox, to: XY): XY {
  const clamp = (value: number, low: number, high: number) =>
    Math.min(Math.max(value, low), high);
  const inside =
    to[0] > box.x &&
    to[0] < box.x + box.width &&
    to[1] > box.y &&
    to[1] < box.y + box.height;
  if (!inside)
    return [
      clamp(to[0], box.x, box.x + box.width),
      clamp(to[1], box.y, box.y + box.height)
    ];
  // Inside: the nearest side.
  const sides: [number, XY][] = [
    [to[0] - box.x, [box.x, to[1]]],
    [box.x + box.width - to[0], [box.x + box.width, to[1]]],
    [to[1] - box.y, [to[0], box.y]],
    [box.y + box.height - to[1], [to[0], box.y + box.height]]
  ];
  sides.sort((a, b) => a[0] - b[0]);
  return sides[0]![1];
}

/**
 * A leader from a frame to `tip` on the model, ending in an arrow: from the
 * middle of the frame's side facing the tip (Y14.5 fig. 3-26).
 */
export function frameLeader(box: FrameBox, tip: XY): SheetStroke[] {
  const middleY = box.y + box.height / 2;
  const from: XY =
    tip[0] < box.x
      ? [box.x, middleY]
      : tip[0] > box.x + box.width
        ? [box.x + box.width, middleY]
        : tip[1] < box.y
          ? [box.x + box.width / 2, box.y]
          : [box.x + box.width / 2, box.y + box.height];
  const length = Math.hypot(tip[0] - from[0], tip[1] - from[1]);
  if (length < 1e-6) return [];
  const d: XY = [(tip[0] - from[0]) / length, (tip[1] - from[1]) / length];
  const head = Math.min(LEADER_ARROW_MM, length);
  return [
    stroke([from[0], from[1], tip[0] - d[0] * head, tip[1] - d[1] * head]),
    filledArrow(tip, d, head, LEADER_ARROW_HALF_MM)
  ];
}

/**
 * A datum feature symbol: its letter in a square frame centred on
 * `center`, joined by a line to a filled triangle whose base sits on `foot`
 * (a point of the datum feature's outline, or of the dimension or frame it
 * hangs from), square to the line.
 */
export function datumFeatureLayout(
  letter: string,
  center: XY,
  foot: XY | null
): FrameLayout {
  const safe = sheetSafeText(letter);
  const side = Math.max(
    FRAME_HEIGHT_MM,
    textWidthMm(safe, FRAME_TEXT_MM) + 2 * CELL_PAD_MM
  );
  const half = side / 2;
  const box: FrameBox = {
    x: center[0] - half,
    y: center[1] - FRAME_HEIGHT_MM / 2,
    width: side,
    height: FRAME_HEIGHT_MM
  };
  const strokes: SheetStroke[] = [
    stroke(
      [
        box.x,
        box.y,
        box.x + box.width,
        box.y,
        box.x + box.width,
        box.y + box.height,
        box.x,
        box.y + box.height
      ],
      true
    )
  ];
  if (foot) {
    const length = Math.hypot(foot[0] - center[0], foot[1] - center[1]);
    if (length > 1e-6) {
      const d: XY = [
        (foot[0] - center[0]) / length,
        (foot[1] - center[1]) / length
      ];
      const n: XY = [-d[1], d[0]];
      // Where the line leaves the frame.
      const exit = Math.min(
        Math.abs(d[0]) > 1e-9 ? half / Math.abs(d[0]) : Infinity,
        Math.abs(d[1]) > 1e-9 ? FRAME_HEIGHT_MM / 2 / Math.abs(d[1]) : Infinity
      );
      const apex: XY = [
        foot[0] - d[0] * DATUM_TRIANGLE_MM,
        foot[1] - d[1] * DATUM_TRIANGLE_MM
      ];
      if (length - exit > DATUM_TRIANGLE_MM)
        strokes.push(
          stroke([
            center[0] + d[0] * exit,
            center[1] + d[1] * exit,
            apex[0],
            apex[1]
          ])
        );
      strokes.push({
        kind: 'dimension',
        filled: true,
        closed: true,
        points: [
          apex[0],
          apex[1],
          foot[0] + n[0] * DATUM_TRIANGLE_HALF_MM,
          foot[1] + n[1] * DATUM_TRIANGLE_HALF_MM,
          foot[0] - n[0] * DATUM_TRIANGLE_HALF_MM,
          foot[1] - n[1] * DATUM_TRIANGLE_HALF_MM
        ]
      });
    }
  }
  return {
    strokes,
    texts: [
      {
        x: center[0],
        y: center[1] - FRAME_TEXT_MM / 2,
        sizeMm: FRAME_TEXT_MM,
        text: safe,
        align: 'middle'
      }
    ],
    box
  };
}

/** The frame's words, for lists, the assistant digest and status text. */
export function featureControlFrameLabel(cells: FrameCells): string {
  const modifier = (material?: DrawingMaterialCondition) =>
    material === 'mmc' ? ' (M)' : material === 'lmc' ? ' (L)' : '';
  return [
    CHARACTERISTIC_LABELS[cells.characteristic],
    `${cells.diameterZone ? 'Ø' : ''}${cells.tolerance}${modifier(cells.material)}`,
    ...cells.datums.map((datum) => `${datum.letter}${modifier(datum.material)}`)
  ].join(' | ');
}
