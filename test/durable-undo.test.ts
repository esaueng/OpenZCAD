import { describe, expect, it, vi } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder,
  normalizeDocument,
  recordDocumentEdit,
  withoutDerivedProjection,
  duplicateProjectDocument
} from '@openzcad/document-core';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  isDocumentHistory,
  MAX_UNDO_BYTES,
  MAX_UNDO_STEPS,
  toUserId,
  type DocumentHistory,
  type ProjectDocument
} from '@openzcad/shared';
import { InMemoryPersistenceService } from '@openzcad/persistence';
import { parseSaveProjectDocumentRequest } from '../apps/web/worker/validation';

const owner = toUserId('user_history');
const initial = () => createProjectDocument('History fixture', owner);
const box = (size = 10) =>
  commandFactories.addPrimitive({
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: size, height: size, depth: size }
  });
const reopen = (manager: CommandManager) =>
  new CommandManager(
    normalizeDocument(
      JSON.parse(
        JSON.stringify(withoutDerivedProjection(manager.document))
      ) as typeof manager.document
    )
  );

function content(manager: CommandManager) {
  const {
    version: _version,
    revisions: _revisions,
    checkpoints: _checkpoints,
    derived: _derived,
    editHistory: _history,
    ...model
  } = manager.document;
  return model;
}

describe('durable undo', () => {
  it('survives serialization and reopening in both directions with monotonic revisions', () => {
    let a = new CommandManager(initial());
    const empty = content(a);
    a.execute(box());
    const solid = content(a);
    const version = a.document.version;
    a = reopen(a);
    expect(a.canUndo).toBe(true);
    a.undo();
    expect(content(a)).toEqual(empty);
    expect(a.document.version).toBeGreaterThan(version);
    a = reopen(a);
    expect(a.canRedo).toBe(true);
    a.redo();
    expect(content(a)).toEqual(solid);
  });

  it('round trips through cloud autosave without a named checkpoint', async () => {
    const store = new InMemoryPersistenceService();
    const { document } = await store.createProject(owner, {
      name: 'Cloud history',
      units: 'mm'
    });
    const a = new CommandManager(document);
    a.execute(box());
    await store.saveDocument(owner, {
      projectId: document.projectId,
      expectedVersion: document.version,
      document: a.document
    });
    const b = new CommandManager(
      (await store.loadProject(owner, document.projectId))!
    );
    b.undo();
    await store.saveDocument(owner, {
      projectId: document.projectId,
      expectedVersion: a.document.version,
      document: b.document
    });
    const c = new CommandManager(
      (await store.loadProject(owner, document.projectId))!
    );
    expect(c.document.bodyOrder).toHaveLength(0);
    expect(c.canRedo).toBe(true);
    c.redo();
    expect(c.document.bodyOrder).toHaveLength(1);
  });

  it('clears redo after a new edit and groups transactions', () => {
    let a = new CommandManager(initial());
    a.runTransaction('Two boxes', [box(), box(20)]);
    a = reopen(a);
    expect(a.undoLabel).toBe('Two boxes');
    a.undo();
    expect(a.document.bodyOrder).toHaveLength(0);
    a.execute(box(30));
    a = reopen(a);
    expect(a.canRedo).toBe(false);
    expect(a.document.bodyOrder).toHaveLength(1);
  });

  it('archives an undone import without making its source device-only after redo', () => {
    let a = new CommandManager(initial());
    a.execute(
      commandFactories.importStep({
        name: 'Source fixture',
        artifactId: 'artifact_local_fixture',
        sourceName: 'fixture.step',
        stepSourceRef: {
          marker: 'openzcad-source-ref',
          version: 1,
          hashAlgorithm: 'sha256',
          checksumSha256: 'a'.repeat(64),
          logicalBytes: 100
        }
      })
    );
    const featureId = a.document.featureOrder[0]!;
    a.undo();
    a.archiveSource(featureId, 'artifact_cloud_fixture');
    expect(a.canRedo).toBe(true);
    expect(JSON.stringify(a.document)).not.toContain('artifact_local_fixture');
    a = reopen(a);
    a.redo();
    expect(a.document.featureOrder).toEqual([featureId]);
    expect(JSON.stringify(a.document)).toContain('artifact_cloud_fixture');
    a.undo();
    expect(a.document.featureOrder).toHaveLength(0);
  });

  it('does not let another collaborator undo an earlier author', () => {
    const a = new CommandManager(initial());
    a.execute(box());
    const b = new CommandManager(a.document, toUserId('user_other'));
    expect(b.canUndo).toBe(false);
    b.execute(box(20));
    b.undo();
    expect(b.document.bodyOrder).toHaveLength(1);
    expect(b.canUndo).toBe(false);
  });

  it('bounds history and never embeds derived meshes or recursive history', () => {
    const a = new CommandManager(initial());
    for (let index = 0; index < 105; index++)
      a.execute(
        commandFactories.renameNode({
          nodeId: a.document.rootNodeId,
          name: `Part ${index}`
        })
      );
    expect(a.document.editHistory?.entries).toHaveLength(100);
    expect(a.document.editHistory?.trimmed).toBe(5);
    expect(JSON.stringify(a.document.editHistory)).not.toContain(
      'bodyRepresentations'
    );
    expect(JSON.stringify(a.document.editHistory)).not.toContain('editHistory');
    expect(
      isDocumentHistory(a.document.editHistory, a.document.projectId)
    ).toBe(true);
  });

  it('rejects corrupt history and protected-field patches', () => {
    const a = new CommandManager(initial());
    a.execute(box());
    const corrupt = structuredClone(a.document);
    corrupt.editHistory!.entries[0]!.changes[0]!.field = 'ownerUserId' as never;
    // Loading drops the unreadable history rather than refusing the model; the
    // patch is never reachable either way.
    const reopened = normalizeDocument(corrupt);
    expect(reopened.editHistory).toBeUndefined();
    expect(reopened.bodyOrder).toEqual(a.document.bodyOrder);
    expect(() => new CommandManager(corrupt)).toThrow('undo history');
    expect(isDocumentHistory(a.document.editHistory, 'another_project')).toBe(
      false
    );
  });

  it('starts a duplicate with independent history and opens legacy documents', () => {
    const a = new CommandManager(initial());
    expect(a.canUndo).toBe(false);
    a.execute(box());
    const duplicate = duplicateProjectDocument(a.document, 'Copy', owner);
    expect(new CommandManager(duplicate).canUndo).toBe(false);
  });

  it('keeps a normalization inside adjacent snapshot endpoints', () => {
    let a = new CommandManager(initial());
    a.execute(box());
    const original = content(a);
    a.normalize(
      commandFactories.renameNode({
        nodeId: a.document.rootNodeId,
        name: 'Normalized'
      })
    );
    a = reopen(a);
    a.undo();
    expect(a.document.bodyOrder).toHaveLength(0);
    a.redo();
    expect(a.document.name).toBe('Normalized');
    expect(a.document.bodyOrder).toEqual(original.bodyOrder);
    a.undo();
    a.normalize(
      commandFactories.renameNode({
        nodeId: a.document.rootNodeId,
        name: 'Repaired'
      })
    );
    a = reopen(a);
    a.redo();
    expect(a.document.bodyOrder).toHaveLength(1);
    a.undo();
    expect(a.document.name).toBe('Repaired');
  });
});

