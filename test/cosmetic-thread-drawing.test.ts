import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  holeBody,
  listFeaturesInOrder,
  patternBody,
  type HoleInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  DRAWING_VIEW_FRAMES,
  toUserId,
  type BodyId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingViewId,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import { holeCalloutLookup } from '../apps/web/src/lib/drawing/annotations';
import {
  cosmeticThreadStrokes,
  cosmeticThreads,
  viewCosmeticThreads,
  type CosmeticThread
} from '../apps/web/src/lib/drawing/cosmeticThreads';
import { composeSheetPage } from '../apps/web/src/lib/drawing/sheetPage';

/**
 * M01: a cosmetic thread (schema v67) leaves the tap-drill bore in the
 * model, so drawing views draw the thread by convention (ISO 6410-1): a thin
 * three-quarter major-diameter circle seen down the bore, hidden major-
 * diameter lines and a limit line seen across it. On a 40 × 40 × 10 plate
 * with an M6 tap drill at its middle (major Ø6, drill Ø5).
 */

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;
const lastFeature = (document: ProjectDocument): FeatureId =>
  listFeaturesInOrder(document).at(-1)!.featureId;

const M6_TAP: HoleInput['standard'] = {
  system: 'iso',
  size: 'M6',
  kind: 'tap-drill'
};

/** Paper = model coordinates, so stroke points read in model units. */
const identity = (u: number, v: number): [number, number] => [u, v];

function pairs(points: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i += 2)
    out.push([points[i]!, points[i + 1]!]);
  return out;
}

