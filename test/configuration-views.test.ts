import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  DRAWING_VIEW_CONFIGURATION_SCHEMA_VERSION,
  addConfigurationColumn,
  addConfigurationRow,
  addDrawingSheet,
  addPrimitiveFeature,
  assertStorableDocument,
  createConfigurations,
  createProjectDocument,
  deleteConfigurationRow,
  deleteConfigurations,
  holeBody,
  listFeaturesInOrder,
  listParameters,
  setConfigurationCell,
  setParameter,
  updateDrawingView
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  drawingSetError,
  isDocumentHistory,
  toUserId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  activeRowSheet,
  projectionSheet,
  projectionViewCacheKey,
  projectionViewRow,
  rowBodyKey,
  rowContentKey,
  rowDocument,
  viewConfigurationRows
} from '../apps/web/src/lib/drawing/viewConfigurations';
import {
  holeCalloutLookup,
  holeCalloutSnapshot,
  rowViewBodyKey,
  viewHoleCallouts
} from '../apps/web/src/lib/drawing/annotations';
import { auditDrawingDimensions } from '../apps/web/src/lib/drawing/dimensionAudit';

/**
 * F06 slice 4b: one configuration per drawing view (schema v89). A base
 * view may name a configuration row it draws; the views derived from it
 * draw the same row, while the document's active row stays the model.
 */
const sheetId = 'dsht_cfg' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const sideId = 'dvw_side' as DrawingViewId;
const sectionId = 'dvw_section' as DrawingViewId;

function model(): ProjectDocument {
  let document = createProjectDocument('Bracket', toUserId('user_cfg'));
  document = setParameter(document, { name: 'width', expression: '20' });
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 10, depth: 4 }
  });
  const width = listParameters(document)[0]!.parameterId;
  document = createConfigurations(document, { rowId: 'small', name: 'Small' });
  document = addConfigurationColumn(document, {
    column: { kind: 'parameter', parameterId: width }
  });
  document = addConfigurationRow(document, { rowId: 'large', name: 'Large' });
  document = setConfigurationCell(document, {
    rowId: 'large',
    column: { kind: 'parameter', parameterId: width },
    value: '45'
  });
  const bodyId = document.bodyOrder[0]!;
  const view = (
    viewId: DrawingViewId,
    extra: Partial<DrawingView> = {}
  ): DrawingView => ({
    viewId,
    orientation: 'front',
    bodyIds: [bodyId],
    centerMm: { x: 100, y: 150 },
    hiddenLines: false,
    ...extra
  });
  const sheet: DrawingSheet = {
    sheetId,
    name: 'Sheet 1',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views: [
      view(frontId),
      view(sideId, {
        orientation: 'right',
        centerMm: { x: 250, y: 150 },
        parentViewId: frontId
      }),
      // A section cut from the front view is seen from the right, level with
      // it and on its right (third-angle projection).
      view(sectionId, {
        orientation: 'right',
        centerMm: { x: 350, y: 150 },
        section: { sourceViewId: frontId, label: 'A', depth: 0 }
      })
    ]
  };
  return addDrawingSheet(document, { sheet });
}

