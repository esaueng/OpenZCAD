import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  appendRevision,
  createProjectDocument,
  findSketch,
  getLatestSketchId,
  updateSketchObject
} from '@openzcad/document-core';
import {
  computeSketchProfileAnalysis,
  setTextFontProvider
} from '@openzcad/geometry';
import {
  assertDocumentTextBudget,
  MAX_DOCUMENT_TEXT_OBJECTS,
  MAX_SKETCH_TEXT_OBJECTS,
  MAX_TEXT_OBJECT_CODE_UNITS,
  toEntityId,
  toUserId,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import { loadTestFont } from '../packages/geometry/src/text/testFonts';

function text(text: string): SketchObjectData {
  return {
    objectKind: 'text',
    text,
    fontFamily: 'open-sans',
    fontStyle: 'regular',
    size: 10,
    x: 0,
    y: 0
  };
}

function scene() {
  const manager = new CommandManager(
    createProjectDocument('Text edits', toUserId('user_test'))
  );
  manager.execute(
    commandFactories.addSketch({
      name: 'Label',
      plane: 'XY',
      offset: 0,
      objects: [text('HI')]
    })
  );
  const sketchId = getLatestSketchId(manager.document)!;
  const sketch = findSketch(manager.document, sketchId)!;
  const objectId = sketch.objectIds[0]!;
  const edit = (value: string) =>
    commandFactories.updateSketchObject({
      sketchId,
      objectId,
      data: text(value)
    });
  return { manager, sketchId, objectId, edit };
}

function expectUnchanged(
  manager: CommandManager,
  previous: ProjectDocument,
  serialized: string
) {
  expect(manager.document).toBe(previous);
  expect(JSON.stringify(manager.document)).toBe(serialized);
}

describe('atomic text command budgets', () => {
  beforeAll(async () => {
    const font = await loadTestFont('open-sans');
    setTextFontProvider(() => font);
  });
  afterAll(() => setTextFontProvider(null));

  it('refuses unsafe normalization atomically and preserves valid normalization history semantics', () => {
    const { manager, objectId, edit } = scene();
    const previous = manager.document;
    const serialized = JSON.stringify(previous);
    const cursor = previous.editHistory!.cursor;
    const entryCount = previous.editHistory!.entries.length;
    expect(() =>
      manager.normalize(edit('A'.repeat(MAX_TEXT_OBJECT_CODE_UNITS + 1)))
    ).toThrow('outline limit');
    expectUnchanged(manager, previous, serialized);
    manager.normalize(edit('OK'));
    expect(manager.document.nodes[objectId]).toMatchObject({
      data: { text: 'OK' }
    });
    expect(manager.document.editHistory!.cursor).toBe(cursor);
    expect(manager.document.editHistory!.entries).toHaveLength(entryCount);
    expect(manager.document.revisions).toHaveLength(
      previous.revisions.length + 1
    );
    expect(() => assertDocumentTextBudget(manager.document)).not.toThrow();
    manager.undo();
    expect(manager.document.nodes[objectId]).toBeUndefined();
    manager.redo();
    expect(manager.document.nodes[objectId]).toMatchObject({
      data: { text: 'OK' }
    });
  });

  it.each(['new sketch', 'existing sketch'] as const)(
    'refuses oversized text creation in a %s before publishing nodes or history',
    (mode) => {
      const { manager, sketchId } = scene();
      const previous = manager.document;
      const serialized = JSON.stringify(previous);
      const objects = [text('A'.repeat(MAX_TEXT_OBJECT_CODE_UNITS + 1))];
      const command =
        mode === 'new sketch'
          ? commandFactories.addSketch({
              name: 'Unsafe label',
              plane: 'XY',
              offset: 0,
              objects
            })
          : commandFactories.addSketchObjects({ sketchId, objects });
      expect(() => manager.execute(command)).toThrow('outline limit');
      expectUnchanged(manager, previous, serialized);
    }
  );

  it.each(['execute', 'transaction'] as const)(
    'refuses a 257-unit %s edit before history changes, then accepts a complete 256-unit edit',
    (mode) => {
      const { manager, sketchId, objectId, edit } = scene();
      const previous = manager.document;
      const serialized = JSON.stringify(previous);
      const excessive = edit('I'.repeat(MAX_TEXT_OBJECT_CODE_UNITS + 1));
      expect(() =>
        mode === 'execute'
          ? manager.execute(excessive)
          : manager.runTransaction('Edit label', [
              commandFactories.renameNode({
                nodeId: findSketch(manager.document, sketchId)!.id,
                name: 'Should roll back'
              }),
              excessive
            ])
      ).toThrow('outline limit');
      expectUnchanged(manager, previous, serialized);
      const accepted = 'I'.repeat(MAX_TEXT_OBJECT_CODE_UNITS);
      manager.runTransaction('Edit label', [edit(accepted)]);
      expect(manager.document.nodes[objectId]).toMatchObject({
        data: { text: accepted }
      });
      const stored = JSON.parse(
        JSON.stringify(manager.document)
      ) as ProjectDocument;
      expect(() => assertDocumentTextBudget(stored)).not.toThrow();
      const node = stored.nodes[objectId]!;
      if (node.kind !== 'sketch-object') throw new Error('Expected label');
      const analysis = computeSketchProfileAnalysis(
        [{ id: objectId, data: node.data }],
        (value) => Number(value)
      );
      expect(analysis.diagnostics).toEqual([]);
      expect(analysis.profiles).toHaveLength(MAX_TEXT_OBJECT_CODE_UNITS);
      manager.undo();
      expect(manager.document.nodes[objectId]).toMatchObject({
        data: { text: 'HI' }
      });
      manager.redo();
      expect(manager.document.nodes[objectId]).toMatchObject({
        data: { text: accepted }
      });
    }
  );

  it('allows an atomic replacement whose intermediate collection exceeds the sketch limit', () => {
    const manager = new CommandManager(
      createProjectDocument('Atomic replacement', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.addSketch({
        name: 'Labels',
        plane: 'XY',
        offset: 0,
        objects: Array.from({ length: MAX_SKETCH_TEXT_OBJECTS }, () =>
          text('A')
        )
      })
    );
    const sketchId = getLatestSketchId(manager.document)!;
    const firstId = findSketch(manager.document, sketchId)!.objectIds[0]!;
    expect(() =>
      manager.runTransaction('Replace label', [
        commandFactories.addSketchObjects({ sketchId, objects: [text('B')] }),
        commandFactories.deleteSketchObject({ sketchId, objectId: firstId })
      ])
    ).not.toThrow();
    expect(findSketch(manager.document, sketchId)!.objectIds).toHaveLength(
      MAX_SKETCH_TEXT_OBJECTS
    );
    manager.undo();
    expect(manager.document.nodes[firstId]).toMatchObject({
      data: { text: 'A' }
    });
    manager.redo();
    expect(manager.document.nodes[firstId]).toBeUndefined();
  });

  it.each(['undo', 'redo'] as const)(
    'refuses unsafe legacy %s without advancing history or revisions',
    (direction) => {
      const { manager, objectId } = scene();
      const candidate = structuredClone(manager.document);
      const original = structuredClone(candidate.nodes[objectId]!);
      if (original.kind !== 'sketch-object') throw new Error('Expected label');
      const unsafe = {
        ...original,
        data: text('A'.repeat(MAX_TEXT_OBJECT_CODE_UNITS + 1))
      };
      const history = candidate.editHistory!;
      history.entries.push({
        id: `unsafe-${direction}`,
        label: 'Legacy text',
        changes: [
          {
            kind: 'value',
            field: 'nodes',
            key: objectId,
            before: direction === 'undo' ? unsafe : original,
            after: direction === 'undo' ? original : unsafe
          }
        ]
      });
      history.cursor =
        direction === 'undo'
          ? history.entries.length
          : history.entries.length - 1;
      const legacy = new CommandManager(candidate);
      const serialized = JSON.stringify(candidate);
      expect(() =>
        direction === 'undo' ? legacy.undo() : legacy.redo()
      ).toThrow('outline limit');
      expectUnchanged(legacy, candidate, serialized);
    }
  );

  it('refuses unsafe document adoption atomically and accepts a normal restore', () => {
    const { manager, objectId, sketchId } = scene();
    const previous = manager.document;
    const serialized = JSON.stringify(previous);
    const restore = (value: string) =>
      appendRevision(
        updateSketchObject(previous, { sketchId, objectId, data: text(value) }),
        'Restore label'
      );
    expect(() =>
      manager.applyDocumentEdit(
        restore('A'.repeat(MAX_TEXT_OBJECT_CODE_UNITS + 1)),
        'Restore label'
      )
    ).toThrow('outline limit');
    expectUnchanged(manager, previous, serialized);
    manager.applyDocumentEdit(restore('OK'), 'Restore label');
    expect(manager.document.nodes[objectId]).toMatchObject({
      data: { text: 'OK' }
    });
    manager.undo();
    expect(manager.document.nodes[objectId]).toMatchObject({
      data: { text: 'HI' }
    });
    manager.redo();
    expect(manager.document.nodes[objectId]).toMatchObject({
      data: { text: 'OK' }
    });
  });

  it('refuses a newly generated over-budget history before publishing an otherwise safe adoption', () => {
    let document = createProjectDocument('Full labels', toUserId('user_test'));
    for (
      let index = 0;
      index < MAX_DOCUMENT_TEXT_OBJECTS / MAX_SKETCH_TEXT_OBJECTS;
      index += 1
    ) {
      document = addSketchFeature(document, {
        name: `Labels ${index}`,
        plane: 'XY',
        offset: 0,
        objects: Array.from({ length: MAX_SKETCH_TEXT_OBJECTS }, () => text(''))
      }).document;
    }
    const manager = new CommandManager(document);
    const prospective = structuredClone(document);
    const sketch = findSketch(prospective, getLatestSketchId(prospective)!)!;
    sketch.objectIds = sketch.objectIds.map((id, index) => {
      const node = prospective.nodes[id]!;
      const replacement = toEntityId(`replacement-${index}`);
      prospective.nodes[replacement] = { ...node, id: replacement };
      delete prospective.nodes[id];
      return replacement;
    });
    expect(() => assertDocumentTextBudget(prospective)).not.toThrow();
    const serialized = JSON.stringify(document);
    expect(() =>
      manager.applyDocumentEdit(prospective, 'Restore labels')
    ).toThrow('Project text exceeds');
    expectUnchanged(manager, document, serialized);
  });
});
