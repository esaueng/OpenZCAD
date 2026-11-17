import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  updateDrawingView
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  DRAWING_VIEW_FRAMES,
  drawingFreeSectionLine,
  drawingSectionPlane,
  drawingSetError,
  drawingViewFrame,
  drawingViewHasOwnFrame,
  toUserId,
  type BodyId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type ProjectDocument
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import {
  composeSheetPage,
  sectionLineOnPage,
  type ComposedView
} from '../apps/web/src/lib/drawing/sheetPage';
import {
  SECTION_FREE_MIN_DEG,
  sectionLineFromDrag,
  sectionPlacement
} from '../apps/web/src/lib/drawing/sectionTool';
import { sectionPlaneKey } from '../apps/web/src/lib/drawing/sheetSources';

/**
 * D03 free section planes (schema v91): a section line drawn at an angle
 * across a principal view cuts the part by an inclined plane, exactly, and
 * the section is seen square to it and placed freely.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_free' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const sectionId = 'dvw_free' as DrawingViewId;

/** A 30 × 20 × 10 block: x 30 wide, y 20 deep, z 10 high, at the origin. */
function block(): ProjectDocument {
  return addPrimitiveFeature(createProjectDocument('Block', toUserId('test')), {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 30, height: 20, depth: 10 }
  });
}

/** The frame of a section seen square to a 45° line in the front view. */
const s = Math.SQRT1_2;
const frame45 = {
  // In the front's (x, z) page: the line runs along (1, 1), seen along
  // (1, −1).
  direction: { x: s, y: 0, z: -s },
  // Page-right is direction × up, up the front's sight (0, 1, 0).
  x: { x: s, y: 0, z: s }
};

function sheetOf(bodyId: BodyId, section: Partial<DrawingView> = {}) {
  const views: DrawingView[] = [
    {
      viewId: frontId,
      orientation: 'front',
      bodyIds: [bodyId],
      centerMm: { x: 120, y: 150 },
      hiddenLines: false
    },
    {
      viewId: sectionId,
      orientation: 'front',
      bodyIds: [bodyId],
      // Anywhere: a free section is not aligned with its source.
      centerMm: { x: 300, y: 80 },
      hiddenLines: false,
      section: { sourceViewId: frontId, label: 'A', depth: 0, frame: frame45 },
      ...section
    }
  ];
  const sheet: DrawingSheet = {
    sheetId,
    name: 'Free',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 2, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'test' },
    views
  };
  return sheet;
}

describe('free section schema', () => {
  it('accepts a free section anywhere, and refuses broken frames by name', () => {
    const bodyId = 'body_1' as BodyId;
    const ok = sheetOf(bodyId);
    expect(drawingSetError({ sheets: [ok] })).toBeNull();
    expect(drawingViewHasOwnFrame(ok.views[1]!)).toBe(true);
    expect(drawingViewHasOwnFrame(ok.views[0]!)).toBe(false);
    // It projects in its frame and cuts along its normal.
    expect(drawingViewFrame(ok.views[1]!).direction).toEqual(frame45.direction);
    const up = drawingViewFrame(ok.views[1]!).up;
    expect(up.x).toBeCloseTo(0, 12);
    expect(up.y).toBeCloseTo(1, 12);
    expect(up.z).toBeCloseTo(0, 12);
    expect(
      drawingSectionPlane({ ...ok.views[1]!, section: ok.views[1]!.section! })
    ).toEqual({ normal: frame45.direction, depth: 0 });

    const broken = (section: Partial<DrawingView>) =>
      drawingSetError({ sheets: [sheetOf(bodyId, section)] });
    const cut = (frame: unknown) => ({
      section: {
        sourceViewId: frontId,
        label: 'A',
        depth: 0,
        frame
      } as DrawingView['section']
    });
    expect(
      broken(cut({ direction: { x: 1, y: 0, z: 1 }, x: frame45.x }))
    ).toMatch(/invalid section frame/);
    expect(
      broken(cut({ direction: frame45.direction, x: { x: 0, y: 0, z: 1 } }))
    ).toMatch(/axes are not square/);
    expect(broken(cut({ ...frame45, extra: 1 }))).toMatch(
      /invalid section frame/
    );
    // Seen along the source's own sight: not a plane across the source.
    expect(
      broken(cut({ direction: { x: 0, y: 1, z: 0 }, x: { x: 1, y: 0, z: 0 } }))
    ).toMatch(/cannot be cut from its source view/);
    // It keeps its source's orientation.
    expect(broken({ orientation: 'top' })).toMatch(
      /cannot be cut from its source view/
    );
  });

  it('gates the frame at v91', () => {
    const document = block();
    const bodyId = document.bodyOrder[0]!;
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheetOf(bodyId) })
    );
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    expect(() =>
      assertStorableDocument({
        ...manager.document,
        // The release before free sections, whatever came after them.
        schemaVersion: 90
      })
    ).toThrow(/Free section planes require project schema v91/);
  });

  it('stays where it is when its source moves', () => {
    const document = block();
    const bodyId = document.bodyOrder[0]!;
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheetOf(bodyId) })
    );
    const moved = updateDrawingView(manager.document, {
      sheetId,
      viewId: frontId,
      centerMm: { x: 100, y: 120 }
    });
    const views = moved.drawings!.sheets[0]!.views;
    expect(views[0]!.centerMm).toEqual({ x: 100, y: 120 });
    expect(views[1]!.centerMm).toEqual({ x: 300, y: 80 });
    // Its plane moves along its own normal.
    const deeper = updateDrawingView(moved, {
      sheetId,
      viewId: sectionId,
      sectionDepth: 2
    });
    expect(deeper.drawings!.sheets[0]!.views[1]!.section).toMatchObject({
      depth: 2,
      frame: frame45
    });
  });
});

