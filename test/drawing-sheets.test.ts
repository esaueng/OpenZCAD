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
  drawingSetError,
  projectedViewSide,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  canonicalProjectContentKey,
  geometryContentKey
} from '../apps/web/src/worker/exactRebuildCache';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import {
  composeSheetPage,
  sheetSafeText,
  titleBlockBox,
  viewPageBox
} from '../apps/web/src/lib/drawing/sheetPage';
import {
  sheetPageToPdf,
  sheetPageToSvg
} from '../apps/web/src/lib/drawing/sheetExport';
import {
  createStarterSheet,
  drawingSourceFingerprint,
  projectionBodyInput,
  sheetBodyIds
} from '../apps/web/src/lib/drawing/sheetSources';
import { parseSaveProjectDocumentRequest } from '../apps/web/worker/validation';

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_one' as DrawingSheetId;
const baseId = 'dvw_front' as DrawingViewId;

function boxDocument(width: number | string = 20): ProjectDocument {
  let document = createProjectDocument('Bracket', toUserId('test'));
  document = setParameter(document, { name: 'w', expression: String(width) });
  return addPrimitiveFeature(document, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 'w', height: 10, depth: 6 }
  });
}

function view(
  orientation: DrawingView['orientation'],
  bodyIds: BodyId[],
  extra: Partial<DrawingView> = {}
): DrawingView {
  return {
    viewId: `dvw_${orientation}` as DrawingViewId,
    orientation,
    bodyIds,
    centerMm: { x: 100, y: 100 },
    hiddenLines: true,
    ...extra
  };
}

function sheet(bodyIds: BodyId[], views?: DrawingView[]): DrawingSheet {
  return {
    sheetId,
    name: 'Sheet 1',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views: views ?? [
      view('front', bodyIds, { centerMm: { x: 100, y: 100 } }),
      view('top', bodyIds, {
        centerMm: { x: 300, y: 200 },
        parentViewId: baseId
      }),
      view('right', bodyIds, {
        centerMm: { x: 250, y: 50 },
        parentViewId: baseId
      }),
      view('iso', bodyIds, { centerMm: { x: 300, y: 250 }, hiddenLines: false })
    ]
  };
}

