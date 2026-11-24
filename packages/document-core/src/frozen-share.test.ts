import { describe, expect, it } from 'vitest';
import {
  BODY_COLOR_METADATA_KEY,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  duplicateProjectDocument,
  frozenShareDocument,
  frozenShareDocumentProblem,
  importStepBody,
  initiallyHiddenBodyIds,
  isSharedWithoutHistory,
  listNodesByKind,
  isTweakableWithoutHistory,
  setParameter,
  sharedProjectSnapshotDocument,
  tweakableShareDocument,
  tweakableShareDocumentProblem,
  withoutSharedHistoryMark
} from './index';

const STEP = 'ISO-10303-21;\nEND-ISO-10303-21;\n';
const owner = toUserId('user_owner');

function frozen(): ProjectDocument {
  const source = createProjectDocument('Bracket', owner, 'cm');
  return frozenShareDocument(source, [
    { name: 'Plate', stepText: STEP, color: '#ff0000', opacity: 0.5 },
    { name: 'Pin', stepText: `${STEP}\n`, color: null, opacity: null }
  ]);
}

describe('frozenShareDocument', () => {
  it('holds one imported solid per body and nothing else', () => {
    const source = createProjectDocument('Bracket', owner, 'cm');
    const document = frozenShareDocument(source, [
      { name: 'Plate', stepText: STEP, color: '#ff0000', opacity: 0.5 },
      { name: 'Pin', stepText: STEP, color: null, opacity: null }
    ]);
    expect(document.projectId).toBe(source.projectId);
    expect(document.name).toBe('Bracket');
    expect(document.units).toBe('cm');
    expect(document.ownerUserId).toBe('user_shared');
    const features = listNodesByKind(document, 'feature');
    expect(features.map((node) => node.featureKind)).toEqual([
      'imported-step',
      'imported-step'
    ]);
    expect(features.map((node) => node.name)).toEqual(['Plate', 'Pin']);
    expect(document.featureOrder).toHaveLength(2);
    expect(document.sketchOrder).toEqual([]);
    expect(document.parameterOrder).toEqual([]);
    expect(document.revisions).toEqual([]);
    expect(document.checkpoints).toEqual([]);
    expect(document.commandLog).toEqual([]);
    const [plate, pin] = listNodesByKind(document, 'body');
    expect(plate?.metadata).toMatchObject({
      [BODY_COLOR_METADATA_KEY]: '#ff0000',
      colorChosen: true,
      opacity: 0.5
    });
    expect(pin?.metadata?.colorChosen).toBeUndefined();
    expect(isSharedWithoutHistory(document)).toBe(true);
    expect(frozenShareDocumentProblem(document)).toBeNull();
  });

  it('marks the bodies the owner hid, and only those', () => {
    const document = frozenShareDocument(
      createProjectDocument('Bracket', owner),
      [
        { name: 'Plate', stepText: STEP, color: null, opacity: null },
        {
          name: 'Cover',
          stepText: STEP,
          color: null,
          opacity: null,
          hidden: true
        }
      ]
    );
    const [plate, cover] = listNodesByKind(document, 'body');
    expect(initiallyHiddenBodyIds(document)).toEqual([cover!.bodyId]);
    expect(plate?.metadata?.initiallyHidden).toBeUndefined();
    expect(frozenShareDocumentProblem(document)).toBeNull();
  });

  it('refuses a model with no solid body', () => {
    expect(() =>
      frozenShareDocument(createProjectDocument('Empty', owner), [])
    ).toThrow(/no solid body/);
  });

  it('still passes once stored and read back', () => {
    const stored = sharedProjectSnapshotDocument(
      assertStorableDocument(JSON.parse(JSON.stringify(frozen())))
    );
    expect(frozenShareDocumentProblem(stored)).toBeNull();
  });
});

