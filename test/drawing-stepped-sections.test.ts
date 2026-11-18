import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  hasDrawingSteppedSection,
  updateDrawingView
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingSectionCut,
  drawingSectionStepAxis,
  drawingSetError,
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
  sectionLineOnPage
} from '../apps/web/src/lib/drawing/sheetPage';
import { sectionPlaneKey } from '../apps/web/src/lib/drawing/sheetSources';

/**
 * D03 stepped (offset) sections (schema v93): an aligned section whose
 * cutting line steps to another depth along its run. On a 40 × 20 × 10
 * block seen from the front, the line runs at z = 3 to x = 20 and at z = 7
 * after it: the top-down section keeps an L-shaped block, hatches both cut
 * faces, and draws no line where it steps.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_stepped' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const sectionId = 'dvw_section' as DrawingViewId;

function block(): ProjectDocument {
  return addPrimitiveFeature(createProjectDocument('Block', toUserId('test')), {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 20, depth: 10 }
  });
}

/** Front view and, above it in third angle, the stepped top section. */
function sheetOf(
  bodyId: BodyId,
  section: Partial<NonNullable<DrawingView['section']>> = {}
): DrawingSheet {
  return {
    sheetId,
    name: 'Stepped',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 2, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'test' },
    views: [
      {
        viewId: frontId,
        orientation: 'front',
        bodyIds: [bodyId],
        centerMm: { x: 150, y: 80 },
        hiddenLines: false
      },
      {
        viewId: sectionId,
        orientation: 'top',
        bodyIds: [bodyId],
        centerMm: { x: 150, y: 200 },
        hiddenLines: false,
        section: {
          sourceViewId: frontId,
          label: 'A',
          // Looking down (−z), the plane z = 3 is at depth −3.
          depth: -3,
          steps: [{ at: 20, depth: -7 }],
          ...section
        }
      }
    ]
  };
}

describe('stepped section schema', () => {
  const bodyId = 'body_1' as BodyId;

  it('accepts ascending steps and refuses others by name', () => {
    expect(drawingSetError({ sheets: [sheetOf(bodyId)] })).toBeNull();
    const broken = (section: Partial<NonNullable<DrawingView['section']>>) =>
      drawingSetError({ sheets: [sheetOf(bodyId, section)] });
    expect(
      broken({
        steps: [
          { at: 20, depth: -7 },
          { at: 10, depth: -5 }
        ]
      })
    ).toMatch(/out of order/);
    expect(
      broken({
        steps: Array.from({ length: 9 }, (_, i) => ({ at: i, depth: -i }))
      })
    ).toMatch(/invalid section steps \(at most 8\)/);
    expect(broken({ steps: [{ at: 20, depth: Number.NaN }] })).toMatch(
      /invalid section steps/
    );
    // The steps run along the source's x for this column pair.
    expect(drawingSectionStepAxis('front', 'top')).toEqual({
      x: 1,
      y: 0,
      z: 0
    });
    const section = sheetOf(bodyId).views[1]!;
    expect(
      drawingSectionCut({ ...section, section: section.section! }, 'front')
    ).toEqual({
      normal: { x: 0, y: 0, z: -1 },
      depth: -3,
      steps: [{ along: { x: 1, y: 0, z: 0 }, at: 20, depth: -7 }]
    });
    expect(sectionPlaneKey(section)).toBe('top@-3+dvw_front:20@-7');
    // The steps run along an axis its source sets: two sections alike but
    // cut from different views are two cuts.
    expect(
      sectionPlaneKey({
        ...section,
        section: {
          ...section.section!,
          sourceViewId: 'dvw_other' as DrawingViewId
        }
      })
    ).not.toBe(sectionPlaneKey(section));
  });

  it('gates a view update that sets or clears steps', () => {
    expect(
      hasDrawingSteppedSection({
        sheetId,
        viewId: sectionId,
        sectionSteps: [{ at: 20, depth: -7 }]
      })
    ).toBe(true);
    expect(hasDrawingSteppedSection({ sheetId, viewId: sectionId })).toBe(
      false
    );
  });

  it('edits and removes steps, and gates them at v93', () => {
    const document = block();
    const id = document.bodyOrder[0]!;
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: sheetOf(id, { steps: undefined })
      })
    );
    const stepped = updateDrawingView(manager.document, {
      sheetId,
      viewId: sectionId,
      sectionSteps: [{ at: 20, depth: -7 }]
    });
    expect(stepped.drawings!.sheets[0]!.views[1]!.section!.steps).toEqual([
      { at: 20, depth: -7 }
    ]);
    expect(() => assertStorableDocument(stepped)).not.toThrow();
    expect(() =>
      assertStorableDocument({
        ...stepped,
        // The release before stepped sections, whatever came after them.
        schemaVersion: 92
      })
    ).toThrow(/Stepped sections require project schema v93/);
    const plain = updateDrawingView(stepped, {
      sheetId,
      viewId: sectionId,
      sectionSteps: []
    });
    expect('steps' in plain.drawings!.sheets[0]!.views[1]!.section!).toBe(
      false
    );
  });
});

