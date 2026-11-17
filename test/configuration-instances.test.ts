import { describe, expect, it } from 'vitest';
import {
  COMPONENT_CONFIGURATION_SCHEMA_VERSION,
  addAssemblyComponents,
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  assertStorableDocument,
  createConfigurations,
  createProjectDocument,
  deleteConfigurationRow,
  deleteConfigurations,
  listParameters,
  setConfigurationCell,
  setParameter,
  updateAssemblyComponent
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  assemblySetError,
  isDocumentHistory,
  toUserId,
  type GeometryReadyState,
  type ProjectDocument
} from '@openzcad/shared';
import {
  buildConfigurationRow,
  configurationRowsToBuild
} from '../apps/web/src/lib/configurationRowGeometry';

/**
 * F06 slice 4: one configuration per assembly instance (schema v90). A
 * component may name a row it shows, built on its own, while the document's
 * active row stays the model being edited.
 */
function assembly(): ProjectDocument {
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
  return addAssemblyComponents(document, {
    components: [
      {
        componentId: 'plate',
        name: 'Plate part',
        bodyId: document.bodyOrder[0]!,
        grounded: true
      }
    ]
  });
}

describe('a component that shows a configuration', () => {
  it('names a row, undoes, refuses an unknown row and clears back to the active row', () => {
    const base = assembly();
    expect(base.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'plate',
        configurationId: 'large'
      })
    );
    const component = manager.document.assembly!.components[0]!;
    expect(component.configurationId).toBe('large');
    // The model being edited is still the active row.
    expect(manager.document.configurations!.activeRowId).toBe('small');
    expect(listParameters(manager.document)[0]!.expression).toBe('20');
    expect(manager.document.editHistory!.entries.at(-1)!.label).toBe(
      'Set component configuration'
    );
    expect(
      isDocumentHistory(
        manager.document.editHistory,
        manager.document.projectId
      )
    ).toBe(true);
    manager.undo();
    expect(
      manager.document.assembly!.components[0]!.configurationId
    ).toBeUndefined();
    manager.redo();
    expect(() => assertStorableDocument(manager.document)).not.toThrow();

    expect(() =>
      updateAssemblyComponent(manager.document, {
        componentId: 'plate',
        configurationId: 'missing'
      })
    ).toThrow(/not in this document/);
    const cleared = updateAssemblyComponent(manager.document, {
      componentId: 'plate',
      configurationId: null
    });
    expect(cleared.assembly!.components[0]!.configurationId).toBeUndefined();
  });

  it('keeps a row a component shows from being deleted', () => {
    const named = updateAssemblyComponent(assembly(), {
      componentId: 'plate',
      configurationId: 'large'
    });
    expect(() => deleteConfigurationRow(named, { rowId: 'large' })).toThrow(
      /Plate part shows "Large"/
    );
    expect(() => deleteConfigurations(named)).toThrow(/Plate part shows/);
    // Once the part follows the active row again, both are allowed.
    const free = updateAssemblyComponent(named, {
      componentId: 'plate',
      configurationId: null
    });
    expect(
      deleteConfigurationRow(free, { rowId: 'large' }).configurations!.rows
    ).toHaveLength(1);
  });

  it('validates and gates the stored choice', () => {
    const named = updateAssemblyComponent(assembly(), {
      componentId: 'plate',
      configurationId: 'large'
    });
    expect(assemblySetError(named.assembly)).toBeNull();
    const malformed = structuredClone(named);
    (
      malformed.assembly!.components[0] as { configurationId: unknown }
    ).configurationId = 7;
    expect(assemblySetError(malformed.assembly)).toMatch(
      /names no usable configuration/
    );
    // A row that is not in the table cannot be stored.
    const dangling = structuredClone(named);
    dangling.assembly!.components[0]!.configurationId = 'gone';
    expect(() => assertStorableDocument(dangling)).toThrow(
      /shows a configuration that is not in the document/
    );
    // An older document cannot hold it, nor run the command.
    const older = {
      ...structuredClone(named),
      schemaVersion: COMPONENT_CONFIGURATION_SCHEMA_VERSION - 1
    } as unknown as ProjectDocument;
    expect(() => assertStorableDocument(older)).toThrow();
    expect(() =>
      updateAssemblyComponent(
        {
          ...assembly(),
          schemaVersion: COMPONENT_CONFIGURATION_SCHEMA_VERSION - 1
        } as unknown as ProjectDocument,
        { componentId: 'plate', configurationId: 'large' }
      )
    ).toThrow(/Component configurations/);
  });
});

describe('building the rows views and components name', () => {
  it('builds each named row once, never the active one', () => {
    const document = assembly();
    expect(
      configurationRowsToBuild(document, [
        'large',
        null,
        undefined,
        'small',
        'large',
        'gone'
      ])
    ).toEqual(['large']);
    expect(
      configurationRowsToBuild(createProjectDocument('x', toUserId('u')), [
        'large'
      ])
    ).toEqual([]);
    expect(configurationRowsToBuild(null, ['large'])).toEqual([]);
  });

  it('builds a row for display without touching the open document', async () => {
    const document = assembly();
    const before = JSON.stringify(document);
    const seen: ProjectDocument[] = [];
    const ready: GeometryReadyState = {
      bodyRepresentations: {},
      warnings: [],
      updatedAt: document.derived.updatedAt,
      analysis: 'complete'
    } as unknown as GeometryReadyState;
    const built = await buildConfigurationRow(
      document,
      'large',
      (row) => {
        seen.push(row);
        return Promise.resolve(ready);
      },
      new AbortController().signal
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.configurations!.activeRowId).toBe('large');
    expect(listParameters(built)[0]!.expression).toBe('45');
    expect(built.derived.bodyRepresentations).toBe(ready.bodyRepresentations);
    expect(JSON.stringify(document)).toBe(before);
  });
});
