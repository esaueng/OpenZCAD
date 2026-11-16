import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONFIGURATION_SCHEMA_VERSION,
  activateConfiguration,
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  assertStorableDocument,
  createConfigurations,
  createProjectDocument,
  deleteConfigurationColumn,
  deleteConfigurationRow,
  documentForConfiguration,
  effectiveConfigurationRow,
  getParameterHiddenBodyIds,
  listParameters,
  normalizeDocument,
  renameConfigurationRow,
  setConfigurationCell,
  setNodeMetadata,
  setParameter
} from '@openzcad/document-core';
import {
  CommandManager,
  commandFactories,
  isConfigurationTableOnlyCommand,
  isTweakCommand,
  replayCommands
} from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  configurationMaterial,
  configurationSetError,
  isDocumentHistory,
  isFeatureManuallySuppressed,
  toUserId,
  type ParameterId,
  type ProjectDocument
} from '@openzcad/shared';
import { createProjectDiagnosticBundle } from '../apps/web/src/lib/projectDiagnostics';
import { sharedDocumentOnRow } from '../apps/web/src/lib/sharedConfiguration';

/**
 * F06 configurations (schema v72): a variant table of named rows over
 * parameters, feature suppression, body visibility and material, with one
 * active row whose parameter and suppression values the model holds.
 */

function model(): {
  document: ProjectDocument;
  width: ParameterId;
} {
  let document = createProjectDocument('Bracket', toUserId('user_cfg'));
  document = setParameter(document, { name: 'width', expression: '20' });
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 10, depth: 4 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Lug',
    primitiveKind: 'box',
    dimensions: { width: 4, height: 4, depth: 4 }
  });
  const width = listParameters(document)[0]!.parameterId;
  return { document, width };
}

function features(document: ProjectDocument) {
  return document.featureOrder.map(
    (featureId) =>
      Object.values(document.nodes).find(
        (node) => node.kind === 'feature' && node.featureId === featureId
      ) as Extract<ProjectDocument['nodes'][string], { kind: 'feature' }>
  );
}

/** Two rows, Small (width 20, lug built, both shown) and Large. */
function table() {
  const { document: base, width } = model();
  const [, lug] = features(base);
  const [plateBody, lugBody] = base.bodyOrder;
  let document = createConfigurations(base, { rowId: 'small', name: 'Small' });
  document = addConfigurationColumn(document, {
    column: { kind: 'parameter', parameterId: width }
  });
  document = addConfigurationColumn(document, {
    column: { kind: 'suppression', featureId: lug!.featureId }
  });
  document = addConfigurationColumn(document, {
    column: { kind: 'body', bodyId: lugBody! }
  });
  document = addConfigurationColumn(document, { column: { kind: 'material' } });
  document = addConfigurationRow(document, { rowId: 'large', name: 'Large' });
  document = setConfigurationCell(document, {
    rowId: 'large',
    column: { kind: 'parameter', parameterId: width },
    value: '45'
  });
  document = setConfigurationCell(document, {
    rowId: 'large',
    column: { kind: 'material' },
    value: { kind: 'preset', presetId: 'aluminium-6061' }
  });
  return {
    document,
    width,
    lug: lug!,
    plateBody: plateBody!,
    lugBody: lugBody!
  };
}

