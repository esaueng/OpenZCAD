import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  normalizeDocument,
  setParameter
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  DRAWING_VIEW_FRAMES,
  drawingSetError,
  projectToView,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingEdgeRef,
  type DrawingLinearDimension,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';
import {
  projectionBuffers,
  projectView
} from '../apps/web/src/lib/drawing/projectView';
import { composeSheetPage } from '../apps/web/src/lib/drawing/sheetPage';
import {
  sheetPageToPdf,
  sheetPageToSvg
} from '../apps/web/src/lib/drawing/sheetExport';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import {
  composeSheetAnnotations,
  formatDrawingNumber,
  layoutAnnotation,
  markHiddenLeaders,
  previewAnnotationLayer,
  resolveDrawingAnnotation,
  resolveSheetAnnotations,
  type AnnotationBodies
} from '../apps/web/src/lib/drawing/annotations';
import {
  applyAnnotationPick,
  draftAnnotation,
  drawnLines,
  edgeRefFor,
  hitEdge,
  pickableEdges,
  repairedAnnotation,
  startAnnotationTool
} from '../apps/web/src/lib/drawing/annotationPicking';
import { parseSaveProjectDocumentRequest } from '../apps/web/worker/validation';
import * as webGlimpse from '../apps/web/src/lib/glimpseContract';
import * as workerGlimpse from '../apps/web/worker/glimpseContract';

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_one' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const topId = 'dvw_top' as DrawingViewId;

function boxDocument(width: number | string = 20): ProjectDocument {
  let document = createProjectDocument('Plate', toUserId('test'));
  document = setParameter(document, { name: 'w', expression: String(width) });
  return addPrimitiveFeature(document, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 'w', height: 10, depth: 6 }
  });
}

function cylinderDocument(): ProjectDocument {
  return addPrimitiveFeature(createProjectDocument('Pin', toUserId('test')), {
    name: 'Pin',
    primitiveKind: 'cylinder',
    dimensions: { radius: 4, height: 12 }
  });
}

function view(
  viewId: DrawingViewId,
  orientation: DrawingView['orientation'],
  bodyIds: BodyId[],
  centerMm = { x: 100, y: 120 }
): DrawingView {
  return { viewId, orientation, bodyIds, centerMm, hiddenLines: false };
}

function sheetOf(
  bodyIds: BodyId[],
  annotations?: DrawingAnnotation[]
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
      view(frontId, 'front', bodyIds),
      view(topId, 'top', bodyIds, { x: 100, y: 220 })
    ],
    ...(annotations ? { annotations } : {})
  };
}

const id = (name: string) => `dann_${name}` as DrawingAnnotationId;

/** A straight model edge whose two ends satisfy `match`. */
function edgeWhere(
  body: BodyRepresentation,
  match: (a: number[], b: number[]) => boolean
): EdgeTopology {
  const found = body.topology!.edges.filter((edge) => {
    if (edge.displayRole === 'seam') return false;
    const p = edge.points;
    const a = p.slice(0, 3);
    const b = p.slice(p.length - 3);
    return match(a, b) || match(b, a);
  });
  expect(found).toHaveLength(1);
  return found[0]!;
}

function refOf(bodyId: BodyId, edge: EdgeTopology): DrawingEdgeRef {
  return {
    bodyId,
    hash: edge.hash,
    ...(edge.reference ? { reference: edge.reference } : {})
  };
}

const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;

async function boxModel(width = 20, from?: ProjectDocument) {
  const document = from
    ? setParameter(from, { name: 'w', expression: String(width) })
    : boxDocument(width);
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  const bodyId = document.bodyOrder[0]!;
  const body = bodies[bodyId]!;
  const { min, max } = body.bbox;
  // The front view looks along +Y: its top edge is the near top one.
  const top = edgeWhere(
    body,
    (a, b) =>
      near(a[1]!, min.y) &&
      near(b[1]!, min.y) &&
      near(a[2]!, max.z) &&
      near(b[2]!, max.z)
  );
  const right = edgeWhere(
    body,
    (a, b) =>
      near(a[0]!, max.x) &&
      near(b[0]!, max.x) &&
      near(a[1]!, min.y) &&
      near(b[1]!, min.y)
  );
  const bottom = edgeWhere(
    body,
    (a, b) =>
      near(a[1]!, min.y) &&
      near(b[1]!, min.y) &&
      near(a[2]!, min.z) &&
      near(b[2]!, min.z)
  );
  return { document, bodies, bodyId, body, top, right, bottom };
}

function linear(
  annotationId: DrawingAnnotationId,
  direction: 'horizontal' | 'vertical' | 'aligned',
  from: DrawingEdgeRef,
  fromAnchor: 'first' | 'second' | 'center',
  to: DrawingEdgeRef,
  toAnchor: 'first' | 'second' | 'center'
): DrawingLinearDimension {
  return {
    annotationId,
    kind: 'linear',
    viewId: frontId,
    direction,
    from: { edge: from, anchor: fromAnchor },
    to: { edge: to, anchor: toAnchor },
    placementMm: { x: 0, y: 12 }
  };
}

