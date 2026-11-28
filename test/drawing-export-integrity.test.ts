import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  normalizeDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  DRAWING_VIEW_FRAMES,
  drawingPaperMm,
  toUserId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';
import {
  bodySilhouettes,
  projectView,
  type ViewProjection
} from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import {
  composeSheetPage,
  joinHiddenRuns,
  sectionCaption,
  sectionNoteRefusal,
  SECTION_APPROXIMATE_NOTE,
  SHEET_HIDDEN_DASH_MM,
  sheetBoxOnPaper,
  sheetMarksOnPaper,
  textWidthMm,
  titleBlockBox,
  viewPageBox,
  viewPlacementIssue,
  type ComposedView,
  type SheetPage
} from '../apps/web/src/lib/drawing/sheetPage';
import {
  sheetPageToDxf,
  sheetPageToPdf,
  sheetPageToSvg
} from '../apps/web/src/lib/drawing/sheetExport';
import {
  composeSheetAnnotations,
  resolveSheetAnnotations
} from '../apps/web/src/lib/drawing/annotations';
import {
  sheetFailedBodies,
  sheetSourceFailureMessage
} from '../apps/web/src/lib/drawing/sourceFailure';

/**
 * Drawing export integrity: an exported sheet says what its paper says.
 * Every annotation the sheet lists prints whole or the export refuses
 * (#2166); hidden edges print dashed however finely hidden-line removal cut
 * them (#2073); a section cut from the tessellation says so on the paper
 * (#2110); and a sheet of a model that failed to rebuild names the failure
 * (#2382). Each is read back out of the SVG, PDF and DXF the writers make.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

function svgTexts(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
}

/** The elements of one stroke kind's SVG group. */
function svgGroup(svg: string, kind: string): string[] {
  const group = new RegExp(`<g class="${kind}"[^>]*>([\\s\\S]*?)</g>`).exec(
    svg
  );
  return group
    ? [...group[1]!.matchAll(/<(polyline|polygon)[^>]*\/>/g)].map((m) => m[0])
    : [];
}

function svgPoints(element: string): [number, number][] {
  const points = /points="([^"]*)"/.exec(element)![1]!;
  return points
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number) as [number, number]);
}

function perimeter(points: [number, number][], closed: boolean): number {
  let length = 0;
  const path = closed ? [...points, points[0]!] : points;
  for (let i = 1; i < path.length; i += 1)
    length += Math.hypot(
      path[i]![0] - path[i - 1]![0],
      path[i]![1] - path[i - 1]![1]
    );
  return length;
}

/** The PDF content stream's paths drawn under the hidden-line dash. */
function pdfHiddenPaths(pdf: string): string[] {
  const lines = pdf.split('\n');
  // 3 mm and 1.5 mm in points: SHEET_HIDDEN_DASH_MM.
  const start = lines.findIndex((line) => line === '[8.504 4.252] 0 d');
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/ w$/.test(line) || / d$/.test(line) || line.startsWith('BT')) break;
    if (/ [sS]$/.test(line)) out.push(line);
  }
  return out;
}

/** The DXF's entities: their type and group-code values. */
function dxfEntities(
  dxf: string
): { type: string; groups: Map<number, string[]> }[] {
  const lines = dxf.split('\r\n');
  const start = lines.indexOf('ENTITIES');
  const out: { type: string; groups: Map<number, string[]> }[] = [];
  for (let i = start + 1; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]);
    const value = lines[i + 1]!;
    if (code === 0) {
      if (value === 'ENDSEC') break;
      out.push({ type: value, groups: new Map() });
      continue;
    }
    const groups = out.at(-1)?.groups;
    if (groups) groups.set(code, [...(groups.get(code) ?? []), value]);
  }
  return out;
}

function dxfTexts(dxf: string): string[] {
  return dxfEntities(dxf)
    .filter((entity) => entity.type === 'TEXT')
    .map((entity) => entity.groups.get(1)![0]!);
}

function pdfText(page: SheetPage, title: string): string {
  return new TextDecoder('latin1').decode(sheetPageToPdf(page, title));
}

const sheetId = 'dsht_integrity' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const sectionId = 'dvw_section' as DrawingViewId;

function view(
  viewId: DrawingViewId,
  orientation: DrawingView['orientation'],
  extra: Partial<DrawingView> = {}
): DrawingView {
  return {
    viewId,
    orientation,
    bodyIds: [],
    centerMm: { x: 120, y: 150 },
    hiddenLines: true,
    ...extra
  };
}

function sheetOf(views: DrawingView[]): DrawingSheet {
  return {
    sheetId,
    name: 'Integrity',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views
  };
}

/** A square outline, `half` either side of the origin, as one polyline. */
function square(half: number): Float64Array {
  return Float64Array.from([
    -half,
    -half,
    half,
    -half,
    half,
    half,
    -half,
    half,
    -half,
    -half
  ]);
}

