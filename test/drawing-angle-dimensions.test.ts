import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  filletEdges,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingSetError,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingEdgeRef,
  type DrawingPointRef,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingViewId,
  type EdgeTopology
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import {
  composeSheetAnnotations,
  layoutAnnotation,
  resolveSheetAnnotations,
  type ResolvedAnnotation
} from '../apps/web/src/lib/drawing/annotations';
import {
  applyAnnotationPick,
  draftAnnotation,
  pickedEnough,
  repairedAnnotation,
  repairToolKind,
  startAnnotationTool
} from '../apps/web/src/lib/drawing/annotationPicking';

/**
 * D02 arc and three-point angles (schema v82): an arc's included angle at
 * its centre, and the angle at a vertex point between two others, read
 * from the kernel bodies on every draw.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_angle' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const topId = 'dvw_top' as DrawingViewId;
const id = (name: string) => `dann_${name}` as DrawingAnnotationId;
const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
const at = { x: 0, y: 25 };

function ref(bodyId: BodyId, edge: EdgeTopology): DrawingEdgeRef {
  return {
    bodyId,
    hash: edge.hash,
    ...(edge.reference ? { reference: edge.reference } : {})
  };
}

/**
 * A box whose top right edge (along y) is filleted R3, so the front view
 * sees a quarter arc face-on, beside a Ø8 pin moved 40 along x.
 */
async function model() {
  let document = createProjectDocument('Angles', toUserId('test'));
  document = addPrimitiveFeature(document, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 6 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Pin',
    primitiveKind: 'cylinder',
    dimensions: { radius: 4, height: 12 }
  });
  document = transformBody(document, {
    name: 'Move',
    targetBodyId: document.bodyOrder[1]!,
    translation: { x: 40, y: 0, z: 0 }
  }).document;
  const first = (await adapter.syncDocument(document)).bodyRepresentations;
  const [plainBoxId, pinId] = document.bodyOrder as [BodyId, BodyId];
  const plain = first[plainBoxId]!;
  const { min, max } = plain.bbox;
  // The box's top right edge, along y.
  const corner = plain.topology!.edges.find((edge) => {
    const p = edge.points;
    const a = p.slice(0, 3);
    const b = p.slice(p.length - 3);
    return [a, b].every((q) => near(q[0]!, max.x) && near(q[2]!, max.z));
  })!;
  document = filletEdges(document, {
    name: 'Round',
    targetBodyId: plainBoxId,
    edgeHashes: [corner.hash],
    size: 3
  }).document;
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  const boxId = document.bodyOrder.find(
    (bodyId) => bodyId !== plainBoxId && bodyId !== pinId
  )!;
  const box = bodies[boxId]!;
  // The fillet's arc on the box's front face (y = min.y), seen face-on.
  const arc = box.topology!.edges.find(
    (edge) =>
      edge.curve?.circle &&
      Math.abs(Math.abs(edge.curve.circle.axis.y) - 1) < 1e-9 &&
      near(edge.curve.circle.center.y, min.y)
  )!;
  expect(arc).toBeDefined();
  // A straight edge of the box along y, at x and z: seen end-on in front.
  const alongY = (x: number, z: number) => {
    const found = box.topology!.edges.filter((edge) => {
      const p = edge.points;
      const a = p.slice(0, 3);
      const b = p.slice(p.length - 3);
      return [a, b].every((q) => near(q[0]!, x) && near(q[2]!, z));
    });
    expect(found).toHaveLength(1);
    return ref(boxId, found[0]!);
  };
  const rims = bodies[pinId]!.topology!.edges.filter(
    (edge) => edge.curve?.circle
  );
  const byHeight = [...rims].sort(
    (a, b) => a.curve!.circle!.center.z - b.curve!.circle!.center.z
  );
  const lowRim = byHeight[0]!;
  const highRim = byHeight.at(-1)!;
  return {
    document,
    bodies,
    boxId,
    pinId,
    min,
    max,
    pinCentre: lowRim.curve!.circle!.center,
    arc: ref(boxId, arc),
    belowRight: alongY(max.x, min.z),
    belowLeft: alongY(min.x, min.z),
    aboveLeft: alongY(min.x, max.z),
    lowRim: ref(pinId, lowRim),
    highRim: ref(pinId, highRim)
  };
}

