import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingEdgeRef,
  type DrawingLinearDimension,
  type DrawingViewId,
  type EdgeTopology
} from '@openzcad/shared';
import {
  buildPart,
  flangeOperations,
  footOperations,
  frontId,
  plateOperations,
  roundedOperations,
  sheetOf,
  stepOperations,
  topId
} from './helpers/drawing-dimension-fixtures';
import { auditDrawingDimensions } from '../apps/web/src/lib/drawing/dimensionAudit';

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const build = (operations: unknown[]) => buildPart(adapter, operations);
const S = Math.SQRT2;

const id = (name: string) => `dann_${name}` as DrawingAnnotationId;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

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
  it('asks for each diameter, chamfer, blend and axial position once', async () => {
    const { bodies, bodyId } = await build(footOperations());
    const audit = auditDrawingDimensions(sheetOf(bodyId), bodies, 'mm');
    // Coaxial: nothing to locate across the axis. Along it, three faces
    // and the shoulder's corner need three dimensions; since slice B (v48)
    // rims' silhouettes mark them, and since slice D (v49) the shoulder is
    // the same 4 × 45° chamfer as the bottom, cut at z = 29, and the three
    // R4 tori are one counted radius.
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
  });

  it('passes a sheet that states every requirement once with the v48 and v49 anchors', async () => {
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
    const chamfer = (
      name: string,
      above: boolean,
      count?: number
    ): DrawingAnnotation => ({
      annotationId: id(name),
      kind: 'chamfer',
      viewId: frontId,
      face: { bodyId, hash: cone(above).hash },
      ...(count ? { count } : {}),
      placementMm: { x: 40, y: above ? 10 : -30 }
    });
    const torus = body.topology!.faces.find((face) =>
      face.geometry?.surfaceType.toLowerCase().includes('tor')
    )!;
    const corner = {
      anchor: 'chamfer-corner' as const,
      face: { bodyId, hash: cone(true).hash },
      like: { bodyId, hash: cone(false).hash },
      side: 'high' as const
    };
    const span = (
      name: string,
      direction: 'horizontal' | 'vertical',
      from: DrawingLinearDimension['from'],
      to: DrawingLinearDimension['to'],
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
    const annotations: DrawingAnnotation[] = [
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
      // One chamfer dimension states both: the shoulder is the same
      // 4 × 45°, and the 29 to the corner it cut locates it.
      chamfer('low', false, 2),
      span('body', 'vertical', silhouette(bottom, 'high'), corner),
      {
        annotationId: id('r4'),
        kind: 'radius',
        viewId: frontId,
        face: { bodyId, hash: torus.hash },
        side: 'high',
        count: 3,
        placementMm: { x: 40, y: 0 }
      }
    ];
    const audit = auditDrawingDimensions(
      sheetOf(bodyId, annotations),
      bodies,
      'mm'
    );
    expect(audit).toMatchObject({
      missing: [],
      redundant: [],
      unmeasurable: [],
      unchecked: [],
      stated: 8,
      required: 8
    });
    // The same Ø40 again face-on, the floor thickness closing the chain,
    // the shoulder's own 3.5 to the neck, a span to its virtual sharp with
    // the body (z = 25, which the 4 × 45° and the 29 fix), and a second R4.
    const bodyFace = body.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType.toLowerCase().includes('cylind') &&
        face.geometry.radius !== undefined &&
        near(face.geometry.radius, 20)
    )!;
    const again = auditDrawingDimensions(
      sheetOf(bodyId, [
        ...annotations,
        radial(id('d40again'), topId, 'diameter', ref(bodyRim)),
        span(
          'floor',
          'vertical',
          silhouette(bottom, 'low'),
          silhouette(floor, 'low')
        ),
        chamfer('shoulder', true),
        span('sharp', 'vertical', silhouette(bottom, 'low'), {
          anchor: 'virtual-sharp',
          faces: [
            { bodyId, hash: bodyFace.hash },
            { bodyId, hash: cone(true).hash }
          ],
          side: 'low'
        }),
        {
          annotationId: id('r4again'),
          kind: 'radius',
          viewId: frontId,
          face: {
            bodyId,
            hash: body.topology!.faces.filter((face) =>
              face.geometry?.surfaceType.toLowerCase().includes('tor')
            )[1]!.hash
          },
          side: 'low',
          placementMm: { x: -40, y: 0 }
        } as DrawingAnnotation
      ]),
      bodies,
      'mm'
    );
    expect(
      again.redundant.map(({ annotationId, reason }) => [annotationId, reason])
    ).toEqual([
      [id('d40again'), 'duplicate-size'],
      [id('floor'), 'closed-chain'],
      [id('shoulder'), 'derived'],
      [id('sharp'), 'derived'],
      [id('r4again'), 'duplicate-size']
    ]);
    expect(again.unchecked).toEqual([]);
  });

  it('flags a repeated diameter and calls a circle a chamfer fixes derived', async () => {
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
      },
      // Ø32 follows from Ø40 and the 4 × 45° chamfer (slice D).
      {
        annotationId: id('d32'),
        reason: 'derived',
        message:
          'It measures where a chamfer or blend meets the next face, which that feature and the diameter it shapes already fix.',
        statedBy: []
      }
    ]);
    expect(audit.unchecked).toEqual([]);
    expect(audit.stated).toBe(3);
  });
});

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
    const { bodies, bodyId, body } = await build(plateOperations());
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
    const { bodies, bodyId, body } = await build(flangeOperations());
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
    const { bodies, bodyId, body } = await build(roundedOperations());
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
