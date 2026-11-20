import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  assertDocumentContentSchema,
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
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  drawingAnnotationError,
  toUserId,
  type BodyId,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingView,
  type DrawingViewId,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  holeCalloutLookup,
  layoutAnnotation,
  resolveDrawingAnnotation
} from '../apps/web/src/lib/drawing/annotations';
import {
  applyAnnotationPick,
  draftAnnotation,
  startAnnotationTool
} from '../apps/web/src/lib/drawing/annotationPicking';

/**
 * M01 hole tables on drawing sheets: one view's bores, each a row with a
 * tag (a letter per size, a number per bore), its X and Y from the lower-
 * left corner of the view's bodies, and its size as the hole's callout
 * writes it. On a 60 × 40 × 10 plate with a Ø8 through hole and an M6 tap
 * drill repeated by an M02 pattern.
 */

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;
const lastFeature = (document: ProjectDocument): FeatureId =>
  listFeaturesInOrder(document).at(-1)!.featureId;

const TOP = 'dvw_top' as DrawingViewId;
const FRONT = 'dvw_front' as DrawingViewId;

function view(viewId: DrawingViewId, bodyId: BodyId): DrawingView {
  return {
    viewId,
    orientation: viewId === TOP ? 'top' : 'front',
    bodyIds: [bodyId],
    centerMm: { x: 150, y: 150 },
    hiddenLines: false
  };
}

function table(viewId: DrawingViewId): DrawingAnnotation {
  return {
    annotationId: 'dann_holes' as DrawingAnnotationId,
    kind: 'hole-table',
    viewId,
    placementMm: { x: -40, y: -40 }
  };
}

describe('M01 hole tables: the stored annotation', () => {
  it('is a view and a place, nothing measured of its own', () => {
    const views = new Set<string>([TOP]);
    expect(drawingAnnotationError(table(TOP), views, 'Table')).toBeNull();
    expect(
      drawingAnnotationError(
        { ...table(TOP), viewId: undefined },
        views,
        'Table'
      )
    ).toMatch(/lists no view's holes/);
    expect(
      drawingAnnotationError({ ...table(TOP), decimals: 2 }, views, 'Table')
    ).toMatch(/states no measured value/);
  });

  it('is refused on a document that declares an older schema', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(115);
    const document = addPrimitiveFeature(
      createProjectDocument('Plate', toUserId('user_m01')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 60, height: 40, depth: 10 }
      }
    );
    const sheet = {
      sheetId: 'dsht_holes',
      name: 'Holes',
      paper: { size: 'A3', orientation: 'landscape' },
      scale: { numerator: 1, denominator: 1 },
      projectionAngle: 'third',
      titleBlock: {},
      source: { fingerprint: 'v1:test' },
      views: [view(TOP, last(document))],
      annotations: [table(TOP)]
    };
    const old = {
      ...document,
      schemaVersion: 114,
      drawings: { sheets: [sheet] }
    } as unknown as ProjectDocument;
    expect(() => assertDocumentContentSchema(old)).toThrow(
      /Hole tables require project schema v115/
    );
  });

  it('takes its view with one click and its place with the next', () => {
    const top = view(TOP, 'body_plate' as BodyId);
    let tool = startAnnotationTool('hole-table');
    const missed = applyAnnotationPick(tool, null, [10, 10], null, {});
    expect(missed.ok).toBe(false);
    const picked = applyAnnotationPick(tool, null, [150, 150], top, {});
    expect(picked.ok && picked.tool.viewId).toBe(TOP);
    tool = picked.ok ? picked.tool : tool;
    const placed = applyAnnotationPick(tool, null, [110, 90], null, {});
    expect(placed.ok).toBe(true);
    expect(
      draftAnnotation(
        placed.ok ? placed.tool : tool,
        'dann_new' as DrawingAnnotationId,
        { x: -40, y: -60 }
      )
    ).toEqual({
      annotationId: 'dann_new',
      kind: 'hole-table',
      viewId: TOP,
      placementMm: { x: -40, y: -60 }
    });
  });
});

describe('M01 hole tables: read from the model', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  /** The plate with a hole at world (x, y). */
  async function drill(
    document: ProjectDocument,
    x: number,
    y: number,
    extra: Partial<HoleInput>
  ): Promise<ProjectDocument> {
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
    return holeBody(document, {
      name: 'Hole',
      targetBodyId: last(document),
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      style: 'simple',
      diameter: 8,
      depthMode: 'through',
      // From the face's centroid, which an earlier hole has moved; the
      // face's u runs along −y.
      position: {
        u: (face.geometry!.centroid ?? face.geometry!.center).y - y,
        v: x - (face.geometry!.centroid ?? face.geometry!.center).x
      },
      positionAnchor: 'centroid',
      ...extra
    }).document;
  }

  async function plate() {
    let document = addPrimitiveFeature(
      createProjectDocument('Plate', toUserId('user_m01')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 60, height: 40, depth: 10 }
      }
    );
    const min = (await adapter.syncDocument(document)).bodyRepresentations[
      last(document)
    ]!.bbox.min;
    document = await drill(document, min.x + 15, min.y + 20, {});
    document = await drill(document, min.x + 40, min.y + 10, {
      diameter: 5,
      standard: { system: 'iso', size: 'M6', kind: 'tap-drill' }
    });
    document = patternBody(document, {
      name: 'Row',
      targetBodyId: last(document),
      patternKind: 'linear',
      count: 2,
      axis: 'x',
      spacing: 10,
      sourceFeatureIds: [lastFeature(document)]
    }).document;
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    return { document, derived };
  }

  it('lists every bore of the top view, smallest size first', async () => {
    const { document, derived } = await plate();
    const resolved = resolveDrawingAnnotation(
      table(TOP),
      view(TOP, last(document)),
      derived.bodyRepresentations,
      'mm',
      holeCalloutLookup(document)
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.resolved.kind !== 'hole-table') return;
    expect(resolved.resolved.header).toEqual(['TAG', 'X', 'Y', 'SIZE']);
    expect(resolved.resolved.rows).toEqual([
      ['A1', '40', '10', 'Ø5 THRU, M6×1 TAP DRILL'],
      ['A2', '50', '10', 'Ø5 THRU, M6×1 TAP DRILL'],
      ['B1', '15', '20', 'Ø8 THRU']
    ]);
    // Each tag stands beside its bore in the view, up and right of its rim.
    const laid = layoutAnnotation(
      resolved.resolved,
      (u, v) => [u, v],
      1,
      [100, 100]
    );
    const tag = laid.texts.find((text) => text.text === 'B1' && text.x < 90);
    const min = derived.bodyRepresentations[last(document)]!.bbox.min;
    expect(tag?.x).toBeCloseTo(min.x + 15 + 4 * Math.SQRT1_2 + 0.8, 9);
    expect(tag?.y).toBeCloseTo(min.y + 20 + 4 * Math.SQRT1_2 + 0.8, 9);
  }, 180_000);

  it('is broken on a view that sees no bore down its axis', async () => {
    const { document, derived } = await plate();
    const resolved = resolveDrawingAnnotation(
      table(FRONT),
      view(FRONT, last(document)),
      derived.bodyRepresentations,
      'mm',
      holeCalloutLookup(document)
    );
    expect(resolved).toMatchObject({ ok: false, reason: 'no-holes' });
  }, 180_000);
});