describe('the variant table', () => {
  it('starts dense, with every row holding every column', () => {
    const { document, width, lug, lugBody } = table();
    expect(document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    const set = document.configurations!;
    expect(configurationSetError(set)).toBeNull();
    expect(set.activeRowId).toBe('small');
    expect(set.rows.map((row) => row.name)).toEqual(['Small', 'Large']);
    expect(set.rows[0]).toMatchObject({
      parameters: { [width]: '20' },
      suppressed: { [lug.featureId]: false },
      bodies: { [lugBody]: true },
      material: { kind: 'unit' }
    });
    // Setting a cell of a row that is not active leaves the model alone.
    expect(listParameters(document)[0]!.expression).toBe('20');
    expect(configurationMaterial(set)).toEqual({ kind: 'unit' });
  });

  it('activates a row into the model in one step, keeping edits in the row left', () => {
    const { document, width, lug } = table();
    // An ordinary edit while Small is active belongs to Small.
    const edited = setParameter(document, { name: 'width', expression: '22' });
    expect(effectiveConfigurationRow(edited, 'small')!.parameters[width]).toBe(
      '22'
    );
    const large = activateConfiguration(edited, { rowId: 'large' });
    expect(large.configurations!.activeRowId).toBe('large');
    expect(listParameters(large)[0]!.expression).toBe('45');
    expect(listParameters(large)[0]!.value).toBe(45);
    expect(configurationMaterial(large.configurations)).toEqual({
      kind: 'preset',
      presetId: 'aluminium-6061'
    });
    // Small kept 22, so switching back restores it.
    const back = activateConfiguration(large, { rowId: 'small' });
    expect(listParameters(back)[0]!.expression).toBe('22');
    // Suppression of the active row is the feature's own flag.
    const suppressed = setConfigurationCell(back, {
      rowId: 'small',
      column: { kind: 'suppression', featureId: lug.featureId },
      value: true
    });
    expect(isFeatureManuallySuppressed(features(suppressed)[1]!)).toBe(true);
    const unsuppressed = activateConfiguration(suppressed, { rowId: 'large' });
    expect(isFeatureManuallySuppressed(features(unsuppressed)[1]!)).toBe(false);
    expect(
      unsuppressed.configurations!.rows.find((row) => row.id === 'small')!
        .suppressed[lug.featureId]
    ).toBe(true);
  });

  it('keeps ordinary edits when another cell of the active row changes', () => {
    const { document, width, lug, lugBody } = table();
    // Edits made in the Parameters panel and History, not the table.
    let edited = setParameter(document, { name: 'width', expression: '22' });
    edited = setNodeMetadata(edited, {
      nodeId: lug.id,
      metadata: { suppressed: true }
    });
    for (const [column, value] of [
      [{ kind: 'body', bodyId: lugBody }, false],
      [{ kind: 'material' }, { kind: 'preset', presetId: 'steel' }]
    ] as const) {
      const next = setConfigurationCell(edited, {
        rowId: 'small',
        column,
        value
      });
      expect(listParameters(next)[0]!.expression).toBe('22');
      expect(isFeatureManuallySuppressed(features(next)[1]!)).toBe(true);
      expect(effectiveConfigurationRow(next, 'small')!.parameters[width]).toBe(
        '22'
      );
      // The row is stored with the live values, not the stale ones.
      expect(
        next.configurations!.rows.find((row) => row.id === 'small')!.suppressed[
          lug.featureId
        ]
      ).toBe(true);
    }
  });

  it('hides the bodies the active row hides, alongside on/off parameters', () => {
    const { document, lugBody } = table();
    expect(getParameterHiddenBodyIds(document).has(lugBody)).toBe(false);
    const hidden = setConfigurationCell(document, {
      rowId: 'small',
      column: { kind: 'body', bodyId: lugBody },
      value: false
    });
    expect([...getParameterHiddenBodyIds(hidden)]).toEqual([lugBody]);
    // Large shows it.
    const large = activateConfiguration(hidden, { rowId: 'large' });
    expect(getParameterHiddenBodyIds(large).size).toBe(0);
  });

  it('refuses rows the model cannot take, naming the row', () => {
    const { document, width } = table();
    const broken = setConfigurationCell(document, {
      rowId: 'large',
      column: { kind: 'parameter', parameterId: width },
      value: 'nope + 1'
    });
    expect(() => activateConfiguration(broken, { rowId: 'large' })).toThrow(
      /Configuration "Large"/
    );
    expect(() =>
      setConfigurationCell(document, {
        rowId: 'small',
        column: { kind: 'parameter', parameterId: width },
        value: 'nope + 1'
      })
    ).toThrow(/Configuration "Small"/);
    expect(() =>
      addConfigurationRow(document, { rowId: 'x', name: 'large' })
    ).toThrow(/already named/);
    expect(() =>
      addConfigurationRow(document, { rowId: 'x', name: ' padded ' })
    ).toThrow(/name/);
    expect(() => deleteConfigurationRow(document, { rowId: 'small' })).toThrow(
      /is active/
    );
    expect(() =>
      addConfigurationColumn(document, {
        column: { kind: 'parameter', parameterId: width }
      })
    ).toThrow(/already a column/);
    expect(() =>
      addConfigurationColumn(document, {
        column: {
          kind: 'parameter',
          parameterId: 'param_missing' as ParameterId
        }
      })
    ).toThrow(/not in the model/);
  });

  it('renames, deletes rows and columns, and keeps the active row valid', () => {
    const { document, width } = table();
    let next = renameConfigurationRow(document, {
      rowId: 'large',
      name: 'Wide'
    });
    expect(next.configurations!.rows[1]!.name).toBe('Wide');
    next = deleteConfigurationColumn(next, {
      column: { kind: 'parameter', parameterId: width }
    });
    expect(
      next.configurations!.rows.every((row) => !(width in row.parameters))
    ).toBe(true);
    next = deleteConfigurationRow(next, { rowId: 'large' });
    expect(next.configurations!.rows).toHaveLength(1);
    expect(configurationSetError(next.configurations)).toBeNull();
  });

  it('exports another row without storing anything', () => {
    const { document } = table();
    const large = documentForConfiguration(document, 'large');
    expect(listParameters(large)[0]!.expression).toBe('45');
    expect(document.configurations!.activeRowId).toBe('small');
    expect(documentForConfiguration(document, 'small')).toBe(document);
  });
});

describe('storage and history', () => {
  it('is gated to its schema and validated on load', () => {
    const { document } = table();
    expect(() => assertStorableDocument(document)).not.toThrow();
    expect(() =>
      normalizeDocument({
        ...document,
        schemaVersion: CONFIGURATION_SCHEMA_VERSION - 1
      } as never)
    ).toThrow(/Configurations require project schema v\d+/);
    const bad = structuredClone(document);
    bad.configurations!.activeRowId = 'gone';
    expect(() => assertStorableDocument(bad)).toThrow(
      /active configuration is not in the table/
    );
    const sparse = structuredClone(document);
    sparse.configurations!.rows[1]!.parameters = {};
    expect(() => assertStorableDocument(sparse)).toThrow(/one parameter value/);
    const unknownMaterial = structuredClone(document);
    unknownMaterial.configurations!.rows[1]!.material = {
      kind: 'preset',
      presetId: 'unobtainium'
    };
    expect(() => assertStorableDocument(unknownMaterial)).toThrow(
      /material this version does not know/
    );
  });

  it('is undoable and replayable, and switching is one step', () => {
    const { document: base, width } = model();
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.createConfigurations({ rowId: 'a', name: 'A' })
    );
    manager.execute(
      commandFactories.addConfigurationColumn({
        column: { kind: 'parameter', parameterId: width }
      })
    );
    manager.execute(
      commandFactories.addConfigurationRow({ rowId: 'b', name: 'B' })
    );
    const cell = commandFactories.setConfigurationCell({
      rowId: 'b',
      column: { kind: 'parameter', parameterId: width },
      value: '33'
    });
    expect(isConfigurationTableOnlyCommand(cell, manager.document)).toBe(true);
    manager.execute(cell);
    // Editing the table is Build's; switching rows is Tweak's, as a value is.
    expect(isTweakCommand(cell)).toBe(false);
    expect(manager.undoIsParameterOnly).toBe(false);
    const activate = commandFactories.activateConfiguration({ rowId: 'b' });
    expect(isConfigurationTableOnlyCommand(activate, manager.document)).toBe(
      false
    );
    expect(isTweakCommand(activate)).toBe(true);
    manager.execute(activate);
    expect(manager.undoIsParameterOnly).toBe(true);
    expect(manager.canUndoIn(true)).toBe(true);
    expect(listParameters(manager.document)[0]!.expression).toBe('33');
    expect(
      isDocumentHistory(
        manager.document.editHistory,
        manager.document.projectId
      )
    ).toBe(true);
    manager.undo();
    expect(listParameters(manager.document)[0]!.expression).toBe('20');
    expect(manager.document.configurations!.activeRowId).toBe('a');
    manager.redo();
    expect(listParameters(manager.document)[0]!.expression).toBe('33');
    const replayed = replayCommands(base, manager.document.commandLog);
    expect(replayed.configurations).toEqual(manager.document.configurations);
    expect(listParameters(replayed)[0]!.expression).toBe('33');
    // A history change that is not a table is refused.
    const history = structuredClone(manager.document.editHistory!);
    const change = history.entries
      .at(-1)!
      .changes.find((entry) => entry.field === 'configurations')!;
    (change as { after: unknown }).after = { rows: [] };
    expect(isDocumentHistory(history, manager.document.projectId)).toBe(false);
  });

  it('opens a shared model on the row its link names (Tweak link)', () => {
    const { document } = table();
    const opened = sharedDocumentOnRow(document, 'large');
    expect(opened.document.configurations!.activeRowId).toBe('large');
    expect(listParameters(opened.document)[0]!.expression).toBe('45');
    expect(opened.note).toBe('Showing Large.');
    // No row named, or the active one: the model as saved.
    expect(sharedDocumentOnRow(document, null)).toEqual({
      document,
      note: null
    });
    expect(sharedDocumentOnRow(document, 'small').document).toBe(document);
    // A row the model no longer has opens it as saved, saying so.
    const gone = sharedDocumentOnRow(document, 'deleted');
    expect(gone.document).toBe(document);
    expect(gone.note).toMatch(/no longer in the model/);
    // A model without a table ignores the row.
    const plain = model().document;
    expect(sharedDocumentOnRow(plain, 'large').document).toBe(plain);
    // A row the model cannot take is refused, not half applied.
    const broken = structuredClone(document);
    broken.configurations!.rows[1]!.parameters[
      Object.keys(broken.configurations!.rows[1]!.parameters)[0] as ParameterId
    ] = 'missing_parameter * 2';
    const refused = sharedDocumentOnRow(broken, 'large');
    expect(refused.document).toBe(broken);
    expect(refused.note).toMatch(/Large could not be built/);
  });

  it('keeps row names out of a diagnostic reproduction', () => {
    const { document } = table();
    const named = renameConfigurationRow(document, {
      rowId: 'large',
      name: 'Customer secret'
    });
    const text = JSON.stringify(
      createProjectDiagnosticBundle(named, {
        remusVersion: 'test',
        remusCommit: 'test'
      })
    );
    expect(text).not.toContain('Customer secret');
    expect(text).toContain('Configuration 2');
  });
});

describe('the exact model', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  it('rebuilds each row, and exports only what the row shows', async () => {
    const { document, plateBody, lugBody } = table();
    const small = setConfigurationCell(document, {
      rowId: 'small',
      column: { kind: 'body', bodyId: lugBody },
      value: false
    });
    const first = await adapter.syncDocument(small);
    expect(first.warnings).toEqual([]);
    const a = first.bodyRepresentations[plateBody]!.bbox;
    expect(a.max.x - a.min.x).toBeCloseTo(20, 6);
    expect(first.exportableBodyIds).toEqual([plateBody]);
    // Stale ids are filtered by the adapter, as for an off parameter.
    const smallStl = await adapter.exportStl(small, small.bodyOrder, 0.1);
    expect(smallStl).toBe(await adapter.exportStl(small, [plateBody], 0.1));

    const large = activateConfiguration(small, { rowId: 'large' });
    const second = await adapter.syncDocument(large);
    expect(second.warnings).toEqual([]);
    const b = second.bodyRepresentations[plateBody]!.bbox;
    expect(b.max.x - b.min.x).toBeCloseTo(45, 6);
    expect(second.exportableBodyIds).toEqual([plateBody, lugBody]);
  }, 60_000);
});
