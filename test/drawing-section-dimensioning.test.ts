import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  DRAWING_VIEW_FRAMES,
  drawingSectionPlane,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingLinearDimension,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';
import {
  annotationModelReading,
  resolveSheetAnnotations,
  sectionBodyKey,
  type AnnotationBodies
} from '../apps/web/src/lib/drawing/annotations';
import { planAutoDimensions } from '../apps/web/src/lib/drawing/autoDimension';
import { auditDrawingDimensions } from '../apps/web/src/lib/drawing/dimensionAudit';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import type { ComposedView } from '../apps/web/src/lib/drawing/sheetPage';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import {
  buildPart,
  footOperations
} from './helpers/drawing-dimension-fixtures';

/**
 * D06 slice F on real kernel bodies: a section view's cut edges are
 * dimension anchors, so a feature inside the part — a bore's floor, a
 * pocket's depth — is required, stated and placed there, on the visible
 * cut, rather than on hidden lines or not at all.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const frontId = 'dvw_front' as DrawingViewId;
const topId = 'dvw_top' as DrawingViewId;
const sectionId = 'dvw_section' as DrawingViewId;

/** Ø20 × 30 with a blind Ø8 bore 18 deep from the top: its floor at z = 12. */
function boredCylinder(): ProjectDocument {
  let document = createProjectDocument('Bushing', toUserId('test'));
  document = addPrimitiveFeature(document, {
    name: 'Body',
    primitiveKind: 'cylinder',
    dimensions: { radius: 10, height: 30 }
  });
  const body = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Bore tool',
    primitiveKind: 'cylinder',
    dimensions: { radius: 4, height: 20 }
  });
  const tool = document.bodyOrder.at(-1)!;
  document = transformBody(document, {
    name: 'Bore position',
    targetBodyId: tool,
    translation: { x: 0, y: 0, z: 12 }
  }).document;
  return booleanBodies(document, {
    name: 'Bore',
    operation: 'subtract',
    targetBodyIds: [body, tool]
  }).document;
}

/**
 * A 40 × 30 × 20 block with a 20 × 10 pocket from its top, 10 deep: the
 * floor at z = 10 is a straight edge every outside view but the top draws
 * hidden, and the top cannot measure z.
 */
function pocketedBlock(): ProjectDocument {
  let document = createProjectDocument('Block', toUserId('test'));
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 30, depth: 20 }
  });
  const body = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Pocket tool',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 12 }
  });
  const tool = document.bodyOrder.at(-1)!;
  document = transformBody(document, {
    name: 'Pocket position',
    targetBodyId: tool,
    translation: { x: 10, y: 10, z: 10 }
  }).document;
  return booleanBodies(document, {
    name: 'Pocket',
    operation: 'subtract',
    targetBodyIds: [body, tool]
  }).document;
}

function view(
  viewId: DrawingViewId,
  orientation: DrawingView['orientation'],
  bodyId: BodyId,
  centerMm: { x: number; y: number },
  extra: Partial<DrawingView> = {}
): DrawingView {
  return {
    viewId,
    orientation,
    bodyIds: [bodyId],
    centerMm,
    hiddenLines: false,
    ...extra
  };
}

/**
 * Front and top views and, when `cutAt` is given, section A-A seen from the
 * right through that point: in third angle, to the right of the front.
 */
function sheetFor(
  bodyId: BodyId,
  options: { cutAt?: Vector3; frontHidden?: boolean } = {}
): DrawingSheet {
  const direction = DRAWING_VIEW_FRAMES.right.direction;
  const views = [
    view(
      frontId,
      'front',
      bodyId,
      { x: 110, y: 100 },
      {
        hiddenLines: options.frontHidden ?? false
      }
    ),
    view(topId, 'top', bodyId, { x: 110, y: 210 })
  ];
  if (options.cutAt)
    views.push(
      view(
        sectionId,
        'right',
        bodyId,
        { x: 250, y: 100 },
        {
          section: {
            sourceViewId: frontId,
            label: 'A',
            depth:
              direction.x * options.cutAt.x +
              direction.y * options.cutAt.y +
              direction.z * options.cutAt.z
          }
        }
      )
    );
  return {
    sheetId: 'dsht_section_dims' as DrawingSheetId,
    name: 'Sheet 1',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views
  };
}

/**
 * Draws the sheet as the workspace does: each view projected, a section
 * from the kernel's exact cut, whose edges sit beside the model's bodies
 * under the section's key.
 */