describe('stepped section on the kernel', () => {
  it('cuts each strip only within its run, across several steps', async () => {
    // z > 7 to x = 10, z > 3 to x = 20, then z > 8: the first strip runs
    // into the deeper second but must not reach the third.
    const document = block();
    const bodyId = document.bodyOrder[0]!;
    const sheet = sheetOf(bodyId, {
      depth: -7,
      steps: [
        { at: 10, depth: -3 },
        { at: 20, depth: -8 }
      ]
    });
    const section = sheet.views[1]!;
    const cut = await adapter.drawingSection(
      document,
      [bodyId],
      drawingSectionCut({ ...section, section: section.section! }, 'front')
    );
    const body = cut[bodyId]!;
    // The block's highest point at either end: the first strip's cut at
    // x = 0, the last one's at x = 40 (the second steps between them).
    const top = (x: number) => {
      let high = -Infinity;
      for (let i = 0; i + 2 < body.vertices.length; i += 3)
        if (Math.abs(body.vertices[i]! - x) < 1e-6)
          high = Math.max(high, body.vertices[i + 2]!);
      return high;
    };
    expect(top(0)).toBeCloseTo(7, 9);
    expect(top(40)).toBeCloseTo(8, 9);
    expect(body.cutFaces).toHaveLength(3);
  });

  it('cuts each strip at its own depth, hatches both, and draws no step line', async () => {
    const document = block();
    const bodyId = document.bodyOrder[0]!;
    const synced = await adapter.syncDocument(document);
    const { min, max } = synced.bodyRepresentations[bodyId]!.bbox;
    // The test's numbers assume the block at the origin, 40 × 20 × 10.
    expect([min.x, min.y, min.z, max.x, max.y, max.z]).toEqual([
      0, 0, 0, 40, 20, 10
    ]);
    const sheet = sheetOf(bodyId);
    const section = sheet.views[1]!;
    const cut = await adapter.drawingSection(
      document,
      [bodyId],
      drawingSectionCut({ ...section, section: section.section! }, 'front')
    );
    const body = cut[bodyId]!;
    expect(body.approximate).toBeUndefined();
    // Two cut faces: z = 3 left of the step, z = 7 right of it.
    expect(body.cutFaces).toHaveLength(2);
    const projection = projectView({
      orientation: 'top',
      hiddenLines: false,
      bodies: [body]
    });
    const hatch = projection.hatch!;
    let area = 0;
    for (let i = 0; i + 5 < hatch.length; i += 6)
      area +=
        Math.abs(
          (hatch[i + 2]! - hatch[i]!) * (hatch[i + 5]! - hatch[i + 1]!) -
            (hatch[i + 4]! - hatch[i]!) * (hatch[i + 3]! - hatch[i + 1]!)
        ) / 2;
    expect(area).toBeCloseTo(20 * 20 + 20 * 20, 6);
    // No edge lies along the step (x = 20) in the drawing...
    const onStep = body.edges.filter((edge) => {
      for (let i = 0; i + 2 < edge.length; i += 3)
        if (Math.abs(edge[i]! - 20) > 1e-6) return false;
      return true;
    });
    expect(onStep).toEqual([]);
    // ...while its edges stay dimensionable: the jog is 7 − 3 = 4 tall.
    expect(
      body.edgeTopology.some(
        (edge) =>
          edge.curve?.type === 'LINE' &&
          Math.abs((edge.length ?? 0) - 4) < 1e-9 &&
          Math.abs(edge.points[0]! - 20) < 1e-9
      )
    ).toBe(true);

    // On the front view, the line runs at z = 3, jogs up at x = 20 to z = 7,
    // thick at both ends and both corners.
    const front = await adapter.drawingTessellation(document, [bodyId]);
    const frontProjection = projectView({
      orientation: 'front',
      hiddenLines: false,
      bodies: [front[bodyId]!]
    });
    const source = { view: sheet.views[0]!, projection: frontProjection };
    const line = sectionLineOnPage(sheet, section, source, 'mm')!;
    // 2:1 about the front's middle (x 20, z 5) at paper (150, 80).
    expect(line.points).toEqual([
      [150 - 40 - 4, 80 - 4],
      [150, 80 - 4],
      [150, 80 + 4],
      [150 + 40 + 4, 80 + 4]
    ]);
    const page = composeSheetPage(
      sheet,
      [source, { view: section, projection }],
      { projectName: 'Block', units: 'mm' }
    );
    const chain = page.strokes.filter((stroke) => stroke.kind === 'chain');
    expect(chain.some((stroke) => stroke.points.length === 8)).toBe(true);
    // Two ends, and two strokes at each of the two corners.
    expect(
      page.strokes.filter((stroke) => stroke.kind === 'cutting')
    ).toHaveLength(6);
    expect(page.texts.some((text) => text.text === 'SECTION A-A')).toBe(true);
  });
});
