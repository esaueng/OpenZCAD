import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCadPatchProposal } from '@openzcad/ai-contracts';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  composeCommands
} from '@openzcad/command-system';
import {
  assertStorableDocument,
  createProjectDocument,
  findSketch,
  normalizeDocument,
  UnstorableDocumentError
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingSetError,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DocumentNode,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingEdgeRef,
  type DrawingFaceRef,
  type DrawingLinearDimension,
  type DrawingPointRef,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type EdgeTopology,
  type FaceTopology,
  type ProjectDocument,
  type SketchId
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import { composeSheetPage } from '../apps/web/src/lib/drawing/sheetPage';
import {
  sheetPageToPdf,
  sheetPageToSvg
} from '../apps/web/src/lib/drawing/sheetExport';
import {
  composeSheetAnnotations,
  resolveDrawingAnnotation,
  resolveSheetAnnotations
} from '../apps/web/src/lib/drawing/annotations';
import {
  applyAnnotationPick,
  draftAnnotation,
  drawnLines,
  drawnOutlines,
  hitEdge,
  hitFace,
  pickableEdges,
  pickableFaces,
  repairedAnnotation,
  startAnnotationTool,
  type AnnotationTool
} from '../apps/web/src/lib/drawing/annotationPicking';
import { parseSaveProjectDocumentRequest } from '../apps/web/worker/validation';

/**
 * D06 slice B (schema v48): the annotation additions that let a turned or
 * chamfered part be dimensioned at all — silhouette and virtual-sharp
 * points, chamfer dimensions, counts, Ø on a linear span, reference
 * dimensions and provenance — read from real kernel bodies.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const S = Math.SQRT2;
/** Typed asymmetric matchers, for object patterns. */
const close = (value: number, digits = 6) =>
  expect.closeTo(value, digits) as number;
const matching = (pattern: RegExp) => expect.stringMatching(pattern) as string;
const near = (a: number, b: number, tolerance = 1e-6) =>
  Math.abs(a - b) < tolerance;

/** The turned foot of the D06 plan, as one revolved profile on XZ. */
function footProfile() {
  const line = (x1: number, y1: number, x2: number, y2: number) => ({
    objectKind: 'line',
    x1,
    y1,
    x2,
    y2
  });
  const arc = (
    centerX: number,
    centerY: number,
    startAngleDeg: number,
    endAngleDeg: number
  ) => ({
    objectKind: 'arc',
    centerX,
    centerY,
    radius: 4,
    startAngleDeg,
    endAngleDeg
  });
  const h = 4 * S;
  return [
    line(0, 0, 16, 0),
    line(16, 0, 16 + h / 2, h / 2),
    arc(16, h, -45, 0),
    line(20, h, 20, 29 - h),
    arc(16, 29 - h, 0, 45),
    line(16 + h / 2, 29 - h / 2, 20.5 - h / 2, 24.5 + h / 2),
    arc(20.5, 24.5 + h, 180, 225),
    line(16.5, 24.5 + h, 16.5, 50),
    line(16.5, 50, 12.5, 50),
    line(12.5, 50, 12.5, 9),
    line(12.5, 9, 0, 9),
    line(0, 9, 0, 0)
  ];
}

/** Point each revolve at its whole sketch, as the Revolve tool does. */
function revolveWholeSketches(document: ProjectDocument): ProjectDocument {
  const nodes = { ...document.nodes } as Record<string, DocumentNode>;
  for (const [key, node] of Object.entries(nodes)) {
    const data = (
      node as { data?: { featureKind?: string; sketchId?: SketchId } }
    ).data;
    if (data?.featureKind !== 'revolve' || !data.sketchId) continue;
    const sketch = findSketch(document, data.sketchId)!;
    nodes[key] = {
      ...node,
      data: {
        ...data,
        profile: { all: true, sourceEntityIds: [...sketch.objectIds] }
      }
    } as DocumentNode;
  }
  return { ...document, nodes };
}

async function build(operations: unknown[]) {
  const manager = new CommandManager(
    createProjectDocument('Schema', toUserId('user_schema'))
  );
  manager.execute(
    composeCommands(
      'Build',
      commandsForCadPatch(
        manager.document,
        parseCadPatchProposal({
          proposalId: 'proposal_schema',
          summary: 'Build a test part.',
          assumptions: [],
          operations
        })
      )
    )
  );
  const document = revolveWholeSketches(manager.document);
  const synced = await adapter.syncDocument(document);
  expect(synced.warnings).toEqual([]);
  const bodies = synced.bodyRepresentations;
  const bodyId = document.bodyOrder.at(-1)!;
  return { document, bodies, bodyId, body: bodies[bodyId]! };
}

const footOperations = () => [
  {
    kind: 'add_sketch',
    name: 'Profile',
    plane: 'XZ',
    offset: 0,
    objects: footProfile(),
    localId: '$profile'
  },
  {
    kind: 'add_revolve',
    name: 'Foot',
    localId: '$foot',
    sketchId: '$profile',
    axis: 'vertical',
    angleDeg: null
  }
];

/**
 * A bar whose top right corner is chamfered unequally: 3 down the side,
 * 5 along the top, so the chamfer makes 31° with the top and 59° with the
 * side. Profile on XZ, extruded along Y.
 */
const chamferedBarOperations = () => [
  {
    kind: 'add_sketch',
    name: 'Bar',
    plane: 'XZ',
    offset: 0,
    objects: [
      [0, 0, 30, 0],
      [30, 0, 30, 7],
      [30, 7, 25, 10],
      [25, 10, 0, 10],
      [0, 10, 0, 0]
    ].map(([x1, y1, x2, y2]) => ({ objectKind: 'line', x1, y1, x2, y2 })),
    localId: '$bar'
  },
  {
    kind: 'add_extrude',
    name: 'Bar',
    localId: '$barBody',
    sketchId: '$bar',
    distance: 8,
    samplePoint: { x: 5, y: 5 }
  }
];

const frontId = 'dvw_front' as DrawingViewId;
const topId = 'dvw_top' as DrawingViewId;
const id = (name: string) => `dann_${name}` as DrawingAnnotationId;

function sheetOf(
  bodyId: BodyId,
  annotations: DrawingAnnotation[] = [],
  hiddenLines = false
): DrawingSheet {
  return {
    sheetId: 'dsht_schema' as DrawingSheetId,
    name: 'Sheet 1',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views: (
      [
        [frontId, 'front', { x: 120, y: 110 }],
        [topId, 'top', { x: 120, y: 220 }]
      ] as [
        DrawingViewId,
        DrawingView['orientation'],
        { x: number; y: number }
      ][]
    ).map(([viewId, orientation, centerMm]) => ({
      viewId,
      orientation,
      bodyIds: [bodyId],
      centerMm,
      hiddenLines
    })),
    ...(annotations.length > 0 ? { annotations } : {})
  };
}

function edgeRef(bodyId: BodyId, edge: EdgeTopology): DrawingEdgeRef {
  return {
    bodyId,
    hash: edge.hash,
    ...(edge.reference ? { reference: edge.reference } : {})
  };
}

function faceRef(bodyId: BodyId, face: FaceTopology): DrawingFaceRef {
  return {
    bodyId,
    hash: face.hash,
    ...(face.reference ? { reference: face.reference } : {})
  };
}

/** The one circular edge of `radius` centred at height `z`. */
function rim(body: BodyRepresentation, radius: number, z: number) {
  const found = body.topology!.edges.filter((edge) => {
    const circle = edge.curve?.circle;
    return (
      circle &&
      edge.displayRole !== 'seam' &&
      near(circle.radius, radius, 1e-5) &&
      near(circle.center.z, z, 1e-5)
    );
  });
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** The one face whose exact surface satisfies `match`. */
function faceWhere(
  body: BodyRepresentation,
  match: (face: FaceTopology) => boolean
): FaceTopology {
  const found = body.topology!.faces.filter(match);
  expect(found).toHaveLength(1);
  return found[0]!;
}

const surface = (face: FaceTopology) =>
  face.geometry?.surfaceType.toLowerCase() ?? '';
const cylinderOf = (body: BodyRepresentation, radius: number) =>
  faceWhere(
    body,
    (face) =>
      surface(face).includes('cylind') &&
      near(face.geometry!.radius!, radius, 1e-5)
  );
/** A cone whose vertex mean sits below or above `z`. */
const coneAt = (body: BodyRepresentation, below: number) =>
  faceWhere(
    body,
    (face) => surface(face).includes('cone') && face.geometry!.center.z < below
  );
const coneAbove = (body: BodyRepresentation, above: number) =>
  faceWhere(
    body,
    (face) => surface(face).includes('cone') && face.geometry!.center.z > above
  );
const planeAt = (body: BodyRepresentation, z: number) =>
  faceWhere(
    body,
    (face) =>
      surface(face).includes('plane') &&
      near(Math.abs(face.geometry!.normal!.z), 1) &&
      near(face.geometry!.planeOffset! * face.geometry!.normal!.z, z, 1e-5)
  );

function linear(
  annotationId: DrawingAnnotationId,
  direction: 'horizontal' | 'vertical',
  from: DrawingPointRef,
  to: DrawingPointRef,
  extra: Partial<DrawingLinearDimension> = {}
): DrawingLinearDimension {
  return {
    annotationId,
    kind: 'linear',
    viewId: frontId,
    direction,
    from,
    to,
    placementMm: { x: 40, y: 0 },
    ...extra
  };
}

const silhouette = (
  edge: DrawingEdgeRef,
  side: 'low' | 'high'
): DrawingPointRef => ({ edge, anchor: 'silhouette', side });

function resolvedIn(
  annotation: DrawingAnnotation,
  sheet: DrawingSheet,
  bodies: Record<string, BodyRepresentation>
) {
  return resolveDrawingAnnotation(
    annotation,
    sheet.views.find((view) => view.viewId === annotation.viewId),
    bodies,
    'mm'
  );
}

function drawnViews(
  sheet: DrawingSheet,
  bodies: Record<string, BodyRepresentation>
) {
  return sheet.views.map((entry) => ({
    view: entry,
    projection: projectView({
      orientation: entry.orientation,
      hiddenLines: entry.hiddenLines,
      bodies: entry.bodyIds.map((bodyId) =>
        projectionBodyInput(bodies[bodyId]!)!
      )
    })
  }));
}

async function footModel() {
  const model = await build(footOperations());
  const { body, bodyId } = model;
  return {
    ...model,
    bottomRim: edgeRef(bodyId, rim(body, 16, 0)),
    topRim: edgeRef(bodyId, rim(body, 16.5, 50)),
    floorRim: edgeRef(bodyId, rim(body, 12.5, 9)),
    // Where the body's cylinder meets its lower blend.
    bodyRim: edgeRef(bodyId, rim(body, 20, 4 * S)),
    bodyFace: faceRef(bodyId, cylinderOf(body, 20)),
    neckFace: faceRef(bodyId, cylinderOf(body, 16.5)),
    bottomCone: faceRef(bodyId, coneAt(body, 4)),
    shoulderCone: faceRef(bodyId, coneAbove(body, 20)),
    bottomFace: faceRef(bodyId, planeAt(body, 0))
  };
}

describe('D06 slice B schema (v48)', () => {
  it('claims v48 and fences documents from newer clients', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(48);
    const document = createProjectDocument('Fence', toUserId('test'));
    const newer = {
      ...document,
      schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION + 1
    } as unknown as ProjectDocument;
    expect(() => normalizeDocument(newer)).toThrow();
    expect(() =>
      parseSaveProjectDocumentRequest(
        {
          projectId: document.projectId,
          expectedVersion: 0,
          document: JSON.parse(JSON.stringify(newer)) as unknown
        },
        document.projectId
      )
    ).toThrow(/newer than this deployment supports/);
  });

  it('round-trips every addition through save and normalize, storing no values', async () => {
    const model = await footModel();
    const annotations: DrawingAnnotation[] = [
      linear(
        id('height'),
        'vertical',
        silhouette(model.bottomRim, 'high'),
        silhouette(model.topRim, 'high'),
        { reference: true }
      ),
      linear(
        id('body'),
        'horizontal',
        silhouette(model.bodyRim, 'low'),
        silhouette(model.bodyRim, 'high'),
        {
          diameter: true,
          provenance: { generated: true, requirement: 'size:diameter:20' }
        }
      ),
      linear(
        id('sharp'),
        'vertical',
        {
          faces: [model.bodyFace, model.shoulderCone],
          anchor: 'virtual-sharp',
          side: 'high'
        },
        silhouette(model.bottomRim, 'high')
      ),
      {
        annotationId: id('chamfer'),
        kind: 'chamfer',
        viewId: frontId,
        face: model.bottomCone,
        count: 2,
        placementMm: { x: 40, y: -30 }
      }
    ];
    const manager = new CommandManager(model.document);
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: sheetOf(model.bodyId, annotations)
      })
    );
    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    expect(saved.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(normalizeDocument(saved).drawings).toEqual(
      manager.document.drawings
    );
    expect(JSON.stringify(saved.drawings)).not.toMatch(/"value"|"label"/);
    // The account stores the section unread, as D02's.
    expect(
      parseSaveProjectDocumentRequest(
        {
          projectId: saved.projectId,
          expectedVersion: 0,
          document: saved as unknown as Record<string, unknown>
        },
        saved.projectId
      ).document
    ).toBe(saved);
  });

  it('refuses malformed additions by name, on load and before any account write', async () => {
    const model = await footModel();
    const face = model.bodyFace;
    // Revolved faces are hash-only; an extruded bar's carry lineage.
    const bar = await build(chamferedBarOperations());
    const named = bar.body.topology!.faces.find((entry) => entry.reference)!;
    const withReference = faceRef(model.bodyId, named);
    const good = linear(
      id('h'),
      'vertical',
      silhouette(model.bottomRim, 'high'),
      silhouette(model.topRim, 'high')
    );
    const radial = {
      annotationId: id('r'),
      kind: 'diameter',
      viewId: topId,
      edge: model.topRim,
      placementMm: { x: 0, y: 0 }
    };
    const chamfer = {
      annotationId: id('c'),
      kind: 'chamfer',
      viewId: frontId,
      face: model.bottomCone,
      placementMm: { x: 0, y: 0 }
    };
    const sharp = (faces: unknown, side: unknown = 'low') => ({
      ...good,
      from: { faces, anchor: 'virtual-sharp', side }
    });
    const cases: [unknown, RegExp][] = [
      [{ ...good, count: 2 }, /only radius, diameter and chamfer/],
      [{ ...radial, count: 1 }, /counts from 2 to 999/],
      [{ ...radial, count: 1000 }, /counts from 2 to 999/],
      [{ ...radial, count: 2.5 }, /counts from 2 to 999/],
      [{ ...radial, diameter: true }, /only a linear dimension takes/],
      [{ ...good, diameter: false }, /Ø prefix with anything but true/],
      [{ ...good, reference: false }, /reference dimension with anything/],
      [
        {
          annotationId: id('n'),
          kind: 'note',
          text: 'A',
          reference: true,
          placementMm: { x: 0, y: 0 }
        },
        /cannot be a reference dimension/
      ],
      [
        { ...good, provenance: { generated: false, requirement: 'x' } },
        /provenance/
      ],
      [
        { ...good, provenance: { generated: true, requirement: '' } },
        /provenance/
      ],
      [
        { ...good, provenance: { generated: true, requirement: 'x', by: 'y' } },
        /provenance/
      ],
      [
        {
          ...good,
          from: { edge: model.topRim, anchor: 'silhouette', side: 'up' }
        },
        /extreme side/
      ],
      [
        { ...good, from: { edge: model.topRim, anchor: 'first', side: 'low' } },
        /takes none/
      ],
      [{ ...good, direction: 'aligned' }, /only a horizontal or vertical/],
      [sharp([face]), /two faces/],
      [sharp([face, face]), /two different faces/],
      [sharp([face, model.neckFace], 'middle'), /extreme side/],
      [sharp([face, { ...model.neckFace, hash: 0 }]), /invalid face hash/],
      [
        sharp([face, { ...withReference, hash: withReference.hash + 1 }]),
        /contradicts its hash/
      ],
      [
        sharp([
          face,
          {
            ...withReference,
            reference: { ...withReference.reference!, kind: 'edge' }
          }
        ]),
        /not a face reference/
      ],
      ...(
        [
          { analytic: { kind: 'torus' } },
          { surfaceType: ' ' },
          { perimeter: 1.5 },
          { centroid: [0, 0] },
          { closure: { u: 'open', v: 'maybe' } },
          { analytic: { kind: 'plane', normal: [0, 0, 1], offset: 0.5 } }
        ] as Record<string, unknown>[]
      ).map(
        (change) =>
          [
            sharp([
              face,
              {
                ...withReference,
                reference: {
                  ...withReference.reference!,
                  witness: { ...withReference.reference!.witness, ...change }
                }
              }
            ]),
            /malformed face reference/
          ] as [unknown, RegExp]
      ),
      [{ ...chamfer, face: { bodyId: model.bodyId } }, /invalid face hash/],
      [{ ...chamfer, face: model.bottomRim, count: 3.5 }, /counts from 2/]
    ];
    for (const [annotation, message] of cases) {
      const drawings = {
        sheets: [sheetOf(model.bodyId, [annotation as DrawingAnnotation])]
      };
      expect(drawingSetError(drawings), String(message)).toMatch(message);
      const broken = { ...model.document, drawings } as ProjectDocument;
      expect(() => normalizeDocument(broken)).toThrow(message);
      const wire = JSON.parse(JSON.stringify(broken)) as Record<
        string,
        unknown
      >;
      expect(() => assertStorableDocument(wire)).toThrow(
        UnstorableDocumentError
      );
      expect(() => assertStorableDocument(wire)).toThrow(message);
    }
    for (const valid of [
      good,
      radial,
      chamfer,
      { ...radial, count: 4 },
      sharp([face, withReference])
    ])
      expect(
        drawingSetError({
          sheets: [sheetOf(model.bodyId, [valid as DrawingAnnotation])]
        })
      ).toBeNull();
  });

  it('refuses a face its view does not draw, as it does an edge', async () => {
    const model = await footModel();
    const manager = new CommandManager(model.document);
    const sheet = sheetOf(model.bodyId);
    manager.execute(commandFactories.addDrawingSheet({ sheet }));
    expect(() =>
      manager.execute(
        commandFactories.addDrawingAnnotation({
          sheetId: sheet.sheetId,
          annotation: {
            annotationId: id('c'),
            kind: 'chamfer',
            viewId: frontId,
            face: { ...model.bottomCone, bodyId: 'body_elsewhere' as BodyId },
            placementMm: { x: 0, y: 0 }
          }
        })
      )
    ).toThrow(/not drawn in that view/);
  });
});

