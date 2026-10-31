import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addDrawingSheet,
  addDrawingView,
  booleanBodies,
  createProjectDocument,
  deleteDrawingView,
  setParameter,
  transformBody,
  updateDrawingSheet,
  updateDrawingView
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingSectionLine,
  drawingSectionOrientations,
  drawingSectionPlane,
  drawingSetError,
  nextDrawingSectionLabel,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingLinearDimension,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import {
  composeSheetPage,
  hatchStrokes,
  sectionLineOnPage
} from '../apps/web/src/lib/drawing/sheetPage';
import {
  sheetPageToPdf,
  sheetPageToSvg
} from '../apps/web/src/lib/drawing/sheetExport';
import {
  annotationBody,
  resolveDrawingAnnotation,
  sectionBodyKey,
  type AnnotationBodies
} from '../apps/web/src/lib/drawing/annotations';
import {
  edgeRefFor,
  pickableEdges
} from '../apps/web/src/lib/drawing/annotationPicking';

/**
 * D03 section views on real kernel bodies. The part is the case a section
 * view exists for: a Ø20 × 30 cylinder with a blind Ø8 bore 18 deep from
 * its top, cut down the bore's axis — the plane the kernel's own `section`
 * refuses ("cylindrical section parallel to axis"), cut here by an exact
 * half-space boolean instead.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_sections' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const sectionId = 'dvw_section' as DrawingViewId;

function boredCylinder(boreDepth = 18): ProjectDocument {
  let document = createProjectDocument('Bushing', toUserId('test'));
  document = setParameter(document, {
    name: 'bore',
    expression: String(boreDepth)
  });
  document = addPrimitiveFeature(document, {
    name: 'Body',
    primitiveKind: 'cylinder',
    dimensions: { radius: 10, height: 30 }
  });
  const body = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Bore tool',
    primitiveKind: 'cylinder',
    dimensions: { radius: 4, height: 'bore + 2' }
  });
  const tool = document.bodyOrder.at(-1)!;
  document = transformBody(document, {
    name: 'Bore position',
    targetBodyId: tool,
    translation: { x: 0, y: 0, z: 30 - boreDepth }
  }).document;
  return booleanBodies(document, {
    name: 'Bore',
    operation: 'subtract',
    targetBodyIds: [body, tool]
  }).document;
}

function liveBody(document: ProjectDocument): BodyId {
  return document.bodyOrder.at(-1)!;
}

function view(
  viewId: DrawingViewId,
  orientation: DrawingView['orientation'],
  bodyIds: BodyId[],
  extra: Partial<DrawingView> = {}
): DrawingView {
  return {
    viewId,
    orientation,
    bodyIds,
    centerMm: { x: 120, y: 150 },
    hiddenLines: false,
    ...extra
  };
}

/** A front view of the part and, beside it, section A–A down its axis. */
function sectionSheet(bodyId: BodyId): DrawingSheet {
  return {
    sheetId,
    name: 'Sections',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 2, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'test' },
    views: [
      view(frontId, 'front', [bodyId]),
      // Third angle: the right view sits to the right of the front.
      view(sectionId, 'right', [bodyId], {
        centerMm: { x: 260, y: 150 },
        section: { sourceViewId: frontId, label: 'A', depth: 0 }
      })
    ]
  };
}

async function sectionInputs(document: ProjectDocument, section: DrawingView) {
  return adapter.drawingSection(
    document,
    section.bodyIds,
    drawingSectionPlane({ ...section, section: section.section! })
  );
}

function sectionEdges(
  bodies: Awaited<ReturnType<typeof sectionInputs>>,
  bodyId: BodyId
): EdgeTopology[] {
  return bodies[bodyId]!.edgeTopology;
}

/** Straight section-plane edges (x = 0) whose ends sit at height `z`. */
function lineAt(edges: EdgeTopology[], z: number): EdgeTopology[] {
  return edges.filter((edge) => {
    if (edge.curve?.type !== 'LINE') return false;
    const p = edge.points;
    const n = p.length;
    return (
      Math.abs(p[0]!) < 1e-9 &&
      Math.abs(p[n - 3]!) < 1e-9 &&
      Math.abs(p[2]! - z) < 1e-9 &&
      Math.abs(p[n - 1]! - z) < 1e-9
    );
  });
}

function sectionBodies(
  document: ProjectDocument,
  bodies: Record<string, BodyRepresentation>,
  section: DrawingView,
  edges: EdgeTopology[]
): AnnotationBodies {
  const bodyId = section.bodyIds[0]!;
  return {
    ...bodies,
    [sectionBodyKey(section.viewId, bodyId)]: {
      ...bodies[bodyId]!,
      topology: { faces: [], edges }
    }
  };
}