describe('a drawing view that shows a configuration', () => {
  it('names a row on a base view, undoes, and clears back to the active row', () => {
    const base = model();
    expect(base.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.updateDrawingView({
        sheetId,
        viewId: frontId,
        configurationId: 'large'
      })
    );
    const views = manager.document.drawings!.sheets[0]!.views;
    expect(views.find((view) => view.viewId === frontId)!.configurationId).toBe(
      'large'
    );
    // The model being edited is still the active row.
    expect(manager.document.configurations!.activeRowId).toBe('small');
    expect(manager.document.editHistory!.entries.at(-1)!.label).toBe(
      'Set view configuration'
    );
    expect(
      isDocumentHistory(
        manager.document.editHistory,
        manager.document.projectId
      )
    ).toBe(true);
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    manager.undo();
    expect(
      manager.document.drawings!.sheets[0]!.views[0]!.configurationId
    ).toBeUndefined();
    manager.redo();
    const cleared = updateDrawingView(manager.document, {
      sheetId,
      viewId: frontId,
      configurationId: null
    });
    expect(
      cleared.drawings!.sheets[0]!.views[0]!.configurationId
    ).toBeUndefined();
  });

  it('refuses a row on a derived view, and a row the table lacks', () => {
    const document = model();
    for (const viewId of [sideId, sectionId])
      expect(() =>
        updateDrawingView(document, {
          sheetId,
          viewId,
          configurationId: 'large'
        })
      ).toThrow(/source view’s configuration/);
    expect(() =>
      updateDrawingView(document, {
        sheetId,
        viewId: frontId,
        configurationId: 'missing'
      })
    ).toThrow(/not in this document/);
  });

  it('keeps a row a view shows from being deleted', () => {
    const named = updateDrawingView(model(), {
      sheetId,
      viewId: frontId,
      configurationId: 'large'
    });
    expect(() => deleteConfigurationRow(named, { rowId: 'large' })).toThrow(
      /A view on Sheet 1 shows "Large"/
    );
    expect(() => deleteConfigurations(named)).toThrow(/A view on Sheet 1/);
  });

  it('validates and gates the stored choice', () => {
    const named = updateDrawingView(model(), {
      sheetId,
      viewId: frontId,
      configurationId: 'large'
    });
    expect(drawingSetError(named.drawings)).toBeNull();
    const onDerived = structuredClone(named);
    onDerived.drawings!.sheets[0]!.views[1]!.configurationId = 'large';
    expect(drawingSetError(onDerived.drawings)).toMatch(
      /draws its source view's configuration/
    );
    const dangling = structuredClone(named);
    dangling.drawings!.sheets[0]!.views[0]!.configurationId = 'gone';
    expect(() => assertStorableDocument(dangling)).toThrow(
      /shows a configuration that is not in the document/
    );
    const older = {
      ...structuredClone(named),
      schemaVersion: DRAWING_VIEW_CONFIGURATION_SCHEMA_VERSION - 1
    } as unknown as ProjectDocument;
    expect(() => assertStorableDocument(older)).toThrow();
    expect(() =>
      updateDrawingView(
        {
          ...model(),
          schemaVersion: DRAWING_VIEW_CONFIGURATION_SCHEMA_VERSION - 1
        } as unknown as ProjectDocument,
        { sheetId, viewId: frontId, configurationId: 'large' }
      )
    ).toThrow(/Drawing view configurations/);
  });
});

