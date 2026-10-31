import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCadDocumentDigest,
  parseCadPatchProposal,
  type CadDigestDrawing,
  type CadDigestDrawingEdge
} from '@openzcad/ai-contracts';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  replayCommands
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingViewId,
  type ProjectDocument
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import { resolveSheetAnnotations } from '../apps/web/src/lib/drawing/annotations';
import {
  drawingAssistantDigest,
  type DrawingAssistantSource
} from '../apps/web/src/lib/drawing/assistantContext';
import { preflightDrawingPatch } from '../apps/web/src/lib/drawing/assistantPreflight';

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_one' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;

/** A 20 wide, 10 tall box on a one-view sheet, drawn as Draw would draw it. */
async function drawnPlate() {
  let document = addPrimitiveFeature(
    createProjectDocument('Plate', toUserId('test')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 6, depth: 10 }
    }
  );
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  const bodyId = document.bodyOrder[0]!;
  const sheet: DrawingSheet = {
    sheetId,
    name: 'Sheet 1',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 2, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views: [
      {
        viewId: frontId,
        orientation: 'front',
        bodyIds: [bodyId],
        centerMm: { x: 120, y: 150 },
        hiddenLines: false
      }
    ]
  };
  const base = document;
  const manager = new CommandManager(document);
  manager.execute(commandFactories.addDrawingSheet({ sheet }));
  document = manager.document;
  const projection = projectView({
    orientation: 'front',
    hiddenLines: false,
    bodies: [projectionBodyInput(bodies[bodyId]!)!]
  });
  const views = [{ view: sheet.views[0]!, projection }];
  const source = (doc: ProjectDocument): DrawingAssistantSource => ({
    sheetId,
    ready: true,
    bodies,
    units: doc.units,
    digest: () =>
      drawingAssistantDigest({
        sheet: doc.drawings!.sheets[0]!,
        views,
        bodies,
        units: doc.units,
        ready: true
      })
  });
  return { base, document, manager, bodies, bodyId, source };
}

// An edge running into the view draws as a point: neither level nor plumb.
const level = (edge: CadDigestDrawingEdge) =>
  edge.curve === 'line' &&
  edge.ends![0][1] === edge.ends![1][1] &&
  edge.ends![0][0] !== edge.ends![1][0];
const plumb = (edge: CadDigestDrawingEdge) =>
  edge.curve === 'line' &&
  edge.ends![0][0] === edge.ends![1][0] &&
  edge.ends![0][1] !== edge.ends![1][1];

/** The top edge and the right edge of the front view, by digest geometry. */
function topAndRight(drawing: CadDigestDrawing) {
  const edges = drawing.views[0]!.edges;
  const top = edges
    .filter(level)
    .reduce((best, edge) =>
      edge.ends![0][1] > best.ends![0][1] ? edge : best
    );
  const right = edges
    .filter(plumb)
    .reduce((best, edge) =>
      edge.ends![0][0] > best.ends![0][0] ? edge : best
    );
  return { top, right };
}

function linear(
  ref: string,
  direction: 'horizontal' | 'vertical',
  placementMm: { x: number; y: number }
) {
  return {
    annotationKind: 'linear',
    viewId: frontId,
    direction,
    from: { edgeRef: ref, anchor: 'first' },
    to: { edgeRef: ref, anchor: 'second' },
    edgeRefs: [],
    text: null,
    placementMm,
    decimals: null
  };
}

function proposalOf(...annotations: unknown[]) {
  return {
    proposalId: 'p1',
    summary: 'Dimension the plate',
    assumptions: [],
    preserveGeometry: false,
    operations: [{ kind: 'add_drawing_annotations', sheetId, annotations }]
  };
}