function sheetOf(
  bodyIds: BodyId[],
  annotations: DrawingAnnotation[]
): DrawingSheet {
  return {
    sheetId,
    name: 'Sheet 1',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views: [
      {
        viewId: frontId,
        orientation: 'front',
        bodyIds,
        centerMm: { x: 120, y: 120 },
        hiddenLines: false
      },
      {
        viewId: topId,
        orientation: 'top',
        bodyIds,
        centerMm: { x: 120, y: 220 },
        hiddenLines: true
      }
    ],
    annotations
  };
}

const end = (edge: DrawingEdgeRef, anchor: 'first' | 'second') =>
  ({ edge, anchor }) as DrawingPointRef;
const centre = (edge: DrawingEdgeRef) =>
  ({ edge, anchor: 'center' }) as DrawingPointRef;

describe('D02 arc and three-point angles (schema v82)', () => {
  it('claims v82 and validates both kinds by name', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(82);
    const edge = { bodyId: 'b' as BodyId, hash: 7 };
    const check = (annotations: unknown[]) =>
      drawingSetError({
        sheets: [sheetOf(['b' as BodyId], annotations as DrawingAnnotation[])]
      });
    const arc = {
      annotationId: id('a'),
      kind: 'arc-angle',
      viewId: frontId,
      edge,
      placementMm: at
    };
    const three = {
      annotationId: id('t'),
      kind: 'three-point-angle',
      viewId: frontId,
      vertex: centre(edge),
      from: end(edge, 'first'),
      to: { anchor: 'mark', annotationId: id('m') },
      placementMm: at
    };
    const mark = {
      annotationId: id('m'),
      kind: 'center-mark',
      viewId: frontId,
      edge,
      placementMm: at
    };
    expect(check([arc, three, mark])).toBeNull();
    expect(
      check([{ ...arc, tolerance: { kind: 'symmetric', value: 0.5 } }])
    ).toBeNull();
    const bad: [unknown, RegExp][] = [
      [{ ...arc, edge: { bodyId: 'b', hash: 0 } }, /invalid edge hash/],
      [{ ...arc, viewId: undefined }, /belongs to no view/],
      [
        { ...three, vertex: { edge, anchor: 'silhouette', side: 'low' } },
        /extreme/
      ],
      [{ ...three, to: { anchor: 'mark', annotationId: 'x' } }, /names no mark/]
    ];
    for (const [annotation, message] of bad)
      expect(check([annotation])).toMatch(message);
    // A mark measured to must be a mark on the angle's view.
    expect(check([three, { ...mark, viewId: topId }])).toMatch(
      /not a mark on its view/
    );
  });

  it('reads an arc’s included angle at its centre, and refuses a whole circle', async () => {
    const { bodies, boxId, pinId, arc, lowRim } = await model();
    const sheet = sheetOf(
      [boxId, pinId],
      [
        {
          annotationId: id('arc'),
          kind: 'arc-angle',
          viewId: frontId,
          edge: arc,
          placementMm: at
        },
        {
          annotationId: id('rim'),
          kind: 'arc-angle',
          viewId: topId,
          edge: lowRim,
          placementMm: at
        },
        {
          annotationId: id('tol'),
          kind: 'arc-angle',
          viewId: frontId,
          edge: arc,
          decimals: 0,
          tolerance: { kind: 'symmetric', value: 0.5 },
          placementMm: { x: 30, y: 25 }
        }
      ]
    );
    expect(drawingSetError({ sheets: [sheet] })).toBeNull();
    const resolutions = resolveSheetAnnotations(sheet, bodies, 'mm');
    const quarter = resolutions.get(id('arc'))!;
    expect(quarter.ok).toBe(true);
    if (!quarter.ok || quarter.resolved.kind !== 'angle')
      throw new Error('no arc angle');
    expect(quarter.resolved.value).toBeCloseTo(90, 9);
    expect(quarter.resolved.label).toBe('90°');
    // Its rays run from the arc's centre to its two ends, R3 long.
    for (const [from, to] of quarter.resolved.rays)
      expect(Math.hypot(to[0] - from[0], to[1] - from[1])).toBeCloseTo(3, 9);
    expect(quarter.resolved.through).toBeDefined();
    const tol = resolutions.get(id('tol'))!;
    expect(tol.ok && tol.resolved.label).toBe('90° ±0.5°');
    const rim = resolutions.get(id('rim'))!;
    expect(!rim.ok && rim.reason).toBe('closed-edge');
    // Drawn through the one layout: an arc of dimension line and two arrows.
    const views = sheet.views.map((entry) => ({
      view: entry,
      projection: projectView({
        orientation: entry.orientation,
        hiddenLines: entry.hiddenLines,
        bodies: entry.bodyIds.map((bodyId) =>
          projectionBodyInput(bodies[bodyId]!)!
        )
      })
    }));
    const layer = composeSheetAnnotations(sheet, views, resolutions, 'mm');
    expect(layer.texts.map((text) => text.text)).toContain('90°');
    expect(layer.boxes.get(id('arc'))).toBeDefined();
  });

  it('sweeps an arc of more than 180° the long way round', () => {
    const toPage = (u: number, v: number): [number, number] => [u, -v];
    const resolved = (through?: [number, number]): ResolvedAnnotation => ({
      kind: 'angle',
      vertex: [0, 0],
      rays: [
        [
          [0, 0],
          [10, 0]
        ],
        [
          [0, 0],
          [0, 10]
        ]
      ],
      value: through ? 270 : 90,
      label: through ? '270°' : '90°',
      ...(through ? { through } : {})
    });
    // The dimension line's points, as page angles from the vertex.
    const swept = (layout: ReturnType<typeof layoutAnnotation>) => {
      const points = layout.strokes[0]!.points;
      const angles: number[] = [];
      for (let i = 0; i + 1 < points.length; i += 2)
        angles.push(Math.atan2(points[i + 1]!, points[i]!));
      return angles;
    };
    const short = swept(layoutAnnotation(resolved(), toPage, 1, [10, -10]));
    // The short way stays in the quarter between the rays.
    expect(
      short.every((angle) => angle <= 1e-9 && angle >= -Math.PI / 2 - 1e-9)
    ).toBe(true);
    // Through (−7, −7): the three quarters the other way.
    const long = swept(
      layoutAnnotation(resolved([-7, -7]), toPage, 1, [10, -10])
    );
    expect(long.some((angle) => angle > Math.PI / 2)).toBe(true);
    const span = long.length;
    expect(span).toBeGreaterThan(short.length);
  });

  it('reads the angle at a vertex between two points in one plane parallel to the view', async () => {
    const {
      bodies,
      boxId,
      pinId,
      max,
      min,
      pinCentre,
      belowRight,
      belowLeft,
      aboveLeft,
      lowRim,
      highRim
    } = await model();
    const angle = (
      name: string,
      vertex: DrawingPointRef,
      viewId: DrawingViewId = topId
    ): DrawingAnnotation => ({
      annotationId: id(name),
      kind: 'three-point-angle',
      viewId,
      vertex,
      from: end(belowRight, 'first'),
      to: end(belowRight, 'second'),
      placementMm: at
    });
    const sheet = sheetOf(
      [boxId, pinId],
      [
        // The pin's bottom centre and the box's bottom right edge share z.
        angle('low', centre(lowRim)),
        // Its top centre lies 12 higher: the angle would not be true size.
        angle('high', centre(highRim)),
        // A vertex on its own arm: no angle.
        angle('flat', end(belowRight, 'first'))
      ]
    );
    expect(drawingSetError({ sheets: [sheet] })).toBeNull();
    const resolutions = resolveSheetAnnotations(sheet, bodies, 'mm');
    const low = resolutions.get(id('low'))!;
    if (!low.ok || low.resolved.kind !== 'angle') throw new Error('no angle');
    // The edge's two ends seen from the pin's centre, in model terms.
    const a = [max.x - pinCentre.x, min.y - pinCentre.y];
    const b = [max.x - pinCentre.x, max.y - pinCentre.y];
    const expected =
      (Math.acos(
        (a[0]! * b[0]! + a[1]! * b[1]!) /
          (Math.hypot(a[0]!, a[1]!) * Math.hypot(b[0]!, b[1]!))
      ) *
        180) /
      Math.PI;
    expect(low.resolved.value).toBeCloseTo(expected, 9);
    expect(low.resolved.label).toBe(`${Math.round(expected * 10) / 10}°`);
    const high = resolutions.get(id('high'))!;
    expect(!high.ok && high.reason).toBe('foreshortened');
    const flat = resolutions.get(id('flat'))!;
    expect(!flat.ok && flat.reason).toBe('no-angle');
    // Seen on one line from above but at two heights: an angle in the
    // model the top view does not show true, so foreshortened, not none.
    const stacked = resolveSheetAnnotations(
      sheetOf(
        [boxId],
        [
          {
            annotationId: id('stacked'),
            kind: 'three-point-angle',
            viewId: topId,
            vertex: end(belowLeft, 'first'),
            from: end(belowLeft, 'second'),
            to: end(aboveLeft, 'first'),
            placementMm: at
          }
        ]
      ),
      bodies,
      'mm'
    ).get(id('stacked'))!;
    expect(!stacked.ok && stacked.reason).toBe('foreshortened');
  });

  it('drafts both from their tools, re-picks them, and is gated below v82', async () => {
    const { document, bodies, boxId, pinId, arc, lowRim, belowRight } =
      await model();
    // The arc tool takes one face-on arc.
    const arcTool = { ...startAnnotationTool('arc-angle'), viewId: frontId };
    expect(pickedEnough(arcTool)).toBe(false);
    const arcDraft = draftAnnotation(
      { ...arcTool, edges: [arc] },
      id('a'),
      at
    )!;
    expect(arcDraft).toEqual({
      annotationId: id('a'),
      kind: 'arc-angle',
      viewId: frontId,
      edge: arc,
      placementMm: at
    });
    expect(repairToolKind(arcDraft)).toBe('arc-angle');
    // The three-point tool takes the vertex first, then the arms' points,
    // a mark among them.
    const markId = id('m');
    const picked = applyAnnotationPick(
      startAnnotationTool('three-point-angle'),
      null,
      [0, 0],
      null,
      bodies,
      null,
      { annotationId: markId, viewId: topId }
    );
    if (!picked.ok) throw new Error(picked.message);
    let three = picked.tool;
    expect(three.viewId).toBe(topId);
    expect(three.points).toEqual([{ anchor: 'mark', annotationId: markId }]);
    three = {
      ...three,
      points: [
        ...three.points,
        end(belowRight, 'first'),
        end(belowRight, 'second')
      ]
    };
    expect(pickedEnough(three)).toBe(true);
    const threeDraft = draftAnnotation(three, id('t'), at)!;
    expect(threeDraft).toMatchObject({
      kind: 'three-point-angle',
      viewId: topId,
      vertex: { anchor: 'mark', annotationId: markId },
      from: end(belowRight, 'first'),
      to: end(belowRight, 'second')
    });
    // A re-pick keeps its format.
    const formatted = {
      ...threeDraft,
      decimals: 2,
      tolerance: { kind: 'symmetric' as const, value: 1 }
    };
    const repick = {
      ...startAnnotationTool('three-point-angle', id('t'), topId),
      points: [
        centre(lowRim),
        end(belowRight, 'first'),
        end(belowRight, 'second')
      ]
    };
    expect(repairedAnnotation(formatted, repick)).toMatchObject({
      vertex: centre(lowRim),
      decimals: 2,
      tolerance: { kind: 'symmetric', value: 1 }
    });

    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: sheetOf([boxId, pinId], [arcDraft])
      })
    );
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    expect(() =>
      assertStorableDocument({
        ...manager.document,
        // The release before the angles, whatever came after them.
        schemaVersion: 81
      })
    ).toThrow(/Arc and three-point angles require project schema v82/);
  });
});