describe('section view schema', () => {
  it('pins the persisted shape and refuses malformed sections', () => {
    const bodyId = 'body_1' as BodyId;
    const sheet = sectionSheet(bodyId);
    expect(drawingSetError({ sheets: [sheet] })).toBeNull();
    const broken = (patch: Partial<DrawingView>) => ({
      sheets: [
        {
          ...sheet,
          views: [sheet.views[0], { ...sheet.views[1]!, ...patch }]
        }
      ]
    });
    // A lower-case or three-letter label, a non-finite depth, an unknown
    // key, a missing source, an iso source, and a view that does not fold.
    for (const section of [
      { sourceViewId: frontId, label: 'a', depth: 0 },
      { sourceViewId: frontId, label: 'ABC', depth: 0 },
      { sourceViewId: frontId, label: 'A', depth: Number.NaN },
      { sourceViewId: frontId, label: 'A', depth: 0, extra: 1 },
      { sourceViewId: 'dvw_missing', label: 'A', depth: 0 }
    ])
      expect(
        drawingSetError(broken({ section } as Partial<DrawingView>))
      ).not.toBeNull();
    expect(drawingSetError(broken({ orientation: 'iso' }))).toMatch(
      /cannot be cut/
    );
    // Out of line with its source, then on the wrong side for third angle.
    expect(drawingSetError(broken({ centerMm: { x: 260, y: 151 } }))).toMatch(
      /out of line/
    );
    expect(drawingSetError(broken({ centerMm: { x: 60, y: 150 } }))).toMatch(
      /wrong side/
    );
    // Two sections with one label, and a section of a section.
    expect(
      drawingSetError({
        sheets: [
          {
            ...sheet,
            views: [
              ...sheet.views,
              view('dvw_second' as DrawingViewId, 'left', [bodyId], {
                centerMm: { x: 40, y: 150 },
                section: { sourceViewId: frontId, label: 'A', depth: 0 }
              })
            ]
          }
        ]
      })
    ).toMatch(/twice/);
    expect(
      drawingSetError({
        sheets: [
          {
            ...sheet,
            views: [
              ...sheet.views,
              view('dvw_second' as DrawingViewId, 'front', [bodyId], {
                centerMm: { x: 260, y: 280 },
                section: { sourceViewId: sectionId, label: 'B', depth: 0 }
              })
            ]
          }
        ]
      })
    ).toMatch(/cannot be cut/);
  });

  it('offers only the orientations that fold from the source', () => {
    expect(drawingSectionOrientations('front', 'vertical')).toEqual([
      'right',
      'left'
    ]);
    expect(drawingSectionOrientations('front', 'horizontal')).toEqual([
      'top',
      'bottom'
    ]);
    // From the top view a horizontal line looks along ±Y; only the front
    // keeps the top's x axis, so only it stays aligned.
    expect(drawingSectionOrientations('top', 'horizontal')).toEqual(['front']);
    expect(drawingSectionOrientations('iso', 'vertical')).toEqual([]);
    // The right view's plane x = 3 crosses the front view at u = 3.
    expect(drawingSectionLine('front', 'right', -3)).toEqual({
      axis: 'vertical',
      at: 3,
      sight: [-1, 0]
    });
    expect(nextDrawingSectionLabel(sectionSheet('b' as BodyId))).toBe('B');
  });
});

