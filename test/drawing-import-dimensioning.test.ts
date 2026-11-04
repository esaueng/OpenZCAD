import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingAnnotationError,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingSheet
} from '@openzcad/shared';
import { resolveDrawingAnnotation } from '../apps/web/src/lib/drawing/annotations';
import { auditDrawingDimensions } from '../apps/web/src/lib/drawing/dimensionAudit';
import {
  buildPart,
  counterboredPlateDocument,
  footOperations,
  frontId,
  importAsStep,
  sheetOf,
  stepOperations
} from './helpers/drawing-dimension-fixtures';
import {
  autoDimension,
  expectClearLayout
} from './helpers/drawing-auto-dimension-harness';

/**
 * D06 slice D: a part with no history, dimensioned from what the checker
 * recognizes in its faces. Each fixture is built from in-app features,
 * exported as STEP through the kernel and imported back, so the body the
 * sheet draws is a history-less import, as a user's file would be.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const messages = (list: { message: string }[]) => list.map((f) => f.message);

/** Each annotation's label as the sheet draws it. */
function labels(
  sheet: DrawingSheet,
  annotations: readonly DrawingAnnotation[],
  bodies: Record<string, BodyRepresentation>
): string[] {
  return annotations.map((annotation) => {
    const view = sheet.views.find(
      (entry) => entry.viewId === annotation.viewId
    );
    const resolution = resolveDrawingAnnotation(annotation, view, bodies, 'mm');
    if (!resolution.ok) throw new Error(resolution.message);
    return resolution.resolved.label;
  });
}

async function importedFoot() {
  const { document, bodyId } = await buildPart(adapter, footOperations());
  return importAsStep(adapter, document, bodyId);
}