describe('D02 annotation section (schema v31)', () => {
  it('is additive: a v30 sheet opens without annotations', () => {
    // D02 took v31; I05's reference images are v32.
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(33);
    const document = boxDocument();
    const v30 = {
      ...document,
      schemaVersion: 30,
      drawings: { sheets: [sheetOf(document.bodyOrder)] }
    } as unknown as ProjectDocument;
    const opened = normalizeDocument(
      JSON.parse(JSON.stringify(v30)) as ProjectDocument
    );
    expect('annotations' in opened.drawings!.sheets[0]!).toBe(false);
    expect(opened.drawings).toEqual(v30.drawings);
  });

  it('round-trips annotations through save and normalize, storing no values', async () => {
    const { document, bodyId, top } = await boxModel();
    const annotations: DrawingAnnotation[] = [
      linear(
        id('w'),
        'horizontal',
        refOf(bodyId, top),
        'first',
        refOf(bodyId, top),
        'second'
      ),
      {
        annotationId: id('note'),
        kind: 'note',
        text: 'DEBURR',
        viewId: frontId,
        leader: refOf(bodyId, top),
        placementMm: { x: -40, y: -20 }
      },
      {
        annotationId: id('free'),
        kind: 'note',
        text: 'GENERAL TOLERANCE ISO 2768-m',
        placementMm: { x: 20, y: 20 }
      }
    ];
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: sheetOf(document.bodyOrder, annotations)
      })
    );
    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    expect(normalizeDocument(saved).drawings).toEqual(
      manager.document.drawings
    );
    expect(JSON.stringify(saved.drawings)).not.toMatch(/"value"|"label"/);
  });

  it('refuses malformed annotations by name, on load and at the account edge', async () => {
    const { document, bodyId, top } = await boxModel();
    const ref = refOf(bodyId, top);
    const good = linear(id('w'), 'horizontal', ref, 'first', ref, 'second');
    const cases: [unknown, RegExp][] = [
      [{ ...good, kind: 'chamfer' }, /unknown kind/],
      [{ ...good, viewId: 'dvw_gone' }, /view that is not on its sheet/],
      [{ ...good, annotationId: 'x' }, /invalid id/],
      [{ ...good, placementMm: { x: Infinity, y: 0 } }, /placement/],
      [{ ...good, decimals: 9 }, /decimals/],
      [{ ...good, direction: 'diagonal' }, /direction/],
      [{ ...good, from: { edge: ref, anchor: 'middle' } }, /point anchor/],
      [
        { ...good, to: { edge: { ...ref, hash: 'x' }, anchor: 'first' } },
        /edge hash/
      ],
      [
        {
          ...good,
          from: {
            edge: { ...ref, reference: { kind: 'face' } },
            anchor: 'first'
          }
        },
        /edge reference/
      ],
      [
        {
          ...good,
          from: {
            edge: {
              ...ref,
              reference: {
                ...ref.reference!,
                lineageName: 'x'.repeat(5000)
              }
            },
            anchor: 'first'
          }
        },
        /edge reference/
      ],
      [
        {
          ...good,
          from: {
            edge: {
              ...ref,
              reference: { ...ref.reference!, currentHash: ref.hash + 1 }
            },
            anchor: 'first'
          }
        },
        /contradicts its hash/
      ],
      // ADR-011 fingerprints are positive safe integers, even when the two
      // copies agree.
      ...[0, -3, 1.5].map(
        (hash) =>
          [
            {
              ...good,
              from: {
                edge: {
                  ...ref,
                  hash,
                  reference: { ...ref.reference!, currentHash: hash }
                },
                anchor: 'first'
              }
            },
            /edge hash|malformed edge reference/
          ] as [unknown, RegExp]
      ),
      ...(
        [
          {},
          { ...ref.reference!.witness, closed: undefined },
          { ...ref.reference!.witness, closed: false, endpoints: [[0, 0, 0]] },
          { ...ref.reference!.witness, closed: false, midpoint: [0.5, 0, 0] },
          { ...ref.reference!.witness, closed: true, axis: 'z' },
          { ...ref.reference!.witness, length: 'long' },
          // Finite but not canonical: fractional or negative lengths, a
          // blank curve type, endpoints out of order, a non-canonical axis.
          { ...ref.reference!.witness, length: 1.5 },
          { ...ref.reference!.witness, length: -1 },
          { ...ref.reference!.witness, curveType: ' ' },
          {
            ...ref.reference!.witness,
            closed: false,
            endpoints: [
              [5, 0, 0],
              [0, 0, 0]
            ],
            midpoint: [2, 0, 0]
          },
          {
            curveType: 'CIRCLE',
            length: 10,
            closed: true,
            center: [0, 0, 0],
            axis: [0, 0, -1000]
          },
          {
            curveType: 'CIRCLE',
            length: 10,
            closed: true,
            center: [0, 0, 0],
            axis: [0, 0, 0]
          }
        ] as unknown[]
      ).map(
        (witness) =>
          [
            {
              ...good,
              from: {
                edge: {
                  ...ref,
                  reference: { ...ref.reference!, witness }
                },
                anchor: 'first'
              }
            },
            /malformed edge reference/
          ] as [unknown, RegExp]
      ),
      [
        {
          annotationId: id('n'),
          kind: 'note',
          text: ' ',
          placementMm: { x: 0, y: 0 }
        },
        /needs text/
      ],
      [
        {
          annotationId: id('n'),
          kind: 'note',
          text: 'A',
          leader: ref,
          placementMm: { x: 0, y: 0 }
        },
        /leader but belongs to no view/
      ],
      [
        {
          annotationId: id('r'),
          kind: 'radius',
          edge: ref,
          placementMm: { x: 0, y: 0 }
        },
        /dimension that belongs to no view/
      ],
      [{ ...good, kind: 'angle', edges: [ref] }, /two edges/]
    ];
    for (const [annotation, message] of cases) {
      const drawings = {
        sheets: [sheetOf(document.bodyOrder, [annotation as DrawingAnnotation])]
      };
      expect(drawingSetError(drawings)).toMatch(message);
      const broken = { ...document, drawings } as ProjectDocument;
      expect(() => normalizeDocument(broken)).toThrow(message);
      const wire = JSON.parse(JSON.stringify(broken)) as Record<
        string,
        unknown
      >;
      expect(() =>
        parseSaveProjectDocumentRequest(
          { projectId: broken.projectId, expectedVersion: 0, document: wire },
          broken.projectId
        )
      ).toThrow(/drawings/);
    }
    expect(
      drawingSetError({ sheets: [sheetOf(document.bodyOrder, [good, good])] })
    ).toMatch(/twice/);
    // A lineage name grown long by a boolean chain is fine within the
    // reference's overall budget.
    const deep = {
      ...ref,
      reference: {
        ...ref.reference!,
        lineageName: `${'boolean.edge.a.'.repeat(30)}${ref.reference!.lineageName}`
      }
    };
    expect(deep.reference.lineageName.length).toBeGreaterThan(256);
    expect(
      drawingSetError({
        sheets: [
          sheetOf(document.bodyOrder, [
            linear(id('d'), 'horizontal', deep, 'first', deep, 'second')
          ])
        ]
      })
    ).toBeNull();
    expect(
      drawingSetError({ sheets: [sheetOf(document.bodyOrder, [good])] })
    ).toBeNull();
  });
});

describe('D02 annotation commands', () => {
  it('adds, edits and deletes annotations with undo, redo and replay', async () => {
    const { document, bodyId, top } = await boxModel();
    const ref = refOf(bodyId, top);
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheetOf(document.bodyOrder) })
    );
    const dimension = linear(
      id('w'),
      'horizontal',
      ref,
      'first',
      ref,
      'second'
    );
    manager.execute(
      commandFactories.addDrawingAnnotation({ sheetId, annotation: dimension })
    );
    manager.execute(
      commandFactories.updateDrawingAnnotation(
        {
          sheetId,
          annotation: {
            ...dimension,
            placementMm: { x: 5, y: 15 },
            decimals: 1
          }
        },
        'Move annotation'
      )
    );
    const edited = manager.document;
    expect(edited.drawings!.sheets[0]!.annotations).toEqual([
      { ...dimension, placementMm: { x: 5, y: 15 }, decimals: 1 }
    ]);
    expect(manager.undoIsDrawingOnly).toBe(true);
    manager.undo();
    manager.undo();
    expect('annotations' in manager.document.drawings!.sheets[0]!).toBe(false);
    manager.redo();
    manager.redo();
    expect(manager.document.drawings).toEqual(edited.drawings);
    expect(replayCommands(document, edited.commandLog).drawings).toEqual(
      edited.drawings
    );
    manager.execute(
      commandFactories.deleteDrawingAnnotation({
        sheetId,
        annotationId: dimension.annotationId
      })
    );
    // The last one gone leaves no empty list behind.
    expect('annotations' in manager.document.drawings!.sheets[0]!).toBe(false);
  });

  it("deletes a view's annotations with it, and keeps free notes", async () => {
    const { document, bodyId, top } = await boxModel();
    const ref = refOf(bodyId, top);
    const free: DrawingAnnotation = {
      annotationId: id('free'),
      kind: 'note',
      text: 'NOTES',
      placementMm: { x: 20, y: 20 }
    };
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: sheetOf(document.bodyOrder, [
          linear(id('w'), 'horizontal', ref, 'first', ref, 'second'),
          free
        ])
      })
    );
    manager.execute(
      commandFactories.deleteDrawingView({ sheetId, viewId: frontId })
    );
    expect(manager.document.drawings!.sheets[0]!.annotations).toEqual([free]);
  });

  it('refuses an edge its view does not draw, and a move to another view', async () => {
    const { document, bodyId, top } = await boxModel();
    const ref = refOf(bodyId, top);
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheetOf(document.bodyOrder) })
    );
    const foreign = { ...ref, bodyId: 'body_other' as BodyId };
    expect(() =>
      manager.execute(
        commandFactories.addDrawingAnnotation({
          sheetId,
          annotation: linear(
            id('x'),
            'horizontal',
            foreign,
            'first',
            ref,
            'second'
          )
        })
      )
    ).toThrow(/not drawn in that view/);
    const dimension = linear(
      id('w'),
      'horizontal',
      ref,
      'first',
      ref,
      'second'
    );
    manager.execute(
      commandFactories.addDrawingAnnotation({ sheetId, annotation: dimension })
    );
    expect(() =>
      manager.execute(
        commandFactories.updateDrawingAnnotation({
          sheetId,
          annotation: { ...dimension, viewId: topId }
        })
      )
    ).toThrow(/another view/);
  });

  it('lists the annotation commands in both analytics allowlists', () => {
    const kinds = [
      'drawing.annotation.add',
      'drawing.annotation.update',
      'drawing.annotation.delete'
    ];
    for (const contract of [webGlimpse, workerGlimpse])
      expect(contract.EXPANDED.feature_operation).toEqual(
        expect.arrayContaining(kinds)
      );
  });
});