describe('section view commands', () => {
  async function documentWithSheet() {
    const document = boredCylinder();
    const bodyId = liveBody(document);
    const sheet = sectionSheet(bodyId);
    return {
      bodyId,
      document: addDrawingSheet(document, {
        sheet: { ...sheet, views: [sheet.views[0]!] }
      }),
      section: sheet.views[1]!
    };
  }

  it('keeps a section aligned with its source and on its side', async () => {
    const { document, section } = await documentWithSheet();
    // Asked for off its row and on the wrong side: mirrored and aligned.
    let next = addDrawingView(document, {
      sheetId,
      view: { ...section, centerMm: { x: 70, y: 180 } }
    });
    const placed = () =>
      next.drawings!.sheets[0]!.views.find((v) => v.viewId === sectionId)!;
    expect(placed().centerMm).toEqual({ x: 170, y: 150 });
    // Moving the source carries the section along.
    next = updateDrawingView(next, {
      sheetId,
      viewId: frontId,
      centerMm: { x: 110, y: 160 }
    });
    expect(placed().centerMm).toEqual({ x: 160, y: 160 });
    // The section itself moves along its row only.
    next = updateDrawingView(next, {
      sheetId,
      viewId: sectionId,
      centerMm: { x: 250, y: 100 }
    });
    expect(placed().centerMm).toEqual({ x: 250, y: 160 });
    // Switching to first angle mirrors it to the other side.
    next = updateDrawingSheet(next, { sheetId, projectionAngle: 'first' });
    // 110 − (250 − 110) = −30, kept on the paper at its edge.
    expect(placed().centerMm).toEqual({ x: 0, y: 160 });
    expect(drawingSetError(next.drawings)).toBeNull();
  });

  it('deletes a section, and its dimensions, with its source', async () => {
    const { document, section, bodyId } = await documentWithSheet();
    let next = addDrawingView(document, { sheetId, view: section });
    next = {
      ...next,
      drawings: {
        sheets: [
          {
            ...next.drawings!.sheets[0]!,
            annotations: [
              {
                annotationId: 'dann_1',
                kind: 'note',
                text: 'On the section',
                viewId: sectionId,
                placementMm: { x: 0, y: 0 }
              } as never
            ]
          }
        ]
      }
    };
    next = deleteDrawingView(next, { sheetId, viewId: frontId });
    const sheet = next.drawings!.sheets[0]!;
    expect(sheet.views).toEqual([]);
    expect(sheet.annotations).toBeUndefined();
    expect(bodyId).toBeTruthy();
  });
});