describe('D06 slice D: the turned foot as a history-less import', () => {
  it('imports as the plan’s 11 analytic faces with no feature history', async () => {
    const { body, document } = await importedFoot();
    expect(body.source).toBe('imported-step');
    const faces = body.topology!.faces;
    expect(faces).toHaveLength(11);
    const types = faces.map((face) => face.geometry!.surfaceType).sort();
    expect(types).toEqual([
      'cone',
      'cone',
      'cylinder',
      'cylinder',
      'cylinder',
      'plane',
      'plane',
      'plane',
      'torus',
      'torus',
      'torus'
    ]);
    expect(
      Object.values(document.nodes).filter(
        (node) =>
          (node as { data?: { featureKind?: string } }).data?.featureKind ===
          'revolve'
      )
    ).toEqual([]);
  });

  it('reads eight requirements: the chamfers as one 4 × 45° at their virtual sharps, the blends as 3× R4', async () => {
    const { bodies, bodyId } = await importedFoot();
    const audit = auditDrawingDimensions(sheetOf(bodyId), bodies, 'mm');
    expect(messages(audit.missing)).toEqual([
      'Ø40 diameter.',
      'Ø33 diameter.',
      'Ø25 diameter.',
      '2× 4 × 45° chamfer.',
      '3× R4 blend radius.',
      'Z: nothing locates the face at z = 9 from the face at z = 0.',
      "Z: nothing locates the 4 × 45° chamfer's corner at z = 29 from the face at z = 0.",
      'Z: nothing locates the face at z = 50 from the face at z = 0.'
    ]);
    expect(audit).toMatchObject({
      redundant: [],
      unmeasurable: [],
      unchecked: [],
      stated: 0,
      required: 8
    });
    // The same reading as the part it was exported from.
    const built = await buildPart(adapter, footOperations());
    expect(
      messages(
        auditDrawingDimensions(sheetOf(built.bodyId), built.bodies, 'mm')
          .missing
      )
    ).toEqual(messages(audit.missing));
  });

  it('Auto-dimension places exactly the plan’s eight dimensions, none derived', async () => {
    const { bodies, bodyId } = await importedFoot();
    const sheet = sheetOf(bodyId);
    const { plan, after, audit, views } = autoDimension(sheet, bodies);
    expect(labels(after, plan.annotations, bodies)).toEqual([
      'Ø40',
      'Ø33',
      'Ø25',
      '2× 4 × 45°',
      '3× R4',
      '9',
      '29',
      '50'
    ]);
    // Bore depth or floor thickness, one of them: the baseline is the
    // bottom face, so the floor's 9.
    expect(plan.skipped).toEqual([]);
    expect(audit).toMatchObject({
      missing: [],
      redundant: [],
      unmeasurable: [],
      unchecked: [],
      stated: 8,
      required: 8
    });
    // Recognized features, every one: nothing is marked as raw geometry.
    for (const annotation of plan.annotations) {
      expect(annotation.provenance).toMatchObject({ generated: true });
      expect(annotation.provenance).not.toHaveProperty('basis');
    }
    // Every placement stores as a valid v49 annotation.
    const viewIds = new Set(after.views.map((view) => view.viewId));
    for (const annotation of plan.annotations)
      expect(
        drawingAnnotationError(
          JSON.parse(JSON.stringify(annotation)),
          viewIds,
          annotation.annotationId
        )
      ).toBeNull();
    expectClearLayout(after, views, bodies);
  });

  it('calls the blend tangent heights, the contact Ø32 and the shoulder’s own 3.5 derived', async () => {
    const { bodies, bodyId, body } = await importedFoot();
    const faces = body.topology!.faces;
    const edges = body.topology!.edges;
    const cones = faces
      .filter((face) => face.geometry!.surfaceType === 'cone')
      .sort((a, b) => a.geometry!.center.z - b.geometry!.center.z);
    const shoulder = cones[1]!;
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    const rim = (radius: number, z: number) =>
      edges.find((edge) => {
        const circle = edge.curve?.circle;
        return (
          circle && near(circle.radius, radius) && near(circle.center.z, z)
        );
      })!;
    const S = Math.SQRT2;
    // Where the bottom blend meets the body, z = 5.657.
    const tangent = rim(20, 4 * S);
    const bottom = rim(16, 0);
    const annotations: DrawingAnnotation[] = [
      {
        annotationId: 'dann_tangent' as never,
        kind: 'linear',
        viewId: frontId,
        direction: 'vertical',
        from: {
          edge: { bodyId, hash: bottom.hash },
          anchor: 'silhouette',
          side: 'high'
        },
        to: {
          edge: { bodyId, hash: tangent.hash },
          anchor: 'silhouette',
          side: 'high'
        },
        placementMm: { x: 50, y: 0 }
      },
      {
        annotationId: 'dann_d32' as never,
        kind: 'diameter',
        viewId: 'dvw_top' as never,
        edge: { bodyId, hash: bottom.hash },
        placementMm: { x: 30, y: 30 }
      },
      {
        annotationId: 'dann_shoulder' as never,
        kind: 'chamfer',
        viewId: frontId,
        face: { bodyId, hash: shoulder.hash },
        placementMm: { x: 40, y: 20 }
      }
    ];
    const sheet = sheetOf(bodyId, annotations);
    expect(labels(sheet, annotations, bodies)).toEqual([
      '5.66',
      'Ø32',
      '3.5 × 45°'
    ]);
    const audit = auditDrawingDimensions(sheet, bodies, 'mm');
    expect(
      audit.redundant.map(({ annotationId, reason }) => [annotationId, reason])
    ).toEqual([
      ['dann_tangent', 'derived'],
      ['dann_d32', 'derived'],
      ['dann_shoulder', 'derived']
    ]);
    expect(audit.stated).toBe(0);
  });
});