describe('D06 slice B: a turned part dimensioned along its axis', () => {
  it('reads the height and the side-view diameter off rim silhouettes', async () => {
    const { bodies, bodyId, bottomRim, topRim, bodyRim } = await footModel();
    const sheet = sheetOf(bodyId);
    const height = resolvedIn(
      linear(
        id('h'),
        'vertical',
        silhouette(bottomRim, 'high'),
        silhouette(topRim, 'high')
      ),
      sheet,
      bodies
    );
    expect(height).toMatchObject({
      ok: true,
      resolved: { kind: 'linear', value: close(50, 9), label: '50' }
    });
    // Level up the axis, `side` picks the rim's end across it: the right.
    if (!height.ok || height.resolved.kind !== 'linear') throw new Error();
    expect(height.resolved.from[0]).toBeCloseTo(16, 9);
    expect(height.resolved.to[0]).toBeCloseTo(16.5, 9);

    const across = resolvedIn(
      linear(
        id('d'),
        'horizontal',
        silhouette(bodyRim, 'low'),
        silhouette(bodyRim, 'high'),
        { diameter: true }
      ),
      sheet,
      bodies
    );
    expect(across).toMatchObject({
      ok: true,
      resolved: { value: close(40, 9), label: 'Ø40' }
    });
    // The bore floor is hidden in the front view, but a silhouette point
    // reads it all the same; the bore depth is 41.
    expect(
      resolvedIn(
        linear(
          id('depth'),
          'vertical',
          silhouette(edgeRefOf(bodies, bodyId, 12.5, 9), 'high'),
          silhouette(topRim, 'high'),
          { reference: true }
        ),
        sheet,
        bodies
      )
    ).toMatchObject({ ok: true, resolved: { label: '(41)' } });
  });

  it('dimensions to a virtual sharp through a blend, and breaks where there is none', async () => {
    const model = await footModel();
    const { bodies, bodyId } = model;
    const sheet = sheetOf(bodyId);
    // The shoulder cone meets the Ø40 body at z = 25, behind its R4 blend.
    const toShoulder = resolvedIn(
      linear(id('s'), 'vertical', silhouette(model.bottomRim, 'high'), {
        faces: [model.bodyFace, model.shoulderCone],
        anchor: 'virtual-sharp',
        side: 'high'
      }),
      sheet,
      bodies
    );
    expect(toShoulder).toMatchObject({
      ok: true,
      resolved: { value: close(25, 6), label: '25' }
    });
    if (!toShoulder.ok || toShoulder.resolved.kind !== 'linear')
      throw new Error();
    expect(toShoulder.resolved.to[0]).toBeCloseTo(20, 6);
    // The bottom face and the body's side: the corner the lower chamfer
    // removed, on both sides of the axis.
    const sharp = (side: 'low' | 'high'): DrawingPointRef => ({
      faces: [model.bottomFace, model.bodyFace],
      anchor: 'virtual-sharp',
      side
    });
    expect(
      resolvedIn(
        linear(id('w'), 'horizontal', sharp('low'), sharp('high'), {
          diameter: true
        }),
        sheet,
        bodies
      )
    ).toMatchObject({ ok: true, resolved: { label: 'Ø40' } });
    // Two coaxial cylinders never meet.
    expect(
      resolvedIn(
        linear(id('x'), 'vertical', silhouette(model.bottomRim, 'high'), {
          faces: [model.bodyFace, model.neckFace],
          anchor: 'virtual-sharp',
          side: 'high'
        }),
        sheet,
        bodies
      )
    ).toMatchObject({ ok: false, reason: 'no-sharp' });
  });

  it('states a chamfer as size × angle, counted, and only side-on', async () => {
    const model = await footModel();
    const { bodies, bodyId } = model;
    const sheet = sheetOf(bodyId);
    const chamfer = (
      face: DrawingFaceRef,
      viewId = frontId,
      count?: number
    ): DrawingAnnotation => ({
      annotationId: id('c'),
      kind: 'chamfer',
      viewId,
      face,
      ...(count ? { count } : {}),
      placementMm: { x: 40, y: -40 }
    });
    // Sharp on the bottom face, through the R4 blend to the body.
    expect(
      resolvedIn(chamfer(model.bottomCone, frontId, 2), sheet, bodies)
    ).toMatchObject({
      ok: true,
      resolved: {
        kind: 'chamfer',
        value: close(4, 6),
        angle: close(45, 6),
        label: '2× 4 × 45°'
      }
    });
    // Blended at both ends: from the Ø40 body (z = 25) to the Ø33 neck.
    expect(
      resolvedIn(chamfer(model.shoulderCone), sheet, bodies)
    ).toMatchObject({
      ok: true,
      resolved: { value: close(3.5, 6), label: '3.5 × 45°' }
    });
    // Looking down the axis the cone is foreshortened; a cylinder is none.
    expect(
      resolvedIn(chamfer(model.bottomCone, topId), sheet, bodies)
    ).toMatchObject({ ok: false, reason: 'foreshortened' });
    expect(resolvedIn(chamfer(model.bodyFace), sheet, bodies)).toMatchObject({
      ok: false,
      reason: 'not-a-chamfer'
    });
  });

  it('states a planar chamfer by its leg on the face it makes the smaller angle with', async () => {
    const { bodies, bodyId, body } = await build(chamferedBarOperations());
    const slope = faceWhere(
      body,
      (face) =>
        surface(face).includes('plane') &&
        Math.abs(face.geometry!.normal!.x) > 1e-3 &&
        Math.abs(face.geometry!.normal!.z) > 1e-3
    );
    const annotation: DrawingAnnotation = {
      annotationId: id('c'),
      kind: 'chamfer',
      viewId: frontId,
      face: faceRef(bodyId, slope),
      placementMm: { x: 40, y: 20 }
    };
    expect(resolvedIn(annotation, sheetOf(bodyId), bodies)).toMatchObject({
      ok: true,
      resolved: {
        value: close(5, 6),
        angle: close((Math.atan2(3, 5) * 180) / Math.PI, 6),
        label: '5 × 31°'
      }
    });
    // Seen from above its ends run across the view, not end-on.
    expect(
      resolvedIn({ ...annotation, viewId: topId }, sheetOf(bodyId), bodies)
    ).toMatchObject({ ok: false, reason: 'foreshortened' });
  });

  it('counts a repeated diameter', async () => {
    const { bodies, bodyId, body } = await build([
      {
        kind: 'add_sketch',
        name: 'Plate',
        plane: 'XZ',
        offset: 0,
        objects: [
          {
            objectKind: 'rectangle',
            width: 40,
            height: 20,
            centerX: 20,
            centerY: 10
          },
          { objectKind: 'circle', radius: 3, centerX: 10, centerY: 10 },
          { objectKind: 'circle', radius: 3, centerX: 30, centerY: 10 }
        ],
        localId: '$plate'
      },
      {
        kind: 'add_extrude',
        name: 'Plate',
        localId: '$plateBody',
        sketchId: '$plate',
        distance: 6,
        samplePoint: { x: 2, y: 2 }
      }
    ]);
    const hole = body.topology!.edges.find(
      (edge) =>
        edge.curve?.circle &&
        near(edge.curve.circle.radius, 3) &&
        near(edge.curve.circle.center.x, 10)
    )!;
    expect(
      resolvedIn(
        {
          annotationId: id('d'),
          kind: 'diameter',
          viewId: frontId,
          edge: edgeRef(bodyId, hole),
          count: 2,
          placementMm: { x: 20, y: 20 }
        },
        sheetOf(bodyId),
        bodies
      )
    ).toMatchObject({ ok: true, resolved: { label: '2× Ø6' } });
  });

  it('draws the additions in SVG and PDF, byte-stable across a reload', async () => {
    const model = await footModel();
    const sheet = sheetOf(model.bodyId, [
      {
        ...linear(
          id('h'),
          'vertical',
          silhouette(model.bottomRim, 'high'),
          silhouette(model.topRim, 'high')
        ),
        placementMm: { x: 45, y: 0 }
      },
      {
        ...linear(
          id('d'),
          'horizontal',
          silhouette(model.bodyRim, 'low'),
          silhouette(model.bodyRim, 'high'),
          { diameter: true, reference: true }
        ),
        placementMm: { x: 0, y: -40 }
      },
      {
        annotationId: id('c'),
        kind: 'chamfer',
        viewId: frontId,
        face: model.bottomCone,
        count: 2,
        placementMm: { x: 35, y: -35 }
      }
    ]);
    const context = { projectName: model.document.name, units: 'mm' as const };
    const render = (
      on: DrawingSheet,
      bodies: Record<string, BodyRepresentation>
    ) => {
      const views = drawnViews(on, bodies);
      const page = composeSheetPage(
        on,
        views,
        context,
        composeSheetAnnotations(
          on,
          views,
          resolveSheetAnnotations(on, bodies, 'mm'),
          'mm'
        )
      );
      return {
        svg: sheetPageToSvg(page, on.name),
        pdf: new TextDecoder('latin1').decode(sheetPageToPdf(page, on.name))
      };
    };
    const first = render(sheet, model.bodies);
    expect(first.svg).toMatch(/>50<\/text>/);
    expect(first.svg).toMatch(/>\(Ø40\)<\/text>/);
    expect(first.svg).toMatch(/>2× 4 × 45°<\/text>/);
    // WinAnsi octal escapes: Ø is \330, × is \327 and ° is \260.
    expect(first.pdf).toMatch(/\(\\+\(\\+33040\\+\)\) Tj/);
    expect(first.pdf).toMatch(/\(2\\+327 4 \\+327 45\\+260\) Tj/);

    const saved = new CommandManager(model.document).execute(
      commandFactories.addDrawingSheet({ sheet })
    );
    const reloaded = normalizeDocument(
      JSON.parse(JSON.stringify(saved)) as ProjectDocument
    );
    const bodiesAgain = (await adapter.syncDocument(reloaded))
      .bodyRepresentations;
    expect(render(reloaded.drawings!.sheets[0]!, bodiesAgain)).toEqual(first);
  });
});

