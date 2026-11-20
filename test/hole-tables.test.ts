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
  type HoleCallout,
  type ProjectDocument
} from '@openzcad/shared';
import {
  drawingNumberFormat,
  holeCalloutLookup,
  layoutAnnotation,
  resolveDrawingAnnotation,
  type AnnotationBodies
} from '../apps/web/src/lib/drawing/annotations';
import {
  applyAnnotationPick,
  draftAnnotation,
  draftRefusal,
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

/** A table's sizes column, or why it is broken. */
const sizes = (resolved: ReturnType<typeof resolveDrawingAnnotation>) =>
  resolved.ok && resolved.resolved.kind === 'hole-table'
    ? resolved.resolved.rows.map((row) => row[3])
    : resolved;

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
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(117);
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
      schemaVersion: 116,
      drawings: { sheets: [sheet] }
    } as unknown as ProjectDocument;
    expect(() => assertDocumentContentSchema(old)).toThrow(
      /Hole tables require project schema v117/
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

  /** A plate with a Ø8 through hole and a Ø6 blind one, both from the top. */
  async function blindAndThrough() {
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
    document = await drill(document, min.x + 40, min.y + 20, {
      diameter: 6,
      depthMode: 'blind',
      depth: 4
    });
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    return { document, derived };
  }

  it('lists only the bores its view shows (review)', async () => {
    const { document, derived } = await blindAndThrough();
    const holes = holeCalloutLookup(document);
    const bottom = (hiddenLines: boolean): DrawingView => ({
      ...view(TOP, last(document)),
      orientation: 'bottom',
      hiddenLines
    });
    // From above both openings show.
    expect(
      sizes(
        resolveDrawingAnnotation(
          table(TOP),
          view(TOP, last(document)),
          derived.bodyRepresentations,
          'mm',
          holes
        )
      )
    ).toEqual(['Ø6 × 4 DEEP', 'Ø8 THRU']);
    // From below the blind hole's floor is under the plate: drawn only as
    // a hidden line, and listed only where hidden lines are drawn.
    expect(
      sizes(
        resolveDrawingAnnotation(
          table(TOP),
          bottom(false),
          derived.bodyRepresentations,
          'mm',
          holes
        )
      )
    ).toEqual(['Ø8 THRU']);
    expect(
      sizes(
        resolveDrawingAnnotation(
          table(TOP),
          bottom(true),
          derived.bodyRepresentations,
          'mm',
          holes
        )
      )
    ).toEqual(['Ø6 × 4 DEEP', 'Ø8 THRU']);
  }, 180_000);

  it('lists only the bores inside a detail’s circle (review)', async () => {
    const { document, derived } = await blindAndThrough();
    const holes = holeCalloutLookup(document);
    const whole = resolveDrawingAnnotation(
      table(TOP),
      view(TOP, last(document)),
      derived.bodyRepresentations,
      'mm',
      holes
    );
    if (!whole.ok || whole.resolved.kind !== 'hole-table')
      throw new Error('The top view lists its holes.');
    const eight = whole.resolved.tags.find((tag) => tag.r === 4)!;
    const detail: DrawingView = {
      ...view(TOP, last(document)),
      detail: {
        sourceViewId: TOP,
        label: 'A',
        center: { u: eight.u, v: eight.v },
        radius: 6,
        scale: { numerator: 2, denominator: 1 }
      }
    };
    expect(
      sizes(
        resolveDrawingAnnotation(
          table(TOP),
          detail,
          derived.bodyRepresentations,
          'mm',
          holes
        )
      )
    ).toEqual(['Ø8 THRU']);
  }, 180_000);

  it('is broken by holes a whole-body pattern copied (review)', async () => {
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
    document = patternBody(document, {
      name: 'Plates',
      targetBodyId: last(document),
      patternKind: 'linear',
      count: 2,
      axis: 'x',
      spacing: 80
    }).document;
    const derived = await adapter.syncDocument(document);
    const named = derived.bodyRepresentations[
      last(document)
    ]!.topology!.faces.some((face) =>
      /^pattern\.face\.instance\.[^.]+\.hole\.face\.bore$/.test(
        face.reference?.lineageName ?? ''
      )
    );
    const resolved = resolveDrawingAnnotation(
      table(TOP),
      view(TOP, last(document)),
      derived.bodyRepresentations,
      'mm',
      holeCalloutLookup(document)
    );
    // Where the copy's bore keeps its name, the table says it cannot list
    // it; it never lists the original alone.
    expect(resolved).toMatchObject(
      named ? { ok: false, reason: 'hole-unnamed' } : { ok: true }
    );
    if (!named && resolved.ok && resolved.resolved.kind === 'hole-table')
      expect(resolved.resolved.rows).toHaveLength(2);
  }, 180_000);

  it('is placed by the tool, which reads the holes it lists (review)', async () => {
    const { document, derived } = await plate();
    const annotation = table(TOP);
    const top = view(TOP, last(document));
    expect(
      draftRefusal(
        annotation,
        top,
        derived.bodyRepresentations,
        'mm',
        undefined,
        undefined,
        holeCalloutLookup(document)
      )
    ).toBeNull();
  }, 180_000);
});

