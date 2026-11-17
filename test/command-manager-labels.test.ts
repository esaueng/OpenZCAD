import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  meshImportLabel
} from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

/**
 * The status line and the undo toast name what an undo or redo would revert
 * ("Undo Delete Boss"), so the manager exposes the label at each end of its
 * stacks without popping anything.
 */
describe('CommandManager undo and redo labels', () => {
  it('reports the label at the top of each stack, or null when empty', () => {
    const manager = new CommandManager(
      createProjectDocument('Labels', toUserId('user_test'))
    );
    expect(manager.undoLabel).toBeNull();
    expect(manager.redoLabel).toBeNull();

    manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    expect(manager.undoLabel).toBe('Add box');
    expect(manager.redoLabel).toBeNull();

    manager.undo();
    expect(manager.undoLabel).toBeNull();
    expect(manager.redoLabel).toBe('Add box');

    manager.redo();
    expect(manager.undoLabel).toBe('Add box');
    expect(manager.redoLabel).toBeNull();
  });
});

describe('mesh import labels', () => {
  it('names the imported format, not STL for every mesh (#1638)', () => {
    expect(meshImportLabel('part.3mf')).toBe('Import 3MF mesh');
    expect(meshImportLabel('Scan.STL')).toBe('Import STL mesh');
    expect(meshImportLabel('model.obj')).toBe('Import OBJ mesh');
    expect(meshImportLabel('model.glb')).toBe('Import GLB mesh');
    expect(meshImportLabel('cloud.ply')).toBe('Import PLY mesh');
    expect(meshImportLabel('Scan')).toBe('Import mesh');
    expect(meshImportLabel('archive.zip')).toBe('Import mesh');
  });

  it('labels the undo entry of a 3MF import as a 3MF import', () => {
    const manager = new CommandManager(
      createProjectDocument('Mesh labels', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.importMesh({
        name: 'part.3mf',
        artifactId: 'artifact_local_label',
        sourceName: 'part.3mf',
        triangleCount: 1,
        vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2]
      })
    );
    expect(manager.undoLabel).toBe('Import 3MF mesh');
    manager.undo();
    expect(manager.redoLabel).toBe('Import 3MF mesh');
  });
});