it('refuses a stale history endpoint without modifying the current model', () => {
  const manager = new CommandManager(initial());
  manager.execute(box());
  const changed = structuredClone(manager.document);
  const feature = Object.values(changed.nodes).find(
    (node) => node.kind === 'feature'
  )!;
  feature.name = 'Changed outside history';
  const stale = new CommandManager(changed);
  expect(() => stale.undo()).toThrow('does not match');
  expect(stale.document).toBe(changed);
});

describe('undo history the loaders and the account accept', () => {
  const managerWithBoxes = (count: number) => {
    const manager = new CommandManager(initial());
    for (let index = 0; index < count; index += 1) manager.execute(box());
    return manager;
  };

  function expectReopenable(document: ProjectDocument) {
    const saved = structuredClone(withoutDerivedProjection(document));
    expect(isDocumentHistory(saved.editHistory, saved.projectId)).toBe(true);
    expect(normalizeDocument(saved).editHistory).toEqual(saved.editHistory);
    expect(() => new CommandManager(saved)).not.toThrow();
    // The account's write screen (the room screens with the same validator).
    expect(
      parseSaveProjectDocumentRequest(
        {
          projectId: saved.projectId,
          expectedVersion: saved.version - 1,
          document: saved
        },
        saved.projectId
      ).document.editHistory
    ).toEqual(saved.editHistory);
  }

  it('records "Roll back after" over more than 100 features as a reopenable entry', () => {
    const manager = managerWithBoxes(102);
    const features = listFeaturesInOrder(manager.document);
    // The command list handleRollbackAfterFeature builds.
    manager.runTransaction(
      `Roll back after ${features[0]!.name}`,
      features.slice(1).map((feature) =>
        commandFactories.setNodeMetadata(
          {
            nodeId: feature.id,
            metadata: { [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: true }
          },
          `Roll back ${feature.name}`
        )
      )
    );
    expect(manager.undoEntryKinds).toEqual(['node.metadata.set']);
    expectReopenable(manager.document);
  });

  it('records a 101-solid STEP import as a reopenable entry', () => {
    const manager = managerWithBoxes(0);
    // The shape stepImportRun builds for a multi-solid STEP file.
    manager.execute(
      composeCommands(
        'Import STEP bodies',
        Array.from({ length: 101 }, (_, index) =>
          commandFactories.importStep({
            name: `assembly.step — Body ${index + 1}`,
            artifactId: 'artifact_local_fixture',
            sourceName: 'assembly.step',
            stepSourceRef: {
              marker: 'openzcad-source-ref',
              version: 1,
              hashAlgorithm: 'sha256',
              checksumSha256: 'a'.repeat(64),
              logicalBytes: 1234
            },
            solidIndices: [index]
          })
        )
      )
    );
    expect(manager.document.featureOrder).toHaveLength(101);
    expectReopenable(manager.document);
  });

  it('keeps a long parameter-only batch undoable in Tweak', () => {
    const manager = managerWithBoxes(0);
    manager.runTransaction(
      'Set parameters',
      Array.from({ length: 150 }, (_, index) =>
        commandFactories.setParameter({
          name: `p${index}`,
          expression: String(index)
        })
      )
    );
    expect(manager.undoEntryKinds).toEqual(['parameter.set']);
    expectReopenable(manager.document);
  });

  it('leaves out kinds the validator would refuse rather than writing them', () => {
    const before = initial();
    const recorded = recordDocumentEdit(
      before,
      { ...before, name: 'Renamed' },
      'Rename',
      owner,
      Array.from({ length: 101 }, (_, index) => `kind.${index}`)
    );
    expect(recorded.editHistory?.entries[0]?.commandKinds).toBeUndefined();
    expect(isDocumentHistory(recorded.editHistory, recorded.projectId)).toBe(
      true
    );
  });

  it('reopens a project an older writer left with an over-long kind list', () => {
    const manager = managerWithBoxes(1);
    const affected = structuredClone(
      withoutDerivedProjection(manager.document)
    );
    affected.editHistory!.entries[0]!.commandKinds = Array.from(
      { length: 101 },
      () => 'primitive.add'
    );
    expect(isDocumentHistory(affected.editHistory, affected.projectId)).toBe(
      false
    );

    const reopened = new CommandManager(normalizeDocument(affected));
    // The undo stack is the price; the model and its timeline survive.
    expect(reopened.canUndo).toBe(false);
    expect(reopened.document.bodyOrder).toEqual(manager.document.bodyOrder);
    expect(reopened.document.version).toBe(manager.document.version);
    reopened.execute(box(20));
    expect(
      isDocumentHistory(reopened.document.editHistory, affected.projectId)
    ).toBe(true);
  });

  it('reports the kinds of the entry redo applies, not the one undo would', () => {
    const manager = managerWithBoxes(1);
    manager.execute(
      commandFactories.setParameter({ name: 'w', expression: '5' })
    );
    const [feature] = listFeaturesInOrder(manager.document);
    manager.execute(
      commandFactories.deleteFeature({ featureId: feature!.featureId })
    );
    manager.undo();

    expect(manager.undoEntryKinds).toEqual(['parameter.set']);
    expect(manager.redoEntryKinds).toEqual(['feature.delete']);
    // Tweak redoes a parameter-only entry and nothing else: the delete waiting
    // to be redone is modeling, whatever the entry below it was.
    expect(manager.undoIsParameterOnly).toBe(true);
    expect(manager.redoIsParameterOnly).toBe(false);
    manager.redo();
    expect(manager.redoEntryKinds).toBeNull();
    expect(manager.redoIsParameterOnly).toBe(false);
    manager.undo();
    manager.undo();
    // Now the parameter set waits to be redone, and an add sits below it.
    expect(manager.undoIsParameterOnly).toBe(false);
    expect(manager.redoIsParameterOnly).toBe(true);
  });

  it('offers Tweak redo after undoing its only parameter edit', () => {
    const manager = new CommandManager(initial());
    manager.execute(
      commandFactories.setParameter({ name: 'w', expression: '5' })
    );
    expect(manager.canUndoIn(true)).toBe(true);
    expect(manager.canRedoIn(true)).toBe(false);
    manager.undo();
    // Nothing is left to undo, but the parameter set waits to be redone; the
    // toolbar and palette read redo's availability from that entry.
    expect(manager.canUndoIn(true)).toBe(false);
    expect(manager.canRedoIn(true)).toBe(true);
    expect(manager.canRedoIn(false)).toBe(true);

    manager.redo();
    manager.execute(box());
    manager.undo();
    // A modeling step waiting to be redone is Build's, never Tweak's.
    expect(manager.canUndoIn(true)).toBe(true);
    expect(manager.canRedoIn(true)).toBe(false);
    expect(manager.canRedoIn(false)).toBe(true);
  });
});

describe('undo byte bound', () => {
  /** Binary STL coordinates are float32 widened to doubles: long in JSON. */
  function mesh(triangles: number) {
    const vertices: number[] = [];
    const indices: number[] = [];
    for (let index = 0; index < triangles * 9; index += 1)
      vertices.push(Math.fround(Math.sin(index) * 50 + 0.1234567));
    for (let index = 0; index < triangles * 3; index += 1) indices.push(index);
    return { vertices, indices };
  }

  it('serializes an oversized edit a bounded number of times, not once per dropped entry', () => {
    const manager = new CommandManager(initial());
    for (let index = 0; index < MAX_UNDO_STEPS; index += 1)
      manager.execute(
        commandFactories.setParameter({ name: 'w', expression: String(index) })
      );
    const command = commandFactories.importMesh({
      name: 'part.stl',
      artifactId: 'artifact_local_fixture',
      sourceName: 'part.stl',
      triangleCount: 30_000,
      ...mesh(30_000)
    });
    const meshChars = JSON.stringify(command.serialize()).length;
    const stringify = JSON.stringify;
    let serializedChars = 0;
    const spy = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((...args: Parameters<typeof stringify>) => {
        const json = stringify(...args);
        serializedChars += json?.length ?? 0;
        return json;
      });
    try {
      manager.execute(command);
    } finally {
      spy.mockRestore();
    }
    // The import's entry holds the mesh twice (node and command log) and alone
    // exceeds the budget, so every entry drops. Re-serializing the history
    // per dropped entry wrote ~200 copies of the mesh; sizing each entry once
    // writes a handful.
    expect(manager.document.editHistory?.entries).toHaveLength(0);
    expect(manager.document.editHistory?.trimmed).toBe(MAX_UNDO_STEPS + 1);
    expect(serializedChars).toBeLessThan(10 * meshChars);
  });

  it('drops the same entries as re-measuring the whole history each time', () => {
    const bytes = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength;
    /** The bound as it was first written: exact, and quadratic. */
    function reference(history: DocumentHistory): DocumentHistory {
      const result = { ...history, entries: [...history.entries] };
      while (
        result.entries.length > MAX_UNDO_STEPS ||
        bytes(result) > MAX_UNDO_BYTES
      ) {
        if (result.cursor > 0) {
          result.entries.shift();
          result.cursor--;
        } else result.entries.pop();
        result.trimmed++;
      }
      return result;
    }
    const before = initial();
    // 99 entries of uneven size, ~7.9 MB together: the new 300 kB edit must
    // evict a few of the oldest by bytes, not by count.
    const entries = Array.from({ length: 99 }, (_, index) => ({
      id: `entry_${index}`,
      label: `Edit ${index}`,
      changes: [
        {
          kind: 'value' as const,
          field: 'name' as const,
          before: 'x'.repeat(60_000 + ((index * 7919) % 41_000)),
          after: `Name ${index}`
        }
      ]
    }));
    const history: DocumentHistory = {
      schemaVersion: 1,
      projectId: before.projectId,
      actorUserId: owner,
      entries,
      cursor: entries.length,
      trimmed: 7
    };
    expect(bytes(history)).toBeLessThan(MAX_UNDO_BYTES);
    const recorded = recordDocumentEdit(
      { ...before, editHistory: history },
      { ...before, name: 'y'.repeat(300_000) },
      'Long name',
      owner
    ).editHistory!;
    const newest = recorded.entries.at(-1)!;
    expect(newest.label).toBe('Long name');

    const expected = reference({
      ...history,
      entries: [...entries, newest],
      cursor: entries.length + 1
    });
    expect(recorded.trimmed).toBeGreaterThan(history.trimmed);
    expect(recorded.entries.map((entry) => entry.id)).toEqual(
      expected.entries.map((entry) => entry.id)
    );
    expect(recorded.cursor).toBe(expected.cursor);
    expect(recorded.trimmed).toBe(expected.trimmed);
    expect(isDocumentHistory(recorded, before.projectId)).toBe(true);
  });
});