describe('free section tool', () => {
  const bodyId = 'body_1' as BodyId;
  const source: ComposedView = {
    view: sheetOf(bodyId).views[0]!,
    projection: {
      bounds: { minU: 0, maxU: 30, minV: 0, maxV: 10 }
    } as ComposedView['projection']
  };
  const sheet = sheetOf(bodyId);

  it('draws a free line for a drag at an angle, and a square one near an axis', () => {
    // The view's middle (model 15, 5) is at the paper centre (120, 150).
    const free = sectionLineFromDrag(
      sheet,
      source,
      [120.5, 150.5],
      [140, 170],
      'mm',
      [],
      3,
      [[15, 5]]
    );
    expect(free).toMatchObject({ axis: 'free', through: [15, 5] });
    expect(free!.axis === 'free' && free!.along[0]).toBeCloseTo(
      Math.SQRT1_2,
      2
    );
    const nearAxis = Math.tan(((SECTION_FREE_MIN_DEG - 2) * Math.PI) / 180);
    const square = sectionLineFromDrag(
      sheet,
      source,
      [120, 150],
      [140, 150 + 20 * nearAxis],
      'mm'
    );
    expect(square).toMatchObject({ axis: 'horizontal', at: 5 });
  });

  it('places a free section seen square to the line from the click’s side', () => {
    const placed = sectionPlacement(
      sheet,
      source.view,
      {
        sourceViewId: frontId,
        axis: 'free',
        through: [15, 5],
        along: [Math.SQRT1_2, Math.SQRT1_2],
        throughMm: [120, 150]
      },
      // Below and right of the line: third angle sees from there.
      [250, 60],
      [bodyId]
    )!;
    expect(placed.orientation).toBe('front');
    expect(placed.centerMm).toEqual({ x: 250, y: 60 });
    const frame = placed.section!.frame!;
    // Seen from the lower right, looking back up-left across the line.
    expect(frame.direction.x).toBeCloseTo(-s, 9);
    expect(frame.direction.z).toBeCloseTo(s, 9);
    expect(frame.direction.y).toBe(0);
    // The plane passes through the line's point (15, ·, 5).
    expect(placed.section!.depth).toBeCloseTo(-15 * s + 5 * s, 9);
    expect(placed.section!.label).toBe('B');
    // Valid on the sheet in place of the first one.
    const replaced = {
      ...sheet,
      views: [sheet.views[0]!, { ...placed, viewId: sectionId }]
    };
    expect(drawingSetError({ sheets: [replaced] })).toBeNull();
  });

  it('sees from the click’s side of the line itself, not of the view’s middle', () => {
    // A line off the middle: through model (25, 5), paper (140, 150) at 2:1.
    const line = sectionLineFromDrag(
      sheet,
      source,
      [140, 150],
      [146, 156],
      'mm'
    )!;
    expect(line).toMatchObject({
      axis: 'free',
      through: [25, 5],
      throughMm: [140, 150]
    });
    // Above-left of this line, though below-right of the parallel line
    // through the view's middle.
    const placed = sectionPlacement(
      sheet,
      source.view,
      line,
      [128, 140],
      [bodyId]
    )!;
    // Third angle: seen from the upper left, looking down-right.
    expect(placed.section!.frame!.direction.x).toBeGreaterThan(0);
    expect(placed.section!.frame!.direction.z).toBeLessThan(0);
  });
});