describe('which row each view draws', () => {
  it('derives a view’s row from its source and leaves the active row out', () => {
    const named = updateDrawingView(model(), {
      sheetId,
      viewId: frontId,
      configurationId: 'large'
    });
    const sheet = named.drawings!.sheets[0]!;
    // The projected and the section view draw their base's row.
    expect(viewConfigurationRows(sheet, named)).toEqual(
      new Map([
        [frontId, 'large'],
        [sideId, 'large'],
        [sectionId, 'large']
      ])
    );
    // The active row, or a row no longer in the table: the model as it is.
    const active = updateDrawingView(named, {
      sheetId,
      viewId: frontId,
      configurationId: 'small'
    });
    expect(
      viewConfigurationRows(active.drawings!.sheets[0]!, active).size
    ).toBe(0);
    const stale = structuredClone(named);
    stale.drawings!.sheets[0]!.views[0]!.configurationId = 'gone';
    expect(viewConfigurationRows(stale.drawings!.sheets[0]!, stale).size).toBe(
      0
    );
  });

  it('keys a row view apart from the active row, and by the model content', () => {
    const named = updateDrawingView(model(), {
      sheetId,
      viewId: frontId,
      configurationId: 'large'
    });
    const sheet = named.drawings!.sheets[0]!;
    const rows = viewConfigurationRows(sheet, named);
    const key = rowContentKey(named);
    const keyed = projectionSheet(sheet, rows, key);
    for (const view of keyed.views)
      expect(projectionViewRow(view)).toBe('large');
    expect(keyed.views[0]!.configurationId).toContain(key);
    // The active row's views keep no configuration in their key.
    const plain = projectionSheet(
      model().drawings!.sheets[0]!,
      new Map(),
      'unused'
    );
    expect(plain.views.every((view) => !view.configurationId)).toBe(true);
    // Editing the row changes the key; a drawing edit does not.
    const edited = setConfigurationCell(named, {
      rowId: 'large',
      column: named.configurations!.columns[0]!,
      value: '50'
    });
    expect(rowContentKey(edited)).not.toBe(key);
    const moved = updateDrawingView(named, {
      sheetId,
      viewId: frontId,
      centerMm: { x: 120, y: 150 }
    });
    expect(rowContentKey(moved)).toBe(key);
    // Bodies on a row never share a tessellation with the active row's.
    expect(rowBodyKey('large', 'body_a')).not.toBe(rowBodyKey(null, 'body_a'));
    expect(rowBodyKey(null, 'body_a')).toBe('body_a');
  });

  it('judges a sheet by its active-row views, and caches row geometry by content', () => {
    const named = updateDrawingView(model(), {
      sheetId,
      viewId: frontId,
      configurationId: 'large'
    });
    const sheet = named.drawings!.sheets[0]!;
    const rows = viewConfigurationRows(sheet, named);
    // Every view here draws Large, so none reads the active build.
    expect(activeRowSheet(sheet, rows).views).toEqual([]);
    expect(activeRowSheet(sheet, new Map())).toBe(sheet);
    // A row edit gives the row's meshes and cuts a new cache key.
    const keyed = projectionSheet(sheet, rows, rowContentKey(named));
    const edited = setConfigurationCell(named, {
      rowId: 'large',
      column: named.configurations!.columns[0]!,
      value: '50'
    });
    const rekeyed = projectionSheet(sheet, rows, rowContentKey(edited));
    expect(projectionViewCacheKey(keyed.views[0]!)).not.toBe(
      projectionViewCacheKey(rekeyed.views[0]!)
    );
    expect(projectionViewRow(rekeyed.views[0]!)).toBe('large');
    expect(
      projectionViewCacheKey(projectionSheet(sheet, new Map(), 'x').views[0]!)
    ).toBeNull();
  });

  it('keys a row view by everything a rebuild reads, the feature order included (review)', () => {
    const named = addPrimitiveFeature(model(), {
      name: 'Boss',
      primitiveKind: 'box',
      dimensions: { width: 5, height: 5, depth: 5 }
    });
    const key = rowContentKey(named);
    // Two steps swapped: the same features, another result.
    expect(named.featureOrder.length).toBeGreaterThan(1);
    expect(
      rowContentKey({
        ...named,
        featureOrder: [...named.featureOrder].reverse()
      })
    ).not.toBe(key);
    // The other orders, the units and the imports a rebuild reads.
    expect(rowContentKey({ ...named, parameterOrder: [] })).not.toBe(key);
    expect(
      rowContentKey({ ...named, bodyOrder: [...named.bodyOrder].reverse() })
    ).not.toBe(key);
    expect(rowContentKey({ ...named, units: 'inch' })).not.toBe(key);
    expect(rowContentKey({ ...named, printClearance: 0.2 })).not.toBe(key);
    expect(
      rowContentKey({
        ...named,
        assets: { asset_x: { assetId: 'asset_x' } } as never
      })
    ).not.toBe(key);
    // What a rebuild never reads keeps the key: the bookkeeping of a
    // command, and the folders bodies are filed in.
    expect(
      rowContentKey({
        ...named,
        version: named.version + 1,
        commandLog: [],
        objectFolders: { folders: [] } as never
      })
    ).toBe(key);
  });

  it('answers a row the model cannot take, rather than throwing (review)', () => {
    const named = model();
    const good = rowDocument(named, 'large');
    expect(good.ok && good.document.configurations!.activeRowId).toBe('large');
    // Large's width names a parameter the model no longer has.
    const set = named.configurations!;
    const width = listParameters(named)[0]!.parameterId;
    const broken: ProjectDocument = {
      ...named,
      configurations: {
        ...set,
        rows: set.rows.map((row) =>
          row.id === 'large'
            ? { ...row, parameters: { ...row.parameters, [width]: 'gone * 2' } }
            : row
        )
      }
    };
    const refused = rowDocument(broken, 'large');
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toMatch(/^Configuration "Large": /);
  });

  it('reads a view’s hole callouts from the row it draws (review)', () => {
    let document = setParameter(
      createProjectDocument('Drilled', toUserId('user_cfg')),
      { name: 'bore', expression: '10' }
    );
    document = addPrimitiveFeature(document, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 60, height: 40, depth: 10 }
    });
    document = holeBody(document, {
      name: 'Hole',
      targetBodyId: document.bodyOrder.at(-1)!,
      faceHash: 1,
      style: 'simple',
      diameter: 'bore',
      depthMode: 'through',
      position: { u: 0, v: 0 }
    }).document;
    const holeId = listFeaturesInOrder(document).at(-1)!.featureId;
    const column = {
      kind: 'parameter' as const,
      parameterId: listParameters(document)[0]!.parameterId
    };
    document = createConfigurations(document, { rowId: 'wide', name: 'Wide' });
    document = addConfigurationColumn(document, { column });
    document = addConfigurationRow(document, {
      rowId: 'narrow',
      name: 'Narrow'
    });
    document = setConfigurationCell(document, {
      rowId: 'narrow',
      column,
      value: '6'
    });
    const narrow = rowDocument(document, 'narrow');
    expect(narrow.ok).toBe(true);
    const callouts = viewHoleCallouts(
      holeCalloutLookup(document),
      new Map([
        [frontId, narrow.ok ? holeCalloutSnapshot(narrow.document) : null],
        [sectionId, null]
      ])
    );
    // The active row's views, and a read that names no view.
    expect(callouts(holeId)?.diameter).toBe(10);
    expect(callouts(holeId, sideId)?.diameter).toBe(10);
    // A view on Narrow reads Narrow's size.
    expect(callouts(holeId, frontId)?.diameter).toBe(6);
    // A row that could not be read calls nothing out, never the active
    // row's size in its place.
    expect(callouts(holeId, sectionId)).toBeNull();
    // With no view on another row the active lookup is used as it is.
    const active = holeCalloutLookup(document);
    expect(viewHoleCallouts(active, new Map())).toBe(active);
  });

  it('reports a view whose row is not in as unchecked, not complete (review)', () => {
    const named = updateDrawingView(model(), {
      sheetId,
      viewId: frontId,
      configurationId: 'large'
    });
    const sheet: DrawingSheet = {
      ...named.drawings!.sheets[0]!,
      views: [named.drawings!.sheets[0]!.views[0]!]
    };
    const bodyId = sheet.views[0]!.bodyIds[0]!;
    // Large is still building: its view has no body to read.
    const bodies = { [rowViewBodyKey(frontId, bodyId)]: undefined };
    expect(auditDrawingDimensions(sheet, bodies, 'mm')).toMatchObject({
      missing: [],
      required: 0
    });
    const audit = auditDrawingDimensions(
      sheet,
      bodies,
      'mm',
      new Map([[frontId, 'Front: its configuration is still being built.']])
    );
    expect(audit.uncheckedViews).toEqual([
      {
        viewId: frontId,
        message: 'Front: its configuration is still being built.'
      }
    ]);
    // A view the map does not name is read as ever.
    expect(
      auditDrawingDimensions(sheet, bodies, 'mm', new Map()).uncheckedViews
    ).toBeUndefined();
  });
});