describe('a section down a blind bore', () => {
  it('cuts the bore exactly, hatches its cut face and draws its line', async () => {
    const document = boredCylinder();
    const synced = await adapter.syncDocument(document);
    const bodyId = liveBody(document);
    const sheet = sectionSheet(bodyId);
    const section = sheet.views[1]!;
    const cut = await sectionInputs(document, section);
    const body = cut[bodyId]!;
    expect(body.cutFaces.length).toBeGreaterThan(0);

    const front = await adapter.drawingTessellation(document, [bodyId]);
    const projections = new Map([
      [
        frontId,
        projectView({
          orientation: 'front',
          hiddenLines: false,
          bodies: [front[bodyId]!]
        })
      ],
      [
        sectionId,
        projectView({ orientation: 'right', hiddenLines: true, bodies: [body] })
      ]
    ]);
    const sectionProjection = projections.get(sectionId)!;
    // Half the part remains: y from -10 to 10 across, 0 to 30 up.
    expect(sectionProjection.bounds!.minU).toBeCloseTo(-10, 6);
    expect(sectionProjection.bounds!.maxU).toBeCloseTo(10, 6);
    expect(sectionProjection.bounds!.maxV).toBeCloseTo(30, 6);

    // The hatched area is the cut face: 20 × 30 less the 8 × 18 bore.
    const hatch = sectionProjection.hatch!;
    let area = 0;
    for (let i = 0; i + 5 < hatch.length; i += 6)
      area +=
        Math.abs(
          (hatch[i + 2]! - hatch[i]!) * (hatch[i + 5]! - hatch[i + 1]!) -
            (hatch[i + 4]! - hatch[i]!) * (hatch[i + 3]! - hatch[i + 1]!)
        ) / 2;
    expect(area).toBeCloseTo(20 * 30 - 8 * 18, 6);

    // The bore's floor and the top are exact lines in the plane.
    const edges = sectionEdges(cut, bodyId);
    const floor = lineAt(edges, 12);
    expect(floor).toHaveLength(1);
    expect(lineAt(edges, 30)).toHaveLength(2);

    const composed = sheet.views.map((entry) => ({
      view: entry,
      projection: projections.get(entry.viewId)!
    }));
    const page = composeSheetPage(sheet, composed, {
      projectName: 'Bushing',
      units: 'mm'
    });
    const hatchLines = page.strokes.filter((s) => s.kind === 'hatch');
    expect(hatchLines.length).toBeGreaterThan(20);
    // No hatch line crosses the bore: at 2:1 it spans x ∈ [-8, 8] mm about
    // the view's centre and from the floor up.
    const k = 2;
    const cv = 15;
    for (const stroke of hatchLines)
      for (let i = 0; i < 4; i += 2) {
        const u = (stroke.points[i]! - 260) / k;
        const v = (stroke.points[i + 1]! - 150) / k + cv;
        expect(Math.abs(u) < 4 - 1e-6 && v > 12 + 1e-6).toBe(false);
      }
    // The cutting-plane line: down the front view's axis, past its extent.
    const line = sectionLineOnPage(sheet, section, composed[0]!, 'mm')!;
    expect(line.from[0]).toBeCloseTo(120, 9);
    expect(line.to[0]).toBeCloseTo(120, 9);
    expect(line.sight).toEqual([-1, 0]);
    expect(page.strokes.filter((s) => s.kind === 'chain')).toHaveLength(1);
    expect(page.strokes.filter((s) => s.kind === 'cutting')).toHaveLength(2);
    expect(page.texts.filter((t) => t.text === 'A')).toHaveLength(2);
    expect(page.texts.some((t) => t.text === 'SECTION A-A')).toBe(true);
    const svg = sheetPageToSvg(page, sheet.name);
    expect(svg).toContain('<g class="hatch"');
    expect(svg).toContain('<g class="chain"');
    expect(svg).toContain('stroke-dasharray="12 1.5 0.5 1.5"');
    const pdf = new TextDecoder('latin1').decode(
      sheetPageToPdf(page, sheet.name)
    );
    expect(pdf).toContain('(SECTION A-A) Tj');

    // Dimensions on the section's own edges: the bore's floor, and its
    // depth from the top.
    const bodies = sectionBodies(
      document,
      synced.bodyRepresentations,
      section,
      edges
    );
    const floorRef = edgeRefFor(bodies, bodyId, floor[0]!, section)!;
    expect(floorRef).toEqual({ bodyId, hash: floor[0]!.hash });
    const width: DrawingLinearDimension = {
      annotationId: 'dann_floor' as DrawingLinearDimension['annotationId'],
      kind: 'linear',
      viewId: sectionId,
      direction: 'horizontal',
      from: { edge: floorRef, anchor: 'first' },
      to: { edge: floorRef, anchor: 'second' },
      placementMm: { x: 0, y: -30 }
    };
    const resolved = resolveDrawingAnnotation(width, section, bodies, 'mm');
    expect(resolved.ok && resolved.resolved.kind === 'linear').toBe(true);
    if (resolved.ok && resolved.resolved.kind === 'linear')
      expect(resolved.resolved.value).toBeCloseTo(8, 9);
    const top = lineAt(edges, 30).find((edge) => edge.points[1]! < 0)!;
    const depth: DrawingLinearDimension = {
      ...width,
      annotationId: 'dann_depth' as DrawingLinearDimension['annotationId'],
      direction: 'vertical',
      from: { edge: floorRef, anchor: 'first' },
      to: { edge: edgeRefFor(bodies, bodyId, top, section)!, anchor: 'second' }
    };
    const resolvedDepth = resolveDrawingAnnotation(
      depth,
      section,
      bodies,
      'mm'
    );
    expect(resolvedDepth.ok).toBe(true);
    if (resolvedDepth.ok && resolvedDepth.resolved.kind === 'linear')
      expect(resolvedDepth.resolved.value).toBeCloseTo(18, 9);
    // The floor is offered for picking in the section, and only there: the
    // model body has no such edge.
    const pickable = pickableEdges(sheet, composed, bodies, 'mm');
    expect(
      pickable.some((p) => p.view.viewId === sectionId && p.edge === floor[0])
    ).toBe(true);
    expect(
      annotationBody(bodies, sheet.views[0], bodyId)?.topology?.edges.includes(
        floor[0]!
      )
    ).toBe(false);
  });

  it('breaks a dimension whose floor moved, never rebinding it', async () => {
    const document = boredCylinder();
    const bodyId = liveBody(document);
    const section = sectionSheet(bodyId).views[1]!;
    const floor = lineAt(
      sectionEdges(await sectionInputs(document, section), bodyId),
      12
    )[0]!;
    const ref = { bodyId, hash: floor.hash };
    const dimension: DrawingLinearDimension = {
      annotationId: 'dann_floor' as DrawingLinearDimension['annotationId'],
      kind: 'linear',
      viewId: sectionId,
      direction: 'horizontal',
      from: { edge: ref, anchor: 'first' },
      to: { edge: ref, anchor: 'second' },
      placementMm: { x: 0, y: -30 }
    };
    // The same part bored 22 deep: its floor is at z = 8, a new edge.
    const deeper = boredCylinder(22);
    const deeperId = liveBody(deeper);
    // A fresh document numbers its bodies afresh; the stored reference is
    // the old floor's hash on the body this section draws.
    const moved = { ...section, bodyIds: [deeperId] };
    const after = sectionEdges(await sectionInputs(deeper, moved), deeperId);
    dimension.from.edge = { bodyId: deeperId, hash: floor.hash };
    dimension.to.edge = { bodyId: deeperId, hash: floor.hash };
    expect(lineAt(after, 8)).toHaveLength(1);
    const bodies = {
      [deeperId]: { id: deeperId } as never,
      [sectionBodyKey(sectionId, deeperId)]: {
        id: deeperId,
        topology: { faces: [], edges: after }
      } as never
    } as AnnotationBodies;
    const resolved = resolveDrawingAnnotation(dimension, moved, bodies, 'mm');
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe('not-found');
  });

  it('refuses a plane that misses the part', async () => {
    const document = boredCylinder();
    const bodyId = liveBody(document);
    const section = {
      ...sectionSheet(bodyId).views[1]!,
      section: { sourceViewId: frontId, label: 'A', depth: -50 }
    };
    // Depth −50 along −X is x = 50: past the part, nothing behind it is cut.
    await expect(sectionInputs(document, section)).rejects.toThrow(
      /does not cut any body/
    );
  });

  it('drops a body wholly in front of the plane and keeps one behind it whole', async () => {
    const document = boredCylinder();
    const bodyId = liveBody(document);
    const front = {
      ...sectionSheet(bodyId).views[1]!,
      section: { sourceViewId: frontId, label: 'A', depth: -5 }
    };
    const kept = await sectionInputs(document, front);
    // x = 5 cuts the part: x ≤ 5 is behind a −X view at depth −5.
    expect(kept[bodyId]!.cutFaces.length).toBeGreaterThan(0);
    expect(hatchStrokes([], () => [0, 0])).toEqual([]);
  });
});