describe('frozenShareDocumentProblem', () => {
  it('refuses an ordinary project, marked or not', () => {
    const project = sharedProjectSnapshotDocument(
      createProjectDocument('Bracket', owner)
    );
    expect(frozenShareDocumentProblem(project)).toMatch(/not marked/);
  });

  it.each<[string, (document: ProjectDocument) => void]>([
    [
      'a parameter',
      (document) => {
        document.parameterOrder = ['param_1' as never];
      }
    ],
    [
      'a save state',
      (document) => {
        document.revisions = [{ revisionId: 'rev_1' } as never];
      }
    ],
    [
      'a command log',
      (document) => {
        document.commandLog = [{ type: 'noop' } as never];
      }
    ],
    [
      'undo history',
      (document) => {
        document.editHistory = { undo: [], redo: [] } as never;
      }
    ],
    [
      'configurations',
      (document) => {
        document.configurations = { rows: [] } as never;
      }
    ],
    [
      'a feature that is not an imported solid',
      (document) => {
        const feature = listNodesByKind(document, 'feature')[0]!;
        (feature as { featureKind: string }).featureKind = 'extrude';
      }
    ],
    [
      'an import that points at a stored source',
      (document) => {
        const feature = listNodesByKind(document, 'feature')[0]!;
        const data = feature.data as unknown as Record<string, unknown>;
        delete data.stepText;
        data.stepSourceRef = { marker: 'openzcad-source-ref' };
      }
    ],
    [
      'a sketch node',
      (document) => {
        document.nodes.ent_sketch = {
          id: 'ent_sketch',
          kind: 'sketch',
          name: 'Sketch 1',
          parentId: null,
          revisionId: null
        } as never;
      }
    ],
    [
      'a hidden mark that carries a value',
      (document) => {
        const body = listNodesByKind(document, 'body')[0]!;
        body.metadata = { ...body.metadata, initiallyHidden: 'secret' };
      }
    ],
    [
      'extra feature metadata',
      (document) => {
        const feature = listNodesByKind(document, 'feature')[0]!;
        feature.metadata = { note: 'secret' };
      }
    ]
  ])('refuses %s', (_label, change) => {
    const document = structuredClone(frozen());
    change(document);
    expect(frozenShareDocumentProblem(document)).not.toBeNull();
  });
});

describe('a copy of a model shared without history', () => {
  it('is an ordinary project of imported solids', () => {
    const copy = withoutSharedHistoryMark(
      duplicateProjectDocument(frozen(), 'Bracket', toUserId('user_visitor'))
    );
    expect(isSharedWithoutHistory(copy)).toBe(false);
    expect(
      listNodesByKind(copy, 'feature').map((node) => node.featureKind)
    ).toEqual(['imported-step', 'imported-step']);
    expect(copy.sketchOrder).toEqual([]);
    expect(copy.parameterOrder).toEqual([]);
    // Only the copy's own first save state: nothing of the owner's.
    expect(copy.revisions).toHaveLength(1);
  });

  it('keeps which bodies start hidden', () => {
    const shared = frozenShareDocument(
      createProjectDocument('Bracket', owner),
      [
        {
          name: 'Cover',
          stepText: STEP,
          color: null,
          opacity: null,
          hidden: true
        }
      ]
    );
    const copy = withoutSharedHistoryMark(
      duplicateProjectDocument(shared, 'Bracket', toUserId('user_visitor'))
    );
    expect(initiallyHiddenBodyIds(copy)).toEqual(
      listNodesByKind(copy, 'body').map((node) => node.bodyId)
    );
  });

  it('leaves an ordinary document alone', () => {
    const base = createProjectDocument('Bracket', owner);
    const withImport = importStepBody(base, {
      name: 'Body',
      artifactId: 'artifact_local_1',
      sourceName: 'body.step',
      stepText: STEP
    }).document;
    expect(withoutSharedHistoryMark(withImport)).toBe(withImport);
  });
});

