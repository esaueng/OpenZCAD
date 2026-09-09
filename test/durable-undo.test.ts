import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  normalizeDocument,
  withoutDerivedProjection,
  duplicateProjectDocument
} from '@openzcad/document-core';
import { isDocumentHistory, toUserId } from '@openzcad/shared';
import { InMemoryPersistenceService } from '@openzcad/persistence';

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
    expect(() => normalizeDocument(corrupt)).toThrow('undo history');
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
