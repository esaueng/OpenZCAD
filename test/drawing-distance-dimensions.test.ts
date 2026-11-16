import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
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
  type DrawingDistanceDimension,
  type DrawingDistanceTarget,
  type DrawingEdgeRef,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingViewId,
  type EdgeTopology
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import {
  composeSheetAnnotations,
  resolveSheetAnnotations
} from '../apps/web/src/lib/drawing/annotations';
import {
  repairedAnnotation,
  startAnnotationTool
} from '../apps/web/src/lib/drawing/annotationPicking';

/**
 * D02 distance dimensions (schema v75): square to a straight edge or a
 * centreline, between parallel lines, and to circles' centres or their
 * near or far sides, read from the kernel bodies.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_dist' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const topId = 'dvw_top' as DrawingViewId;
const id = (name: string) => `dann_${name}` as DrawingAnnotationId;
const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
const at = { x: 0, y: 20 };

function ref(bodyId: BodyId, edge: EdgeTopology): DrawingEdgeRef {
  return {
    bodyId,
    hash: edge.hash,
    ...(edge.reference ? { reference: edge.reference } : {})
  };
}

/** A box beside a Ø8 pin, moved 40 along x. */
async function model() {
  let document = createProjectDocument('Distances', toUserId('test'));
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
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  const [boxId, pinId] = document.bodyOrder as [BodyId, BodyId];
  const box = bodies[boxId]!;
  const { min, max } = box.bbox;
  const straight = (match: (a: number[], b: number[]) => boolean) => {
    const found = box.topology!.edges.filter((edge) => {
      const p = edge.points;
      const a = p.slice(0, 3);
      const b = p.slice(p.length - 3);
      return match(a, b) || match(b, a);
    });
    expect(found).toHaveLength(1);
    return ref(boxId, found[0]!);
  };
  const front = (axis: 0 | 2, value: number) =>
    straight(
      (a, b) =>
        near(a[1]!, min.y) &&
        near(b[1]!, min.y) &&
        near(a[axis]!, value) &&
        near(b[axis]!, value)
    );
  // Seen from above, the edges of the box's top face along y.
  const above = (x: number) =>
    straight(
      (a, b) =>
        near(a[0]!, x) &&
        near(b[0]!, x) &&
        near(a[2]!, max.z) &&
        near(b[2]!, max.z)
    );
  const rims = bodies[pinId]!.topology!.edges.filter(
    (edge) => edge.curve?.circle
  );
  const rim = rims.reduce((best, edge) =>
    edge.curve!.circle!.center.z > best.curve!.circle!.center.z ? edge : best
  );
  return {
    document,
    bodies,
    boxId,
    pinId,
    min,
    max,
    pinX: rim.curve!.circle!.center.x,
    top: front(2, max.z),
    bottom: front(2, min.z),
    left: front(0, min.x),
    right: front(0, max.x),
    aboveRight: above(max.x),
    rim: ref(pinId, rim)
  };
}

function distance(
  name: string,
  viewId: DrawingViewId,
  from: DrawingDistanceTarget,
  to: DrawingDistanceTarget,
  extra: Partial<DrawingDistanceDimension> = {}
): DrawingDistanceDimension {
  return {
    annotationId: id(name),
    kind: 'distance',
    viewId,
    from,
    to,
    placementMm: at,
    ...extra
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
        hiddenLines: false
      }
    ],
    annotations
  };
}

const mm = (value: number) => String(Math.round(value * 100) / 100);