describe('hidden edges export as hidden (#2073)', () => {
  /**
   * A Ø14 hidden port as hidden-line removal hands it over on a real
   * housing: its 120 chords each cut in two, and more than a third of the
   * pieces repeated backwards (the edge, and the bore's silhouette along
   * it) — 373 polylines, every one shorter than a 3 mm dash.
   */
  function fragmentedPort(): Float64Array[] {
    const n = 120;
    const r = 7;
    const at = (i: number) => {
      const a = (2 * Math.PI * i) / n;
      return [r * Math.cos(a), r * Math.sin(a)] as const;
    };
    const pieces: Float64Array[] = [];
    for (let i = 0; i < n; i += 1) {
      const [x0, y0] = at(i);
      const [x1, y1] = at(i + 1);
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      pieces.push(Float64Array.from([x0, y0, mx, my]));
      pieces.push(Float64Array.from([mx, my, x1, y1]));
    }
    const repeated = pieces
      .filter((_, index) => index % 2 === 0 || index % 5 === 0)
      .slice(0, 133)
      .map((piece) =>
        Float64Array.from([piece[2]!, piece[3]!, piece[0]!, piece[1]!])
      );
    return [...pieces, ...repeated];
  }

  function portPage(hidden: Float64Array[]): SheetPage {
    const left = view(frontId, 'left');
    const projection: ViewProjection = {
      visible: [square(30)],
      hidden,
      bounds: { minU: -30, minV: -30, maxU: 30, maxV: 30 }
    };
    return composeSheetPage(sheetOf([left]), [{ view: left, projection }], {
      projectName: 'Housing',
      units: 'mm'
    });
  }

  it('draws a finely cut hidden circle as one dashed run in SVG, PDF and DXF', () => {
    const pieces = fragmentedPort();
    expect(pieces).toHaveLength(373);
    expect(
      pieces.every(
        (piece) => Math.hypot(piece[2]! - piece[0]!, piece[3]! - piece[1]!) < 3
      )
    ).toBe(true);
    const page = portPage(pieces);

    const svg = sheetPageToSvg(page, 'Integrity');
    expect(svg).toContain('<g class="hidden"');
    expect(svg).toMatch(/<g class="hidden"[^>]*stroke-dasharray="3 1.5"/);
    const hidden = svgGroup(svg, 'hidden');
    // One closed run, the circle's whole circumference: the dash pattern
    // runs on around it, leaving gaps a reader sees.
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toMatch(/^<polygon /);
    const length = perimeter(svgPoints(hidden[0]!), true);
    expect(length).toBeCloseTo(2 * 7 * 120 * Math.sin(Math.PI / 120), 2);
    expect(length / (3 + 1.5)).toBeGreaterThan(9);
    // Every chord once: no repeated piece restarts the pattern on top.
    expect(svgPoints(hidden[0]!)).toHaveLength(240);

    const pdf = pdfText(page, 'Integrity');
    const paths = pdfHiddenPaths(pdf);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/ s$/);

    const dxf = sheetPageToDxf(page);
    const hiddenEntities = dxfEntities(dxf).filter(
      (entity) =>
        entity.type === 'POLYLINE' && entity.groups.get(8)?.[0] === 'HIDDEN'
    );
    expect(hiddenEntities).toHaveLength(1);
  });

  it('keeps hidden runs that do not meet apart, and visible lines as drawn', () => {
    const page = portPage([
      Float64Array.from([-10, -10, -5, -10]),
      Float64Array.from([-5, -10, -5, -5]),
      Float64Array.from([5, 5, 10, 5]),
      Float64Array.from([5, 5, 10, 5])
    ]);
    const svg = sheetPageToSvg(page, 'Integrity');
    const hidden = svgGroup(svg, 'hidden');
    // The two edges of the corner stay two runs; the far piece, drawn
    // twice, is once.
    expect(hidden).toHaveLength(3);
    expect(hidden.map((element) => svgPoints(element).length)).toEqual([
      2, 2, 2
    ]);
    expect(svgGroup(svg, 'visible')).toHaveLength(1);
  });

  it('never joins two edges that only share a corner', () => {
    // A 3.2 mm hidden edge, then a 0.9 mm one square to it. As one run the
    // 3 mm dash ends on the first and its 1.5 mm gap swallows the second.
    const corner = [
      [0, 0, 3.2, 0],
      [3.2, 0, 3.2, 0.9]
    ];
    expect(joinHiddenRuns(corner)).toEqual([
      { points: [0, 0, 3.2, 0], closed: false },
      { points: [3.2, 0, 3.2, 0.9], closed: false }
    ]);
    const page = portPage(corner.map((line) => Float64Array.from(line)));
    const hidden = svgGroup(sheetPageToSvg(page, 'Integrity'), 'hidden').map(
      (element) => perimeter(svgPoints(element), false)
    );
    expect(hidden).toHaveLength(2);
    expect(hidden[0]).toBeCloseTo(3.2, 9);
    expect(hidden[1]).toBeCloseTo(0.9, 9);
    // A sharp corner on a loop is where its run starts and ends.
    expect(
      joinHiddenRuns([
        [5, 5, 6, 5],
        [6, 5, 6, 6],
        [6, 6, 5, 5]
      ])
    ).toEqual([
      { points: [5, 5, 6, 5], closed: false },
      { points: [6, 5, 6, 6], closed: false },
      { points: [6, 6, 5, 5], closed: false }
    ]);
    // The coarsest tessellation's chords (0.24 rad apart) still join.
    const arc = [0, 1, 2, 3].map((i) => [
      Math.cos(0.24 * i),
      Math.sin(0.24 * i),
      Math.cos(0.24 * (i + 1)),
      Math.sin(0.24 * (i + 1))
    ]);
    expect(joinHiddenRuns(arc)).toHaveLength(1);
  });

  it('measures the joining tolerance along the line between the ends', () => {
    // 0.8 µm on each axis is 1.13 µm apart: not one point.
    expect(
      joinHiddenRuns([
        [0, 0, 1, 0],
        [1.0008, 0.0008, 2, 0]
      ])
    ).toHaveLength(2);
    expect(
      joinHiddenRuns([
        [0, 0, 1, 0],
        [1.0007, 0.0007, 2, 0]
      ])
    ).toHaveLength(1);
  });

  it('joins pieces end to end, stops at branches and keeps the same order', () => {
    // A 36-sided ring: every joint turns 10 degrees, so it is one loop.
    const ring = Array.from({ length: 36 }, (_, i) => {
      const at = (k: number) => [
        5 + Math.cos((Math.PI * k) / 18),
        5 + Math.sin((Math.PI * k) / 18)
      ];
      return [...at(i), ...at(i + 1)];
    });
    const lines = [[0, 0, 1, 0], [1, 0, 2, 0], [1, 0, 1, 1], ...ring];
    const runs = joinHiddenRuns(lines);
    expect(runs.slice(0, 3)).toEqual([
      { points: [0, 0, 1, 0], closed: false },
      { points: [1, 0, 2, 0], closed: false },
      { points: [1, 0, 1, 1], closed: false }
    ]);
    expect(runs).toHaveLength(4);
    expect(runs[3]!.closed).toBe(true);
    expect(runs[3]!.points).toHaveLength(72);
    expect(runs[3]!.points.slice(0, 2)).toEqual([6, 5]);
    expect(joinHiddenRuns(lines)).toEqual(runs);
    // Ends a micron apart are one point; a piece of no length is none.
    expect(
      joinHiddenRuns([
        [0, 0, 1, 0],
        [1.0004, 0.0004, 2, 0],
        [3, 3, 3, 3]
      ])
    ).toEqual([{ points: [0, 0, 1, 0, 2, 0], closed: false }]);
  });

  /**
   * A circular rim sampled every 12 degrees, seen so nearly edge-on that it
   * projects to a 1.5 x 0.3 mm ellipse: its 30 chords turn by up to 55
   * degrees at the ellipse's two ends, and the whole of it is as long as one
   * dash and its gap.
   */
  const rimPoint = (i: number): [number, number] => [
    0.75 * Math.cos((Math.PI * i) / 15),
    0.15 * Math.sin((Math.PI * i) / 15)
  ];
  const rimChords = Array.from({ length: 30 }, (_, i) => [
    ...rimPoint(i),
    ...rimPoint(i + 1)
  ]);

  it('joins every piece of one projected edge, however sharply its projection turns', () => {
    const turns = rimChords.map((chord, i) => {
      const next = rimChords[(i + 1) % 30]!;
      const [ax, ay] = [chord[2]! - chord[0]!, chord[3]! - chord[1]!];
      const [bx, by] = [next[2]! - next[0]!, next[3]! - next[1]!];
      return Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
    });
    expect(Math.max(...turns)).toBeGreaterThan((50 * Math.PI) / 180);
    // Handed over chord by chord, all of one edge: one closed run.
    const pieces = joinHiddenRuns(
      rimChords,
      rimChords.map(() => 7)
    );
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.closed).toBe(true);
    expect(pieces[0]!.points).toHaveLength(60);
    // Handed over whole, with no record of its edge: a polyline is one
    // edge's, and stays one run.
    const whole = joinHiddenRuns([
      Array.from({ length: 31 }, (_, i) => rimPoint(i)).flat()
    ]);
    expect(whole).toHaveLength(1);
    expect(whole[0]!.closed).toBe(true);
    expect(whole[0]!.points).toHaveLength(60);
    // Two pieces of one edge and a piece of another meeting them part-way:
    // the branch still ends the runs.
    expect(
      joinHiddenRuns(
        [
          [0, 0, 1, 0],
          [1, 0, 1, 1],
          [1, 0, 2, -1]
        ],
        [3, 3, 4]
      )
    ).toHaveLength(3);
  });

  it('joins two different edges only where the line carries straight on', () => {
    const corner = (degrees: number) => {
      const turn = (degrees * Math.PI) / 180;
      return [
        [0, 0, 4, 0],
        [4, 0, 4 + 4 * Math.cos(turn), 4 * Math.sin(turn)]
      ];
    };
    // A 15 degree corner is a corner: more than any smooth curve's chords
    // turn (0.24 rad, 13.75 degrees), whether or not the edges are known.
    expect(joinHiddenRuns(corner(15), [1, 2])).toHaveLength(2);
    expect(joinHiddenRuns(corner(15))).toHaveLength(2);
    // Two halves of one curve, split at a seam, still read as one line.
    expect(joinHiddenRuns(corner(13.7), [1, 2])).toHaveLength(1);
    // The same 15 degrees inside one edge is that edge's own shape.
    expect(joinHiddenRuns(corner(15), [5, 5])).toHaveLength(1);
  });

  it('carries each hidden line’s edge from the projection to the exported page', () => {
    // A 10 mm cube with a Ø1.5 rim inside it, tilted until the Front view
    // sees it as a 1.5 x 0.3 mm ellipse: wholly hidden.
    const corners = [
      [-5, -5, -5],
      [5, -5, -5],
      [5, 5, -5],
      [-5, 5, -5],
      [-5, -5, 5],
      [5, -5, 5],
      [5, 5, 5],
      [-5, 5, 5]
    ];
    const quads = [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [2, 3, 7, 6],
      [1, 2, 6, 5],
      [0, 4, 7, 3]
    ];
    const tilt = Math.sqrt(1 - 0.2 ** 2);
    const rim = Array.from({ length: 31 }, (_, i) => {
      const a = (Math.PI * (i % 30)) / 15;
      // Front looks along y: x across the page, z up it.
      return [
        0.75 * Math.cos(a),
        0.75 * Math.sin(a) * tilt,
        0.75 * Math.sin(a) * 0.2
      ];
    }).flat();
    const front = view(frontId, 'front');
    const projection = projectView({
      orientation: 'front',
      hiddenLines: true,
      bodies: [
        {
          vertices: Float64Array.from(corners.flat()),
          indices: Uint32Array.from(
            quads.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!])
          ),
          edges: [
            rim,
            ...[
              [0, 1],
              [1, 2],
              [2, 3],
              [3, 0],
              [4, 5],
              [5, 6],
              [6, 7],
              [7, 4],
              [0, 4],
              [1, 5],
              [2, 6],
              [3, 7]
            ].map(([a, b]) => [...corners[a!]!, ...corners[b!]!])
          ]
        }
      ]
    });
    // One edge id per hidden line, and the rim's lines share one.
    expect(projection.hiddenSources).toHaveLength(projection.hidden.length);
    const rimLines = projection.hidden.flatMap((line, index) =>
      Math.abs(line[0]!) < 1 && Math.abs(line[1]!) < 1 ? [index] : []
    );
    expect(rimLines.length).toBeGreaterThan(0);
    expect(
      new Set(rimLines.map((index) => projection.hiddenSources![index])).size
    ).toBe(1);

    const page = composeSheetPage(
      sheetOf([front]),
      [{ view: front, projection }],
      {
        projectName: 'Rim',
        units: 'mm'
      }
    );
    // The rim alone lies within a millimetre of the view's centre (the SVG
    // counts y down the page).
    const a3 = drawingPaperMm({ size: 'A3', orientation: 'landscape' });
    const near = (points: [number, number][]) =>
      points.every(
        ([x, y]) =>
          Math.abs(x - 120) < 1 &&
          Math.min(Math.abs(y - 150), Math.abs(a3.height - y - 150)) < 1
      );
    const svgRim = svgGroup(sheetPageToSvg(page, 'Integrity'), 'hidden').filter(
      (element) => near(svgPoints(element))
    );
    // One closed dashed path, 3.2 mm round: not six solid slivers.
    expect(svgRim).toHaveLength(1);
    expect(svgRim[0]).toMatch(/^<polygon /);
    expect(svgPoints(svgRim[0]!)).toHaveLength(30);
    expect(perimeter(svgPoints(svgRim[0]!), true)).toBeGreaterThan(3);
    const drawn = page.strokes.filter(
      (stroke) =>
        stroke.kind === 'hidden' &&
        stroke.points.every((value, index) =>
          index % 2 === 0
            ? Math.abs(value - 120) < 1
            : Math.abs(value - 150) < 1
        )
    );
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.closed).toBe(true);
  });

  /** The length of a run, round to its start when it is closed. */
  function runLength(run: { points: number[]; closed: boolean }): number {
    const points: [number, number][] = [];
    for (let i = 0; i + 1 < run.points.length; i += 2)
      points.push([run.points[i]!, run.points[i + 1]!]);
    return perimeter(points, run.closed);
  }

  /** `count` chords of a circle about the origin, as one polyline. */
  function arc(
    radius: number,
    from: number,
    to: number,
    count: number,
    wobble = 0
  ): number[] {
    return Array.from({ length: count + 1 }, (_, k) => {
      const a = from + ((to - from) * k) / count;
      // Off the circle by as much as a kernel's approximated curve is.
      const r = radius + (k % count === 0 ? 0 : wobble * Math.sin(7 * k));
      return [r * Math.cos(a), r * Math.sin(a)];
    }).flat();
  }

  it('draws two edges that project onto one curve once', () => {
    // A radial port seen along its axis: its rim, and the saddle it cuts in
    // the bore, both on one Ø16 circle. The rim is 105 chords from the top;
    // the saddle is two edges, 127 and 196 chords the other way round, each
    // sampled at its own points and 0.7 µm off the circle here and there.
    const rim = arc(8, Math.PI / 2, Math.PI / 2 + 2 * Math.PI, 105);
    const quarter = arc(8, Math.PI / 2, 0, 127, 7e-4);
    const rest = arc(8, 2 * Math.PI, Math.PI / 2, 196, 7e-4);
    const runs = joinHiddenRuns([rim, quarter, rest], [14, 17, 18]);
    // One closed loop: the longest edge, whole.
    expect(runs).toHaveLength(1);
    expect(runs[0]!.closed).toBe(true);
    expect(runs[0]!.points).toHaveLength(2 * 105);
    expect(runLength(runs[0]!)).toBeCloseTo(
      2 * 8 * 105 * Math.sin(Math.PI / 105)
    );
    // Drawn in any order, it is the same loop.
    expect(joinHiddenRuns([quarter, rest, rim], [17, 18, 14])).toEqual(runs);
  });

  it('draws an edge that doubles back over itself once', () => {
    // The saddle seen from the side: out along a 100 degree arc in 60
    // chords and back along it in 47, as one edge.
    const out = arc(20, 0, 1.75, 60);
    const back = arc(20, 1.75, 0, 47, 5e-4);
    const runs = joinHiddenRuns([[...out, ...back.slice(2)]], [18]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.closed).toBe(false);
    expect(runs[0]!.points).toEqual(out);
    expect(runLength(runs[0]!)).toBeCloseTo(20 * 1.75, 1);
  });

  it('keeps two curves a visible distance apart, however coarsely sampled', () => {
    // The inner and outer wall of a tube, half a millimetre apart on the
    // paper, in 30 chords each: either's chords sit 0.23 mm inside its
    // circle, more than the walls are apart.
    const outer = arc(42, 0, 2 * Math.PI, 30);
    const inner = arc(41.5, 0.1, 0.1 + 2 * Math.PI, 30);
    const runs = joinHiddenRuns([outer, inner], [1, 2]);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.closed)).toBe(true);
    expect(runs.map((run) => run.points.length)).toEqual([60, 60]);
  });

  it('takes two straight lines for one only where they are one', () => {
    // 5 µm apart: two lines, as a DXF reader will find them.
    expect(
      joinHiddenRuns(
        [
          [0, 0, 10, 0],
          [0, 0.005, 10, 0.005]
        ],
        [1, 2]
      )
    ).toHaveLength(2);
    // A shorter edge along a longer one is the longer one.
    expect(
      joinHiddenRuns(
        [
          [2, 0, 8, 0],
          [0, 0, 10, 0]
        ],
        [1, 2]
      )
    ).toEqual([{ points: [0, 0, 10, 0], closed: false }]);
    // Two that cross are two, however short the pieces at the crossing.
    const crossing = joinHiddenRuns(
      [
        [0, 0, 10, 0],
        [4.9, -0.1, 4.9995, -0.0005, 5.0005, 0.0005, 5.1, 0.1]
      ],
      [1, 2]
    );
    expect(crossing).toHaveLength(2);
    expect(crossing.map((run) => run.points.length)).toEqual([4, 8]);
  });

  it('does not take a line that carries on from another for a repeat of it', () => {
    // An arc, then the edge after it: tangent, and its first piece 4 µm
    // long, less than the arc's chords may sit from their curve. Past the
    // arc's end it is no repeat of the arc.
    const first = arc(8, 0, 1, 20);
    const [ex, ey] = [8 * Math.cos(1), 8 * Math.sin(1)];
    const [tx, ty] = [-Math.sin(1), Math.cos(1)];
    const next = [0, 4e-3, 2, 4].flatMap((t) => [ex + tx * t, ey + ty * t]);
    const runs = joinHiddenRuns([first, next], [1, 2]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.points).toHaveLength(2 * (21 + 3));
    expect(runs[0]!.points.slice(-2)).toEqual(next.slice(-2));
  });
});

