import { PROJECT_DOCUMENT_SCHEMA_VERSION } from '@openzcad/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  normalizeDocument,
  setParameter,
  UnstorableDocumentError
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingPaperMm,
  drawingSetError,
  MAX_PROJECT_NAME_LENGTH,
  projectedViewSide,
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
  fitText,
  fitViewsToSheet,
  sheetSafeText,
  sheetUnprintableCharacters,
  textWidthMm,
  titleBlockBox,
  viewPageBox,
  viewPlacementIssue
} from '../apps/web/src/lib/drawing/sheetPage';
import {
  drawingExportFileName,
  MAX_EXPORT_FILE_NAME_BYTES,
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
import { sharedProjectSnapshotDocument } from '@openzcad/persistence';
import { createProjectDiagnosticBundle } from '../apps/web/src/lib/projectDiagnostics';
import * as webGlimpse from '../apps/web/src/lib/glimpseContract';
import * as workerGlimpse from '../apps/web/worker/glimpseContract';

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
        centerMm: { x: 100, y: 200 },
        parentViewId: baseId
      }),
      view('right', bodyIds, {
        centerMm: { x: 250, y: 100 },
        parentViewId: baseId
      }),
      view('iso', bodyIds, { centerMm: { x: 300, y: 250 }, hiddenLines: false })
    ]
  };
}