describe('free section on the kernel', () => {
  it('cuts the block exactly along the inclined plane and draws its line', async () => {
    const document = block();
    const bodyId = document.bodyOrder[0]!;
    const synced = await adapter.syncDocument(document);
    const { min, max } = synced.bodyRepresentations[bodyId]!.bbox;
    const centre = { x: (min.x + max.x) / 2, z: (min.z + max.z) / 2 };
    const X = max.x - min.x;
    const Y = max.y - min.y;
    const Z = max.z - min.z;
    // The 45° plane through the block's centre, seen along (s, 0, −s).
    const depth = s * centre.x - s * centre.z;
    const sheet = sheetOf(bodyId, {
      section: { sourceViewId: frontId, label: 'A', depth, frame: frame45 }
    });
    const section = sheet.views[1]!;
    expect(sectionPlaneKey(section)).toBe(`${s},0,${-s}@${depth}`);
    const cut = await adapter.drawingSection(
      document,
      [bodyId],
      drawingSectionPlane({ ...section, section: section.section! })
    );
    const body = cut[bodyId]!;
    expect(body.approximate).toBeUndefined();
    expect(body.cutFaces.length).toBe(1);
    // The cut runs from the bottom to the top face: its edges across the
    // block are Z√2 long, and Y deep along the sight of the source.
    const lengths = body.edgeTopology.map((edge) => edge.length);
    expect(
      lengths.some((length) => Math.abs((length ?? 0) - Z * Math.SQRT2) < 1e-6)
    ).toBe(true);
    const projection = projectView({
      orientation: 'front',
      frame: drawingViewFrame(section),
      hiddenLines: false,
      bodies: [body]
    });
    // The hatched cut face, seen square: Z√2 by Y.
    const hatch = projection.hatch!;
    let area = 0;
    for (let i = 0; i + 5 < hatch.length; i += 6)
      area +=
        Math.abs(
          (hatch[i + 2]! - hatch[i]!) * (hatch[i + 5]! - hatch[i + 1]!) -
            (hatch[i + 4]! - hatch[i]!) * (hatch[i + 3]! - hatch[i + 1]!)
        ) / 2;
    expect(area).toBeCloseTo(Z * Math.SQRT2 * Y, 6);
    // The kept part is the half behind the plane, seen square to it: across
    // the page it spans the cut (Z√2) and what lies behind it.
    expect(projection.bounds!.maxV - projection.bounds!.minV).toBeCloseTo(Y, 6);
    expect(X).toBeGreaterThan(Z);

    // On the source, the line crosses the footprint at 45° through its
    // middle, with arrows along the direction of sight.
    const front = await adapter.drawingTessellation(document, [bodyId]);
    const frontProjection = projectView({
      orientation: 'front',
      hiddenLines: false,
      bodies: [front[bodyId]!]
    });
    const composedSource: ComposedView = {
      view: sheet.views[0]!,
      projection: frontProjection
    };
    const line = sectionLineOnPage(sheet, section, composedSource, 'mm')!;
    const slope = (line.to[1] - line.from[1]) / (line.to[0] - line.from[0]);
    expect(slope).toBeCloseTo(1, 9);
    expect(line.sight[0]).toBeCloseTo(s, 9);
    expect(line.sight[1]).toBeCloseTo(-s, 9);
    // Through the view's middle, which the paper centre draws.
    const { sight } = drawingFreeSectionLine('front', frame45, depth);
    expect(sight[0]).toBeCloseTo(s, 12);
    const crossing = line.from[1] - 150 - slope * (line.from[0] - 120);
    expect(crossing).toBeCloseTo(0, 6);
    const page = composeSheetPage(
      sheet,
      [composedSource, { view: section, projection }],
      { projectName: 'Block', units: 'mm' }
    );
    expect(page.texts.filter((text) => text.text === 'A')).toHaveLength(2);
    expect(page.texts.some((text) => text.text === 'SECTION A-A')).toBe(true);
    expect(DRAWING_VIEW_FRAMES.front.direction).toEqual({ x: 0, y: 1, z: 0 });
  });
});