describe('a hidden radial port prints dashed on the kernel’s own geometry (#2073)', () => {
  /**
   * `fixtures/drawing/port-block.openzcad`: a 60 x 30 x 16 block with a Ø16
   * bore through it, a Ø8 port from the bore's axis out through one end, and
   * a Ø8 bore near the other. Seen from the far end the port is a hidden
   * Ø8 circle: its rim, the saddle it cuts in the bore (two edges the
   * kernel approximates, a few tenths of a micron off the port's cylinder)
   * and, between them, the port's wall, seen along its axis.
   */
  let bodies: Readonly<Record<string, BodyRepresentation | undefined>>;
  let bodyId: string;

  beforeAll(async () => {
    const file = JSON.parse(
      readFileSync(
        new URL('./fixtures/drawing/port-block.openzcad', import.meta.url),
        'utf8'
      )
    ) as { document: ProjectDocument };
    const document = normalizeDocument(file.document);
    bodies = (await adapter.syncDocument(document)).bodyRepresentations;
    bodyId = document.bodyOrder.at(-1)!;
  });

  const center = { x: 316, y: 205 };

  /** An A3 first-angle sheet at 2:1 with one view of the block. */
  function pageOf(orientation: DrawingView['orientation']) {
    const drawn = view(frontId, orientation, {
      bodyIds: [bodyId as DrawingView['bodyIds'][number]],
      centerMm: center
    });
    const sheet: DrawingSheet = {
      ...sheetOf([drawn]),
      scale: { numerator: 2, denominator: 1 },
      projectionAngle: 'first'
    };
    const projection = projectView({
      orientation,
      hiddenLines: true,
      bodies: [projectionBodyInput(bodies[bodyId]!)!]
    });
    const page = composeSheetPage(sheet, [{ view: drawn, projection }], {
      projectName: 'Port block',
      units: 'mm'
    });
    return { projection, page };
  }

  function strokePoints(stroke: SheetPage['strokes'][number]) {
    const points: [number, number][] = [];
    for (let i = 0; i + 1 < stroke.points.length; i += 2)
      points.push([stroke.points[i]!, stroke.points[i + 1]!]);
    return points;
  }

  const strokeLength = (stroke: SheetPage['strokes'][number]) =>
    perimeter(strokePoints(stroke), stroke.closed === true);

  it('draws a wall seen along its axis as its end edges, with no outline of its own', () => {
    const { projection } = pageOf('left');
    const edges = projectionBodyInput(bodies[bodyId]!)!.edges.length;
    // Every hidden line on the port's circle is a piece of a B-rep edge:
    // the wall's leaning facets gave it 345 silhouette pieces of its own.
    const onPort = projection.hidden.flatMap((line, index) => {
      for (let i = 0; i + 1 < line.length; i += 2)
        if (Math.abs(Math.hypot(line[i]! + 15, line[i + 1]! - 8) - 4) > 0.01)
          return [];
      return [projection.hiddenSources![index]!];
    });
    expect(onPort.length).toBeGreaterThan(0);
    expect(onPort.length).toBeLessThanOrEqual(4);
    expect(onPort.every((source) => source < edges)).toBe(true);
    expect(projection.hidden.length).toBeLessThanOrEqual(10);
  });

  it('exports the port as one dashed loop in SVG, PDF and DXF', () => {
    const { page } = pageOf('left');
    const hidden = page.strokes.filter((stroke) => stroke.kind === 'hidden');
    // The port, and the silhouettes of the two bores: nothing shorter than
    // a dash, where there were 910 pieces of the port alone.
    expect(hidden.length).toBeLessThanOrEqual(6);
    expect(
      hidden.every((stroke) => strokeLength(stroke) > SHEET_HIDDEN_DASH_MM[0])
    ).toBe(true);
    // The port sits at the middle of the view: a Ø16 circle on the paper.
    const onPort = (points: [number, number][], cy: number) =>
      points.every(
        ([x, y]) => Math.abs(Math.hypot(x - center.x, y - cy) - 8) < 0.05
      );
    const port = hidden.filter((stroke) =>
      onPort(strokePoints(stroke), center.y)
    );
    expect(port).toHaveLength(1);
    expect(port[0]!.closed).toBe(true);
    // Once round: eleven dashes and their gaps.
    expect(strokeLength(port[0]!)).toBeCloseTo(2 * Math.PI * 8, 1);

    const svg = sheetPageToSvg(page, 'Port block');
    expect(svg).toMatch(/<g class="hidden"[^>]*stroke-dasharray="3 1.5"/);
    const svgHidden = svgGroup(svg, 'hidden');
    expect(svgHidden).toHaveLength(hidden.length);
    const a3 = drawingPaperMm({ size: 'A3', orientation: 'landscape' });
    const svgPort = svgHidden.filter((element) =>
      onPort(svgPoints(element), a3.height - center.y)
    );
    expect(svgPort).toHaveLength(1);
    expect(svgPort[0]).toMatch(/^<polygon /);
    expect(perimeter(svgPoints(svgPort[0]!), true)).toBeCloseTo(
      2 * Math.PI * 8,
      1
    );

    const paths = pdfHiddenPaths(pdfText(page, 'Port block'));
    expect(paths).toHaveLength(hidden.length);
    // One closed path under the dash: the port.
    expect(paths.filter((path) => / s$/.test(path))).toHaveLength(1);

    const entities = dxfEntities(sheetPageToDxf(page)).filter(
      (entity) => entity.groups.get(8)?.[0] === 'HIDDEN'
    );
    expect(
      entities.filter((entity) => ['POLYLINE', 'LINE'].includes(entity.type))
    ).toHaveLength(hidden.length);
    // One closed polyline, its line type running on from chord to chord.
    expect(
      entities.filter(
        (entity) =>
          entity.type === 'POLYLINE' && entity.groups.get(70)?.[0] === '129'
      )
    ).toHaveLength(1);
  });

  it('draws the saddle once where it doubles back, seen from the side', () => {
    // From the front the saddle runs out along its near half and back
    // along its far one, over the same curve: 8.4 mm above the port's axis
    // and 8.4 mm below it on the paper.
    const { page } = pageOf('front');
    const saddle = page.strokes.filter(
      (stroke) =>
        stroke.kind === 'hidden' &&
        strokePoints(stroke).every(
          ([x, y]) =>
            x - center.x > 13.8 &&
            x - center.x < 16.05 &&
            Math.abs(y - center.y) < 8.05
        )
    );
    expect(saddle.length).toBeGreaterThan(0);
    expect(saddle.length).toBeLessThanOrEqual(2);
    expect(
      saddle.every((stroke) => strokeLength(stroke) > SHEET_HIDDEN_DASH_MM[0])
    ).toBe(true);
    const drawn = saddle.reduce((sum, stroke) => sum + strokeLength(stroke), 0);
    expect(drawn).toBeGreaterThan(16.5);
    expect(drawn).toBeLessThan(17.2);
  });
});