describe('D06 slice D: prismatic imports', () => {
  it('dimensions an imported plate’s counterbored holes from their features', async () => {
    const { document, bodyId: sourceId } = counterboredPlateDocument();
    const { bodies, bodyId } = await importAsStep(adapter, document, sourceId);
    const sheet = sheetOf(bodyId, [], ['top', 'front']);
    const { before, plan, after, audit, views } = autoDimension(sheet, bodies);
    expect(messages(before.missing)).toEqual([
      '2× Ø6 diameter.',
      '2× Ø11 diameter.',
      'X: nothing locates the Ø6 axis at x = 10 from the face at x = 0.',
      'X: nothing locates the Ø6 axis at x = 30 from the face at x = 0.',
      'X: nothing locates the face at x = 40 from the face at x = 0.',
      'Y: nothing locates the Ø6 axis at y = 15 from the face at y = 0.',
      'Y: nothing locates the face at y = 30 from the face at y = 0.',
      'Z: nothing locates the face at z = 5 from the face at z = 0.',
      'Z: nothing locates the face at z = 8 from the face at z = 0.'
    ]);
    // v50: one callout states both diameters and the counterbore's depth,
    // so no span to its floor (z = 5) is placed.
    expect(labels(after, plan.annotations, bodies)).toEqual([
      '2× Ø6 THRU, CBORE Ø11 × 3 DEEP',
      '10',
      '30',
      '40',
      '15',
      '30',
      '8'
    ]);
    expect(audit).toMatchObject({
      missing: [],
      redundant: [],
      unchecked: [],
      stated: 9,
      required: 9
    });
    // The counterbore floor is the counterbore's, the rest the envelope.
    for (const annotation of plan.annotations)
      expect(annotation.provenance).not.toHaveProperty('basis');
    expectClearLayout(after, views, bodies);
  });

  it('marks a dimension to a face no feature explains as raw geometry', async () => {
    const built = await buildPart(adapter, stepOperations());
    const { bodies, bodyId } = await importAsStep(
      adapter,
      built.document,
      built.bodyId
    );
    const { plan, audit } = autoDimension(sheetOf(bodyId), bodies);
    expect(audit).toMatchObject({ missing: [], redundant: [] });
    // The L's inner step faces, at x = 10 and z = 10, are no envelope face
    // and no feature's: their spans are raw geometry (decision 2).
    const marked = plan.annotations
      .filter((annotation) => annotation.provenance?.basis === 'geometry')
      .map((annotation) => annotation.provenance!.requirement);
    expect(marked).toEqual([
      'X: the face at x = 10 from the face at x = 0',
      'Z: the face at z = 10 from the face at z = 0'
    ]);
    // The same part with its history is never marked.
    const history = autoDimension(sheetOf(built.bodyId), built.bodies);
    expect(
      history.plan.annotations.filter(
        (annotation) => annotation.provenance?.basis !== undefined
      )
    ).toEqual([]);
  });
});

describe('Counterbored hole callouts (schema v50)', () => {
  it('states both diameters and the bore depth, and calls a span to its floor repeated', async () => {
    const { document, bodyId: sourceId } = counterboredPlateDocument();
    const { bodies, bodyId } = await importAsStep(adapter, document, sourceId);
    const sheet = sheetOf(bodyId, [], ['top', 'front']);
    const first = autoDimension(sheet, bodies);
    const callout = first.plan.annotations.find(
      (annotation) =>
        annotation.kind === 'diameter' && annotation.counterbore !== undefined
    )!;
    expect(callout).toBeDefined();
    // The callout alone states the three requirements it covers; the bore's
    // floor and the top it opens from then need one span to z = 0, not two.
    const alone = auditDrawingDimensions(
      { ...sheet, annotations: [callout] },
      bodies,
      'mm'
    );
    expect(alone.stated).toBe(3);
    expect(
      alone.missing.filter((entry) => entry.message.startsWith('Z:'))
    ).toHaveLength(1);
    // Without the callout, both heights get a span; with it, the second
    // closes a chain through its depth.
    // The same diameter without its counterbore: a plain Ø6.
    const diameter: DrawingAnnotation = { ...callout };
    if (diameter.kind === 'diameter') delete diameter.counterbore;
    const plain = autoDimension(
      sheetOf(bodyId, [diameter], ['top', 'front']),
      bodies
    );
    const heights = plain.plan.annotations.filter(
      (annotation) =>
        annotation.kind === 'linear' &&
        annotation.provenance?.requirement.startsWith('Z:')
    );
    expect(heights).toHaveLength(2);
    const twice = auditDrawingDimensions(
      { ...sheet, annotations: [callout, ...heights] },
      bodies,
      'mm'
    );
    expect(twice.redundant.map((entry) => entry.reason)).toEqual([
      'closed-chain'
    ]);
  });
});