describe('assistant drawing operations (D06 slice E)', () => {
  it('lists each drawn edge once, in paper mm from the view centre', async () => {
    const { document, source } = await drawnPlate();
    const drawing = source(document).digest();
    const view = drawing.views[0]!;
    expect(drawing).toMatchObject({ sheetId, ready: true, scale: '2:1' });
    expect(view).toMatchObject({
      widthMm: 40,
      heightMm: 20,
      edgeInventoryComplete: true
    });
    // A box's 12 edges, under refs that do not change between reads.
    expect(view.edges.map((edge) => edge.ref)).toEqual(
      Array.from({ length: 12 }, (_, index) => `v1:e${index + 1}`)
    );
    expect(source(document).digest()).toEqual(drawing);
    const { top, right } = topAndRight(drawing);
    expect(top.ends).toEqual([
      [-20, 10],
      [20, 10]
    ]);
    expect(right.ends).toEqual([
      [20, -10],
      [20, 10]
    ]);
  });

  it('proposes two dimensions, checks them, and applies them as one undo step', async () => {
    const { base, document, manager, bodies, source } = await drawnPlate();
    const sheetSource = source(document);
    const drawing = sheetSource.digest();
    const { top, right } = topAndRight(drawing);
    const digest = {
      ...createCadDocumentDigest(document, {
        featureIds: [],
        bodyIds: [],
        topologies: []
      }),
      drawing
    };
    const proposal = parseCadPatchProposal(
      proposalOf(
        linear(top.ref, 'horizontal', { x: 0, y: 14 }),
        linear(right.ref, 'vertical', { x: 28, y: 0 })
      ),
      digest
    );

    const { commands, sheet } = preflightDrawingPatch(
      document,
      proposal,
      sheetSource
    );
    const values = [
      ...resolveSheetAnnotations(sheet, bodies, document.units).values()
    ].map((resolution) => resolution.ok && resolution.resolved.label);
    expect(values).toEqual(['20', '10']);
    // The stored references are the ones a pick of the same edge makes.
    expect(
      sheet.annotations!.every(
        (annotation) =>
          annotation.kind === 'linear' &&
          'edge' in annotation.from &&
          annotation.from.edge.reference?.currentHash ===
            annotation.from.edge.hash
      )
    ).toBe(true);

    manager.runTransaction('Apply AI annotations', commands);
    const applied = manager.document;
    expect(applied.drawings!.sheets[0]!.annotations).toHaveLength(2);
    expect(manager.undoIsDrawingOnly).toBe(true);
    manager.undo();
    expect('annotations' in manager.document.drawings!.sheets[0]!).toBe(false);
    manager.redo();
    expect(manager.document.drawings).toEqual(applied.drawings);
    expect(replayCommands(base, applied.commandLog).drawings).toEqual(
      applied.drawings
    );

    // The next turn reads the dimensions back with their values and refs.
    const next = source(applied).digest();
    expect(next.annotations).toEqual([
      expect.objectContaining({
        kind: 'linear',
        edgeRefs: [top.ref, top.ref],
        value: 20,
        label: '20',
        broken: null
      }),
      expect.objectContaining({
        edgeRefs: [right.ref, right.ref],
        value: 10,
        broken: null
      })
    ]);

    // ...and can remove one by id, again as one step.
    const removal = parseCadPatchProposal(
      {
        proposalId: 'p2',
        summary: 'Drop the height',
        assumptions: [],
        operations: [
          {
            kind: 'remove_drawing_annotations',
            sheetId,
            annotationIds: [next.annotations[1]!.annotationId]
          }
        ]
      },
      { ...digest, drawing: next }
    );
    manager.runTransaction(
      'Apply AI annotations',
      commandsForCadPatch(applied, removal)
    );
    expect(manager.document.drawings!.sheets[0]!.annotations).toHaveLength(1);
  });

  it('refuses a proposal whose annotation does not resolve', async () => {
    const { document, source } = await drawnPlate();
    const sheetSource = source(document);
    const drawing = sheetSource.digest();
    const edges = drawing.views[0]!.edges.filter(level);
    // Two parallel edges make no angle: the contract cannot know that,
    // the drawn model does.
    const proposal = parseCadPatchProposal(
      proposalOf({
        annotationKind: 'angle',
        viewId: frontId,
        direction: null,
        from: null,
        to: null,
        edgeRefs: [edges[0]!.ref, edges[1]!.ref],
        text: null,
        placementMm: { x: 0, y: 20 },
        decimals: null
      }),
      {
        ...createCadDocumentDigest(document, {
          featureIds: [],
          bodyIds: [],
          topologies: []
        }),
        drawing
      }
    );
    expect(() =>
      preflightDrawingPatch(document, proposal, sheetSource)
    ).toThrow(/does not pass the drawing check/);
    expect(() =>
      preflightDrawingPatch(document, proposal, {
        ...sheetSource,
        ready: false
      })
    ).toThrow(/Update it/);
    expect(() => preflightDrawingPatch(document, proposal, null)).toThrow(
      /Open the sheet in Draw/
    );
  });

  it('refuses a proposal that repeats a dimension, and reports what is missing', async () => {
    const { document, source } = await drawnPlate();
    const sheetSource = source(document);
    const drawing = sheetSource.digest();
    // The check reads the plate's sizes; nothing states them yet.
    expect(drawing.audit).toMatchObject({ stated: 0, redundant: [] });
    expect(drawing.audit!.missing.length).toBeGreaterThan(0);
    const edges = drawing.views[0]!.edges.filter(level);
    const { right } = topAndRight(drawing);
    const digest = {
      ...createCadDocumentDigest(document, {
        featureIds: [],
        bodyIds: [],
        topologies: []
      }),
      drawing
    };
    // The top and bottom edges are both 20 long: the width, stated twice.
    const twice = parseCadPatchProposal(
      proposalOf(
        linear(edges[0]!.ref, 'horizontal', { x: 0, y: 14 }),
        linear(edges[1]!.ref, 'horizontal', { x: 0, y: -14 }),
        linear(right.ref, 'vertical', { x: 28, y: 0 })
      ),
      digest
    );
    expect(() => preflightDrawingPatch(document, twice, sheetSource)).toThrow(
      /repeats a value/
    );
    // Width and height alone pass, though the depth is still missing: a
    // front-view request leaves the top view's size out on purpose.
    const once = parseCadPatchProposal(
      proposalOf(
        linear(edges[0]!.ref, 'horizontal', { x: 0, y: 14 }),
        linear(right.ref, 'vertical', { x: 28, y: 0 })
      ),
      digest
    );
    expect(() =>
      preflightDrawingPatch(document, once, sheetSource)
    ).not.toThrow();
  });

  it('refuses an ungrounded edge rather than look it up', async () => {
    const { document } = await drawnPlate();
    const raw = parseCadPatchProposal(
      proposalOf(linear('v1:e1', 'horizontal', { x: 0, y: 14 }))
    );
    expect(() => commandsForCadPatch(document, raw)).toThrow(
      /not checked against the sheet/
    );
  });
});