describe('M01 hole tables: rows and sizes (review)', () => {
  /** A body of bare bores down Z: a cylinder face each, no mesh to hide them. */
  function bores(
    entries: { hole: string; x: number; z0: number; z1: number }[]
  ): AnnotationBodies {
    return {
      body_b: {
        bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 40, z: 10 } },
        mesh: {
          kind: 'mesh',
          vertices: new Float32Array(),
          indices: new Uint32Array()
        },
        topology: {
          faces: entries.map((entry, index) => ({
            hash: index + 1,
            reference: {
              producingFeatureId: entry.hole,
              lineageName: 'hole.face.bore'
            },
            geometry: {
              surfaceType: 'Cylinder',
              axisStart: { x: entry.x, y: 20, z: entry.z0 },
              axisEnd: { x: entry.x, y: 20, z: entry.z1 }
            }
          })),
          edges: []
        }
      }
    } as unknown as AnnotationBodies;
  }
  const callout = (diameter: number): HoleCallout => ({
    count: 1,
    diameter,
    depth: null,
    style: 'simple'
  });
  const topView = view(TOP, 'body_b' as BodyId);

  it('keeps two holes on one axis as two rows', () => {
    const resolved = resolveDrawingAnnotation(
      table(TOP),
      topView,
      bores([
        { hole: 'feat_wide', x: 20, z0: 5, z1: 10 },
        { hole: 'feat_narrow', x: 20, z0: 0, z1: 5 }
      ]),
      'mm',
      (id) => (id === 'feat_wide' ? callout(12) : callout(6))
    );
    expect(sizes(resolved)).toEqual(['Ø6 THRU', 'Ø12 THRU']);
  });

  it('tells sizes apart by the model, not by the printed digits', () => {
    const resolved = resolveDrawingAnnotation(
      table(TOP),
      topView,
      bores([
        { hole: 'feat_a', x: 10, z0: 0, z1: 10 },
        { hole: 'feat_b', x: 30, z0: 0, z1: 10 }
      ]),
      'mm',
      (id) => (id === 'feat_a' ? callout(5.01) : callout(5.04)),
      drawingNumberFormat({ decimals: 1 }, 'mm')
    );
    expect(
      resolved.ok && resolved.resolved.kind === 'hole-table'
        ? resolved.resolved.rows.map((row) => row[0])
        : resolved
    ).toEqual(['A1', 'B1']);
  });
});