describe('D02 values from the model', () => {
  it('measures horizontal, vertical and aligned spans from exact vertices', async () => {
    const { bodies, bodyId, body, top, right, bottom } = await boxModel(20);
    const front = view(frontId, 'front', [bodyId]);
    const width = body.bbox.max.x - body.bbox.min.x;
    const height = body.bbox.max.z - body.bbox.min.z;
    expect(width).toBeCloseTo(20, 9);
    const measure = (annotation: DrawingAnnotation) => {
      const result = resolveDrawingAnnotation(annotation, front, bodies, 'mm');
      if (!result.ok) throw new Error(result.message);
      return result.resolved;
    };
    const t = refOf(bodyId, top);
    const r = refOf(bodyId, right);
    const b = refOf(bodyId, bottom);
    const horizontal = measure(
      linear(id('h'), 'horizontal', t, 'first', t, 'second')
    );
    expect(horizontal.kind === 'linear' && horizontal.value).toBeCloseTo(
      width,
      12
    );
    expect(horizontal.kind === 'linear' && horizontal.label).toBe('20');
    const vertical = measure(
      linear(id('v'), 'vertical', r, 'first', r, 'second')
    );
    expect(vertical.kind === 'linear' && vertical.value).toBeCloseTo(
      height,
      12
    );
    // Top-left corner to bottom-right corner: the page order puts the top
    // edge's left end first and the bottom edge's right end second.
    const diagonal = measure(
      linear(id('d'), 'aligned', t, 'first', b, 'second')
    );
    expect(diagonal.kind === 'linear' && diagonal.value).toBeCloseTo(
      Math.hypot(width, height),
      12
    );
    // Horizontal on a vertical edge, vertical on a horizontal one: no span.
    expect(
      resolveDrawingAnnotation(
        linear(id('hz'), 'horizontal', r, 'first', r, 'second'),
        front,
        bodies,
        'mm'
      )
    ).toMatchObject({ ok: false, reason: 'degenerate' });
    expect(
      resolveDrawingAnnotation(
        linear(id('vz'), 'vertical', t, 'first', t, 'second'),
        front,
        bodies,
        'mm'
      )
    ).toMatchObject({ ok: false, reason: 'degenerate' });
    const angle = measure({
      annotationId: id('a'),
      kind: 'angle',
      viewId: frontId,
      edges: [t, r],
      placementMm: { x: 5, y: 5 }
    });
    expect(angle.kind === 'angle' && angle.value).toBeCloseTo(90, 9);
    expect(angle.kind === 'angle' && angle.label).toBe('90°');
  });

  it('follows a widened box by lineage, so the value updates rather than breaks', async () => {
    const narrow = await boxModel(20);
    const ref = refOf(narrow.bodyId, narrow.top);
    expect(ref.reference?.lineageName).toBeTruthy();
    const dimension = linear(
      id('w'),
      'horizontal',
      ref,
      'first',
      ref,
      'second'
    );
    const wide = await boxModel(30, narrow.document);
    // Same edge, new geometry: a new hash, the same lineage name.
    expect(wide.top.hash).not.toBe(narrow.top.hash);
    const front = view(frontId, 'front', [wide.bodyId]);
    const result = resolveDrawingAnnotation(
      dimension,
      front,
      wide.bodies,
      'mm'
    );
    expect(
      result.ok && result.resolved.kind === 'linear' && result.resolved.value
    ).toBeCloseTo(30, 12);
  });

  it('reads radius and diameter from the published circle, face-on only', async () => {
    const document = cylinderDocument();
    const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
    const bodyId = document.bodyOrder[0]!;
    const rim = bodies[bodyId]!.topology!.edges.find(
      (edge) => edge.curve?.circle && edge.displayRole !== 'seam'
    )!;
    const edge = refOf(bodyId, rim);
    const top = view(topId, 'top', [bodyId]);
    const radius = resolveDrawingAnnotation(
      {
        annotationId: id('r'),
        kind: 'radius',
        viewId: topId,
        edge,
        placementMm: { x: 10, y: 10 }
      },
      top,
      bodies,
      'mm'
    );
    expect(radius.ok && radius.resolved.label).toBe('R4');
    const diameter = resolveDrawingAnnotation(
      {
        annotationId: id('d'),
        kind: 'diameter',
        viewId: topId,
        edge,
        placementMm: { x: 10, y: 10 },
        decimals: 3
      },
      top,
      bodies,
      'mm'
    );
    expect(diameter.ok && diameter.resolved.label).toBe('Ø8');
    // From the front the rim is a line: no radius to read there.
    const sideways = resolveDrawingAnnotation(
      {
        annotationId: id('r'),
        kind: 'radius',
        viewId: frontId,
        edge,
        placementMm: { x: 10, y: 10 }
      },
      view(frontId, 'front', [bodyId]),
      bodies,
      'mm'
    );
    expect(sideways).toMatchObject({ ok: false, reason: 'edge-on' });
    // A rim has no ends to measure from; its centre is a point.
    const fromCentre = resolveDrawingAnnotation(
      linear(id('c'), 'horizontal', edge, 'center', edge, 'first'),
      top,
      bodies,
      'mm'
    );
    expect(fromCentre).toMatchObject({ ok: false, reason: 'closed-edge' });
  });

  it('breaks visibly, with a reason, instead of rebinding', async () => {
    const { bodies, bodyId, top, right } = await boxModel();
    const front = view(frontId, 'front', [bodyId]);
    const t = refOf(bodyId, top);
    const dimension = linear(id('w'), 'horizontal', t, 'first', t, 'second');
    // Gone from the model: no edge carries its hash any more.
    const gone = { bodyId, hash: 1 };
    // A reference whose witness does not fingerprint to its hash is not
    // trusted, whatever its lineage name says.
    const forged = {
      ...t,
      reference: { ...t.reference!, lineageName: 'primitive.box.edge.other' }
    };
    expect(
      resolveDrawingAnnotation(
        linear(
          id('f'),
          'horizontal',
          {
            ...forged,
            hash: 99,
            reference: { ...forged.reference, currentHash: 99 }
          },
          'first',
          t,
          'second'
        ),
        front,
        bodies,
        'mm'
      )
    ).toMatchObject({ ok: false, reason: 'invalid-reference' });
    expect(
      resolveDrawingAnnotation(
        linear(id('g'), 'horizontal', gone, 'first', gone, 'second'),
        front,
        bodies,
        'mm'
      )
    ).toMatchObject({ ok: false, reason: 'not-found' });
    // The body left the view, or the model.
    expect(
      resolveDrawingAnnotation(
        dimension,
        view(frontId, 'front', ['body_x' as BodyId]),
        bodies,
        'mm'
      )
    ).toMatchObject({ ok: false, reason: 'not-in-view' });
    expect(resolveDrawingAnnotation(dimension, front, {}, 'mm')).toMatchObject({
      ok: false,
      reason: 'body-missing'
    });
    // Two edges carrying one identity: ambiguous, never the first match.
    const twin = {
      ...bodies[bodyId]!,
      topology: {
        ...bodies[bodyId]!.topology!,
        edges: [
          ...bodies[bodyId]!.topology!.edges,
          { ...top, topologyId: 'twin' }
        ]
      }
    };
    expect(
      resolveDrawingAnnotation(dimension, front, { [bodyId]: twin }, 'mm')
    ).toMatchObject({ ok: false, reason: 'ambiguous' });
    // Parallel edges make no angle; a straight edge has no radius.
    const b = refOf(
      bodyId,
      edgeWhere(
        bodies[bodyId]!,
        (p, q) =>
          near(p[1]!, bodies[bodyId]!.bbox.min.y) &&
          near(q[1]!, bodies[bodyId]!.bbox.min.y) &&
          near(p[2]!, bodies[bodyId]!.bbox.min.z) &&
          near(q[2]!, bodies[bodyId]!.bbox.min.z)
      )
    );
    expect(
      resolveDrawingAnnotation(
        {
          annotationId: id('a'),
          kind: 'angle',
          viewId: frontId,
          edges: [t, b],
          placementMm: { x: 0, y: 0 }
        },
        front,
        bodies,
        'mm'
      )
    ).toMatchObject({ ok: false, reason: 'parallel' });
    expect(
      resolveDrawingAnnotation(
        {
          annotationId: id('r'),
          kind: 'radius',
          viewId: frontId,
          edge: refOf(bodyId, right),
          placementMm: { x: 0, y: 0 }
        },
        front,
        bodies,
        'mm'
      )
    ).toMatchObject({ ok: false, reason: 'not-circular' });
    // The whole sheet's map keeps every broken entry, and the page leaves
    // them out rather than drawing a guess.
    const sheet = sheetOf(
      [bodyId],
      [linear(id('g'), 'horizontal', gone, 'first', gone, 'second'), dimension]
    );
    const resolutions = resolveSheetAnnotations(sheet, bodies, 'mm');
    expect([...resolutions.values()].map((entry) => entry.ok)).toEqual([
      false,
      true
    ]);
  });

  it('refuses an aligned span or an angle that slopes into a principal view', async () => {
    const { bodies, bodyId, body, top, right } = await boxModel();
    const front = view(frontId, 'front', [bodyId]);
    const { min, max } = body.bbox;
    // The bottom edge at the back: its ends lie deeper in the front view
    // than the top front edge's.
    const backBottom = edgeWhere(
      body,
      (a, b) =>
        near(a[1]!, max.y) &&
        near(b[1]!, max.y) &&
        near(a[2]!, min.z) &&
        near(b[2]!, min.z)
    );
    const t = refOf(bodyId, top);
    const back = refOf(bodyId, backBottom);
    expect(
      resolveDrawingAnnotation(
        linear(id('s'), 'aligned', t, 'first', back, 'second'),
        front,
        bodies,
        'mm'
      )
    ).toMatchObject({ ok: false, reason: 'foreshortened' });
    // Along a model axis the same two points are still exact.
    const across = resolveDrawingAnnotation(
      linear(id('x'), 'horizontal', t, 'first', back, 'second'),
      front,
      bodies,
      'mm'
    );
    expect(
      across.ok && across.resolved.kind === 'linear' && across.resolved.value
    ).toBeCloseTo(max.x - min.x, 12);
    // A straight edge that slopes into the view gives no true angle.
    const sloped: EdgeTopology = {
      topologyId: 'sloped',
      hash: 777,
      curve: { type: 'LINE' },
      vertexIds: [900, 901],
      points: [max.x, min.y, max.z, max.x + 5, max.y, max.z + 10]
    };
    const withSlope: AnnotationBodies = {
      [bodyId]: {
        ...body,
        topology: {
          ...body.topology!,
          edges: [...body.topology!.edges, sloped]
        }
      }
    };
    expect(
      resolveDrawingAnnotation(
        {
          annotationId: id('a'),
          kind: 'angle',
          viewId: frontId,
          edges: [t, { bodyId, hash: 777 }],
          placementMm: { x: 0, y: 0 }
        },
        front,
        withSlope,
        'mm'
      )
    ).toMatchObject({ ok: false, reason: 'foreshortened' });
    // Edges in the view's plane still measure.
    expect(
      resolveDrawingAnnotation(
        {
          annotationId: id('a'),
          kind: 'angle',
          viewId: frontId,
          edges: [t, refOf(bodyId, right)],
          placementMm: { x: 0, y: 0 }
        },
        front,
        withSlope,
        'mm'
      )
    ).toMatchObject({ ok: true });
  });

  it('refuses lengths and angles read off the isometric view', async () => {
    const { bodies, bodyId, top } = await boxModel();
    const t = refOf(bodyId, top);
    const iso = view(frontId, 'iso', [bodyId]);
    expect(
      resolveDrawingAnnotation(
        linear(id('i'), 'aligned', t, 'first', t, 'second'),
        iso,
        bodies,
        'mm'
      )
    ).toMatchObject({ ok: false, reason: 'foreshortened' });
    const projection = projectView({
      orientation: 'iso',
      hiddenLines: false,
      bodies: [projectionBodyInput(bodies[bodyId]!)!]
    });
    const edges = pickableEdges(
      sheetOf([bodyId]),
      [{ view: iso, projection }],
      bodies,
      'mm'
    );
    const hit = edges.find((entry) => entry.edge === top)!;
    expect(
      applyAnnotationPick(
        startAnnotationTool('aligned'),
        hit,
        hit.page[0]!,
        iso,
        bodies
      )
    ).toMatchObject({ ok: false, message: /foreshortens/ });
    // A note may still point into it.
    expect(
      applyAnnotationPick(
        startAnnotationTool('note'),
        hit,
        hit.page[0]!,
        iso,
        bodies
      )
    ).toMatchObject({ ok: true });
  });

  it('formats values with trimmed zeros and no negative zero', () => {
    expect(formatDrawingNumber(20, 2)).toBe('20');
    expect(formatDrawingNumber(12.5, 2)).toBe('12.5');
    expect(formatDrawingNumber(1 / 3, 3)).toBe('0.333');
    expect(formatDrawingNumber(-0.0001, 2)).toBe('0');
    expect(formatDrawingNumber(2.005, 0)).toBe('2');
  });
});