describe('M01 cosmetic threads drawn in views', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function drilled(extra: Partial<HoleInput>) {
    const document = addPrimitiveFeature(
      createProjectDocument('Plate', toUserId('user_m01')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 40, depth: 10 }
      }
    );
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[last(document)]!;
    const face = body.topology!.faces.find(
      (candidate) =>
        candidate.geometry?.surfaceType === 'plane' &&
        (candidate.geometry.normal?.z ?? 0) > 0.999 &&
        Math.abs(
          (candidate.geometry.centroid ?? candidate.geometry.center).z -
            body.bbox.max.z
        ) < 1e-6
    )!;
    const holed = holeBody(document, {
      name: 'Hole',
      targetBodyId: last(document),
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      style: 'simple',
      diameter: 5,
      depthMode: 'through',
      position: { u: 0, v: 0 },
      positionAnchor: 'centroid',
      standard: M6_TAP,
      ...extra
    }).document;
    return {
      document: holed,
      derived: await adapter.syncDocument(holed),
      top: body.bbox.max.z,
      middle: {
        x: (body.bbox.min.x + body.bbox.max.x) / 2,
        y: (body.bbox.min.y + body.bbox.max.y) / 2
      }
    };
  }

  it('reads a thread stopped short from the bore’s entry end', async () => {
    const { document, derived, top, middle } = await drilled({
      depthMode: 'blind',
      depth: 8,
      tapped: { cosmetic: true, length: 6 }
    });
    const threads = cosmeticThreads(
      [derived.bodyRepresentations[last(document)]],
      holeCalloutLookup(document)
    );
    expect(threads).toHaveLength(1);
    const [thread] = threads as [CosmeticThread];
    expect(thread.holeId).toBe(lastFeature(document));
    expect(thread.majorRadius).toBeCloseTo(3, 12);
    expect(thread.length).toBeCloseTo(6, 12);
    expect(thread.entry.x).toBeCloseTo(middle.x, 9);
    expect(thread.entry.y).toBeCloseTo(middle.y, 9);
    expect(thread.entry.z).toBeCloseTo(top, 9);
    expect(thread.axis.z).toBeCloseTo(-1, 12);
  }, 180_000);

  it('draws a thin three-quarter circle from above, hidden from below', async () => {
    const { document, derived, middle } = await drilled({
      tapped: { cosmetic: true }
    });
    const threads = cosmeticThreads(
      [derived.bodyRepresentations[last(document)]],
      holeCalloutLookup(document)
    );
    const [arc] = cosmeticThreadStrokes(
      threads,
      DRAWING_VIEW_FRAMES.top,
      identity
    );
    expect(arc?.kind).toBe('thin');
    const points = pairs(arc!.points);
    // Every point on the Ø6 circle about the bore's axis…
    for (const [u, v] of points) {
      expect(Math.hypot(u - middle.x, v - middle.y)).toBeCloseTo(3, 9);
    }
    // …from 90° round to 360°: a quarter left open, upper right.
    const angle = ([u, v]: [number, number]) =>
      Math.atan2(v - middle.y, u - middle.x);
    expect(angle(points[0]!)).toBeCloseTo(Math.PI / 2, 9);
    expect(angle(points.at(-1)!)).toBeCloseTo(0, 9);
    const [below] = cosmeticThreadStrokes(
      threads,
      DRAWING_VIEW_FRAMES.bottom,
      identity
    );
    expect(below?.kind).toBe('hidden');
  }, 180_000);

  it('draws hidden major-diameter lines and a limit line across the bore', async () => {
    const { document, derived, top, middle } = await drilled({
      depthMode: 'blind',
      depth: 8,
      tapped: { cosmetic: true, length: 6 }
    });
    const threads = cosmeticThreads(
      [derived.bodyRepresentations[last(document)]],
      holeCalloutLookup(document)
    );
    const strokes = cosmeticThreadStrokes(
      threads,
      DRAWING_VIEW_FRAMES.front,
      identity
    );
    expect(strokes.map((stroke) => stroke.kind)).toEqual([
      'hidden',
      'hidden',
      'hidden'
    ]);
    // Front: u is x, v is z. The two lines run 6 down from the top, ±3 off
    // the axis; the limit line closes them at 6 deep.
    const lines = strokes.map((stroke) => pairs(stroke.points));
    const us = lines
      .slice(0, 2)
      .map((line) => line[0]![0] - middle.x)
      .sort();
    expect(us[0]).toBeCloseTo(-3, 9);
    expect(us[1]).toBeCloseTo(3, 9);
    for (const line of lines.slice(0, 2)) {
      expect(line[0]![1]).toBeCloseTo(top, 9);
      expect(line[1]![1]).toBeCloseTo(top - 6, 9);
    }
    const limit = lines[2]!;
    expect(limit[0]![1]).toBeCloseTo(top - 6, 9);
    expect(limit[1]![1]).toBeCloseTo(top - 6, 9);
    expect(Math.abs(limit[0]![0] - limit[1]![0])).toBeCloseTo(6, 9);
    // Seen obliquely, nothing is drawn.
    expect(
      cosmeticThreadStrokes(threads, DRAWING_VIEW_FRAMES.iso, identity)
    ).toEqual([]);
  }, 180_000);

  it('threads every copy of a patterned cosmetic hole, and none of a plain one', async () => {
    const { document } = await drilled({ tapped: { cosmetic: true } });
    const row = patternBody(document, {
      name: 'Row',
      targetBodyId: last(document),
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 8,
      sourceFeatureIds: [lastFeature(document)]
    }).document;
    const derived = await adapter.syncDocument(row);
    const threads = cosmeticThreads(
      [derived.bodyRepresentations[last(row)]],
      holeCalloutLookup(row)
    );
    expect(threads).toHaveLength(3);
    expect(threads.every((thread) => thread.length === 10)).toBe(true);
    const plain = await drilled({});
    expect(
      cosmeticThreads(
        [plain.derived.bodyRepresentations[last(plain.document)]],
        holeCalloutLookup(plain.document)
      )
    ).toEqual([]);
  }, 180_000);

  it('puts the thread on the composed sheet, and leaves a section view without one', async () => {
    const { document, derived } = await drilled({
      tapped: { cosmetic: true }
    });
    const bodyId = last(document);
    const view = {
      viewId: 'dvw_top' as DrawingViewId,
      orientation: 'top' as const,
      bodyIds: [bodyId],
      centerMm: { x: 200, y: 150 },
      hiddenLines: true
    };
    const sheet: DrawingSheet = {
      sheetId: 'dsht_threads' as DrawingSheetId,
      name: 'Threads',
      paper: { size: 'A3', orientation: 'landscape' },
      scale: { numerator: 1, denominator: 1 },
      projectionAngle: 'third',
      titleBlock: {},
      source: { fingerprint: 'v1:test' },
      views: [view]
    };
    const bodies = derived.bodyRepresentations;
    const holes = holeCalloutLookup(document);
    const page = composeSheetPage(
      sheet,
      [
        {
          view,
          projection: {
            visible: [],
            hidden: [],
            bounds: { minU: 0, minV: 0, maxU: 40, maxV: 40 }
          }
        }
      ],
      {
        projectName: 'Plate',
        units: 'mm',
        cosmeticThreads: (shown) => viewCosmeticThreads(shown, bodies, holes)
      }
    );
    const thin = page.strokes.filter((stroke) => stroke.kind === 'thin');
    // The view's centre is the plate's middle, at 1:1 on the paper.
    const arc = thin.find((stroke) =>
      pairs(stroke.points).every(
        ([x, y]) => Math.abs(Math.hypot(x - 200, y - 150) - 3) < 1e-9
      )
    );
    expect(arc).toBeDefined();
    expect(
      viewCosmeticThreads(
        { ...view, section: {} as never },
        bodies,
        holes
      )
    ).toEqual([]);
  }, 180_000);
});