describe('tweakableShareDocument', () => {
  /** An owner's parametric model, with names, a warning and a past. */
  function recipeSource(): ProjectDocument {
    let document = setParameter(createProjectDocument('Bracket', owner), {
      name: 'width',
      expression: '20'
    });
    document = addPrimitiveFeature(document, {
      name: 'Secret boss',
      primitiveKind: 'box',
      dimensions: { width: 'width', height: 10, depth: 4 }
    });
    return {
      ...document,
      commandLog: [{ kind: 'secret' } as never],
      editHistory: { undo: [], redo: [] } as never,
      derived: {
        ...document.derived,
        warnings: ['Secret boss could not be filleted.']
      }
    };
  }

  it('keeps the recipe, without its history or the names it was built with', () => {
    const source = recipeSource();
    const [body] = listNodesByKind(source, 'body');
    const document = tweakableShareDocument(source, new Set([body!.bodyId]));
    expect(isSharedWithoutHistory(document)).toBe(true);
    expect(isTweakableWithoutHistory(document)).toBe(true);
    expect(document.revisions).toEqual([]);
    expect(document.commandLog).toEqual([]);
    expect(document.editHistory).toBeUndefined();
    expect(document.derived.warnings).toEqual([]);
    expect(document.ownerUserId).toBe('user_shared');
    expect(document.parameterOrder).toHaveLength(1);
    expect(
      listNodesByKind(document, 'feature').map((node) => node.name)
    ).toEqual(['Feature 1']);
    expect(initiallyHiddenBodyIds(document)).toEqual([body!.bodyId]);
    // Bodies keep their names; nothing else says "Secret boss".
    const nodes = Object.values(document.nodes).filter(
      (node) => node.kind !== 'body'
    );
    expect(JSON.stringify({ ...document, nodes })).not.toContain('Secret');
    expect(tweakableShareDocumentProblem(document)).toBeNull();
    // The Worker's one check accepts it as a model without history.
    expect(frozenShareDocumentProblem(document)).toBeNull();
    expect(
      frozenShareDocumentProblem(
        sharedProjectSnapshotDocument(
          assertStorableDocument(JSON.parse(JSON.stringify(document)))
        )
      )
    ).toBeNull();
  });

  it('refuses a model built on an imported file, inline or stored', () => {
    const inline = importStepBody(recipeSource(), {
      name: 'Plate',
      artifactId: 'artifact_local_1',
      sourceName: 'customer-x.step',
      stepText: "ISO-10303-21;\nHEADER;\nFILE_NAME('customer-x');\n"
    }).document;
    expect(() => tweakableShareDocument(inline)).toThrow(/imported file/);
    const stored = structuredClone(inline);
    const feature = listNodesByKind(stored, 'feature').at(-1)!;
    const data = feature.data as unknown as Record<string, unknown>;
    delete data.stepText;
    data.stepSourceRef = { marker: 'openzcad-source-ref' };
    expect(() => tweakableShareDocument(stored)).toThrow(/imported file/);
  });

  it.each<[string, (document: ProjectDocument) => void]>([
    [
      'a feature name',
      (document) => {
        listNodesByKind(document, 'feature')[0]!.name = 'Secret boss';
      }
    ],
    [
      'an imported file',
      (document) => {
        const feature = listNodesByKind(document, 'feature')[0]!;
        (feature as { featureKind: string }).featureKind = 'imported-step';
      }
    ],
    [
      'an imported file named only in its data',
      (document) => {
        const feature = listNodesByKind(document, 'feature')[0]!;
        const data = feature.data as unknown as Record<string, unknown>;
        data.featureKind = 'imported-step';
        data.stepText = "ISO-10303-21;\nFILE_NAME('customer-x');";
      }
    ],
    [
      'the owner\u2019s edit time',
      (document) => {
        document.derived.updatedAt = '2026-11-20T10:00:00.000Z';
      }
    ],
    [
      'a rebuild warning',
      (document) => {
        document.derived.warnings = ['Secret boss failed.'];
      }
    ],
    [
      'its owner',
      (document) => {
        document.ownerUserId = owner;
      }
    ],
    [
      'a save state',
      (document) => {
        document.revisions = [{ revisionId: 'rev_1' } as never];
      }
    ],
    [
      'undo history',
      (document) => {
        document.editHistory = { undo: [], redo: [] } as never;
      }
    ],
    [
      'drawings',
      (document) => {
        document.drawings = { sheets: [] };
      }
    ]
  ])('refuses %s', (_label, change) => {
    const document = tweakableShareDocument(recipeSource());
    change(document);
    expect(frozenShareDocumentProblem(document)).not.toBeNull();
  });

  it('copies as an ordinary project, without either mark', () => {
    const copy = withoutSharedHistoryMark(
      tweakableShareDocument(recipeSource())
    );
    expect(isSharedWithoutHistory(copy)).toBe(false);
    expect(isTweakableWithoutHistory(copy)).toBe(false);
  });
});