async function drawSheet(document: ProjectDocument, sheet: DrawingSheet) {
  const synced = await adapter.syncDocument(document);
  const model = synced.bodyRepresentations as Record<
    string,
    BodyRepresentation
  >;
  const bodies: Record<string, BodyRepresentation> = { ...model };
  const views: ComposedView[] = [];
  for (const entry of sheet.views) {
    if (!entry.section) {
      views.push({
        view: entry,
        projection: projectView({
          orientation: entry.orientation,
          hiddenLines: entry.hiddenLines,
          bodies: entry.bodyIds.map((id) => projectionBodyInput(model[id]!)!)
        })
      });
      continue;
    }
    const cut = await adapter.drawingSection(
      document,
      entry.bodyIds,
      drawingSectionPlane({ ...entry, section: entry.section })
    );
    // A body the kernel would not cut exactly is cut from its mesh, with
    // no edges to dimension, as the workspace draws it.
    for (const id of entry.bodyIds) {
      bodies[sectionBodyKey(entry.viewId, id)] = {
        ...model[id]!,
        topology: { faces: [], edges: [...cut[id]!.edgeTopology] }
      };
    }
    views.push({
      view: entry,
      projection: {
        ...projectView({
          orientation: entry.orientation,
          hiddenLines: entry.hiddenLines,
          bodies: entry.bodyIds.map((id) =>
            cut[id]!.approximate
              ? {
                  ...cut[id]!,
                  clip: drawingSectionPlane({
                    ...entry,
                    section: entry.section!
                  })
                }
              : cut[id]!
          )
        }),
        sectionEdges: Object.fromEntries(
          entry.bodyIds.map((id) => [id, cut[id]!.edgeTopology])
        )
      }
    });
  }
  return {
    bodies,
    views,
    approximate: views.some(
      (entry) =>
        entry.view.section &&
        Object.values(entry.projection.sectionEdges ?? {}).some(
          (edges) => edges.length === 0
        )
    )
  };
}

function counter() {
  let next = 0;
  return () => `dann_auto${(next += 1)}` as DrawingAnnotationId;
}

/** Plans, applies and re-checks, as the corpus test does. */
function autoDimension(
  sheet: DrawingSheet,
  views: readonly ComposedView[],
  bodies: AnnotationBodies
) {
  const before = auditDrawingDimensions(sheet, bodies, 'mm');
  const plan = planAutoDimensions(sheet, views, bodies, 'mm', counter());
  const after: DrawingSheet = {
    ...sheet,
    annotations: [...(sheet.annotations ?? []), ...plan.annotations]
  };
  for (const [annotationId, resolution] of resolveSheetAnnotations(
    after,
    bodies,
    'mm'
  ))
    expect(resolution, annotationId).toMatchObject({ ok: true });
  const audit = auditDrawingDimensions(after, bodies, 'mm');
  return { before, plan, after, audit };
}

/** The z values a linear dimension spans, read from the model. */
function zSpan(
  annotation: DrawingAnnotation,
  sheet: DrawingSheet,
  bodies: AnnotationBodies
): [number, number] {
  const reading = annotationModelReading(
    annotation,
    sheet.views.find((entry) => entry.viewId === annotation.viewId),
    bodies,
    'mm'
  );
  if (reading?.kind !== 'linear') throw new Error('not a linear dimension');
  const ends = [reading.from.z, reading.to.z].map(
    (value) => Math.round(value * 1e6) / 1e6
  );
  return [Math.min(...ends), Math.max(...ends)];
}

const messages = (list: { message: string }[]) => list.map((f) => f.message);

describe('D06 slice F: a blind bore dimensioned on its section', () => {
  it('puts the floor on a hidden rim without a section, and asks for one', async () => {
    const document = boredCylinder();
    const bodyId = document.bodyOrder.at(-1)!;
    const sheet = sheetFor(bodyId);
    const { bodies, views } = await drawSheet(document, sheet);
    const { plan, after, audit } = autoDimension(sheet, views, bodies);
    // Outside, the floor is only the silhouette of a rim inside the part.
    const floor = plan.annotations.find(
      (a) => a.kind === 'linear' && zSpan(a, after, bodies).join() === '0,12'
    );
    expect(floor?.viewId).toBe(frontId);
    expect(plan.onHiddenLines).toBe(1);
    expect(plan.sectionAdvice).toBe(
      'Add a section through the part to dimension the face at z = 12 on visible lines.'
    );
    expect(audit).toMatchObject({ missing: [], redundant: [] });
  });

  it('states the floor and the height on the section, and places them there', async () => {
    const document = boredCylinder();
    const bodyId = document.bodyOrder.at(-1)!;
    const sheet = sheetFor(bodyId, { cutAt: { x: 0, y: 0, z: 0 } });
    const { bodies, views } = await drawSheet(document, sheet);
    const { before, plan, after, audit } = autoDimension(sheet, views, bodies);
    expect(messages(before.missing)).toEqual([
      'Ø20 diameter.',
      'Ø8 diameter.',
      'Z: nothing locates the face at z = 12 from the face at z = 0.',
      'Z: nothing locates the face at z = 30 from the face at z = 0.'
    ]);
    expect(before.unmeasurable).toEqual([]);

    // The diameters face-on from above; the floor and the height on the
    // cut, where both are visible lines.
    const linear = plan.annotations.filter(
      (a): a is DrawingLinearDimension => a.kind === 'linear'
    );
    expect(
      linear.map((a) => ({ viewId: a.viewId, span: zSpan(a, after, bodies) }))
    ).toEqual([
      { viewId: sectionId, span: [0, 12] },
      { viewId: sectionId, span: [0, 30] }
    ]);
    expect(linear.every((a) => a.direction === 'vertical')).toBe(true);
    expect(
      plan.annotations.filter((a) => a.kind === 'diameter').map((a) => a.viewId)
    ).toEqual([topId, topId]);
    expect(plan.onHiddenLines).toBe(0);
    expect(plan.sectionAdvice).toBeNull();
    // The invariant: nothing missing, nothing repeated, nothing unread.
    expect(audit).toMatchObject({
      missing: [],
      redundant: [],
      unmeasurable: [],
      unchecked: []
    });
    expect(audit.stated).toBe(audit.required);

    // A depth the user adds on the section closes the chain the floor and
    // height already state: 30 − 12.
    const [floor, height] = linear;
    const depth: DrawingLinearDimension = {
      ...floor!,
      annotationId: 'dann_depth' as DrawingAnnotationId,
      from: floor!.to,
      to: height!.to
    };
    expect(zSpan(depth, after, bodies)).toEqual([12, 30]);
    const repeated = auditDrawingDimensions(
      { ...after, annotations: [...after.annotations!, depth] },
      bodies,
      'mm'
    );
    expect(repeated.redundant).toMatchObject([
      { annotationId: 'dann_depth', reason: 'closed-chain' }
    ]);
  });
});