describe('a face seen edge-on has no silhouette (#2073)', () => {
  /**
   * The wall of a Ø8 bore, 20 long, in 48 facets, along `axis`. Its far end
   * is `ragged` off the cylinder, in and out from one vertex to the next,
   * as an end the kernel approximates is.
   */
  function wall(axis: [number, number, number], ragged: number) {
    const n = 48;
    const length = Math.hypot(...axis);
    const w = axis.map((value) => value / length) as [number, number, number];
    // Two unit vectors square to the axis.
    const pick: [number, number, number] =
      Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const cross = (a: number[], b: number[]) => [
      a[1]! * b[2]! - a[2]! * b[1]!,
      a[2]! * b[0]! - a[0]! * b[2]!,
      a[0]! * b[1]! - a[1]! * b[0]!
    ];
    const unit = (a: number[]) => a.map((value) => value / Math.hypot(...a));
    const p = unit(cross(w, pick));
    const q = cross(w, p);
    const vertices: number[] = [];
    for (const [along, off] of [
      [0, 0],
      [20, ragged]
    ] as const)
      for (let k = 0; k < n; k += 1) {
        const a = (2 * Math.PI * k) / n;
        const r = 4 + (k % 2 === 0 ? off : -off);
        for (let c = 0; c < 3; c += 1)
          vertices.push(
            w[c]! * along + r * (Math.cos(a) * p[c]! + Math.sin(a) * q[c]!)
          );
      }
    const indices: number[] = [];
    for (let k = 0; k < n; k += 1) {
      const j = (k + 1) % n;
      indices.push(k, j, n + j, k, n + j, n + k);
    }
    return {
      vertices: Float64Array.from(vertices),
      indices: Uint32Array.from(indices),
      faces: [{ triangleStart: 0, triangleCount: 2 * n }],
      edges: []
    };
  }
  const top = DRAWING_VIEW_FRAMES.top;

  it('finds none on a wall seen along its axis, however its facets lean', () => {
    // Exactly along the axis no facet shows; with the far end 0.3 µm off
    // the cylinder each leans a little, one way and the other.
    expect(bodySilhouettes(wall([0, 0, 1], 0), top, 1e-9)).toEqual([]);
    expect(bodySilhouettes(wall([0, 0, 1], 3e-4), top, 1e-9)).toEqual([]);
  });

  it('still outlines a wall that shows, and a ragged one as before', () => {
    // Tilted two degrees the wall shows 0.7 mm of itself: two silhouettes
    // along it, ragged end or not.
    const tilt = Math.tan((2 * Math.PI) / 180);
    for (const ragged of [0, 3e-4]) {
      const lines = bodySilhouettes(wall([tilt, 0, 1], ragged), top, 1e-9);
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line.points).toHaveLength(6);
    }
    // Without faces there is nothing to judge a wall by: unchanged.
    const bare = { ...wall([0, 0, 1], 3e-4), faces: undefined };
    expect(bodySilhouettes(bare, top, 1e-9).length).toBeGreaterThan(0);
  });
});