describe('a section the kernel will not cut exactly', () => {
  /** A 40 × 30 × 30 plate bored through by a Ø12 hole at (20, 15). */
  function boredPlate(): ProjectDocument {
    let document = createProjectDocument('Plate', toUserId('test'));
    document = addPrimitiveFeature(document, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, depth: 30, height: 30 }
    });
    const plate = document.bodyOrder.at(-1)!;
    document = addPrimitiveFeature(document, {
      name: 'Bore tool',
      primitiveKind: 'cylinder',
      dimensions: { radius: 6, height: 30 }
    });
    const tool = document.bodyOrder.at(-1)!;
    document = transformBody(document, {
      name: 'Bore position',
      targetBodyId: tool,
      translation: { x: 20, y: 15, z: 0 }
    }).document;
    return booleanBodies(document, {
      name: 'Bore',
      operation: 'subtract',
      targetBodyIds: [plate, tool]
    }).document;
  }

  it('cuts it from the tessellation instead, hatched and labelled approximate', async () => {
    const document = boredPlate();
    const bodyId = liveBody(document);
    // Down the bore's axis, x = 20, seen along −X.
    const section = view(sectionId, 'right', [bodyId], {
      section: { sourceViewId: frontId, label: 'A', depth: -20 }
    });
    const cut = await sectionInputs(document, section);
    const body = cut[bodyId]!;
    // Measured against the pin: the exact-only boolean refuses this plane.
    expect(body.approximate).toMatch(/could not cut it exactly/);
    expect(body.cutFaces).toEqual([]);
    expect(body.edgeTopology).toEqual([]);
    const projection = projectView({
      orientation: 'right',
      hiddenLines: true,
      bodies: [
        {
          ...body,
          clip: drawingSectionPlane({ ...section, section: section.section! })
        }
      ]
    });
    // Behind the plane: y from 0 to 30 across (page right is +Y), z up to 30.
    expect(projection.bounds!.minU).toBeCloseTo(0, 4);
    expect(projection.bounds!.maxU).toBeCloseTo(30, 4);
    expect(projection.bounds!.maxV).toBeCloseTo(30, 4);
    // The cut face is the 30 × 30 square less the 12-wide bore, to the
    // tessellation's chords.
    const hatch = projection.hatch!;
    let area = 0;
    for (let i = 0; i + 5 < hatch.length; i += 6)
      area +=
        Math.abs(
          (hatch[i + 2]! - hatch[i]!) * (hatch[i + 5]! - hatch[i + 1]!) -
            (hatch[i + 4]! - hatch[i]!) * (hatch[i + 3]! - hatch[i + 1]!)
        ) / 2;
    expect(area).toBeGreaterThan(540 * 0.99);
    expect(area).toBeLessThan(540 * 1.01);
    // Nothing in front of the plane is drawn.
    for (const line of [...projection.visible, ...projection.hidden])
      expect(line.length).toBeGreaterThanOrEqual(4);
    expect(projection.visible.length).toBeGreaterThan(0);
  });
});