describe('D01 drawing section (schema v30)', () => {
  it('is schema 30, additive, and never added to a document without drawings', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(30);
    const document = boxDocument();
    expect(document.drawings).toBeUndefined();
    const saved = JSON.parse(JSON.stringify(document)) as ProjectDocument;
    // An older document opens exactly as written: no empty section appears.
    const older = { ...saved, schemaVersion: 26 } as unknown as ProjectDocument;
    const opened = normalizeDocument(older);
    expect('drawings' in opened).toBe(false);
    expect(opened.nodes).toEqual(saved.nodes);
  });

  it('round-trips a sheet through save and normalize unchanged', () => {
    const document = boxDocument();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheet(document.bodyOrder) })
    );
    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    expect(normalizeDocument(saved).drawings).toEqual(
      manager.document.drawings
    );
    // Only intent is stored: no projected lines, meshes or page geometry.
    expect(JSON.stringify(saved.drawings)).not.toMatch(
      /visible|hidden"|points|strokes/
    );
  });

  it('refuses malformed sections by name, on load and at the account edge', () => {
    const ids = boxDocument().bodyOrder;
    const cases: [unknown, RegExp][] = [
      [
        {
          sheets: [
            { ...sheet(ids), paper: { size: 'B5', orientation: 'landscape' } }
          ]
        },
        /paper size/
      ],
      [
        {
          sheets: [{ ...sheet(ids), scale: { numerator: 0, denominator: 1 } }]
        },
        /scale/
      ],
      [
        {
          sheets: [{ ...sheet(ids), scale: { numerator: 1.5, denominator: 1 } }]
        },
        /scale/
      ],
      [
        { sheets: [{ ...sheet(ids), titleBlock: { owner: 'x' } }] },
        /title-block/
      ],
      [
        { sheets: [{ ...sheet(ids), titleBlock: { title: 'x'.repeat(121) } }] },
        /title-block/
      ],
      [{ sheets: [sheet(ids), sheet(ids)] }, /twice/],
      [
        {
          sheets: [
            sheet(ids, [
              view('iso', ids),
              view('front', ids, { parentViewId: 'dvw_iso' as DrawingViewId })
            ])
          ]
        },
        /fold/
      ],
      [
        {
          sheets: [
            sheet(ids, [
              view('front', ids),
              view('top', ids, { parentViewId: baseId }),
              view('right', ids, { parentViewId: 'dvw_top' as DrawingViewId })
            ])
          ]
        },
        /fold/
      ],
      [{ sheets: [sheet(ids, [view('front', [])])] }, /bodies/],
      [
        {
          sheets: [
            sheet(ids, [
              view('front', ids, { centerMm: { x: Infinity, y: 0 } })
            ])
          ]
        },
        /placement/
      ]
    ];
    for (const [drawings, message] of cases) {
      expect(drawingSetError(drawings)).toMatch(message);
      const document = { ...boxDocument(), drawings } as ProjectDocument;
      expect(() => normalizeDocument(document)).toThrow(message);
      const wire = JSON.parse(JSON.stringify(document)) as Record<
        string,
        unknown
      >;
      expect(() =>
        parseSaveProjectDocumentRequest(
          { projectId: document.projectId, expectedVersion: 0, document: wire },
          document.projectId
        )
      ).toThrow(/drawings/);
    }
    expect(drawingSetError({ sheets: [sheet(ids)] })).toBeNull();
  });

  it('treats a malformed drawing snapshot in undo history like a malformed section', () => {
    const document = boxDocument();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheet(document.bodyOrder) })
    );
    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    const change = saved
      .editHistory!.entries.at(-1)!
      .changes.find((entry) => entry.field === 'drawings')!;
    // Undo would restore this: a projected view whose base does not exist.
    (change as { before?: unknown }).before = {
      sheets: [
        sheet(document.bodyOrder, [
          view('top', document.bodyOrder, {
            parentViewId: 'dvw_missing' as DrawingViewId
          })
        ])
      ]
    };
    // On load the unreadable history is dropped, the document kept.
    const opened = normalizeDocument(saved);
    expect(opened.editHistory).toBeUndefined();
    expect(opened.drawings).toEqual(manager.document.drawings);
    // The account refuses to store it.
    expect(() =>
      parseSaveProjectDocumentRequest(
        { projectId: saved.projectId, expectedVersion: 0, document: saved },
        saved.projectId
      )
    ).toThrow(/undo history/);
  });

  it('decides drawing-only undo from the recorded changes, not the kind label', () => {
    const document = boxDocument();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheet(document.bodyOrder) })
    );
    expect(manager.undoIsDrawingOnly).toBe(true);
    // A history from disk or a peer labelled "drawing" but changing the model.
    const forged = structuredClone(manager.document.editHistory!);
    forged.entries.at(-1)!.changes.push({
      kind: 'value',
      field: 'name',
      before: 'Bracket',
      after: 'Renamed'
    });
    const tampered = new CommandManager({
      ...manager.document,
      editHistory: forged
    });
    expect(tampered.undoIsDrawingOnly).toBe(false);
    // A model edit is never drawing-only, and undoing a sheet edit is redo's.
    manager.undo();
    expect(manager.redoIsDrawingOnly).toBe(true);
  });

  it('undoes, redoes and replays sheet commands', () => {
    const document = boxDocument();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheet(document.bodyOrder) })
    );
    manager.execute(
      commandFactories.updateDrawingSheet({
        sheetId,
        scale: { numerator: 1, denominator: 2 },
        titleBlock: { title: 'Bracket plate', revision: 'B' }
      })
    );
    const edited = manager.document;
    expect(edited.drawings!.sheets[0]!.scale).toEqual({
      numerator: 1,
      denominator: 2
    });
    expect(edited.drawings!.sheets[0]!.titleBlock).toEqual({
      title: 'Bracket plate',
      revision: 'B'
    });
    manager.undo();
    manager.undo();
    expect(manager.document.drawings).toBeUndefined();
    manager.redo();
    manager.redo();
    expect(manager.document.drawings).toEqual(edited.drawings);
    const replayed = replayCommands(document, edited.commandLog);
    expect(replayed.drawings).toEqual(edited.drawings);
    // Clearing a title-block field returns it to its automatic value.
    manager.execute(
      commandFactories.updateDrawingSheet({
        sheetId,
        titleBlock: { title: '  ' }
      })
    );
    expect(manager.document.drawings!.sheets[0]!.titleBlock).toEqual({
      revision: 'B'
    });
    manager.execute(commandFactories.deleteDrawingSheet({ sheetId }));
    expect('drawings' in manager.document).toBe(false);
  });

  it('keeps projected views aligned with their base', () => {
    const document = boxDocument();
    const ids = document.bodyOrder;
    const manager = new CommandManager(document);
    manager.execute(commandFactories.addDrawingSheet({ sheet: sheet(ids) }));
    const views = () =>
      Object.fromEntries(
        manager.document.drawings!.sheets[0]!.views.map((entry) => [
          entry.orientation,
          entry.centerMm
        ])
      );
    // Stored as given; alignment is applied when views move.
    manager.execute(
      commandFactories.updateDrawingView({
        sheetId,
        viewId: baseId,
        centerMm: { x: 90, y: 80 }
      })
    );
    expect(views().front).toEqual({ x: 90, y: 80 });
    // The base carries its projected views along, snapped to its shared
    // axis: the top view onto the front's x, the right view onto its y.
    expect(views().top).toEqual({ x: 90, y: 180 });
    expect(views().right).toEqual({ x: 240, y: 80 });
    expect(views().iso).toEqual({ x: 300, y: 250 });
    // A projected view moves only along its shared axis.
    manager.execute(
      commandFactories.updateDrawingView({
        sheetId,
        viewId: 'dvw_top' as DrawingViewId,
        centerMm: { x: 10, y: 210 }
      })
    );
    expect(views().top).toEqual({ x: 90, y: 210 });
    manager.execute(
      commandFactories.updateDrawingView({
        sheetId,
        viewId: 'dvw_right' as DrawingViewId,
        centerMm: { x: 260, y: 5 }
      })
    );
    expect(views().right).toEqual({ x: 260, y: 80 });
    // Deleting the base frees its projected views where they stand.
    manager.execute(
      commandFactories.deleteDrawingView({ sheetId, viewId: baseId })
    );
    const left = manager.document.drawings!.sheets[0]!.views;
    expect(left.map((entry) => entry.parentViewId)).toEqual([
      undefined,
      undefined,
      undefined
    ]);
    expect(views().top).toEqual({ x: 90, y: 210 });
  });

  it("keeps every projected view on its projection angle's side of the base", () => {
    // The glass-box sides: third angle shows a view on its camera's side.
    expect(projectedViewSide('front', 'top', 'third')).toBe(1);
    expect(projectedViewSide('front', 'bottom', 'third')).toBe(-1);
    expect(projectedViewSide('front', 'right', 'third')).toBe(1);
    expect(projectedViewSide('front', 'left', 'third')).toBe(-1);
    expect(projectedViewSide('front', 'top', 'first')).toBe(-1);
    expect(projectedViewSide('front', 'left', 'first')).toBe(1);
    expect(projectedViewSide('front', 'back', 'third')).toBe(
      -projectedViewSide('front', 'back', 'first')
    );
    expect(projectedViewSide('front', 'iso', 'third')).toBe(0);

    const document = boxDocument();
    const ids = document.bodyOrder;
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: sheet(ids, [
          view('front', ids, { centerMm: { x: 100, y: 100 } })
        ])
      })
    );
    // Third angle: a bottom view asked for above the front is put below it.
    manager.execute(
      commandFactories.addDrawingView({
        sheetId,
        view: view('bottom', ids, {
          centerMm: { x: 40, y: 160 },
          parentViewId: baseId
        })
      })
    );
    const bottom = () =>
      manager.document.drawings!.sheets[0]!.views.find(
        (entry) => entry.orientation === 'bottom'
      )!.centerMm;
    expect(bottom()).toEqual({ x: 100, y: 40 });
    // A move cannot take it across to the top view's side.
    manager.execute(
      commandFactories.updateDrawingView({
        sheetId,
        viewId: 'dvw_bottom' as DrawingViewId,
        centerMm: { x: 100, y: 150 }
      })
    );
    expect(bottom()).toEqual({ x: 100, y: 100 });
  });

  it('mirrors projected views across their base when the projection angle changes', () => {
    const document = boxDocument();
    const ids = document.bodyOrder;
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: sheet(ids, [
          view('front', ids, { centerMm: { x: 100, y: 100 } }),
          view('top', ids, {
            centerMm: { x: 100, y: 180 },
            parentViewId: baseId
          }),
          view('right', ids, {
            centerMm: { x: 190, y: 100 },
            parentViewId: baseId
          }),
          view('iso', ids, { centerMm: { x: 300, y: 250 } })
        ])
      })
    );
    const centres = () =>
      Object.fromEntries(
        manager.document.drawings!.sheets[0]!.views.map((entry) => [
          entry.orientation,
          entry.centerMm
        ])
      );
    // Third angle (top above, right to the right) to first angle: the same
    // views on the opposite sides of the front, in one edit.
    manager.execute(
      commandFactories.updateDrawingSheet({ sheetId, projectionAngle: 'first' })
    );
    expect(centres()).toEqual({
      front: { x: 100, y: 100 },
      top: { x: 100, y: 20 },
      right: { x: 10, y: 100 },
      iso: { x: 300, y: 250 }
    });
    manager.undo();
    expect(centres().top).toEqual({ x: 100, y: 180 });
    expect(manager.document.drawings!.sheets[0]!.projectionAngle).toBe('third');
  });

  it('lets a view drop, or keep beside a new one, a body the model deleted', () => {
    const document = addPrimitiveFeature(boxDocument(), {
      name: 'Second',
      primitiveKind: 'box',
      dimensions: { width: 5, height: 5, depth: 5 }
    });
    const [first, second] = document.bodyOrder;
    const gone = 'body_gone' as BodyId;
    // Saved while the body existed; the model has since lost it.
    const stale = {
      ...document,
      drawings: {
        sheets: [sheet([first!, gone], [view('front', [first!, gone])])]
      }
    } as ProjectDocument;
    const manager = new CommandManager(stale);
    manager.execute(
      commandFactories.updateDrawingView({
        sheetId,
        viewId: baseId,
        bodyIds: [first!, gone, second!]
      })
    );
    manager.execute(
      commandFactories.updateDrawingView({
        sheetId,
        viewId: baseId,
        bodyIds: [first!, second!]
      })
    );
    expect(manager.document.drawings!.sheets[0]!.views[0]!.bodyIds).toEqual([
      first,
      second
    ]);
    // Adding a body that does not exist is still refused.
    expect(() =>
      manager.execute(
        commandFactories.updateDrawingView({
          sheetId,
          viewId: baseId,
          bodyIds: [first!, gone]
        })
      )
    ).toThrow(/not in this project/);
  });

  it('refuses a view of a body the project does not have', () => {
    const document = boxDocument();
    expect(() =>
      new CommandManager(document).execute(
        commandFactories.addDrawingSheet({
          sheet: sheet(['body_missing' as BodyId])
        })
      )
    ).toThrow(/not in this project/);
  });

  it('keeps drawing edits out of the geometry rebuild key but not the saved-content key', () => {
    const document = boxDocument();
    const drawn = new CommandManager(document).execute(
      commandFactories.addDrawingSheet({ sheet: sheet(document.bodyOrder) })
    );
    expect(geometryContentKey(drawn)).toBe(geometryContentKey(document));
    expect(canonicalProjectContentKey(drawn)).not.toBe(
      canonicalProjectContentKey(document)
    );
  });
});

