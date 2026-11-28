import { describe, expect, it } from 'vitest';
import {
  activateConfiguration,
  addAssemblyComponents,
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  assemblyExportRowIds,
  assemblyExportRowParts,
  assemblyRowDrawnParts,
  createConfigurations,
  createProjectDocument,
  documentForConfiguration,
  getParameterHiddenBodyIds,
  listParameters,
  setConfigurationCell,
  setParameter,
  updateAssemblyComponent
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type FeatureId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import { emptyExportMessage, exportScope } from './exportScope';
import {
  NO_ROW_DRAW,
  exportRowDraw,
  exportScopeBodies,
  exportScopeBodyName,
  exportTargetEmpty,
  exportTargetFor,
  rowDrawnHiddenBodyIds
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
  const features = Object.values(document.nodes).filter(
    (node): node is FeatureNode => node.kind === 'feature'
  );
  const lug = features.find((node) => node.name === 'Indicator lug')!;
  const plateFeature = features.find((node) => node.name === 'Plate')!;
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
  return {
    document,
    plate,
    lug: lugBody,
    lugFeature: lug.featureId,
    plateFeature: plateFeature.featureId
  };
}

/** Whether `rowId` suppresses the feature. */
function suppress(
  document: ProjectDocument,
  rowId: string,
  featureId: FeatureId,
  value: boolean
) {
  return setConfigurationCell(document, {
    rowId,
    column: { kind: 'suppression', featureId },
    value
  });
}

/** A Visible column for the body: whether each row shows it. */
function shownIn(
  document: ProjectDocument,
  bodyId: BodyId,
  rows: Record<string, boolean>
) {
  let next = addConfigurationColumn(document, {
    column: { kind: 'body', bodyId }
  });
  for (const [rowId, value] of Object.entries(rows))
    next = setConfigurationCell(next, {
      rowId,
      column: { kind: 'body', bodyId },
      value
    });
  return next;
}

/** The document as its active row built it: these bodies, exportable. */
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

/** `rowId` built on its own, as Assemble builds a row a part names. */
function rowBuilt(document: ProjectDocument, rowId: string, bodies: BodyId[]) {
  return built(documentForConfiguration(document, rowId), bodies);
}

/**
 * The export scope File › Export reads, as App computes it: the model's
 * hidden set (the active row's and `local`, this browser's), what Assemble
 * draws from the rows built so far, and the parts an export of that scope
 * would be refused for.
 */
function scopeOf(
  document: ProjectDocument,
  rows: Record<string, ProjectDocument | undefined> = {},
  local: BodyId[] = []
) {
  const draw = exportRowDraw(document, (rowId) => rows[rowId]);
  const hidden = rowDrawnHiddenBodyIds(
    new Set<string>([...local, ...getParameterHiddenBodyIds(document)]),
    new Set<string>(local),
    draw
  );
  const scope = exportScope(
    exportScopeBodies(
      document,
      draw,
      (bodyId) => hidden.has(bodyId),
      () => false
    ),
    null
  );
  return {
    draw,
    scope,
    bodyIds: scope.bodyIds,
    refused: assemblyExportRowParts(draw, scope.bodyIds as BodyId[]).map(
      (part) => part.componentName
    )
  };
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
    // Nothing for the kernel's guard to refuse: no part names another row.
    expect(assemblyExportRowIds(target.document)).toEqual([]);
    expect(assemblyRowDrawnParts(target.document, () => undefined)).toEqual([]);
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
    // With Wide built, and before it is.
    for (const rows of [{ wide: rowBuilt(document, 'wide', [plate]) }, {}]) {
      const hidden = scopeOf(document, rows, [plate]);
      expect(hidden.bodyIds).toEqual([lug]);
      expect(hidden.refused).toEqual([]);
      // Shown, the plate is in the scope and refused.
      const shown = scopeOf(document, rows);
      expect(shown.bodyIds).toEqual([plate, lug]);
      expect(shown.refused).toEqual(['Plate']);
    }
  });

  it('scopes a part only its own row builds, so its refusal is reached', () => {
    // Wide active suppresses the lug; its part keeps Narrow.
    const { document: start, plate, lug } = configuredPlate();
    const configured = updateAssemblyComponent(
      activateConfiguration(start, { rowId: 'wide' }),
      { componentId: 'c_lug', configurationId: 'narrow' }
    );
    const document = built(configured, [plate]);
    for (const rows of [
      { narrow: rowBuilt(document, 'narrow', [plate, lug]) },
      {}
    ]) {
      const shown = scopeOf(document, rows);
      expect(shown.bodyIds).toEqual([plate, lug]);
      expect(exportScopeBodyName(document, shown.draw, lug)).toBe(
        'Indicator lug'
      );
      expect(shown.refused).toEqual(['Indicator lug']);
      // Even as the only body, the scope is not empty.
      const alone = built(configured, []);
      expect(scopeOf(alone, rows).bodyIds).toEqual([lug]);
      // Hidden in this browser, it leaves the scope like any body.
      const hidden = scopeOf(alone, rows, [lug]);
      expect(hidden.bodyIds).toEqual([]);
      expect(emptyExportMessage(hidden.scope)).toBe(
        'Show a body before exporting.'
      );
    }
    // A part following the model adds nothing.
    const following = built(
      updateAssemblyComponent(configured, {
        componentId: 'c_lug',
        configurationId: null
      }),
      [plate]
    );
    expect(scopeOf(following).draw).toBe(NO_ROW_DRAW);
    expect(scopeOf(following).bodyIds).toEqual([plate]);
  });

  it('scopes a part the active row hides while its own row shows it', () => {
    // Narrow active hides the lug through its Visible cell; the lug's part
    // is set to Wide, which builds and shows it, so Assemble draws it.
    const { document: start, plate, lug, lugFeature } = configuredPlate();
    const document = built(
      updateAssemblyComponent(
        shownIn(suppress(start, 'wide', lugFeature, false), lug, {
          narrow: false,
          wide: true
        }),
        { componentId: 'c_lug', configurationId: 'wide' }
      ),
      [plate, lug]
    );
    expect(getParameterHiddenBodyIds(document).has(lug)).toBe(true);
    for (const rows of [
      { wide: rowBuilt(document, 'wide', [plate, lug]) },
      {}
    ]) {
      // Not left out as hidden: the file would hold the plate alone.
      const shown = scopeOf(document, rows);
      expect(shown.bodyIds).toEqual([plate, lug]);
      expect(shown.scope.hiddenExcluded).toBe(0);
      expect(shown.refused).toEqual(['Indicator lug']);
      // A hide in this browser still leaves it out, as in the viewport.
      const local = scopeOf(document, rows, [lug]);
      expect(local.bodyIds).toEqual([plate]);
      expect(local.refused).toEqual([]);
    }
    // A part following the model is hidden with the active row.
    const following = built(
      updateAssemblyComponent(document, {
        componentId: 'c_lug',
        configurationId: null
      }),
      [plate, lug]
    );
    expect(scopeOf(following).bodyIds).toEqual([plate]);
  });

  it('leaves out a part whose own row shows nothing for it', () => {
    const { document: start, plate, lug, lugFeature } = configuredPlate();
    // Suppressed in Narrow and in Wide, and set to Wide: Assemble draws the
    // plate alone, so the plate alone exports, with no refusal.
    const suppressed = built(
      updateAssemblyComponent(suppress(start, 'narrow', lugFeature, true), {
        componentId: 'c_lug',
        configurationId: 'wide'
      }),
      [plate]
    );
    const drawn = scopeOf(suppressed, {
      wide: rowBuilt(suppressed, 'wide', [plate])
    });
    expect(drawn.bodyIds).toEqual([plate]);
    expect(drawn.refused).toEqual([]);
    // Before Wide is built the part is scoped by the body it was made
    // from, and the exact export, which builds Wide, leaves it out.
    expect(scopeOf(suppressed).bodyIds).toEqual([plate, lug]);

    // Built and shown by Narrow, hidden by Wide, and set to Wide: Assemble
    // draws nothing in the lug's place.
    const hiddenThere = built(
      updateAssemblyComponent(
        shownIn(suppress(start, 'wide', lugFeature, false), lug, {
          narrow: true,
          wide: false
        }),
        { componentId: 'c_lug', configurationId: 'wide' }
      ),
      [plate, lug]
    );
    const removed = scopeOf(hiddenThere, {
      wide: rowBuilt(hiddenThere, 'wide', [plate, lug])
    });
    expect(removed.bodyIds).toEqual([plate]);
    expect(removed.scope.hiddenExcluded).toBe(1);
    expect(removed.refused).toEqual([]);
  });

  it('never stops another row for the active row having nothing to export', () => {
    // Narrow suppresses every body; Wide builds the plate.
    const { document: start, plateFeature, lugFeature } = configuredPlate();
    let document = addConfigurationColumn(start, {
      column: { kind: 'suppression', featureId: plateFeature }
    });
    document = suppress(document, 'narrow', plateFeature, true);
    document = built(suppress(document, 'narrow', lugFeature, true), []);
    const scope = scopeOf(document);
    expect(scope.bodyIds).toEqual([]);
    // The model's own export has nothing to write…
    expect(exportTargetEmpty(exportTargetFor(document, null, []))).toBe(true);
    expect(exportTargetEmpty(exportTargetFor(document, 'narrow', []))).toBe(
      true
    );
    // …while "Export Wide" is the kernel's to list, and is not stopped.
    const wide = exportTargetFor(document, 'wide', []);
    expect(wide.document.configurations?.activeRowId).toBe('wide');
    expect(exportTargetEmpty(wide)).toBe(false);
  });
});
