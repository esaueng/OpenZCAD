import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingPaperMm,
  toUserId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type EdgeTopology
} from '@openzcad/shared';
import {
  projectView,
  type ViewProjection
} from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import {
  composeSheetPage,
  joinHiddenRuns,
  sectionCaption,
  SECTION_APPROXIMATE_NOTE,
  sheetMarksOnPaper,
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

  /** An approximate section of a Front at `source`, centred at `center`. */
  function edgePage(
    orientation: DrawingView['orientation'],
    source: { x: number; y: number },
    center: { x: number; y: number }
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
      { projectName: 'Spindle', units: 'mm' }
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
});

describe('the off-paper check and the page agree on the paper’s edge (#2166)', () => {
  const paper = drawingPaperMm({ size: 'A3', orientation: 'landscape' });
  const note = (x: number) => ({
    x,
    y: 50,
    sizeMm: 3,
    text: 'EDGE NOTE',
    align: 'start' as const
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
