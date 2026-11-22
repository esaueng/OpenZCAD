import { describe, expect, it } from 'vitest';
import {
  BODY_COLOR_METADATA_KEY,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  assertStorableDocument,
  createProjectDocument,
  duplicateProjectDocument,
  frozenShareDocument,
  frozenShareDocumentProblem,
  importStepBody,
  isSharedWithoutHistory,
  listNodesByKind,
  sharedProjectSnapshotDocument,
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