function edgeRefOf(
  bodies: Record<string, BodyRepresentation>,
  bodyId: BodyId,
  radius: number,
  z: number
): DrawingEdgeRef {
  return edgeRef(bodyId, rim(bodies[bodyId]!, radius, z));
}

describe('D06 slice B picking', () => {
  async function pickSetup(hiddenLines = false) {
    const model = await footModel();
    const sheet = sheetOf(model.bodyId, [], hiddenLines);
    const views = drawnViews(sheet, model.bodies);
    const front = views[0]!.view;
    const edges = pickableEdges(sheet, views, model.bodies, 'mm');
    const faces = pickableFaces(sheet, views, model.bodies, 'mm');
    const drawn = drawnLines(sheet, views, 'mm');
    const outlines = drawnOutlines(sheet, views, 'mm');
    const at = (x: number, z: number): [number, number] =>
      edges.find((entry) => entry.view === front)!.toPage!(x, z);
    const pick = (
      tool: AnnotationTool,
      point: [number, number]
    ): ReturnType<typeof applyAnnotationPick> =>
      applyAnnotationPick(
        tool,
        hitEdge(edges, point, 1, drawn),
        point,
        front,
        model.bodies,
        hitFace(faces, point, 1, outlines)
      );
    return { ...model, sheet, front, edges, faces, at, pick };
  }

  it('picks a rim seen side-on as its silhouette end nearer the click', async () => {
    const { at, pick, bodies, sheet, front } = await pickSetup();
    // The front view's u is model x and its v model z.
    const first = pick(startAnnotationTool('vertical'), at(15.5, 0));
    expect(first).toMatchObject({
      ok: true,
      tool: { points: [{ anchor: 'silhouette', side: 'high' }] }
    });
    const both = pick((first as { tool: AnnotationTool }).tool, at(-16, 50));
    expect(both).toMatchObject({
      ok: true,
      tool: {
        points: [
          { anchor: 'silhouette', side: 'high' },
          { anchor: 'silhouette', side: 'low' }
        ]
      }
    });
    const draft = draftAnnotation(
      (both as { tool: AnnotationTool }).tool,
      id('h'),
      { x: 40, y: 0 }
    )!;
    expect(resolveDrawingAnnotation(draft, front, bodies, 'mm')).toMatchObject({
      ok: true,
      resolved: { label: '50' }
    });
    expect(
      drawingSetError({ sheets: [{ ...sheet, annotations: [draft] }] })
    ).toBeNull();
    // An aligned span has no extreme to measure to.
    expect(pick(startAnnotationTool('aligned'), at(15.5, 0))).toMatchObject({
      ok: false,
      message: matching(/horizontally or vertically/)
    });
  });

  it('picks two face outlines as a virtual sharp, and a cone as a chamfer', async () => {
    const { at, pick, faces, front, bodies, shoulderCone, bodyFace } =
      await pickSetup();
    // The body's right side, a silhouette, at mid-height.
    const bodySide = at(20, 14);
    const faceHit = hitFace(faces, bodySide, 1);
    expect(faceHit?.face.hash).toBe(bodyFace.hash);
    const one = pick(startAnnotationTool('vertical'), bodySide);
    expect(one).toMatchObject({
      ok: true,
      tool: { faces: [bodyFace], points: [] }
    });
    // The shoulder cone's right outline, half way up it.
    const shoulder = at(18.25, 26.75);
    const two = pick((one as { tool: AnnotationTool }).tool, shoulder);
    expect(two).toMatchObject({
      ok: true,
      tool: {
        faces: [],
        points: [
          {
            anchor: 'virtual-sharp',
            faces: [bodyFace, shoulderCone],
            side: 'high'
          }
        ]
      }
    });
    // A chamfer is picked by its outline alone.
    const chamfer = pick(startAnnotationTool('chamfer'), shoulder);
    expect(chamfer).toMatchObject({
      ok: true,
      tool: { faces: [shoulderCone] }
    });
    const draft = draftAnnotation(
      (chamfer as { tool: AnnotationTool }).tool,
      id('c'),
      { x: 40, y: 0 }
    )!;
    expect(resolveDrawingAnnotation(draft, front, bodies, 'mm')).toMatchObject({
      ok: true,
      resolved: { label: '3.5 × 45°' }
    });
    // Re-picking keeps the count and reference, and drops provenance.
    const repaired = repairedAnnotation(
      {
        ...draft,
        count: 2,
        reference: true,
        provenance: { generated: true, requirement: 'chamfer:shoulder' }
      } as DrawingAnnotation,
      {
        ...(chamfer as { tool: AnnotationTool }).tool,
        repairId: id('c')
      }
    );
    expect(repaired).toMatchObject({ count: 2, reference: true });
    expect(repaired && 'provenance' in repaired).toBe(false);
    // Empty paper is no chamfer, and no edge stands in for one.
    expect(pick(startAnnotationTool('chamfer'), at(60, 60))).toMatchObject({
      ok: false
    });
  });

  it('offers a face only where its view draws its outline', async () => {
    const { faces, at } = await pickSetup();
    const bodySide = at(20, 14);
    expect(hitFace(faces, bodySide, 1)).not.toBeNull();
    expect(hitFace(faces, bodySide, 1, new Map())).toBeNull();
  });
});