describe('a section cut from the tessellation says so on the paper (#2110)', () => {
  function sectionPage(approximate: string | undefined): SheetPage {
    const front = view(frontId, 'front', { centerMm: { x: 120, y: 150 } });
    const section = view(sectionId, 'right', {
      centerMm: { x: 260, y: 150 },
      section: { sourceViewId: frontId, label: 'A', depth: 0 }
    });
    const bounds = { minU: -10, minV: -10, maxU: 10, maxV: 10 };
    const views: ComposedView[] = [
      {
        view: front,
        projection: { visible: [square(10)], hidden: [], bounds }
      },
      {
        view: section,
        projection: {
          visible: [square(10)],
          hidden: [],
          bounds,
          hatch: Float64Array.from([-10, -10, 10, -10, 10, 10]),
          ...(approximate ? { sectionApproximate: approximate } : {})
        }
      }
    ];
    return composeSheetPage(sheetOf([front, section]), views, {
      projectName: 'Spindle',
      units: 'mm'
    });
  }

  it('prints the approximation beside the caption in SVG, PDF and DXF', () => {
    const page = sectionPage(
      'The kernel could not cut the modelled thread exactly.'
    );
    const caption = page.texts.find(
      (text) => text.text === sectionCaption('A')
    )!;
    const note = page.texts.find(
      (text) => text.text === SECTION_APPROXIMATE_NOTE
    )!;
    expect(note).toBeDefined();
    // With its caption: centred under it, on the side away from the view.
    expect(note.x).toBe(caption.x);
    expect(note.y).toBeGreaterThan(caption.y);

    expect(svgTexts(sheetPageToSvg(page, 'Integrity'))).toEqual(
      expect.arrayContaining([sectionCaption('A'), SECTION_APPROXIMATE_NOTE])
    );
    expect(pdfText(page, 'Integrity')).toContain(
      `(${SECTION_APPROXIMATE_NOTE}) Tj`
    );
    expect(dxfTexts(sheetPageToDxf(page))).toEqual(
      expect.arrayContaining([sectionCaption('A'), SECTION_APPROXIMATE_NOTE])
    );
  });

  /**
   * An approximate section of a Front at `source`, centred at `center`,
   * with `layer` as the sheet's annotations.
   */
  function edgePage(
    orientation: DrawingView['orientation'],
    source: { x: number; y: number },
    center: { x: number; y: number },
    layer?: Parameters<typeof composeSheetPage>[3]
  ): SheetPage {
    const front = view(frontId, 'front', { centerMm: source });
    const section = view(sectionId, orientation, {
      centerMm: center,
      section: { sourceViewId: frontId, label: 'A', depth: 0 }
    });
    const bounds = { minU: -10, minV: -10, maxU: 10, maxV: 10 };
    return composeSheetPage(
      sheetOf([front, section]),
      [
        {
          view: front,
          projection: { visible: [square(10)], hidden: [], bounds }
        },
        {
          view: section,
          projection: {
            visible: [square(10)],
            hidden: [],
            bounds,
            sectionApproximate: 'The kernel could not cut it exactly.'
          }
        }
      ],
      { projectName: 'Spindle', units: 'mm' },
      layer
    );
  }
  const a3 = drawingPaperMm({ size: 'A3', orientation: 'landscape' });

  it('keeps the approximation on the page when its section sits at an edge', () => {
    for (const [name, page] of [
      // Under its source with its outline 8 mm above the bottom edge: the
      // caption's baseline is 1 mm up, and the note under it would be 3 mm
      // below the paper.
      ['bottom', edgePage('bottom', { x: 120, y: 150 }, { x: 120, y: 18 })],
      // Beside its source, its caption just under the top edge.
      ['top', edgePage('right', { x: 120, y: 279 }, { x: 260, y: 279 })],
      // Hard against the left and the right edge: the note is wider than
      // the view.
      ['left', edgePage('right', { x: 200, y: 150 }, { x: 12, y: 150 })],
      ['right', edgePage('right', { x: 200, y: 150 }, { x: 408, y: 150 })]
    ] as const) {
      const note = page.texts.find(
        (text) => text.text === SECTION_APPROXIMATE_NOTE
      );
      expect(note, name).toBeDefined();
      // Whole, as the writers set it: nothing of it past the paper.
      expect(sheetMarksOnPaper([], [note!], a3), name).toBe(true);
      expect(svgTexts(sheetPageToSvg(page, 'Integrity')), name).toContain(
        SECTION_APPROXIMATE_NOTE
      );
      expect(pdfText(page, 'Integrity'), name).toContain(
        `(${SECTION_APPROXIMATE_NOTE}) Tj`
      );
      expect(dxfTexts(sheetPageToDxf(page)), name).toContain(
        SECTION_APPROXIMATE_NOTE
      );
    }
  });

  type Box = { minX: number; minY: number; maxX: number; maxY: number };
  /** A text's box as the writers set it: its width, cap height tall. */
  const textBox = (text: SheetPage['texts'][number]): Box => {
    const width = textWidthMm(text.text, text.sizeMm, text.bold);
    const left =
      text.x -
      (text.align === 'middle' ? width / 2 : text.align === 'end' ? width : 0);
    return {
      minX: left,
      minY: text.y,
      maxX: left + width,
      maxY: text.y + text.sizeMm
    };
  };
  const overlap = (a: Box, b: Box) =>
    a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
  const noteOf = (page: SheetPage) =>
    page.texts.find((text) => text.text === SECTION_APPROXIMATE_NOTE);
  /** The 20 mm square view centred at `center`. */
  const viewBox = (center: { x: number; y: number }): Box => ({
    minX: center.x - 10,
    minY: center.y - 10,
    maxX: center.x + 10,
    maxY: center.y + 10
  });

  it('keeps the approximation clear of the view next to its section', () => {
    // The section's outline 2 mm above the bottom edge: no room under it or
    // in the gap to its caption, so the note goes over the view. Its source
    // starts 2 mm above it, where the note would have gone.
    const source = { x: 120, y: 34 };
    const center = { x: 120, y: 12 };
    const page = edgePage('bottom', source, center);
    const note = noteOf(page)!;
    expect(note).toBeDefined();
    expect(page.crowdedSectionNotes).toBeUndefined();
    expect(sheetMarksOnPaper([], [note], a3)).toBe(true);
    expect(overlap(textBox(note), viewBox(source))).toBe(false);
    expect(overlap(textBox(note), viewBox(center))).toBe(false);
  });

  it('keeps the approximation clear of a sheet note, a dimension and the title block', () => {
    const source = { x: 120, y: 60 };
    const center = { x: 120, y: 12 };
    // Where the note goes with nothing in its way.
    const alone = noteOf(edgePage('bottom', source, center))!;
    const remark = {
      x: alone.x - 20,
      y: alone.y + 0.5,
      sizeMm: 3,
      text: 'DEBURR ALL EDGES'
    };
    const noted = edgePage('bottom', source, center, {
      strokes: [],
      texts: [remark]
    });
    expect(noteOf(noted)).toBeDefined();
    expect(overlap(textBox(noteOf(noted)!), textBox(remark))).toBe(false);
    expect(noted.texts).toContainEqual(remark);
    // A dimension line through it.
    const line = {
      kind: 'dimension' as const,
      points: [alone.x - 30, alone.y + 1, alone.x + 30, alone.y + 1.5]
    };
    const dimensioned = noteOf(
      edgePage('bottom', source, center, { strokes: [line], texts: [] })
    )!;
    const box = textBox(dimensioned);
    expect(box.minY >= alone.y + 1.5 || box.maxY <= alone.y + 1).toBe(true);
    // Over the title block, the note is put clear of it.
    const block = titleBlockBox(sheetOf([]));
    const inBlock = { x: block.x + 60, y: block.y + 3 };
    const blocked = edgePage(
      'bottom',
      { x: inBlock.x, y: inBlock.y + 60 },
      inBlock
    );
    expect(noteOf(blocked)).toBeDefined();
    expect(
      overlap(textBox(noteOf(blocked)!), {
        minX: block.x,
        minY: block.y,
        maxX: block.x + block.width,
        maxY: block.y + block.height
      })
    ).toBe(false);
  });

  it('refuses the export, naming the section, when its approximation has nowhere to go', () => {
    // A picture over the whole sheet: wherever the note went, it would
    // print over it.
    const page = edgePage(
      'right',
      { x: 120, y: 150 },
      { x: 260, y: 150 },
      {
        strokes: [],
        texts: [],
        images: [
          {
            x: 5,
            y: 5,
            width: a3.width - 10,
            height: a3.height - 10,
            checksumSha256: 'a'.repeat(64),
            contentType: 'image/png'
          }
        ]
      }
    );
    expect(page.crowdedSectionNotes).toEqual([
      { viewId: sectionId, label: 'A' }
    ]);
    expect(sectionNoteRefusal(page)).toBe(
      'The note that Section A-A is approximate has no clear place by the section: views, annotations or the title block take every one. Move the section, or what is beside it, to export.'
    );
    // The sheet on screen still says so, by the caption.
    expect(noteOf(page)).toBeDefined();
    // A page whose notes are all placed refuses nothing.
    expect(
      sectionNoteRefusal(
        edgePage('right', { x: 120, y: 150 }, { x: 260, y: 150 })
      )
    ).toBeNull();
  });

  it('leaves an exact section as it was', () => {
    const page = sectionPage(undefined);
    expect(page.texts.some((text) => text.text === sectionCaption('A'))).toBe(
      true
    );
    const svg = sheetPageToSvg(page, 'Integrity');
    expect(svg).not.toContain('APPROXIMATE');
    expect(pdfText(page, 'Integrity')).not.toContain('APPROXIMATE');
    expect(sheetPageToDxf(page)).not.toContain('APPROXIMATE');
  });
});