describe('D02 picking', () => {
  it('picks a straight edge whole, or the end nearest the click', async () => {
    const { bodies, bodyId, top } = await boxModel(20);
    const front = view(frontId, 'front', [bodyId]);
    const sheet = sheetOf([bodyId]);
    const projection = projectView({
      orientation: 'front',
      hiddenLines: false,
      bodies: [projectionBodyInput(bodies[bodyId]!)!]
    });
    const edges = pickableEdges(
      sheet,
      [{ view: front, projection }],
      bodies,
      'mm'
    );
    const topPick = edges.find((entry) => entry.edge === top)!;
    const [a, b] = [topPick.page[0]!, topPick.page.at(-1)!];
    const middle: [number, number] = [
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2 + 0.3
    ];
    expect(hitEdge(edges, middle, 1)?.edge).toBe(top);
    expect(hitEdge(edges, [middle[0], middle[1] + 5], 1)).toBeNull();
    // Only where the view draws a line: an edge it does not show is not
    // offered through a face.
    expect(
      hitEdge(
        edges,
        middle,
        1,
        drawnLines(sheet, [{ view: front, projection }], 'mm')
      )?.edge
    ).toBe(top);
    expect(hitEdge(edges, middle, 1, new Map([[frontId, []]]))).toBeNull();
    const whole = applyAnnotationPick(
      startAnnotationTool('horizontal'),
      hitEdge(edges, middle, 1),
      middle,
      front,
      bodies
    );
    expect(whole.ok && whole.tool.points.map((point) => point.anchor)).toEqual([
      'first',
      'second'
    ]);
    // Near the right end: that end alone, which page order calls `second`.
    const rightEnd: [number, number] = a[0] > b[0] ? a : b;
    const one = applyAnnotationPick(
      startAnnotationTool('horizontal'),
      hitEdge(edges, rightEnd, 1),
      rightEnd,
      front,
      bodies
    );
    expect(one.ok && one.tool.points.map((point) => point.anchor)).toEqual([
      'second'
    ]);
    // A straight edge is no radius; empty paper is no edge.
    expect(
      applyAnnotationPick(
        startAnnotationTool('radius'),
        topPick,
        middle,
        front,
        bodies
      )
    ).toMatchObject({ ok: false });
    expect(
      applyAnnotationPick(
        startAnnotationTool('angle'),
        null,
        middle,
        front,
        bodies
      )
    ).toMatchObject({ ok: false });
    // A finished pick drafts the dimension; re-picking keeps its placement.
    const draft = draftAnnotation(
      whole.ok ? whole.tool : startAnnotationTool('horizontal'),
      id('w'),
      { x: 0, y: 12 }
    ) as DrawingLinearDimension;
    expect(draft).toMatchObject({
      kind: 'linear',
      direction: 'horizontal',
      viewId: frontId
    });
    const repaired = repairedAnnotation(
      { ...draft, placementMm: { x: 3, y: 4 }, decimals: 1 },
      whole.ok
        ? { ...whole.tool, repairId: id('w') }
        : startAnnotationTool('horizontal')
    );
    expect(repaired).toMatchObject({
      placementMm: { x: 3, y: 4 },
      decimals: 1
    });
  });

  it('offers an occluded edge only where the view draws it, not where it crosses a drawn line', () => {
    const front = view(frontId, 'front', ['body_a' as BodyId]);
    const edge = (hash: number) => ({
      topologyId: `e${hash}`,
      hash,
      points: []
    });
    // A visible horizontal edge, and a hidden vertical one crossing it
    // nearer the viewer's side of the click.
    const visible = {
      view: front,
      bodyId: 'body_a' as BodyId,
      edge: edge(1),
      page: [
        [0, 0],
        [20, 0]
      ] as [number, number][],
      depths: [5, 5],
      coincidenceMm: 0.05
    };
    const hidden = {
      view: front,
      bodyId: 'body_a' as BodyId,
      edge: edge(2),
      page: [
        [10, -5],
        [10, 5]
      ] as [number, number][],
      depths: [1, 1],
      coincidenceMm: 0.05
    };
    const click: [number, number] = [10, 0.1];
    const drawn = new Map([[frontId, [visible.page]]]);
    // Without the drawn lines, the nearer hidden edge would win.
    expect(hitEdge([visible, hidden], click, 1)?.edge.hash).toBe(2);
    expect(hitEdge([visible, hidden], click, 1, drawn)?.edge.hash).toBe(1);
    // Drawn, the vertical edge is offered again.
    const both = new Map([[frontId, [visible.page, hidden.page]]]);
    expect(hitEdge([visible, hidden], [10, 2], 1, both)?.edge.hash).toBe(2);
  });

  it("breaks a tie by depth at the click, not by the edge's nearest end", () => {
    const front = view(frontId, 'front', ['body_a' as BodyId]);
    const edge = (hash: number) => ({
      topologyId: `e${hash}`,
      hash,
      points: []
    });
    // Two edges drawn on one line. The sloped one comes very near the
    // viewer at its far end, but is behind the level one where clicked.
    const level = {
      view: front,
      bodyId: 'body_a' as BodyId,
      edge: edge(1),
      page: [
        [0, 0],
        [20, 0]
      ] as [number, number][],
      depths: [5, 5],
      coincidenceMm: 0.05
    };
    const sloped = {
      ...level,
      edge: edge(2),
      depths: [10, 0]
    };
    expect(hitEdge([level, sloped], [2, 0], 1)?.edge.hash).toBe(1);
    expect(hitEdge([sloped, level], [2, 0], 1)?.edge.hash).toBe(1);
    // Near its close end, the sloped edge is in front.
    expect(hitEdge([level, sloped], [18, 0], 1)?.edge.hash).toBe(2);
  });

  it('picks and points at a curved edge drawn from the canonical tessellation after a held-deflection edit', async () => {
    // The view projects from the canonical drawing tessellation; the edge
    // identity comes from the display topology, whose rims keep an earlier
    // deflection through a small edit. At 10:1 they disagree by more than
    // a fixed 0.05 mm on paper.
    let document = setParameter(
      createProjectDocument('Disc', toUserId('test')),
      {
        name: 'r',
        expression: '20'
      }
    );
    document = addPrimitiveFeature(document, {
      name: 'Disc',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'r', height: 12 }
    });
    await adapter.syncDocument(document);
    document = setParameter(document, { name: 'r', expression: '21' });
    const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
    const bodyId = document.bodyOrder[0]!;
    const canonical = (await adapter.drawingTessellation(document, [bodyId]))[
      bodyId
    ]!;
    const top = view(topId, 'top', [bodyId]);
    const projection = projectView({
      orientation: 'top',
      hiddenLines: false,
      bodies: [canonical]
    });
    const rim = bodies[bodyId]!.topology!.edges.find(
      (edge) =>
        edge.displayRole !== 'seam' &&
        edge.curve?.circle &&
        near(edge.curve.circle.center.z, bodies[bodyId]!.bbox.max.z)
    )!;
    const sheet: DrawingSheet = {
      ...sheetOf([bodyId]),
      scale: { numerator: 10, denominator: 1 }
    };
    const edges = pickableEdges(
      sheet,
      [{ view: top, projection }],
      bodies,
      'mm'
    );
    const pick = edges.find((entry) => entry.edge === rim)!;
    const at = pick.page[Math.floor(pick.page.length / 3)]!;
    const drawn = drawnLines(sheet, [{ view: top, projection }], 'mm');
    expect(hitEdge(edges, at, 1, drawn)?.edge).toBe(rim);
    const noted = sheetOf(
      [bodyId],
      [
        {
          annotationId: id('n'),
          kind: 'note',
          text: 'RIM',
          viewId: topId,
          leader: refOf(bodyId, rim),
          placementMm: { x: 40, y: 40 }
        }
      ]
    );
    const tenToOne = { ...noted, scale: { numerator: 10, denominator: 1 } };
    expect(
      markHiddenLeaders(
        tenToOne,
        resolveSheetAnnotations(tenToOne, bodies, 'mm'),
        [{ view: { ...top, viewId: topId }, projection }],
        'mm',
        bodies
      ).get(id('n'))
    ).toMatchObject({ ok: true });
  });

  it('never takes a curved-face silhouette for a drawn edge', async () => {
    // A cylinder seen from the side: its sides are silhouettes, its rims
    // edges. edgeRuns keeps the edges and leaves the silhouettes out.
    const document = cylinderDocument();
    const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
    const bodyId = document.bodyOrder[0]!;
    const side = projectView({
      orientation: 'front',
      hiddenLines: true,
      bodies: [projectionBodyInput(bodies[bodyId]!)!]
    });
    expect(side.edgeRuns!.visible.length).toBeGreaterThan(0);
    expect(side.edgeRuns!.visible.length).toBeLessThan(side.visible.length);
    expect(
      side.edgeRuns!.visible.every((run) => side.visible.includes(run))
    ).toBe(true);
    // A box's top edge, drawn in a view only as a silhouette run (no edge
    // run): not offered to a pick, and not a leader target.
    const box = await boxModel();
    const front = view(frontId, 'front', [box.bodyId]);
    const real = projectView({
      orientation: 'front',
      hiddenLines: false,
      bodies: [projectionBodyInput(box.bodies[box.bodyId]!)!]
    });
    const silhouetteOnly = {
      ...real,
      edgeRuns: { visible: [] as Float64Array[], hidden: [] as Float64Array[] }
    };
    const sheet = sheetOf([box.bodyId]);
    const edges = pickableEdges(
      sheet,
      [{ view: front, projection: silhouetteOnly }],
      box.bodies,
      'mm'
    );
    const topPick = edges.find((entry) => entry.edge === box.top)!;
    const middle = topPick.page[Math.floor(topPick.page.length / 2)]!;
    const [a, b] = [topPick.page[0]!, topPick.page.at(-1)!];
    const centre: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    expect(middle).toBeDefined();
    expect(
      hitEdge(
        edges,
        centre,
        1,
        drawnLines(sheet, [{ view: front, projection: silhouetteOnly }], 'mm')
      )
    ).toBeNull();
    const noted = sheetOf(
      [box.bodyId],
      [
        {
          annotationId: id('n'),
          kind: 'note',
          text: 'TOP',
          viewId: frontId,
          leader: refOf(box.bodyId, box.top),
          placementMm: { x: -30, y: 20 }
        }
      ]
    );
    expect(
      markHiddenLeaders(
        noted,
        resolveSheetAnnotations(noted, box.bodies, 'mm'),
        [{ view: front, projection: silhouetteOnly }],
        'mm',
        box.bodies
      ).get(id('n'))
    ).toMatchObject({ ok: false, reason: 'leader-hidden' });
  });

  it('stores a pick hash-only when its reference would not fit a document', async () => {
    const { bodies, bodyId, top } = await boxModel();
    const long = {
      ...top,
      reference: {
        ...top.reference!,
        lineageName: 'boolean.edge.a.'.repeat(400) + top.reference!.lineageName
      }
    };
    const withLong: AnnotationBodies = {
      [bodyId]: {
        ...bodies[bodyId]!,
        topology: {
          ...bodies[bodyId]!.topology!,
          edges: bodies[bodyId]!.topology!.edges.map((edge) =>
            edge === top ? long : edge
          )
        }
      }
    };
    expect(edgeRefFor(withLong, bodyId, long)).toEqual({
      bodyId,
      hash: top.hash
    });
    // An ordinary one keeps its reference.
    expect(edgeRefFor(bodies, bodyId, top)?.reference).toEqual(top.reference);
  });

  it('offers only the edge a drawn run belongs to, not a hidden neighbour beside it', () => {
    const front = view(frontId, 'front', ['body_a' as BodyId]);
    const edge = (hash: number) => ({
      topologyId: `e${hash}`,
      hash,
      points: []
    });
    const entry = (hash: number, y: number, depth: number) => ({
      view: front,
      bodyId: 'body_a' as BodyId,
      edge: edge(hash),
      page: [
        [0, y],
        [20, y]
      ] as [number, number][],
      depths: [depth, depth],
      coincidenceMm: 0.05
    });
    // A drawn edge, and a hidden one 0.03 mm beside it (inside the
    // coincidence tolerance) that the view does not draw.
    const drawnEdge = entry(1, 0, 1);
    const hiddenEdge = entry(2, 0.03, 5);
    const drawn = new Map([[frontId, [drawnEdge.page]]]);
    // A click nearer the hidden edge's position still gets the drawn one.
    expect(
      hitEdge([drawnEdge, hiddenEdge], [10, 0.04], 1, drawn)?.edge.hash
    ).toBe(1);
  });

  it('lists every projection buffer once for transfer and accounting', async () => {
    const document = cylinderDocument();
    const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
    const projection = projectView({
      orientation: 'front',
      hiddenLines: true,
      bodies: [projectionBodyInput(bodies[document.bodyOrder[0]!]!)!]
    });
    const buffers = projectionBuffers(projection);
    expect(new Set(buffers).size).toBe(buffers.length);
    for (const line of [
      ...projection.visible,
      ...projection.hidden,
      ...projection.edgeRuns!.visible,
      ...projection.edgeRuns!.hidden
    ])
      expect(buffers).toContain(line.buffer);
  });

  it('refuses an edge that shares its identity with another', async () => {
    const { bodies, bodyId, top } = await boxModel();
    expect(edgeRefFor(bodies, bodyId, top)).not.toBeNull();
    const twin: AnnotationBodies = {
      [bodyId]: {
        ...bodies[bodyId]!,
        topology: {
          ...bodies[bodyId]!.topology!,
          edges: [
            ...bodies[bodyId]!.topology!.edges,
            { ...top, topologyId: 'twin' }
          ]
        }
      }
    };
    expect(edgeRefFor(twin, bodyId, top)).toBeNull();
  });

  it('places a free note on empty paper and a leader note on an edge', async () => {
    const { bodies, bodyId, top } = await boxModel();
    const front = view(frontId, 'front', [bodyId]);
    const free = applyAnnotationPick(
      startAnnotationTool('note'),
      null,
      [30, 40],
      null,
      bodies
    );
    expect(
      free.ok && draftAnnotation(free.tool, id('n'), { x: 30, y: 40 })
    ).toEqual({
      annotationId: id('n'),
      kind: 'note',
      text: 'NOTE',
      placementMm: { x: 30, y: 40 }
    });
    const projection = projectView({
      orientation: 'front',
      hiddenLines: false,
      bodies: [projectionBodyInput(bodies[bodyId]!)!]
    });
    const edges = pickableEdges(
      sheetOf([bodyId]),
      [{ view: front, projection }],
      bodies,
      'mm'
    );
    const hit = edges.find((entry) => entry.edge === top)!;
    const leader = applyAnnotationPick(
      startAnnotationTool('note'),
      hit,
      hit.page[0]!,
      front,
      bodies
    );
    expect(
      leader.ok && draftAnnotation(leader.tool, id('n'), { x: -20, y: 0 })
    ).toMatchObject({
      kind: 'note',
      viewId: frontId,
      leader: { bodyId, hash: top.hash }
    });
  });
});