describe('D06 slice D: schema v49 annotations', () => {
  const viewIds = new Set(['dvw_front']);
  const face = (hash: number) => ({ bodyId: 'body_a', hash });
  const base = {
    annotationId: 'dann_v49',
    viewId: 'dvw_front',
    placementMm: { x: 0, y: 0 }
  };
  const corner = {
    anchor: 'chamfer-corner',
    face: face(11),
    like: face(12),
    side: 'high'
  };
  const silhouette = {
    edge: { bodyId: 'body_a', hash: 13 },
    anchor: 'silhouette',
    side: 'low'
  };
  const error = (value: unknown) =>
    drawingAnnotationError(value, viewIds, 'It');

  it('accepts a chamfer corner, a blend radius and a raw-geometry basis', () => {
    expect(
      error({
        ...base,
        kind: 'linear',
        direction: 'vertical',
        from: silhouette,
        to: corner,
        provenance: { generated: true, requirement: 'Z', basis: 'geometry' }
      })
    ).toBeNull();
    expect(
      error({ ...base, kind: 'radius', face: face(14), side: 'high', count: 3 })
    ).toBeNull();
  });

  it('refuses malformed v49 shapes', () => {
    const linear = (to: unknown, extra: object = {}) =>
      error({
        ...base,
        kind: 'linear',
        direction: 'vertical',
        from: silhouette,
        to,
        ...extra
      });
    expect(linear({ ...corner, like: face(11) })).toBe(
      'It sizes a chamfer corner like itself.'
    );
    expect(linear({ ...corner, like: { bodyId: 'body_b', hash: 12 } })).toBe(
      'It sizes a chamfer corner like a chamfer on another body.'
    );
    expect(linear({ ...corner, side: 'middle' })).toBe(
      'It has an unknown extreme side.'
    );
    expect(
      error({
        ...base,
        kind: 'linear',
        direction: 'aligned',
        from: silhouette,
        to: corner
      })
    ).toBe(
      'It measures to an extreme, which only a horizontal or vertical dimension can.'
    );
    expect(
      linear(corner, {
        provenance: { generated: true, requirement: 'Z', basis: 'feature' }
      })
    ).toBe('It has malformed provenance.');
    expect(
      error({ ...base, kind: 'diameter', face: face(14), side: 'high' })
    ).toBe('It is a diameter of a blend face, which only a radius states.');
    // v50: a counterbore belongs to a diameter callout on an edge.
    const edge = { bodyId: 'body_a', hash: 21 };
    expect(
      error({
        ...base,
        kind: 'diameter',
        edge,
        counterbore: { ...edge, hash: 22 }
      })
    ).toBeNull();
    expect(
      error({
        ...base,
        kind: 'radius',
        edge,
        counterbore: { ...edge, hash: 22 }
      })
    ).toBe('It names a counterbore, which only a diameter callout states.');
    expect(
      error({
        ...base,
        kind: 'diameter',
        edge,
        counterbore: { bodyId: 'body_a' }
      })
    ).not.toBeNull();
    expect(
      error({
        ...base,
        kind: 'radius',
        face: face(14),
        side: 'high',
        edge: { bodyId: 'body_a', hash: 13 }
      })
    ).toBe('It names both an edge and a blend face.');
    expect(error({ ...base, kind: 'radius', face: face(14) })).toBe(
      'It has an unknown extreme side.'
    );
    // v51: a countersink likewise, never with a counterbore; an outside
    // angle turns one of the two edges it names.
    expect(
      error({
        ...base,
        kind: 'diameter',
        edge,
        countersink: { ...edge, hash: 23 }
      })
    ).toBeNull();
    expect(
      error({
        ...base,
        kind: 'radius',
        edge,
        countersink: { ...edge, hash: 23 }
      })
    ).toBe('It names a countersink, which only a diameter callout states.');
    expect(
      error({
        ...base,
        kind: 'diameter',
        edge,
        counterbore: { ...edge, hash: 22 },
        countersink: { ...edge, hash: 23 }
      })
    ).toBe('It names both a counterbore and a countersink.');
    const edges = [edge, { ...edge, hash: 24 }];
    expect(error({ ...base, kind: 'angle', edges, outside: 1 })).toBeNull();
    expect(error({ ...base, kind: 'angle', edges, outside: 2 })).toBe(
      'It turns outward an edge it does not name.'
    );
  });
});