describe('a dimension that leaves the paper is diagnosed, not dropped (#2166)', () => {
  async function dimensionedBox(centerY: number) {
    const document = addPrimitiveFeature(
      createProjectDocument('Bracket', toUserId('test')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 54, height: 10, depth: 6 }
      }
    );
    const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
    const bodyId = document.bodyOrder[0]!;
    const body: BodyRepresentation = bodies[bodyId]!;
    const { min, max } = body.bbox;
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    const top = body.topology!.edges.find((edge: EdgeTopology) => {
      const p = edge.points;
      return (
        near(p[1]!, min.y) &&
        near(p[p.length - 2]!, min.y) &&
        near(p[2]!, max.z) &&
        near(p[p.length - 1]!, max.z)
      );
    })!;
    const annotations: DrawingAnnotation[] = [
      {
        annotationId: 'dann_w' as DrawingAnnotationId,
        kind: 'linear',
        viewId: frontId,
        direction: 'horizontal',
        from: { edge: { bodyId, hash: top.hash }, anchor: 'first' },
        to: { edge: { bodyId, hash: top.hash }, anchor: 'second' },
        placementMm: { x: 0, y: 14 }
      }
    ];
    const sheet: DrawingSheet = {
      ...sheetOf([
        view(frontId, 'front', {
          bodyIds: [bodyId],
          centerMm: { x: 150, y: centerY },
          hiddenLines: false
        })
      ]),
      paper: { size: 'A4', orientation: 'landscape' },
      annotations
    };
    const views = sheet.views.map((entry) => ({
      view: entry,
      projection: projectView({
        orientation: entry.orientation,
        hiddenLines: entry.hiddenLines,
        bodies: entry.bodyIds.map((id) => projectionBodyInput(bodies[id]!)!)
      })
    }));
    const layer = composeSheetAnnotations(
      sheet,
      views,
      resolveSheetAnnotations(sheet, bodies, 'mm'),
      'mm'
    );
    const page = composeSheetPage(
      sheet,
      views,
      { projectName: document.name, units: 'mm' },
      layer
    );
    const box = viewPageBox(
      sheet.views[0]!,
      views[0]!.projection.bounds!,
      sheet,
      'mm'
    );
    return { sheet, layer, page, box };
  }

  it('prints a dimension whole when it is on the paper', async () => {
    const { layer, page } = await dimensionedBox(120);
    expect(layer.offPaper).toEqual([]);
    expect(svgTexts(sheetPageToSvg(page, 'Integrity'))).toContain('54');
    expect(dxfTexts(sheetPageToDxf(page))).toContain('54');
  });

  it('flags a dimension past the edge of a view that is still on the paper', async () => {
    // The view's top at 205 mm of the A4's 210: the dimension 14 mm above
    // it is past the edge.
    const { sheet, layer, page, box } = await dimensionedBox(200);
    expect(box.y + box.height).toBeLessThan(210);
    expect(viewPlacementIssue(box, sheet)).not.toBe('off-page');
    expect(viewPlacementIssue(box, sheet)).not.toBe('partly-off-page');
    expect(layer.offPaper).toEqual(['dann_w']);
    // What the composer would print: the value is gone. The workspace
    // refuses this export by the flag above rather than write it.
    expect(svgTexts(sheetPageToSvg(page, 'Integrity'))).not.toContain('54');
  });

  /**
   * The e2e drawing-angles sheet in small: a 30 × 20 × 10 block whose top
   * right edge is rounded R5, at 1:1 on A4, its front view's quarter arc
   * dimensioned with the Arc angle tool, placed 15 mm from the arc's centre
   * 60° round from its first end. The dimension's arc spans the whole
   * quarter, so it reaches 15 mm above the centre, and its extension line
   * 2 mm more, wherever along the arc it is placed.
   */
  async function arcAngleSheet(centerY: number) {
    let document = addPrimitiveFeature(
      createProjectDocument('Rounded block', toUserId('test')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 20, depth: 10 }
      }
    );
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    const plainId = document.bodyOrder[0]!;
    const plain = (await adapter.syncDocument(document)).bodyRepresentations[
      plainId
    ]!;
    const corner = plain.topology!.edges.find((edge: EdgeTopology) => {
      const p = edge.points;
      return [p.slice(0, 3), p.slice(p.length - 3)].every(
        (q) => near(q[0]!, plain.bbox.max.x) && near(q[2]!, plain.bbox.max.z)
      );
    })!;
    document = filletEdges(document, {
      name: 'Round',
      targetBodyId: plainId,
      edgeHashes: [corner.hash],
      size: 5
    }).document;
    const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
    const bodyId =
      document.bodyOrder.find((entry) => entry !== plainId) ?? plainId;
    const body = bodies[bodyId]!;
    // The fillet's arc on the block's front face, seen face-on.
    const arc = body.topology!.edges.find(
      (edge: EdgeTopology) =>
        edge.curve?.circle &&
        Math.abs(Math.abs(edge.curve.circle.axis.y) - 1) < 1e-9 &&
        near(edge.curve.circle.center.y, body.bbox.min.y)
    )!;
    // The block's front view is 30 × 10 about its centre: the arc's centre
    // is 10 right of it.
    const reach = 15;
    const annotations: DrawingAnnotation[] = [
      {
        annotationId: 'dann_arc' as DrawingAnnotationId,
        kind: 'arc-angle',
        viewId: frontId,
        edge: {
          bodyId,
          hash: arc.hash,
          ...(arc.reference ? { reference: arc.reference } : {})
        },
        placementMm: {
          x: 10 + reach * Math.cos(Math.PI / 3),
          y: reach * Math.sin(Math.PI / 3)
        }
      }
    ];
    const sheet: DrawingSheet = {
      ...sheetOf([
        view(frontId, 'front', {
          bodyIds: [bodyId],
          centerMm: { x: 150, y: centerY },
          hiddenLines: false
        })
      ]),
      paper: { size: 'A4', orientation: 'landscape' },
      annotations
    };
    const views = sheet.views.map((entry) => ({
      view: entry,
      projection: projectView({
        orientation: entry.orientation,
        hiddenLines: entry.hiddenLines,
        bodies: entry.bodyIds.map((id) => projectionBodyInput(bodies[id]!)!)
      })
    }));
    const resolutions = resolveSheetAnnotations(sheet, bodies, 'mm');
    expect(resolutions.get('dann_arc' as DrawingAnnotationId)?.ok).toBe(true);
    const layer = composeSheetAnnotations(sheet, views, resolutions, 'mm');
    return { layer, paper: drawingPaperMm(sheet.paper) };
  }

  it('prints an arc angle whole when its arc is on the paper', async () => {
    const { layer, paper } = await arcAngleSheet(150);
    expect(layer.offPaper).toEqual([]);
    expect(layer.texts.map((text) => text.text)).toContain('90°');
    const top = Math.max(
      ...layer.strokes.flatMap((stroke) =>
        stroke.points.filter((_, index) => index % 2 === 1)
      )
    );
    // The arc's top and its extension line, 15 and 17 above the centre.
    expect(top).toBeCloseTo(150 + 17, 6);
    expect(top).toBeLessThan(paper.height);
  });

  it('flags an arc angle whose arc runs past the edge though its value is on the paper', async () => {
    // The centre 196 mm up the A4's 210: the value, at 45° round the arc,
    // and the placement are on the paper; the arc's end and its extension
    // line reach 211 and 213 mm.
    const { layer, paper } = await arcAngleSheet(196);
    expect(sheetMarksOnPaper([], layer.texts, paper)).toBe(true);
    expect(layer.offPaper).toEqual(['dann_arc']);
  });
});

