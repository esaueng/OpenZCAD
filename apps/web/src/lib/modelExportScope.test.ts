import { describe, expect, it } from 'vitest';
import {
  activateConfiguration,
  addAssemblyComponents,
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  assemblyConfigurationOverrides,
  createConfigurations,
  createProjectDocument,
  listParameters,
  setConfigurationCell,
  setParameter,
  updateAssemblyComponent
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import { emptyExportMessage, exportScope } from './exportScope';
import {
  exportScopeBodies,
  exportScopeBodyName,
  exportTargetFor
} from './modelExportScope';

/**
 * #2389's fixture: a plate whose width the configuration drives (Narrow 20,
 * Wide 45) and an Indicator lug that Wide suppresses, both assembly parts.
 */
function configuredPlate() {
  let document = createProjectDocument('Stop', toUserId('user_f06_scope'));
  document = setParameter(document, { name: 'width', expression: '20' });
  for (const [name, width] of [
    ['Plate', 'width'],
    ['Indicator lug', 4]
  ] as const)
    document = addPrimitiveFeature(document, {
      name,
      bodyName: name,
      primitiveKind: 'box',
      dimensions: { width, height: 4, depth: 4 }
    });
  const width = listParameters(document)[0]!.parameterId;
  const lug = Object.values(document.nodes).find(
    (node): node is FeatureNode =>
      node.kind === 'feature' && node.name === 'Indicator lug'
  )!;
  const [plate, lugBody] = document.bodyOrder as [BodyId, BodyId];
  document = createConfigurations(document, {
    rowId: 'narrow',
    name: 'Narrow'
  });
  document = addConfigurationColumn(document, {
    column: { kind: 'parameter', parameterId: width }
  });
  document = addConfigurationColumn(document, {
    column: { kind: 'suppression', featureId: lug.featureId }
  });
  document = addConfigurationRow(document, { rowId: 'wide', name: 'Wide' });
  document = setConfigurationCell(document, {
    rowId: 'wide',
    column: { kind: 'parameter', parameterId: width },
    value: '45'
  });
  document = setConfigurationCell(document, {
    rowId: 'wide',
    column: { kind: 'suppression', featureId: lug.featureId },
    value: true
  });
  document = addAssemblyComponents(document, {
    components: [
      { componentId: 'c_plate', name: 'Plate', bodyId: plate, grounded: true },
      {
        componentId: 'c_lug',
        name: 'Indicator lug',
        bodyId: lugBody,
        grounded: true
      }
    ]
  });
  return { document, plate, lug: lugBody };
}

/** The document as the active row built it: these bodies, exportable. */
function built(document: ProjectDocument, bodies: BodyId[]): ProjectDocument {
  return {
    ...document,
    derived: {
      ...document.derived,
      bodyRepresentations: Object.fromEntries(
        bodies.map((bodyId) => [
          bodyId,
          {
            bodyId,
            name: bodyId,
            exportableStep: true,
            consumed: false
          } as unknown as BodyRepresentation
        ])
      )
    }
  };
}

/** The export scope File › Export reads, as App computes it. */
function scopeOf(document: ProjectDocument, hidden: BodyId[] = []) {
  return exportScope(
    exportScopeBodies(
      document,
      (bodyId) => hidden.includes(bodyId),
      () => false
    ),
    null
  );
}

describe('the export scope of a configured assembly (F06, #2412)', () => {
  it('exports another row with every part in it, an explicit pin included', () => {
    // Narrow active; Plate set to Narrow explicitly, then "Export Wide".
    const { document: start } = configuredPlate();
    const document = updateAssemblyComponent(start, {
      componentId: 'c_plate',
      configurationId: 'narrow'
    });
    const target = exportTargetFor(document, 'wide', []);
    expect(target.rowName).toBe('Wide');
    expect(target.allShownBodies).toBe(true);
    expect(target.document.configurations?.activeRowId).toBe('wide');
    // Nothing for the kernel's guard to refuse.
    expect(assemblyConfigurationOverrides(target.document)).toEqual([]);
    // The open document keeps its row and the pin.
    expect(document.configurations?.activeRowId).toBe('narrow');
    expect(document.assembly?.components[0]?.configurationId).toBe('narrow');
    // The active row is the model as Assemble shows it, pins and all.
    const active = exportTargetFor(document, 'narrow', ['b' as BodyId]);
    expect(active.document).toBe(document);
    expect(active.bodyIds).toEqual(['b']);
  });

  it('leaves a hidden configured part out of the refusal', () => {
    const { document: start, plate, lug } = configuredPlate();
    const document = built(
      updateAssemblyComponent(start, {
        componentId: 'c_plate',
        configurationId: 'wide'
      }),
      [plate, lug]
    );
    const hidden = scopeOf(document, [plate]);
    expect(hidden.bodyIds).toEqual([lug]);
    expect(
      assemblyConfigurationOverrides(document, hidden.bodyIds as BodyId[])
    ).toEqual([]);
    // Shown, the plate is in the scope and refused.
    const shown = scopeOf(document);
    expect(
      assemblyConfigurationOverrides(document, shown.bodyIds as BodyId[]).map(
        (entry) => entry.componentName
      )
    ).toEqual(['Plate']);
  });

  it('scopes a part only its own row builds, so its refusal is reached', () => {
    // Wide active suppresses the lug; its part keeps Narrow.
    const { document: start, plate, lug } = configuredPlate();
    const configured = updateAssemblyComponent(
      activateConfiguration(start, { rowId: 'wide' }),
      { componentId: 'c_lug', configurationId: 'narrow' }
    );
    const document = built(configured, [plate]);
    const scope = scopeOf(document);
    expect(scope.bodyIds).toEqual([plate, lug]);
    expect(exportScopeBodyName(document, lug)).toBe('Indicator lug');
    expect(
      assemblyConfigurationOverrides(document, scope.bodyIds as BodyId[]).map(
        (entry) => entry.componentName
      )
    ).toEqual(['Indicator lug']);
    // Even as the only body, the scope is not empty.
    const alone = built(configured, []);
    expect(scopeOf(alone).bodyIds).toEqual([lug]);
    // Hidden, it leaves the scope like any body.
    const hidden = scopeOf(alone, [lug]);
    expect(hidden.bodyIds).toEqual([]);
    expect(emptyExportMessage(hidden)).toBe('Show a body before exporting.');
    // A part following the model adds nothing.
    const following = built(
      updateAssemblyComponent(configured, {
        componentId: 'c_lug',
        configurationId: null
      }),
      [plate]
    );
    expect(scopeOf(following).bodyIds).toEqual([plate]);
  });
});
