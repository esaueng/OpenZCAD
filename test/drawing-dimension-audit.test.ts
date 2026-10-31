import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCadPatchProposal } from '@openzcad/ai-contracts';
import {
  CommandManager,
  commandsForCadPatch,
  composeCommands
} from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DocumentNode,
  type ProjectDocument,
  type SketchId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingEdgeRef,
  type DrawingLinearDimension,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type EdgeTopology
} from '@openzcad/shared';
import { auditDrawingDimensions } from '../apps/web/src/lib/drawing/dimensionAudit';

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const S = Math.SQRT2;

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

/**
 * A revolve proposal turns the sketch's first object; the foot's profile is
 * a chain of lines and arcs, so point its revolve at every object, as the
 * Revolve tool does for a picked region.
 */
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
    createProjectDocument('Audit', toUserId('user_audit'))
  );
  manager.execute(
    composeCommands(
      'Build',
      commandsForCadPatch(
        manager.document,
        parseCadPatchProposal({
          proposalId: 'proposal_audit',
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

const frontId = 'dvw_front' as DrawingViewId;
const topId = 'dvw_top' as DrawingViewId;
const id = (name: string) => `dann_${name}` as DrawingAnnotationId;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function sheetOf(
  bodyId: BodyId,
  annotations: DrawingAnnotation[] = [],
  orientations: DrawingView['orientation'][] = ['front', 'top']
): DrawingSheet {
  const ids: Partial<Record<DrawingView['orientation'], DrawingViewId>> = {
    front: frontId,
    top: topId
  };
  return {
    sheetId: 'dsht_audit' as DrawingSheetId,
    name: 'Sheet 1',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views: orientations.map((orientation, index) => ({
      viewId: ids[orientation] ?? (`dvw_${orientation}` as DrawingViewId),
      orientation,
      bodyIds: [bodyId],
      centerMm: { x: 100, y: 100 + 100 * index },
      hiddenLines: false
    })),
    ...(annotations.length > 0 ? { annotations } : {})
  };
}

function refOf(bodyId: BodyId, edge: EdgeTopology): DrawingEdgeRef {
  return {
    bodyId,
    hash: edge.hash,
    ...(edge.reference ? { reference: edge.reference } : {})
  };
}

/** The one straight edge whose ends satisfy `match`, in either order. */
function lineEdge(
  body: BodyRepresentation,
  match: (a: number[], b: number[]) => boolean
): EdgeTopology {
  const found = body.topology!.edges.filter((edge) => {
    if (edge.displayRole === 'seam' || edge.curve?.circle) return false;
    const p = edge.points;
    const a = p.slice(0, 3);
    const b = p.slice(p.length - 3);
    return match(a, b) || match(b, a);
  });
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** The circular edges of `radius` centred at height `z`. */
function circleEdge(
  body: BodyRepresentation,
  radius: number,
  at: Partial<Record<'x' | 'y' | 'z', number>>
): EdgeTopology {
  const found = body.topology!.edges.filter((edge) => {
    const circle = edge.curve?.circle;
    return (
      circle &&
      near(circle.radius, radius) &&
      Object.entries(at).every(([axis, value]) =>
        near(circle.center[axis as 'x' | 'y' | 'z'], value)
      )
    );
  });
  expect(found.length).toBeGreaterThan(0);
  return found[0]!;
}

function linear(
  annotationId: DrawingAnnotationId,
  viewId: DrawingViewId,
  direction: 'horizontal' | 'vertical' | 'aligned',
  from: DrawingEdgeRef,
  fromAnchor: 'first' | 'second' | 'center',
  to: DrawingEdgeRef,
  toAnchor: 'first' | 'second' | 'center'
): DrawingAnnotation {
  return {
    annotationId,
    kind: 'linear',
    viewId,
    direction,
    from: { edge: from, anchor: fromAnchor },
    to: { edge: to, anchor: toAnchor },
    placementMm: { x: 0, y: 30 }
  };
}

function radial(
  annotationId: DrawingAnnotationId,
  viewId: DrawingViewId,
  kind: 'radius' | 'diameter',
  edge: DrawingEdgeRef
): DrawingAnnotation {
  return { annotationId, kind, viewId, edge, placementMm: { x: 20, y: 20 } };
}

const messages = (list: { message: string }[]) => list.map((f) => f.message);

describe('D06 dimension audit: the turned foot', () => {
  it('asks for each diameter, chamfer and axial position once', async () => {
    const { bodies, bodyId } = await build(footOperations());
    const audit = auditDrawingDimensions(sheetOf(bodyId), bodies, 'mm');
    // Coaxial: nothing to locate across the axis. Along it, three faces
    // need two dimensions; since slice B (v46) their rims' silhouettes mark
    // them, and each chamfer is stated as size × angle.
    expect(messages(audit.missing)).toEqual([
      'Ø40 diameter.',
      'Ø33 diameter.',
      'Ø25 diameter.',
      '4 × 45° chamfer.',
      '3.5 × 45° chamfer.',
      'Z: nothing locates the face at z = 9 from the face at z = 0.',
      'Z: nothing locates the face at z = 50 from the face at z = 0.'
    ]);
    expect(messages(audit.unmeasurable)).toEqual([
      '3× R4 revolved blend: its radius needs a dimension D02 cannot place yet.'
    ]);
    expect(audit).toMatchObject({
      redundant: [],
      unchecked: [],
      stated: 0,
      required: 7
    });
  });

  it('passes a sheet that states every requirement once with the v46 anchors', async () => {
    const { bodies, bodyId, body } = await build(footOperations());
    const ref = (edge: EdgeTopology) => refOf(bodyId, edge);
    const silhouette = (edge: EdgeTopology, side: 'low' | 'high') => ({
      edge: ref(edge),
      anchor: 'silhouette' as const,
      side
    });
    const cone = (above: boolean) =>
      body.topology!.faces.find(
        (face) =>
          face.geometry?.surfaceType.toLowerCase().includes('cone') &&
          face.geometry.center.z > 20 === above
      )!;
    const chamfer = (name: string, above: boolean): DrawingAnnotation => ({
      annotationId: id(name),
      kind: 'chamfer',
      viewId: frontId,
      face: { bodyId, hash: cone(above).hash },
      placementMm: { x: 40, y: above ? 10 : -30 }
    });
    const span = (
      name: string,
      direction: 'horizontal' | 'vertical',
      from: ReturnType<typeof silhouette>,
      to: ReturnType<typeof silhouette>,
      extra: Partial<DrawingLinearDimension> = {}
    ): DrawingAnnotation => ({
      annotationId: id(name),
      kind: 'linear',
      viewId: frontId,
      direction,
      from,
      to,
      placementMm: { x: 45, y: 0 },
      ...extra
    });
    const bottom = circleEdge(body, 16, { z: 0 });
    const top = circleEdge(body, 16.5, { z: 50 });
    const floor = circleEdge(body, 12.5, { z: 9 });
    const bodyRim = circleEdge(body, 20, { z: 4 * S });
    const annotations = [
      span(
        'height',
        'vertical',
        silhouette(bottom, 'high'),
        silhouette(top, 'high')
      ),
      span(
        'depth',
        'vertical',
        silhouette(floor, 'high'),
        silhouette(top, 'high')
      ),
      // Ø40 across the body seen side-on.
      span(
        'd40',
        'horizontal',
        silhouette(bodyRim, 'low'),
        silhouette(bodyRim, 'high'),
        { diameter: true }
      ),
      radial(id('d33'), topId, 'diameter', ref(top)),
      radial(
        id('d25'),
        topId,
        'diameter',
        ref(circleEdge(body, 12.5, { z: 50 }))
      ),
      chamfer('low', false),
      chamfer('shoulder', true)
    ];
    const audit = auditDrawingDimensions(
      sheetOf(bodyId, annotations),
      bodies,
      'mm'
    );
    expect(audit).toMatchObject({
      missing: [],
      redundant: [],
      unchecked: [],
      stated: 7,
      required: 7
    });
    // The same Ø40 again face-on, and the floor thickness closing the chain.
    const again = auditDrawingDimensions(
      sheetOf(bodyId, [
        ...annotations,
        radial(id('d40again'), topId, 'diameter', ref(bodyRim)),
        span(
          'floor',
          'vertical',
          silhouette(bottom, 'low'),
          silhouette(floor, 'low')
        )
      ]),
      bodies,
      'mm'
    );
    expect(
      again.redundant.map(({ annotationId, reason }) => [annotationId, reason])
    ).toEqual([
      [id('d40again'), 'duplicate-size'],
      [id('floor'), 'closed-chain']
    ]);
  });

  it('flags a repeated diameter and leaves a derived circle unchecked', async () => {
    const { bodies, bodyId, body } = await build(footOperations());
    const ref = (edge: EdgeTopology) => refOf(bodyId, edge);
    const annotations = [
      radial(
        id('d40'),
        topId,
        'diameter',
        ref(circleEdge(body, 20, { z: 4 * S }))
      ),
      radial(
        id('d33'),
        topId,
        'diameter',
        ref(circleEdge(body, 16.5, { z: 50 }))
      ),
      radial(
        id('d25'),
        topId,
        'diameter',
        ref(circleEdge(body, 12.5, { z: 50 }))
      ),
      // The bore again, from its floor: the same feature stated twice.
      radial(
        id('d25again'),
        topId,
        'diameter',
        ref(circleEdge(body, 12.5, { z: 9 }))
      ),
      // The contact face's rim follows from Ø40 and the chamfer.
      radial(id('d32'), topId, 'diameter', ref(circleEdge(body, 16, { z: 0 })))
    ];
    const audit = auditDrawingDimensions(
      sheetOf(bodyId, annotations),
      bodies,
      'mm'
    );
    expect(messages(audit.missing).filter((m) => m.startsWith('Ø'))).toEqual(
      []
    );
    expect(audit.redundant).toEqual([
      {
        annotationId: id('d25again'),
        reason: 'duplicate-size',
        message: 'Another dimension already states this Ø25 diameter.',
        statedBy: [id('d25')]
      }
    ]);
    expect(audit.unchecked.map((entry) => entry.annotationId)).toEqual([
      id('d32')
    ]);
    expect(audit.stated).toBe(3);
  });
});

/** An L section on XZ: steps at z = 10 and x = 10, extruded 8 along Y. */
const stepOperations = () => [
  {
    kind: 'add_sketch',
    name: 'Step',
    plane: 'XZ',
    offset: 0,
    objects: [
      [0, 0, 30, 0],
      [30, 0, 30, 10],
      [30, 10, 10, 10],
      [10, 10, 10, 20],
      [10, 20, 0, 20],
      [0, 20, 0, 0]
    ].map(([x1, y1, x2, y2]) => ({ objectKind: 'line', x1, y1, x2, y2 })),
    localId: '$step'
  },
  {
    kind: 'add_extrude',
    name: 'Step',
    localId: '$stepBody',
    sketchId: '$step',
    distance: 8,
    samplePoint: { x: 5, y: 5 }
  }
];

describe('D06 dimension audit: positions along an axis', () => {
  it('needs one dimension fewer than an axis has positions, and refuses a closed chain', async () => {
    const { bodies, bodyId, body } = await build(stepOperations());
    const nearY = body.bbox.min.y;
    // Vertical edges on the near face, at x = 30, 10 and 0.
    const upright = (x: number) =>
      refOf(
        bodyId,
        lineEdge(
          body,
          (a, b) =>
            near(a[0]!, x) &&
            near(b[0]!, x) &&
            near(a[1]!, nearY) &&
            near(b[1]!, nearY)
        )
      );
    const before = auditDrawingDimensions(sheetOf(bodyId), bodies, 'mm');
    expect(messages(before.missing)).toEqual([
      'X: nothing locates the face at x = 10 from the face at x = 0.',
      'X: nothing locates the face at x = 30 from the face at x = 0.',
      expect.stringMatching(/^Y: nothing locates the face at y = /),
      'Z: nothing locates the face at z = 10 from the face at z = 0.',
      'Z: nothing locates the face at z = 20 from the face at z = 0.'
    ]);
    expect(before.required).toBe(5);

    const chain = [
      linear(
        id('low'),
        frontId,
        'vertical',
        upright(30),
        'first',
        upright(30),
        'second'
      ),
      linear(
        id('high'),
        frontId,
        'vertical',
        upright(10),
        'first',
        upright(10),
        'second'
      ),
      linear(
        id('overall'),
        frontId,
        'vertical',
        upright(0),
        'first',
        upright(0),
        'second'
      )
    ];
    const after = auditDrawingDimensions(sheetOf(bodyId, chain), bodies, 'mm');
    expect(messages(after.missing).filter((m) => m.startsWith('Z'))).toEqual(
      []
    );
    expect(after.redundant).toEqual([
      {
        annotationId: id('overall'),
        reason: 'closed-chain',
        message:
          'The 2 dimensions it closes a chain with already state this distance.',
        statedBy: [id('low'), id('high')]
      }
    ]);
    expect(after.stated).toBe(2);
  });

  it('locates a hole by its centre and counts a repeated one once', async () => {
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
    const before = auditDrawingDimensions(sheetOf(bodyId), bodies, 'mm');
    expect(messages(before.missing)).toEqual([
      '2× Ø6 diameter.',
      'X: nothing locates the Ø6 axis at x = 10 from the face at x = 0.',
      'X: nothing locates the Ø6 axis at x = 30 from the face at x = 0.',
      'X: nothing locates the face at x = 40 from the face at x = 0.',
      expect.stringMatching(/^Y: nothing locates the face at y = /),
      'Z: nothing locates the Ø6 axis at z = 10 from the face at z = 0.',
      'Z: nothing locates the face at z = 20 from the face at z = 0.'
    ]);
    const nearY = body.bbox.min.y;
    const left = lineEdge(
      body,
      (a, b) =>
        near(a[0]!, 0) &&
        near(b[0]!, 0) &&
        near(a[1]!, nearY) &&
        near(b[1]!, nearY)
    );
    const hole = circleEdge(body, 3, { x: 10, y: nearY });
    const audit = auditDrawingDimensions(
      sheetOf(bodyId, [
        linear(
          id('x'),
          frontId,
          'horizontal',
          refOf(bodyId, left),
          'first',
          refOf(bodyId, hole),
          'center'
        ),
        radial(id('d'), frontId, 'diameter', refOf(bodyId, hole))
      ]),
      bodies,
      'mm'
    );
    expect(messages(audit.missing)).not.toContain('2× Ø6 diameter.');
    expect(messages(audit.missing)).not.toContain(
      'X: nothing locates the Ø6 axis at x = 10 from the face at x = 0.'
    );
    expect(audit.stated).toBe(2);
    expect(audit.redundant).toEqual([]);
  });
});

describe('D06 dimension audit: bolt circles', () => {
  it('states holes spaced round a bore by their pitch circle, not each position', async () => {
    const hole = (centerX: number, centerY: number) => ({
      objectKind: 'circle',
      radius: 1.5,
      centerX,
      centerY
    });
    const { bodies, bodyId, body } = await build([
      {
        kind: 'add_sketch',
        name: 'Flange',
        plane: 'XZ',
        offset: 0,
        objects: [
          {
            objectKind: 'rectangle',
            width: 40,
            height: 40,
            centerX: 20,
            centerY: 20
          },
          { objectKind: 'circle', radius: 6, centerX: 20, centerY: 20 },
          hole(30, 20),
          hole(20, 30),
          hole(10, 20),
          hole(20, 10)
        ],
        localId: '$flange'
      },
      {
        kind: 'add_extrude',
        name: 'Flange',
        localId: '$flangeBody',
        sketchId: '$flange',
        distance: 5,
        samplePoint: { x: 2, y: 2 }
      }
    ]);
    const audit = auditDrawingDimensions(sheetOf(bodyId), bodies, 'mm');
    expect(messages(audit.missing)).toEqual([
      'Ø12 diameter.',
      '4× Ø3 diameter.',
      'Ø20 pitch diameter of the 4× Ø3 bolt circle.',
      'X: nothing locates the Ø12 axis at x = 20 from the face at x = 0.',
      'X: nothing locates the face at x = 40 from the face at x = 0.',
      expect.stringMatching(/^Y: nothing locates the face at y = /),
      'Z: nothing locates the Ø12 axis at z = 20 from the face at z = 0.',
      'Z: nothing locates the face at z = 40 from the face at z = 0.'
    ]);
    expect(audit.unmeasurable).toEqual([]);
    // A Ø span between two opposite holes' centres states the pitch circle.
    const nearY = body.bbox.min.y;
    const holeAt = (x: number) =>
      refOf(bodyId, circleEdge(body, 1.5, { x, y: nearY }));
    const pitch: DrawingAnnotation = {
      ...linear(
        id('pitch'),
        frontId,
        'horizontal',
        holeAt(10),
        'center',
        holeAt(30),
        'center'
      ),
      diameter: true
    } as DrawingAnnotation;
    const stated = auditDrawingDimensions(
      sheetOf(bodyId, [pitch]),
      bodies,
      'mm'
    );
    expect(messages(stated.missing)).not.toContain(
      'Ø20 pitch diameter of the 4× Ø3 bolt circle.'
    );
    expect(stated).toMatchObject({ redundant: [], unchecked: [], stated: 1 });
  });
});

describe('D06 dimension audit: blends', () => {
  it('asks for a corner radius, not its position, and calls a dimension to its tangent derived', async () => {
    const { bodies, bodyId, body } = await build([
      {
        kind: 'add_sketch',
        name: 'Rounded',
        plane: 'XZ',
        offset: 0,
        objects: [
          { objectKind: 'line', x1: 0, y1: 0, x2: 30, y2: 0 },
          { objectKind: 'line', x1: 30, y1: 0, x2: 30, y2: 15 },
          {
            objectKind: 'arc',
            centerX: 25,
            centerY: 15,
            radius: 5,
            startAngleDeg: 0,
            endAngleDeg: 90
          },
          { objectKind: 'line', x1: 25, y1: 20, x2: 0, y2: 20 },
          { objectKind: 'line', x1: 0, y1: 20, x2: 0, y2: 0 }
        ],
        localId: '$rounded'
      },
      {
        kind: 'add_extrude',
        name: 'Rounded',
        localId: '$roundedBody',
        sketchId: '$rounded',
        distance: 8,
        samplePoint: { x: 5, y: 5 }
      }
    ]);
    const before = auditDrawingDimensions(sheetOf(bodyId), bodies, 'mm');
    expect(messages(before.missing)).toEqual([
      'R5 blend radius.',
      'X: nothing locates the face at x = 30 from the face at x = 0.',
      expect.stringMatching(/^Y: nothing locates the face at y = /),
      'Z: nothing locates the face at z = 20 from the face at z = 0.'
    ]);
    const nearY = body.bbox.min.y;
    const top = lineEdge(
      body,
      (a, b) =>
        near(a[2]!, 20) &&
        near(b[2]!, 20) &&
        near(a[1]!, nearY) &&
        near(b[1]!, nearY)
    );
    const audit = auditDrawingDimensions(
      sheetOf(bodyId, [
        // The top face's left end to its right end, where the blend starts.
        linear(
          id('tangent'),
          frontId,
          'horizontal',
          refOf(bodyId, top),
          'first',
          refOf(bodyId, top),
          'second'
        ),
        radial(
          id('r'),
          frontId,
          'radius',
          refOf(bodyId, circleEdge(body, 5, { y: nearY }))
        )
      ]),
      bodies,
      'mm'
    );
    expect(audit.redundant).toEqual([
      expect.objectContaining({
        annotationId: id('tangent'),
        reason: 'derived'
      })
    ]);
    expect(messages(audit.missing)).not.toContain('R5 blend radius.');
  });
});