describe('M01 hole tables: what the view shows (re-check)', () => {
  interface Bore {
    hole: string;
    x: number;
    y?: number;
    z0: number;
    z1: number;
    lineageName?: string;
  }
  /** A body of bores down Z, and flat squares of cover over them. */
  function body(
    bores: Bore[],
    covers: { x0: number; x1: number; y0: number; y1: number; z: number }[] = []
  ) {
    const vertices: number[] = [];
    const indices: number[] = [];
    for (const { x0, x1, y0, y1, z } of covers) {
      const at = vertices.length / 3;
      vertices.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z);
      indices.push(at, at + 1, at + 2, at, at + 2, at + 3);
    }
    const xs = bores.map((bore) => bore.x);
    return {
      bbox: {
        min: { x: Math.min(...xs) - 10, y: 0, z: 0 },
        max: { x: Math.max(...xs) + 10, y: 40, z: 10 }
      },
      mesh: {
        kind: 'mesh',
        vertices: new Float32Array(vertices),
        indices: new Uint32Array(indices)
      },
      topology: {
        faces: bores.map((bore, index) => ({
          hash: index + 1,
          reference: {
            producingFeatureId: bore.hole,
            lineageName: bore.lineageName ?? 'hole.face.bore'
          },
          geometry: {
            surfaceType: 'Cylinder',
            radius: 4,
            axisStart: { x: bore.x, y: bore.y ?? 20, z: bore.z0 },
            axisEnd: { x: bore.x, y: bore.y ?? 20, z: bore.z1 }
          }
        })),
        edges: []
      }
    };
  }
  const eight = (extra: Partial<HoleCallout> = {}): HoleCallout => ({
    count: 1,
    diameter: 8,
    depth: null,
    style: 'simple',
    ...extra
  });
  const resolve = (
    bodies: Record<string, unknown>,
    holes: (id: string) => HoleCallout | null,
    hiddenLines = false
  ) =>
    resolveDrawingAnnotation(
      table(TOP),
      {
        ...view(TOP, Object.keys(bodies)[0] as BodyId),
        bodyIds: Object.keys(bodies) as BodyId[],
        hiddenLines
      },
      bodies as unknown as AnnotationBodies,
      'mm',
      holes
    );

  it('keeps one-size holes of two bodies on one axis as two rows', () => {
    const resolved = resolve(
      {
        body_upper: body([{ hole: 'feat_upper', x: 20, z0: 5, z1: 10 }]),
        body_lower: body([{ hole: 'feat_lower', x: 20, z0: 0, z1: 5 }])
      },
      () => eight(),
      true
    );
    expect(sizes(resolved)).toEqual(['Ø8 THRU', 'Ø8 THRU']);
  });

  it('hides a bore a thin cover just over it hides, far from the origin', () => {
    const covered = body(
      [{ hole: 'feat_far', x: 10_000, z0: 0, z1: 10 }],
      [{ x0: 9_990, x1: 10_010, y0: 10, y1: 30, z: 10.3 }]
    );
    expect(resolve({ body_far: covered }, () => eight())).toMatchObject({
      ok: false,
      reason: 'no-holes'
    });
  });

  it('lists a bore a strip across its middle leaves showing', () => {
    const striped = body(
      [{ hole: 'feat_hole', x: 20, z0: 0, z1: 10 }],
      [{ x0: 19.5, x1: 20.5, y0: 0, y1: 40, z: 12 }]
    );
    expect(sizes(resolve({ body_strip: striped }, () => eight()))).toEqual([
      'Ø8 THRU'
    ]);
  });

  it('names the hole of a feature pattern copy its body was copied with', () => {
    const copied = body([
      { hole: 'feat_hole', x: 10, z0: 0, z1: 10 },
      {
        hole: 'feat_whole',
        x: 90,
        z0: 0,
        z1: 10,
        lineageName:
          'pattern.face.instance.2.pattern.face.instance.2.source.feat_hole.hole.face.bore'
      }
    ]);
    expect(
      sizes(
        resolve({ body_copied: copied }, (id) =>
          id === 'feat_hole' ? eight() : null
        )
      )
    ).toEqual(['Ø8 THRU', 'Ø8 THRU']);
  });

  it('gives one letter to one standard size however its keys are ordered', () => {
    const resolved = resolve(
      {
        body_std: body([
          { hole: 'feat_a', x: 10, z0: 0, z1: 10 },
          { hole: 'feat_b', x: 30, z0: 0, z1: 10 }
        ])
      },
      (id) =>
        id === 'feat_a'
          ? eight({
              standard: {
                system: 'iso',
                size: 'M8',
                kind: 'clearance',
                fit: 'normal'
              }
            })
          : eight({
              standard: {
                fit: 'normal',
                kind: 'clearance',
                size: 'M8',
                system: 'iso'
              }
            })
    );
    expect(
      resolved.ok && resolved.resolved.kind === 'hole-table'
        ? resolved.resolved.rows.map((row) => row[0])
        : resolved
    ).toEqual(['A1', 'A2']);
  });
});