describe('the off-paper check and the page agree on the paper’s edge (#2166)', () => {
  const paper = drawingPaperMm({ size: 'A3', orientation: 'landscape' });
  const note = (x: number) => ({
    x,
    y: 50,
    sizeMm: 3,
    text: 'EDGE NOTE'
  });
  const head = (x: number) => ({
    kind: 'dimension' as const,
    points: [x, 60, x + 3, 61, x + 3, 59],
    closed: true,
    filled: true
  });
  const line = (x: number) => ({
    kind: 'dimension' as const,
    points: [x, 70, 40, 70]
  });
  const pageOf = (x: number) =>
    composeSheetPage(
      sheetOf([]),
      [],
      { projectName: 'Edge', units: 'mm' },
      { strokes: [head(x), line(x)], texts: [note(x)] }
    );
  const drawnMarks = (page: SheetPage) => ({
    note: page.texts.find((text) => text.text === 'EDGE NOTE'),
    head: page.strokes.find(
      (stroke) => stroke.filled && stroke.points[1] === 60
    ),
    line: page.strokes.find((stroke) => stroke.points[1] === 70)
  });

  it('prints whole every mark the check passes', () => {
    // 5 µm past the left edge: inside the check's tolerance.
    for (const x of [0, -0.005, -0.0099]) {
      expect(sheetMarksOnPaper([head(x), line(x)], [note(x)], paper)).toBe(
        true
      );
      const drawn = drawnMarks(pageOf(x));
      expect(drawn.note, String(x)).toBeDefined();
      expect(drawn.head, String(x)).toBeDefined();
      expect(drawn.line?.points, String(x)).toHaveLength(4);
      // And nothing of them leaves the page.
      expect(drawn.note!.x).toBeGreaterThanOrEqual(0);
      expect(Math.min(...drawn.head!.points)).toBeGreaterThanOrEqual(0);
      expect(Math.min(...drawn.line!.points)).toBeGreaterThanOrEqual(0);
    }
  });

  it('prints whole every picture the check passes, and none it refuses', () => {
    const picture = (box: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => ({
      ...box,
      checksumSha256: 'b'.repeat(64),
      contentType: 'image/png' as const
    });
    const drawnPicture = (box: Parameters<typeof picture>[0]) =>
      composeSheetPage(
        sheetOf([]),
        [],
        { projectName: 'Edge', units: 'mm' },
        { strokes: [], texts: [], images: [picture(box)] }
      ).images?.[0];
    for (const [name, box] of [
      // A strip wholly in the hair under the bottom edge: 7 to 3 µm below.
      ['under', { x: 20, y: -0.007, width: 30, height: 0.004 }],
      ['left of', { x: -0.007, y: 20, width: 0.004, height: 30 }],
      // A picture laid flush whose arithmetic lands it 5 µm past an edge.
      ['over', { x: 20, y: paper.height - 30 + 0.005, width: 40, height: 30 }],
      [
        'right of',
        { x: paper.width - 40 + 0.005, y: 20, width: 40, height: 30 }
      ],
      ['on', { x: 20, y: 20, width: 40, height: 30 }]
    ] as const) {
      expect(sheetBoxOnPaper(box, paper), name).toBe(true);
      const drawn = drawnPicture(box)!;
      // Drawn, at its size, and none of it past the paper.
      expect(drawn, name).toBeDefined();
      expect(drawn.width, name).toBe(box.width);
      expect(drawn.height, name).toBe(box.height);
      expect(drawn.x, name).toBeGreaterThanOrEqual(0);
      expect(drawn.y, name).toBeGreaterThanOrEqual(0);
      expect(drawn.x + drawn.width, name).toBeLessThanOrEqual(paper.width);
      expect(drawn.y + drawn.height, name).toBeLessThanOrEqual(paper.height);
    }
    // Past the tolerance the check refuses it, wherever the page stands.
    for (const box of [
      { x: 20, y: -0.03, width: 30, height: 0.01 },
      { x: 20, y: -5, width: 30, height: 30 },
      { x: paper.width - 10, y: 20, width: 40, height: 30 }
    ])
      expect(sheetBoxOnPaper(box, paper)).toBe(false);
    // One wholly off the paper is not drawn; one partly on it still shows.
    expect(
      drawnPicture({ x: 20, y: -40, width: 30, height: 30 })
    ).toBeUndefined();
    expect(drawnPicture({ x: 20, y: -5, width: 30, height: 30 })).toEqual(
      picture({ x: 20, y: -5, width: 30, height: 30 })
    );
  });

  it('refuses every mark the page would cut or drop', () => {
    for (const x of [-0.02, -1]) {
      expect(sheetMarksOnPaper([], [note(x)], paper)).toBe(false);
      expect(sheetMarksOnPaper([head(x)], [], paper)).toBe(false);
      expect(sheetMarksOnPaper([line(x)], [], paper)).toBe(false);
      const drawn = drawnMarks(pageOf(x));
      expect(drawn.note).toBeUndefined();
      expect(drawn.head).toBeUndefined();
      expect(drawn.line!.points[0]).toBe(0);
    }
  });
});

describe('a sheet of a model that failed to rebuild names the failure (#2382)', () => {
  const plate = 'body_plate' as never;
  const other = 'body_other' as never;
  const failed = new Map([[plate, { featureName: 'Cut 3' }]]);
  const name = (id: string) => (id === plate ? 'Plate' : 'Bracket');

  it('finds the failed bodies a sheet draws, once each, and only those', () => {
    expect(sheetFailedBodies([other, plate, plate], failed, name)).toEqual([
      { bodyId: plate, bodyName: 'Plate', featureName: 'Cut 3' }
    ]);
    expect(sheetFailedBodies([other], failed, name)).toEqual([]);
    expect(sheetFailedBodies([plate], undefined, name)).toEqual([]);
  });

  it('names the feature and holds the export, or the Update', () => {
    const found = sheetFailedBodies([plate], failed, name);
    expect(sheetSourceFailureMessage(found, false)).toBe(
      '“Cut 3” failed to rebuild, so Plate is not the design and this sheet would not show it. Fix or suppress the failed feature in History, then export.'
    );
    expect(sheetSourceFailureMessage(found, true)).toContain(
      'then Update the sheet to export it.'
    );
    expect(sheetSourceFailureMessage([], true)).toBeNull();
  });

  it('names the configuration a pinned view’s feature failed in', () => {
    const [found] = sheetFailedBodies([plate], failed, name);
    expect(
      sheetSourceFailureMessage([{ ...found!, rowName: 'Narrow' }], false)
    ).toBe(
      '“Cut 3” failed to rebuild in the configuration “Narrow”, so Plate is not the design there and this sheet would not show it. Fix or suppress the failed feature, or change that configuration’s values, then export.'
    );
    // The same plate, failed in the active build and in two pinned rows.
    expect(
      sheetSourceFailureMessage(
        [
          found!,
          { ...found!, rowName: 'Narrow' },
          { ...found!, featureName: 'Bore 3', rowName: 'Third' }
        ],
        true
      )
    ).toBe(
      'Features failed to rebuild (“Cut 3”, “Cut 3” in the configuration “Narrow”, “Bore 3” in the configuration “Third”), so Plate is not the design there and this sheet would not show it. Fix or suppress the failed feature, or change those configurations’ values, then Update the sheet to export it.'
    );
  });
});