describe('D02 distance dimensions (schema v75)', () => {
  it('claims v75 and validates targets and extents by name', async () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(75);
    const { boxId, top, bottom, rim } = await model();
    const check = (annotations: unknown[]) =>
      drawingSetError({
        sheets: [sheetOf([boxId], annotations as DrawingAnnotation[])]
      });
    expect(
      check([distance('d', frontId, { line: top }, { line: bottom })])
    ).toBeNull();
    const circle = {
      annotationId: id('o'),
      kind: 'centerline',
      viewId: frontId,
      mode: 'circle',
      through: [
        { edge: top, anchor: 'first' },
        { edge: top, anchor: 'second' },
        { edge: bottom, anchor: 'first' }
      ],
      placementMm: at
    };
    const bad: [unknown[], RegExp][] = [
      [
        [
          distance(
            'd',
            frontId,
            { line: top },
            { line: bottom },
            {
              extent: 'min'
            }
          )
        ],
        /side of a circle but names none/
      ],
      [
        [
          distance(
            'd',
            topId,
            { circle: rim },
            { line: top },
            {
              extent: 'mid' as never
            }
          )
        ],
        /unknown extent/
      ],
      [
        [
          distance(
            'd',
            frontId,
            { line: top, circle: rim },
            {
              line: bottom
            }
          )
        ],
        /not one point, line, centreline or circle/
      ],
      [
        [
          distance(
            'd',
            frontId,
            { point: { edge: top, anchor: 'silhouette', side: 'low' } },
            { line: bottom }
          )
        ],
        /through an extreme/
      ],
      [
        [
          circle,
          distance('d', frontId, { centerline: id('o') }, { line: top })
        ],
        /not a straight centreline on its view/
      ]
    ];
    for (const [annotations, message] of bad)
      expect(check(annotations)).toMatch(message);
  });

  it('measures square to lines and centrelines, between parallel lines, and to circles’ sides', async () => {
    const {
      bodies,
      boxId,
      pinId,
      min,
      max,
      pinX,
      top,
      bottom,
      left,
      right,
      aboveRight,
      rim
    } = await model();
    const annotations: DrawingAnnotation[] = [
      // From the left edge to the top edge's right end: the width.
      distance(
        'pointLine',
        frontId,
        { line: left },
        { point: { edge: top, anchor: 'second' } }
      ),
      distance('lines', frontId, { line: top }, { line: bottom }),
      {
        annotationId: id('mid'),
        kind: 'centerline',
        viewId: frontId,
        mode: 'lines',
        edges: [top, bottom],
        placementMm: at
      },
      distance(
        'toCentreline',
        frontId,
        { centerline: id('mid') },
        {
          line: top
        }
      ),
      distance('centre', topId, { line: aboveRight }, { circle: rim }),
      distance(
        'min',
        topId,
        { line: aboveRight },
        { circle: rim },
        {
          extent: 'min'
        }
      ),
      distance(
        'max',
        topId,
        { circle: rim },
        { line: aboveRight },
        {
          extent: 'max',
          tolerance: { kind: 'symmetric', value: 0.1 }
        }
      ),
      {
        annotationId: id('mark'),
        kind: 'center-mark',
        viewId: topId,
        edge: rim,
        placementMm: at
      },
      distance(
        'toMark',
        topId,
        { point: { anchor: 'mark', annotationId: id('mark') } },
        { line: aboveRight }
      ),
      distance('crossed', frontId, { line: top }, { line: right }),
      distance(
        'onLine',
        frontId,
        { point: { edge: top, anchor: 'first' } },
        { line: top }
      )
    ];
    const sheet = sheetOf([boxId, pinId], annotations);
    expect(drawingSetError({ sheets: [sheet] })).toBeNull();
    const resolutions = resolveSheetAnnotations(sheet, bodies, 'mm');
    const label = (name: string) => {
      const resolution = resolutions.get(id(name))!;
      return resolution.ok ? resolution.resolved.label : resolution.reason;
    };
    expect(label('pointLine')).toBe(mm(max.x - min.x));
    expect(label('lines')).toBe(mm(max.z - min.z));
    expect(label('toCentreline')).toBe(mm((max.z - min.z) / 2));
    expect(label('centre')).toBe(mm(pinX - max.x));
    expect(label('min')).toBe(mm(pinX - 4 - max.x));
    expect(label('max')).toBe(`${mm(pinX + 4 - max.x)} ±0.10`);
    expect(label('toMark')).toBe(mm(pinX - max.x));
    expect(label('crossed')).toBe('not-parallel');
    expect(label('onLine')).toBe('degenerate');

    // Deleting the centreline breaks what measured to it, by name.
    const without = {
      ...sheet,
      annotations: annotations.filter(
        (entry) => entry.annotationId !== id('mid')
      )
    };
    const broken = resolveSheetAnnotations(without, bodies, 'mm').get(
      id('toCentreline')
    )!;
    expect(!broken.ok && broken.reason).toBe('mark-missing');

    // Laid out like an aligned dimension along its span: two arrows and
    // its value.
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
    const only = { ...sheet, annotations: [annotations[4]!] };
    const layer = composeSheetAnnotations(
      only,
      views,
      resolveSheetAnnotations(only, bodies, 'mm'),
      'mm'
    );
    expect(layer.strokes.filter((stroke) => stroke.filled)).toHaveLength(2);
    expect(layer.texts.map((text) => text.text)).toEqual([mm(pinX - max.x)]);
  });

  it('keeps a circle extent through a re-pick only while a circle is picked', () => {
    const line: DrawingEdgeRef = { bodyId: 'b' as BodyId, hash: 7 };
    const rim: DrawingEdgeRef = { bodyId: 'b' as BodyId, hash: 8 };
    const previous = distance(
      'd',
      topId,
      { line },
      { circle: rim },
      {
        extent: 'min',
        decimals: 3
      }
    );
    const repick = (targets: DrawingDistanceTarget[]) =>
      repairedAnnotation(previous, {
        ...startAnnotationTool('distance', previous.annotationId, topId),
        targets
      });
    expect(repick([{ line }, { circle: rim }])).toMatchObject({
      extent: 'min',
      decimals: 3
    });
    // Two lines now: no circle to measure a side of, so no extent, and the
    // repaired annotation stays storable.
    const lines = repick([{ line }, { line: { ...line, hash: 9 } }])!;
    expect(lines).not.toHaveProperty('extent');
    expect(lines).toMatchObject({ decimals: 3 });
    expect(
      drawingSetError({ sheets: [sheetOf(['b' as BodyId], [lines])] })
    ).toBeNull();
  });

  it('is stored by one undoable command, gated below v75', async () => {
    const { document, boxId, top, bottom } = await model();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheetOf([boxId], []) })
    );
    manager.execute(
      commandFactories.addDrawingAnnotation({
        sheetId,
        annotation: distance('d', frontId, { line: top }, { line: bottom })
      })
    );
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    expect(() =>
      assertStorableDocument({
        ...manager.document,
        schemaVersion: 74
      })
    ).toThrow(/Distance dimensions require project schema v75/);
    manager.undo();
    expect(manager.document.drawings!.sheets[0]!.annotations ?? []).toEqual([]);
  });
});