describe('D01 drawing section (schema v30)', () => {
  it('is additive, and never added to a document without drawings', () => {
    const document = boxDocument();
    expect(document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
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

  it('refuses malformed sections by name, on load and in the browser before any account write', () => {
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
      // Third angle: a top view below the front, or off its column.
      [
        {
          sheets: [
            sheet(ids, [
              view('front', ids),
              view('top', ids, {
                centerMm: { x: 100, y: 40 },
                parentViewId: baseId
              })
            ])
          ]
        },
        /wrong side|out of line/
      ],
      [
        {
          sheets: [
            sheet(ids, [
              view('front', ids),
              view('top', ids, {
                centerMm: { x: 130, y: 180 },
                parentViewId: baseId
              })
            ])
          ]
        },
        /wrong side|out of line/
      ],
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
      expect(() => assertStorableDocument(wire)).toThrow(
        UnstorableDocumentError
      );
      expect(() => assertStorableDocument(wire)).toThrow(/drawings/);
      expect(() => assertStorableDocument(wire)).toThrow(message);
      // ADR-024 Phase 1: the account stores section contents unread.
      expect(
        parseSaveProjectDocumentRequest(
          { projectId: document.projectId, expectedVersion: 0, document: wire },
          document.projectId
        ).document
      ).toBe(wire);
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

  it('keeps mirrored views on the paper when the projection angle changes', () => {
    const document = boxDocument();
    const ids = document.bodyOrder;
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: sheet(ids, [
          view('front', ids, { centerMm: { x: 100, y: 100 } }),
          view('top', ids, {
            centerMm: { x: 100, y: 280 },
            parentViewId: baseId
          }),
          view('right', ids, {
            centerMm: { x: 400, y: 100 },
            parentViewId: baseId
          })
        ])
      })
    );
    // Mirrored across the front these land at y = −80 and x = −200: off the
    // A3 sheet. They stop at its edge, still on first angle's sides.
    manager.execute(
      commandFactories.updateDrawingSheet({ sheetId, projectionAngle: 'first' })
    );
    const views = manager.document.drawings!.sheets[0]!.views;
    expect(views.map((entry) => entry.centerMm)).toEqual([
      { x: 100, y: 100 },
      { x: 100, y: 0 },
      { x: 0, y: 100 }
    ]);
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

  it('lists every drawing command in both analytics operation allowlists', () => {
    const kinds = [
      'drawing.sheet.add',
      'drawing.sheet.update',
      'drawing.sheet.delete',
      'drawing.view.add',
      'drawing.view.update',
      'drawing.view.delete'
    ];
    for (const contract of [webGlimpse, workerGlimpse])
      expect(contract.EXPANDED.feature_operation).toEqual(
        expect.arrayContaining(kinds)
      );
  });

  it('records no edit when a projected view is nudged along its locked axis', () => {
    const document = boxDocument();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheet(document.bodyOrder) })
    );
    const before = manager.document;
    // The top view shares the front's x: a sideways nudge snaps straight back.
    const after = manager.execute(
      commandFactories.updateDrawingView({
        sheetId,
        viewId: 'dvw_top' as DrawingViewId,
        centerMm: { x: 140, y: 200 }
      })
    );
    expect(after).toBe(before);
    expect(after.version).toBe(before.version);
    expect(manager.undoLabel).toBe(`Add drawing Sheet 1`);
  });

  it('keeps drawing sheets out of share-link snapshots and diagnostic bundles', () => {
    const document = boxDocument();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: {
          ...sheet(document.bodyOrder),
          titleBlock: { author: 'Private Person', drawingNumber: 'DWG-SECRET' }
        }
      })
    );
    manager.execute(commandFactories.deleteDrawingSheet({ sheetId }));
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: {
          ...sheet(document.bodyOrder),
          titleBlock: { date: '2026-10-19' }
        }
      })
    );
    const drawn = manager.document;
    expect('drawings' in sharedProjectSnapshotDocument(drawn)).toBe(false);
    const bundle = createProjectDiagnosticBundle(
      drawn,
      { remusVersion: '0', remusCommit: '0' },
      '2026-10-19T00:00:00.000Z'
    );
    expect('drawings' in bundle.document).toBe(false);
    const text = JSON.stringify(bundle);
    // Even a deleted sheet's title block stays out through its commands.
    expect(text).not.toContain('Private Person');
    expect(text).not.toContain('DWG-SECRET');
    expect(
      bundle.document.commandLog.some((command) =>
        command.kind.startsWith('drawing.')
      )
    ).toBe(false);
  });

  it("leaves the previous document's command log alone, so undo and replay agree", () => {
    const document = boxDocument();
    const manager = new CommandManager(document);
    const before = manager.document;
    const logLength = before.commandLog.length;
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheet(document.bodyOrder) })
    );
    // The command went into the new document's log only.
    expect(before.commandLog).toHaveLength(logLength);
    manager.undo();
    expect(manager.document.commandLog).toHaveLength(logLength);
    expect(
      manager.document.commandLog.some((command) =>
        command.kind.startsWith('drawing.')
      )
    ).toBe(false);
    // A replay of the undone document does not bring the sheet back.
    expect(
      replayCommands(document, manager.document.commandLog).drawings
    ).toBeUndefined();
  });

  it('keeps every view centre on its paper', () => {
    const document = boxDocument();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheet(document.bodyOrder) })
    );
    manager.execute(
      commandFactories.updateDrawingView({
        sheetId,
        viewId: 'dvw_iso' as DrawingViewId,
        centerMm: { x: -500, y: 5000 }
      })
    );
    // A3 landscape is 420 × 297 mm.
    expect(
      manager.document.drawings!.sheets[0]!.views.find(
        (entry) => entry.orientation === 'iso'
      )!.centerMm
    ).toEqual({ x: 0, y: 297 });
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

  it('scales a large model past the presets, and refuses one no sheet holds', async () => {
    const make = async (width: number) => {
      const document = boxDocument(width);
      const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
      const ids = document.bodyOrder;
      return () =>
        createStarterSheet({
          name: 'Sheet 1',
          bodyIds: ids,
          bodies,
          units: 'mm',
          paper: { size: 'A3', orientation: 'landscape' },
          projectionAngle: 'third',
          fingerprint: drawingSourceFingerprint(bodies, ids)!
        });
    };
    // A 30 m part needs more than 1:100 on A3; 1:200 fits it.
    const large = (await make(30000))();
    expect(large.scale).toEqual({ numerator: 1, denominator: 200 });
    const paper = drawingPaperMm(large.paper);
    for (const entry of large.views) {
      expect(entry.centerMm.x).toBeGreaterThan(0);
      expect(entry.centerMm.x).toBeLessThan(paper.width);
    }
    // A kilometre does not fit A3 even at 1:1000.
    expect(await make(1e6)).toThrow(/too large for a sheet/);
  });

  it('measures title-block text with the real Helvetica widths, Latin-1 included', () => {
    // Width at a 10 mm cap height (font size = cap height / 0.718) of
    // `units` thousandths of an em.
    const em = (units: number) => (units * 10) / 0.718 / 1000;
    // Ø is 778/1000 em and Æ 1000 in Helvetica; a flat 556 for every
    // character past ASCII let a title of them run into the next cell.
    expect(textWidthMm('ØØØØ', 10)).toBeCloseTo(em(4 * 778), 9);
    expect(textWidthMm('ÆÆ', 10)).toBeCloseTo(em(2000), 9);
    // Bold has its own widths, not regular plus 5%: i is 278, not 233.
    expect(textWidthMm('iiii', 10, true)).toBeCloseTo(em(4 * 278), 9);
    expect(textWidthMm('é', 10, true)).toBeCloseTo(em(556), 9);
    // Anything sheetSafeText turns into "?" is measured as one.
    expect(textWidthMm('\u4e2d', 10)).toBeCloseTo(em(556), 9);
    const fitted = fitText('Æ'.repeat(40), 3.5, 40);
    expect(textWidthMm(fitted, 3.5)).toBeLessThanOrEqual(40);
  });

  it('bounds the export file name to what the desktop save dialog accepts', () => {
    // Two valid 120-character names make a 245-byte file name together.
    const project = 'Gearbox housing '.repeat(8).slice(0, 120);
    const sheet = 'Assembly sheet '.repeat(8).slice(0, 120);
    for (const format of ['pdf', 'svg'] as const) {
      const name = drawingExportFileName(project, sheet, format);
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(
        MAX_EXPORT_FILE_NAME_BYTES
      );
      expect(name.endsWith(`.${format}`)).toBe(true);
      expect(name.startsWith('Gearbox-housing-')).toBe(true);
      expect(name).toContain('-Assembly-sheet');
      expect(name).not.toMatch(/[-.]{2}/);
    }
    // Short names are unchanged.
    expect(drawingExportFileName('Bracket', 'Sheet 1', 'pdf')).toBe(
      'Bracket-Sheet-1.pdf'
    );
  });

  it('reserves the fallback sheet name inside the export file name budget', () => {
    const project = 'P'.repeat(MAX_PROJECT_NAME_LENGTH);
    for (const format of ['pdf', 'svg'] as const) {
      const name = drawingExportFileName(project, '---', format);
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(
        MAX_EXPORT_FILE_NAME_BYTES
      );
      expect(name.endsWith(`-sheet.${format}`)).toBe(true);
    }
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

  it('writes only XML-safe characters into the SVG title', () => {
    const page = composeSheetPage({ ...sheet([]), views: [] }, [], {
      projectName: 'Bracket',
      units: 'mm'
    });
    const svg = sheetPageToSvg(page, 'Sheet\u0000one <a>');
    expect(svg).toContain('<title>Sheet?one &lt;a&gt;</title>');
    expect(svg).not.toContain('\u0000');
  });

  it('keeps sheet text inside the PDF font and the title block cells', () => {
    // Engineering symbols outside Latin-1 print as their stand-ins (U+2300
    // as Ø, the em dash and minus sign as a hyphen); anything else is "?".
    expect(sheetSafeText('⌀12 bore — 30° −0.1')).toBe('Ø12 bore - 30° -0.1');
    expect(sheetSafeText('Ø12 bore ★ 30°')).toBe('Ø12 bore ? 30°');
    expect(sheetUnprintableCharacters('⌀ ★ ok ✓ ★')).toEqual(['★', '✓']);
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

  it('fits title-block text at the font size used by preview and exports', () => {
    const drawing = {
      ...sheet([]),
      views: [],
      titleBlock: { title: 'M'.repeat(50), author: 'M'.repeat(20) }
    };
    const page = composeSheetPage(drawing, [], {
      projectName: 'Bracket',
      units: 'mm'
    });
    const box = titleBlockBox(drawing);
    const fitted = page.texts.filter((text) => text.text.startsWith('MMM'));
    expect(fitted).toHaveLength(2);
    for (const text of fitted) {
      // Base-14 Helvetica and Helvetica-Bold both advance M by 833/1000 em
      // and a period by 278/1000 em. The page stores cap height; all three
      // renderers use font-size = cap height / 0.718.
      const advance =
        ([...text.text].reduce(
          (sum, char) => sum + (char === 'M' ? 833 : 278),
          0
        ) *
          text.sizeMm) /
        0.718 /
        1000;
      const available = text.bold ? box.width - 4 : box.width * 0.3 - 3;
      expect(advance).toBeLessThanOrEqual(available);
      expect(text.text.endsWith('...')).toBe(true);
    }
  });

  it('prints a full ISO date and revision in the title block on every paper', () => {
    // QA F007: the DATE cell used to cut "2026-10-28" to "2026-10-...".
    for (const paper of [
      { size: 'A4', orientation: 'portrait' },
      { size: 'A4', orientation: 'landscape' },
      { size: 'A3', orientation: 'landscape' },
      { size: 'ANSI-A', orientation: 'portrait' }
    ] as const) {
      const page = composeSheetPage(
        {
          ...sheet([]),
          paper,
          views: [],
          titleBlock: { date: '2026-10-28', revision: '2026-10-28' }
        },
        [],
        { projectName: 'Bracket', units: 'mm' }
      );
      expect(
        page.texts.filter((text) => text.text === '2026-10-28'),
        `${paper.size} ${paper.orientation}`
      ).toHaveLength(2);
      const pdf = new TextDecoder('latin1').decode(
        sheetPageToPdf(page, 'Sheet')
      );
      expect(pdf).toContain('(2026-10-28) Tj');
      expect(sheetPageToSvg(page, 'Sheet')).toContain('>2026-10-28</text>');
    }
  });

  it('flags a view by its whole footprint, not its centre', () => {
    const drawing = {
      ...sheet([]),
      paper: { size: 'A4', orientation: 'landscape' }
    } as const;
    const box = (x: number, y: number, width = 40, height = 30) => ({
      x,
      y,
      width,
      height
    });
    // A4 landscape: 297 × 210, a 10 mm border and the title block at
    // bottom right, 170 × 32 mm.
    expect(viewPlacementIssue(box(50, 100), drawing)).toBeNull();
    expect(viewPlacementIssue(box(400, 100), drawing)).toBe('off-page');
    // Centre on the paper, footprint past its right edge.
    expect(viewPlacementIssue(box(270, 100), drawing)).toBe('partly-off-page');
    expect(viewPlacementIssue(box(-20, 100), drawing)).toBe('partly-off-page');
    expect(viewPlacementIssue(box(250, 100), drawing)).toBe('past-border');
    expect(viewPlacementIssue(box(200, 20), drawing)).toBe('over-title-block');
  });

  it('never draws past the paper, and fits views back onto a smaller one', async () => {
    // QA F006: the A3 starter at its scale, switched to A4, runs off the
    // paper. The page and its PDF keep every point on the paper, the views
    // say so, and "Fit views to sheet" lays them out on A4 again.
    const { created, projections } = await starter('mm', 'third');
    const a4: DrawingSheet = {
      ...created,
      paper: { size: 'A4', orientation: 'landscape' }
    };
    const paper = drawingPaperMm(a4.paper);
    const extents = new Map(
      projections.map(({ view: entry, projection }) => [
        entry.viewId,
        projection.bounds!
      ])
    );
    const issues = (layout: DrawingSheet) =>
      layout.views.map((entry) =>
        viewPlacementIssue(
          viewPageBox(entry, extents.get(entry.viewId)!, layout, 'mm'),
          layout
        )
      );
    expect(issues(a4)).toContain('partly-off-page');

    const page = composeSheetPage(
      a4,
      projections.map(({ view: entry, projection }) => ({
        view: a4.views.find((v) => v.viewId === entry.viewId)!,
        projection
      })),
      { projectName: 'Bracket', units: 'mm' }
    );
    for (const stroke of page.strokes)
      for (let i = 0; i + 1 < stroke.points.length; i += 2) {
        expect(stroke.points[i]!).toBeGreaterThanOrEqual(0);
        expect(stroke.points[i]!).toBeLessThanOrEqual(paper.width);
        expect(stroke.points[i + 1]!).toBeGreaterThanOrEqual(0);
        expect(stroke.points[i + 1]!).toBeLessThanOrEqual(paper.height);
      }
    // The PDF: every path point inside the MediaBox, and the page clipped.
    const pdf = new TextDecoder('latin1').decode(sheetPageToPdf(page, 'A4'));
    const [, mediaWidth, mediaHeight] = pdf.match(
      /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/
    )!;
    expect(pdf).toContain(`0 0 ${mediaWidth} ${mediaHeight} re W n`);
    const points = [...pdf.matchAll(/(-?[\d.]+) (-?[\d.]+) [ml]\b/g)];
    expect(points.length).toBeGreaterThan(20);
    for (const [, x, y] of points) {
      expect(Number(x)).toBeGreaterThanOrEqual(0);
      expect(Number(x)).toBeLessThanOrEqual(Number(mediaWidth));
      expect(Number(y)).toBeGreaterThanOrEqual(0);
      expect(Number(y)).toBeLessThanOrEqual(Number(mediaHeight));
    }

    const fitted = fitViewsToSheet(a4, extents, 'mm')!;
    // 5:1 no longer fits A4; the next preset that does is 2:1.
    expect(fitted.scale).toEqual({ numerator: 2, denominator: 1 });
    const laidOut: DrawingSheet = {
      ...a4,
      scale: fitted.scale,
      views: a4.views.map((entry) => ({
        ...entry,
        centerMm: fitted.centers.find((c) => c.viewId === entry.viewId)!
          .centerMm
      }))
    };
    expect(issues(laidOut)).toEqual([null, null, null, null]);
    const [front, top, right] = laidOut.views;
    expect(top!.centerMm.x).toBe(front!.centerMm.x);
    expect(right!.centerMm.y).toBe(front!.centerMm.y);
    // Already on the sheet: fitting keeps the scale and only centres.
    const again = fitViewsToSheet(created, extents, 'mm')!;
    expect(again.scale).toEqual(created.scale);
  });
});