describe('D01 model fence', () => {
  it('fingerprints the source bodies and changes only when they do', async () => {
    const narrow = boxDocument(20);
    const ids = narrow.bodyOrder;
    const a = (await adapter.syncDocument(narrow)).bodyRepresentations;
    const again = (
      await adapter.syncDocument(
        JSON.parse(JSON.stringify(narrow)) as ProjectDocument
      )
    ).bodyRepresentations;
    const wide = (
      await adapter.syncDocument(
        setParameter(narrow, { name: 'w', expression: '30' })
      )
    ).bodyRepresentations;
    const first = drawingSourceFingerprint(a, ids);
    expect(first).toMatch(/^v1:[0-9a-f]{16}$/);
    expect(drawingSourceFingerprint(again, ids)).toBe(first);
    expect(drawingSourceFingerprint(wide, ids)).not.toBe(first);
    expect(drawingSourceFingerprint(a, ['body_gone' as BodyId])).toBeNull();
    const pending = { [ids[0]!]: { ...a[ids[0]!]!, topology: undefined } };
    expect(drawingSourceFingerprint(pending, ids)).toBeNull();
  });
});

describe('D01 sheet page and export', () => {
  async function starter(
    units: 'mm' | 'inch' = 'mm',
    angle: 'first' | 'third' = 'third'
  ) {
    let document = boxDocument();
    if (units === 'inch') document = { ...document, units: 'inch' };
    const derived = await adapter.syncDocument(document);
    const bodies = derived.bodyRepresentations;
    const ids = document.bodyOrder;
    const created = createStarterSheet({
      name: 'Sheet 1',
      bodyIds: ids,
      bodies,
      units,
      paper: { size: 'A3', orientation: 'landscape' },
      projectionAngle: angle,
      fingerprint: drawingSourceFingerprint(bodies, ids)!
    });
    const projections = created.views.map((entry) => ({
      view: entry,
      projection: projectView({
        orientation: entry.orientation,
        hiddenLines: entry.hiddenLines,
        bodies: entry.bodyIds.map((id) => projectionBodyInput(bodies[id]!)!)
      })
    }));
    return { document, created, projections };
  }

  it('lays out the four-view starter aligned, inside the paper and clear of the title block', async () => {
    const { created, projections } = await starter('mm', 'third');
    expect(created.views.map((entry) => entry.orientation)).toEqual([
      'front',
      'top',
      'right',
      'iso'
    ]);
    const [front, top, right] = created.views;
    expect(top!.centerMm.x).toBeCloseTo(front!.centerMm.x, 9);
    expect(top!.centerMm.y).toBeGreaterThan(front!.centerMm.y);
    expect(right!.centerMm.y).toBeCloseTo(front!.centerMm.y, 9);
    expect(right!.centerMm.x).toBeGreaterThan(front!.centerMm.x);
    // 5:1 is the largest preset at which this 20 × 10 × 6 part's two columns
    // and two rows fit the A3 view area with gaps.
    expect(created.scale).toEqual({ numerator: 5, denominator: 1 });
    expect(drawingSetError({ sheets: [created] })).toBeNull();
    const block = titleBlockBox(created);
    for (const { view: entry, projection } of projections) {
      const box = viewPageBox(entry, projection.bounds!, created, 'mm');
      expect(box.x).toBeGreaterThanOrEqual(10);
      expect(box.y).toBeGreaterThanOrEqual(10);
      expect(box.x + box.width).toBeLessThanOrEqual(410);
      expect(box.y + box.height).toBeLessThanOrEqual(287);
      const overlapsBlock =
        box.x < block.x + block.width &&
        box.x + box.width > block.x &&
        box.y < block.y + block.height &&
        box.y + box.height > block.y;
      expect(overlapsBlock, entry.orientation).toBe(false);
    }
    const first = await starter('mm', 'first');
    const [f, t, l] = first.created.views;
    expect(l!.orientation).toBe('left');
    expect(t!.centerMm.y).toBeLessThan(f!.centerMm.y);
    expect(l!.centerMm.x).toBeGreaterThan(f!.centerMm.x);
  });

  it('maps model spans to paper through one transform: 1:2 halves them, inches scale by 25.4', async () => {
    const { created, projections } = await starter();
    const front = projections[0]!;
    const span = (scale: DrawingSheet['scale'], units: 'mm' | 'inch') =>
      viewPageBox(front.view, front.projection.bounds!, { scale }, units).width;
    expect(span({ numerator: 1, denominator: 1 }, 'mm')).toBeCloseTo(20, 9);
    expect(span({ numerator: 1, denominator: 2 }, 'mm')).toBeCloseTo(10, 9);
    expect(span({ numerator: 1, denominator: 1 }, 'inch')).toBeCloseTo(508, 9);
    // The composed page draws the front view's outline at its centre.
    const page = composeSheetPage(
      { ...created, scale: { numerator: 1, denominator: 1 } },
      [front],
      {
        projectName: 'Bracket',
        units: 'mm'
      }
    );
    const xs = page.strokes
      .filter((stroke) => stroke.kind === 'visible')
      .flatMap((stroke) => stroke.points.filter((_, index) => index % 2 === 0));
    expect(Math.min(...xs)).toBeCloseTo(front.view.centerMm.x - 10, 6);
    expect(Math.max(...xs)).toBeCloseTo(front.view.centerMm.x + 10, 6);
  });

  it('writes a vector PDF and SVG that are byte-stable across a reload', async () => {
    const { document, created: plain } = await starter();
    // Hidden lines on in the isometric too, so the page has dashed runs.
    const created = {
      ...plain,
      views: plain.views.map((entry) => ({ ...entry, hiddenLines: true }))
    };
    const bodiesNow = (await adapter.syncDocument(document))
      .bodyRepresentations;
    const projections = created.views.map((entry) => ({
      view: entry,
      projection: projectView({
        orientation: entry.orientation,
        hiddenLines: entry.hiddenLines,
        bodies: entry.bodyIds.map((id) => projectionBodyInput(bodiesNow[id]!)!)
      })
    }));
    const context = { projectName: document.name, units: document.units };
    const page = composeSheetPage(created, projections, context);
    const pdf = sheetPageToPdf(page, created.name);
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // A3 landscape in points.
    expect(text).toContain('/MediaBox [0 0 1190.551 841.89]');
    expect(text).toContain('/BaseFont /Helvetica');
    // Hidden lines are dashed, and each xref offset points at its object.
    expect(text).toMatch(/\[8\.504 4\.252\] 0 d/);
    const xref = text.slice(text.indexOf('xref\n'));
    const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) =>
      Number(match[1])
    );
    offsets.forEach((offset, index) => {
      expect(text.slice(offset, offset + 12)).toMatch(
        new RegExp(`^${index + 1} 0 obj`)
      );
    });
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    const svg = sheetPageToSvg(page, created.name);
    expect(svg).toContain('width="420mm" height="297mm" viewBox="0 0 420 297"');
    expect(svg).toContain('stroke-dasharray="3 1.5"');
    expect(svg).toContain('>Bracket</text>');

    // Reload: the canonical document through JSON and normalize, the same
    // kernel pin, a fresh projection — the same bytes.
    const drawn = new CommandManager(document).execute(
      commandFactories.addDrawingSheet({ sheet: created })
    );
    const reloaded = normalizeDocument(
      JSON.parse(JSON.stringify(drawn)) as ProjectDocument
    );
    const sheetAgain = reloaded.drawings!.sheets[0]!;
    const bodies = (await adapter.syncDocument(reloaded)).bodyRepresentations;
    const again = sheetAgain.views.map((entry) => ({
      view: entry,
      projection: projectView({
        orientation: entry.orientation,
        hiddenLines: entry.hiddenLines,
        bodies: sheetBodyIds({ views: [entry] }).map((id) =>
          projectionBodyInput(bodies[id]!)!
        )
      })
    }));
    const pageAgain = composeSheetPage(sheetAgain, again, {
      projectName: reloaded.name,
      units: reloaded.units
    });
    expect(sheetPageToPdf(pageAgain, sheetAgain.name)).toEqual(pdf);
    expect(sheetPageToSvg(pageAgain, sheetAgain.name)).toBe(svg);
  });

  it('keeps sheet text inside the PDF font and the title block cells', () => {
    expect(sheetSafeText('Ø12 bore — 30°')).toBe('Ø12 bore ? 30°');
    const page = composeSheetPage(
      {
        ...sheet([]),
        views: [],
        titleBlock: { drawingNumber: 'D-'.repeat(60) }
      },
      [],
      { projectName: 'Bracket (rev) \\ 2', units: 'mm' }
    );
    const number = page.texts.find((text) => text.text.startsWith('D-D-'))!;
    expect(number.text.endsWith('...')).toBe(true);
    const pdf = new TextDecoder('latin1').decode(sheetPageToPdf(page, 'Sheet'));
    expect(pdf).toContain('(Bracket \\(rev\\) \\\\ 2) Tj');
  });
});