describe('D02 page and export', () => {
  async function dimensioned() {
    const { document, bodies, bodyId, top, right } = await boxModel(20);
    const t = refOf(bodyId, top);
    const r = refOf(bodyId, right);
    const sheet = sheetOf(
      [bodyId],
      [
        linear(id('h'), 'horizontal', t, 'first', t, 'second'),
        {
          ...linear(id('v'), 'vertical', r, 'first', r, 'second'),
          placementMm: { x: 25, y: 0 }
        },
        {
          annotationId: id('n'),
          kind: 'note',
          text: 'BREAK EDGES',
          viewId: frontId,
          leader: t,
          placementMm: { x: -40, y: 20 }
        }
      ]
    );
    return { document, bodies, sheet };
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

  it('lays out a horizontal dimension: extension lines, two arrows, centred text', async () => {
    const { bodies, sheet } = await dimensioned();
    const views = drawnViews(sheet, bodies);
    const resolutions = resolveSheetAnnotations(sheet, bodies, 'mm');
    const layer = composeSheetAnnotations(sheet, views, resolutions, 'mm');
    expect(layer.boxes.size).toBe(3);
    const horizontal = resolutions.get(id('h'))!;
    if (!horizontal.ok) throw new Error(horizontal.message);
    const layout = layoutAnnotation(
      horizontal.resolved,
      (u, v) => [u, v],
      1,
      [10, 30]
    );
    // Two extension lines, the dimension line and two filled arrowheads.
    expect(layout.strokes.filter((stroke) => stroke.filled)).toHaveLength(2);
    expect(layout.strokes.filter((stroke) => !stroke.filled)).toHaveLength(3);
    expect(layout.texts).toEqual([
      expect.objectContaining({ text: '20', align: 'middle', y: 31 })
    ]);
  });

  it('ends a leader on the part of its edge the view draws', () => {
    const note = {
      kind: 'note' as const,
      label: 'HIDDEN END',
      leader: [0, 0, 20, 0]
    };
    const identity = (u: number, v: number): [number, number] => [u, v];
    const tipOf = (pieces?: number[][]) => {
      const layout = layoutAnnotation(
        pieces ? { ...note, leaderPieces: pieces } : note,
        identity,
        1,
        [16, 10]
      );
      const arrow = layout.strokes.find((stroke) => stroke.filled);
      return arrow ? arrow.points[0]! : null;
    };
    // The whole edge: the tip lands under the note.
    expect(tipOf()).toBeGreaterThan(10);
    // Only its left quarter is drawn: the tip stays on it.
    expect(tipOf([[0, 0, 5, 0]])).toBeLessThanOrEqual(5 + 1e-9);
    // Placed right next to the edge, or on it: still an arrow onto it.
    for (const anchor of [
      [8, 2],
      [8, 0]
    ] as [number, number][]) {
      const close = layoutAnnotation(note, identity, 1, anchor);
      const head = close.strokes.find((stroke) => stroke.filled);
      expect(head).toBeDefined();
      expect(head!.points[1]).toBeCloseTo(0, 9);
    }
    // None of it is drawn: no arrow into blank paper.
    expect(tipOf([])).toBeNull();
  });

  it('breaks a note whose leader edge its view no longer draws at all', async () => {
    const { bodies, bodyId, top } = await boxModel();
    const sheet = sheetOf(
      [bodyId],
      [
        {
          annotationId: id('n'),
          kind: 'note',
          text: 'SEE EDGE',
          viewId: frontId,
          leader: refOf(bodyId, top),
          placementMm: { x: -30, y: 20 }
        }
      ]
    );
    const front = sheet.views[0]!;
    const projection = projectView({
      orientation: 'front',
      hiddenLines: false,
      bodies: [projectionBodyInput(bodies[bodyId]!)!]
    });
    const resolved = resolveSheetAnnotations(sheet, bodies, 'mm');
    // Drawn: the leader stands.
    expect(
      markHiddenLeaders(
        sheet,
        resolved,
        [{ view: front, projection }],
        'mm',
        bodies
      ).get(id('n'))
    ).toMatchObject({ ok: true });
    // The view draws nothing of that edge (say it is occluded after an
    // Update): broken, so export refuses rather than drop the leader.
    const far = Float64Array.from([-500, -500, -499, -500]);
    const elsewhere = {
      ...projection,
      visible: [far],
      edgeRuns: { visible: [far], hidden: [] }
    };
    expect(
      markHiddenLeaders(
        sheet,
        resolved,
        [{ view: front, projection: elsewhere }],
        'mm',
        bodies
      ).get(id('n'))
    ).toMatchObject({ ok: false, reason: 'leader-hidden' });
    // The back top edge lies on the same drawn line as the front one, but
    // behind it: that line is the front edge's, so a leader to the back
    // edge, with hidden lines off, points at nothing the view draws of it.
    const { min, max } = bodies[bodyId]!.bbox;
    const backTop = edgeWhere(
      bodies[bodyId]!,
      (a, b) =>
        near(a[1]!, max.y) &&
        near(b[1]!, max.y) &&
        near(a[2]!, max.z) &&
        near(b[2]!, max.z)
    );
    expect(min.y).toBeLessThan(max.y);
    const behind = sheetOf(
      [bodyId],
      [
        {
          annotationId: id('b'),
          kind: 'note',
          text: 'BACK EDGE',
          viewId: frontId,
          leader: refOf(bodyId, backTop),
          placementMm: { x: -30, y: 20 }
        }
      ]
    );
    expect(
      markHiddenLeaders(
        behind,
        resolveSheetAnnotations(behind, bodies, 'mm'),
        [{ view: front, projection }],
        'mm',
        bodies
      ).get(id('b'))
    ).toMatchObject({ ok: false, reason: 'leader-hidden' });
    // The placement preview follows the same rule: no arrow to the hidden
    // back edge, an arrow to the front one.
    const arrowsIn = (leader: DrawingEdgeRef) =>
      previewAnnotationLayer(
        sheetOf([bodyId]),
        {
          annotationId: id('p'),
          kind: 'note',
          text: 'PREVIEW',
          viewId: frontId,
          leader,
          placementMm: { x: -30, y: 20 }
        },
        [{ view: front, projection }],
        bodies,
        'mm'
      ).strokes.filter((stroke) => stroke.filled).length;
    expect(arrowsIn(refOf(bodyId, backTop))).toBe(0);
    expect(arrowsIn(refOf(bodyId, top))).toBe(1);
    // A view not drawn yet is left alone.
    expect(
      markHiddenLeaders(sheet, resolved, [], 'mm', bodies).get(id('n'))
    ).toMatchObject({ ok: true });
  });

  it('keeps a leader on its own run beside a nearer, separately drawn edge', async () => {
    const { bodies, bodyId, top } = await boxModel();
    const front = view(frontId, 'front', [bodyId]);
    const body = bodies[bodyId]!;
    // Another edge just above the top edge in the view (inside the
    // coincidence tolerance, but not on it) and nearer the viewer.
    const offset = 0.02;
    const shifted = top.points.map((value, index) =>
      index % 3 === 2 ? value + offset : index % 3 === 1 ? value - 1 : value
    );
    const beside = {
      ...top,
      topologyId: 'beside',
      hash: 4242,
      reference: undefined,
      points: shifted
    };
    const withBeside: AnnotationBodies = {
      [bodyId]: {
        ...body,
        topology: {
          ...body.topology!,
          edges: [...body.topology!.edges, beside]
        }
      }
    };
    const projection = projectView({
      orientation: 'front',
      hiddenLines: false,
      bodies: [projectionBodyInput(body)!]
    });
    const besideRun = Float64Array.from(
      [0, shifted.length - 3].flatMap((i) => {
        const p = projectToView(DRAWING_VIEW_FRAMES.front, {
          x: shifted[i]!,
          y: shifted[i + 1]!,
          z: shifted[i + 2]!
        });
        return [p.u, p.v];
      })
    );
    const drawn = {
      ...projection,
      edgeRuns: {
        visible: [...projection.edgeRuns!.visible, besideRun],
        hidden: []
      }
    };
    const sheet = sheetOf(
      [bodyId],
      [
        {
          annotationId: id('n'),
          kind: 'note',
          text: 'TOP',
          viewId: frontId,
          leader: refOf(bodyId, top),
          placementMm: { x: -30, y: 20 }
        }
      ]
    );
    expect(
      markHiddenLeaders(
        sheet,
        resolveSheetAnnotations(sheet, withBeside, 'mm'),
        [{ view: front, projection: drawn }],
        'mm',
        withBeside
      ).get(id('n'))
    ).toMatchObject({ ok: true });
  });

  it('lands radial arrowheads on a partial arc, not on its full circle', () => {
    // A quarter arc of radius 10 about the origin, from +x to +y.
    const arc: number[] = [];
    for (let i = 0; i <= 16; i += 1) {
      const angle = (Math.PI / 2) * (i / 16);
      arc.push(10 * Math.cos(angle), 10 * Math.sin(angle));
    }
    const identity = (u: number, v: number): [number, number] => [u, v];
    const tips = (
      kind: 'radius' | 'diameter',
      anchor: [number, number],
      withArc = true
    ) =>
      layoutAnnotation(
        {
          kind,
          center: [0, 0],
          radius: 10,
          value: 10,
          label: 'R10',
          ...(withArc ? { arc } : {})
        },
        identity,
        1,
        anchor
      )
        .strokes.filter((stroke) => stroke.filled)
        .map((stroke) => [stroke.points[0]!, stroke.points[1]!]);
    const onQuarter = ([x, y]: number[]) =>
      x! >= -1e-6 && y! >= -1e-6 && Math.abs(Math.hypot(x!, y!) - 10) < 1e-6;
    // Placed within the sweep: the tip is where the placement points.
    const inside = tips('radius', [20, 20]);
    expect(inside).toHaveLength(1);
    expect(inside[0]![0]).toBeCloseTo(10 / Math.SQRT2, 9);
    // Placed beyond it (down-left): the tip turns to the arc, never the
    // blank half of the circle.
    for (const anchor of [
      [-20, -5],
      [5, -20],
      [-20, 3]
    ] as [number, number][])
      expect(tips('radius', anchor).every(onQuarter)).toBe(true);
    // A quarter never reaches round to the diameter's far side: one tip.
    expect(tips('diameter', [20, 20])).toHaveLength(1);
    // A whole circle keeps both.
    expect(tips('diameter', [20, 20], false)).toHaveLength(2);
  });

  it('exports dimensions and notes in SVG and PDF, byte-stable across a reload', async () => {
    const { document, bodies, sheet } = await dimensioned();
    const context = { projectName: document.name, units: document.units };
    const views = drawnViews(sheet, bodies);
    const layer = composeSheetAnnotations(
      sheet,
      views,
      resolveSheetAnnotations(sheet, bodies, 'mm'),
      'mm'
    );
    const page = composeSheetPage(sheet, views, context, layer);
    const svg = sheetPageToSvg(page, sheet.name);
    expect(svg).toContain(
      '<g class="dimension" fill="none" stroke="#000000" stroke-width="0.25"'
    );
    expect(svg).toMatch(
      /<polygon points="[^"]+" fill="#000000" stroke="none"\/>/
    );
    expect(svg).toMatch(/>20<\/text>/);
    // The vertical dimension reads up the page, turned a quarter.
    expect(svg).toMatch(/transform="rotate\(-90 [^"]+\)">6<\/text>/);
    expect(svg).toContain('>BREAK EDGES</text>');
    const pdf = new TextDecoder('latin1').decode(
      sheetPageToPdf(page, sheet.name)
    );
    expect(pdf).toContain('(20) Tj');
    expect(pdf).toMatch(/0 1 -1 0 [\d.]+ [\d.]+ Tm \(6\) Tj/);
    expect(pdf).toContain(' h f');

    // Reload through JSON and normalize: the same bytes.
    const saved = new CommandManager(document).execute(
      commandFactories.addDrawingSheet({ sheet })
    );
    const reloaded = normalizeDocument(
      JSON.parse(JSON.stringify(saved)) as ProjectDocument
    );
    const again = reloaded.drawings!.sheets[0]!;
    const bodiesAgain = (await adapter.syncDocument(reloaded))
      .bodyRepresentations;
    const viewsAgain = drawnViews(again, bodiesAgain);
    const pageAgain = composeSheetPage(
      again,
      viewsAgain,
      context,
      composeSheetAnnotations(
        again,
        viewsAgain,
        resolveSheetAnnotations(again, bodiesAgain, 'mm'),
        'mm'
      )
    );
    expect(sheetPageToSvg(pageAgain, again.name)).toBe(svg);
    expect(
      new TextDecoder('latin1').decode(sheetPageToPdf(pageAgain, again.name))
    ).toBe(pdf);
  });

  it('leaves a sheet without annotations byte-identical to D01', async () => {
    const { document, bodies } = await dimensioned();
    const plain = sheetOf(document.bodyOrder);
    const views = drawnViews(plain, bodies);
    const context = { projectName: document.name, units: document.units };
    const without = composeSheetPage(plain, views, context);
    const withEmpty = composeSheetPage(
      plain,
      views,
      context,
      composeSheetAnnotations(plain, views, new Map(), 'mm')
    );
    expect(sheetPageToSvg(withEmpty, plain.name)).toBe(
      sheetPageToSvg(without, plain.name)
    );
    expect(sheetPageToSvg(without, plain.name)).not.toContain(
      'class="dimension"'
    );
  });
});