describe('D06 slice F: an internal pocket prefers the section to hidden lines', () => {
  it('dimensions the floor on hidden lines without a section, and asks for one', async () => {
    const document = pocketedBlock();
    const bodyId = document.bodyOrder.at(-1)!;
    const sheet = sheetFor(bodyId, { frontHidden: true });
    const { bodies, views } = await drawSheet(document, sheet);
    const { plan, after, audit } = autoDimension(sheet, views, bodies);
    const floor = plan.annotations.find(
      (a) =>
        a.kind === 'linear' && zSpan(a, after, bodies).join() === [0, 10].join()
    );
    expect(floor?.viewId).toBe(frontId);
    expect(plan.onHiddenLines).toBe(1);
    expect(plan.sectionAdvice).toBe(
      'Add a section through the part to dimension the face at z = 10 on visible lines.'
    );
    expect(audit).toMatchObject({ missing: [], redundant: [] });
  });

  it('moves the floor onto the section once there is one', async () => {
    const document = pocketedBlock();
    const bodyId = document.bodyOrder.at(-1)!;
    const sheet = sheetFor(bodyId, {
      frontHidden: true,
      cutAt: { x: 20, y: 0, z: 0 }
    });
    const { bodies, views } = await drawSheet(document, sheet);
    const { plan, after, audit } = autoDimension(sheet, views, bodies);
    const floor = plan.annotations.find(
      (a) =>
        a.kind === 'linear' && zSpan(a, after, bodies).join() === [0, 10].join()
    );
    expect(floor?.viewId).toBe(sectionId);
    expect(plan.onHiddenLines).toBe(0);
    expect(plan.sectionAdvice).toBeNull();
    expect(audit).toMatchObject({
      missing: [],
      redundant: [],
      unmeasurable: [],
      unchecked: []
    });
    expect(audit.stated).toBe(audit.required);
  });
});

describe('D06 slice F: the turned foot', () => {
  it('asks for a section for its bore floor when it has none', async () => {
    const { document, bodyId } = await buildPart(adapter, footOperations());
    const sheet = sheetFor(bodyId);
    const { bodies, views } = await drawSheet(document, sheet);
    const { plan, after, audit } = autoDimension(sheet, views, bodies);
    // 9 floor thickness (on the bore rim's hidden silhouette) and 50
    // overall, from the contact face.
    expect(
      plan.annotations
        .filter((a) => a.kind === 'linear')
        .map((a) => zSpan(a, after, bodies))
    ).toEqual([
      [0, 9],
      [0, 50]
    ]);
    expect(plan.onHiddenLines).toBe(1);
    expect(plan.sectionAdvice).toBe(
      'Add a section through the part to dimension the face at z = 9 on visible lines.'
    );
    expect(audit.redundant).toEqual([]);
  });

  it('places nothing on a section the kernel cut from the tessellation, and says so', async () => {
    // The pinned kernel's exact-only boolean refuses every plane through
    // the foot's revolved blends and chamfers (a Remus ask on D03's open
    // list), so section A-A is drawn from the mesh with no edge identity.
    // When it cuts exactly, this case becomes the bored cylinder's.
    const { document, bodyId } = await buildPart(adapter, footOperations());
    const sheet = sheetFor(bodyId, { cutAt: { x: 0, y: 0, z: 0 } });
    const { bodies, views, approximate } = await drawSheet(document, sheet);
    expect(approximate).toBe(true);
    const { plan, audit } = autoDimension(sheet, views, bodies);
    expect(plan.annotations.some((a) => a.viewId === sectionId)).toBe(false);
    expect(plan.sectionAdvice).toBe(
      'Add a section through the part to dimension the face at z = 9 on visible lines. Section A-A was cut from the tessellation, so its edges cannot carry dimensions.'
    );
    expect(audit.redundant).toEqual([]);
  });
});
