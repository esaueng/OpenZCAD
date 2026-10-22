import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  nextObjectFolderName,
  normalizeDocument,
  objectFolderOfBody,
  objectFolderPlacements
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  objectFolderSetError,
  toUserId,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import { sharedProjectSnapshotDocument } from '@openzcad/persistence';
import { geometryContentKey } from '../apps/web/src/worker/exactRebuildCache';
import { parseSaveProjectDocumentRequest } from '../apps/web/worker/validation';
import { createProjectDiagnosticBundle } from '../apps/web/src/lib/projectDiagnostics';
import * as webGlimpse from '../apps/web/src/lib/glimpseContract';
import * as workerGlimpse from '../apps/web/worker/glimpseContract';

/**
 * U06 Objects folders (schema v34, research audit ZC-128): folders whose
 * membership is independent of geometry, nest for the I02 STEP hierarchy,
 * follow a body through the features that reshape it, and change only
 * through undoable `objectFolder.*` commands that no rebuild reads.
 */
const owner = toUserId('user_object_folders');

function threeBoxes() {
  const manager = new CommandManager(createProjectDocument('Folders', owner));
  for (const name of ['Base', 'Lug', 'Pin']) {
    manager.execute(
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
  }
  const [base, lug, pin] = manager.document.bodyOrder as [
    BodyId,
    BodyId,
    BodyId
  ];
  return { manager, base, lug, pin };
}

const folderOf = (document: ProjectDocument, bodyId: BodyId) =>
  objectFolderOfBody(document, bodyId);

describe('Objects folders (U06, schema v34)', () => {
  it('is additive and absent from a project without folders', () => {
    const { manager } = threeBoxes();
    expect(manager.document.schemaVersion).toBe(
      PROJECT_DOCUMENT_SCHEMA_VERSION
    );
    expect(manager.document.objectFolders).toBeUndefined();
    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    const older = { ...saved, schemaVersion: 30 } as unknown as ProjectDocument;
    const opened = normalizeDocument(older);
    expect('objectFolders' in opened).toBe(false);
    expect(opened.nodes).toEqual(saved.nodes);
  });

  it('creates a folder with bodies in one undoable step, and renames and nests it', () => {
    const { manager, base, lug, pin } = threeBoxes();
    const before = manager.document;
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_a',
        name: ' Fasteners ',
        parentId: null,
        bodyIds: [lug, pin]
      })
    );
    expect(manager.document.objectFolders?.folders).toEqual([
      { id: 'folder_a', name: 'Fasteners', parentId: null }
    ]);
    expect(folderOf(manager.document, lug)).toBe('folder_a');
    expect(folderOf(manager.document, pin)).toBe('folder_a');
    expect(folderOf(manager.document, base)).toBeNull();
    expect(manager.undoIsObjectFolderOnly).toBe(true);

    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_b',
        name: 'Pins',
        parentId: 'folder_a',
        bodyIds: [pin]
      })
    );
    manager.execute(
      commandFactories.renameObjectFolder({
        folderId: 'folder_a',
        name: 'Hardware'
      })
    );
    expect(folderOf(manager.document, pin)).toBe('folder_b');
    expect(manager.document.objectFolders?.folders).toEqual([
      { id: 'folder_a', name: 'Hardware', parentId: null },
      { id: 'folder_b', name: 'Pins', parentId: 'folder_a' }
    ]);

    // Each was one step: three undos restore the folder-free document.
    manager.undo();
    expect(manager.document.objectFolders?.folders[0]?.name).toBe('Fasteners');
    manager.undo();
    manager.undo();
    expect(manager.document.objectFolders).toBeUndefined();
    expect(manager.document.nodes).toEqual(before.nodes);
    manager.redo();
    expect(folderOf(manager.document, lug)).toBe('folder_a');
  });

  it('moves bodies and folders in and out, and refuses a folder inside itself', () => {
    const { manager, base, lug } = threeBoxes();
    for (const [folderId, parentId] of [
      ['folder_a', null],
      ['folder_b', 'folder_a']
    ] as const) {
      manager.execute(
        commandFactories.createObjectFolder({
          folderId,
          name: folderId,
          parentId
        })
      );
    }
    manager.execute(
      commandFactories.moveToObjectFolder({
        parentId: 'folder_b',
        bodyIds: [base, lug]
      })
    );
    expect(folderOf(manager.document, base)).toBe('folder_b');
    manager.execute(
      commandFactories.moveToObjectFolder({ parentId: null, bodyIds: [base] })
    );
    expect(folderOf(manager.document, base)).toBeNull();
    // Moving out to where it would be anyway leaves no placement behind.
    expect(manager.document.objectFolders?.placements).toEqual({
      [lug]: 'folder_b'
    });

    const version = manager.document.version;
    expect(() =>
      manager.execute(
        commandFactories.moveToObjectFolder({
          parentId: 'folder_b',
          folderIds: ['folder_a']
        })
      )
    ).toThrow(/inside itself/);
    expect(manager.document.version).toBe(version);

    // Out to the top level, the nested folder goes last among its siblings.
    manager.execute(
      commandFactories.moveToObjectFolder({
        parentId: null,
        folderIds: ['folder_b']
      })
    );
    expect(manager.document.objectFolders?.folders).toEqual([
      { id: 'folder_a', name: 'folder_a', parentId: null },
      { id: 'folder_b', name: 'folder_b', parentId: null }
    ]);
    // A move that changes nothing is no edit.
    const settled = manager.document;
    manager.execute(
      commandFactories.moveToObjectFolder({
        parentId: 'folder_b',
        bodyIds: [lug]
      })
    );
    expect(manager.document).toBe(settled);
  });

  it('deletes a folder only: what it held moves up a level', () => {
    const { manager, base, lug } = threeBoxes();
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_a',
        name: 'Outer',
        parentId: null
      })
    );
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_b',
        name: 'Inner',
        parentId: 'folder_a',
        bodyIds: [base]
      })
    );
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_c',
        name: 'Deepest',
        parentId: 'folder_b',
        bodyIds: [lug]
      })
    );
    const bodies = manager.document.bodyOrder;
    manager.execute(
      commandFactories.deleteObjectFolder({ folderId: 'folder_b' })
    );
    expect(manager.document.bodyOrder).toEqual(bodies);
    expect(folderOf(manager.document, base)).toBe('folder_a');
    expect(manager.document.objectFolders?.folders).toEqual([
      { id: 'folder_a', name: 'Outer', parentId: null },
      { id: 'folder_c', name: 'Deepest', parentId: 'folder_a' }
    ]);
    expect(folderOf(manager.document, lug)).toBe('folder_c');
    manager.undo();
    expect(folderOf(manager.document, base)).toBe('folder_b');
  });

  it('keeps a body in its folder as a boolean reshapes it under a new id', () => {
    const { manager, base, lug, pin } = threeBoxes();
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_a',
        name: 'Frame',
        parentId: null,
        bodyIds: [base]
      })
    );
    const union = commandFactories.booleanBodies({
      name: 'Union',
      operation: 'union',
      targetBodyIds: [base, lug]
    });
    manager.execute(union);
    const result = (union.payload.ids as { bodyId: BodyId }).bodyId;
    expect(result).not.toBe(base);
    // The result follows its base body; an explicit placement wins.
    expect(folderOf(manager.document, result)).toBe('folder_a');
    expect(folderOf(manager.document, pin)).toBeNull();
    manager.execute(
      commandFactories.moveToObjectFolder({ parentId: null, bodyIds: [result] })
    );
    expect(folderOf(manager.document, result)).toBeNull();
    expect(folderOf(manager.document, base)).toBe('folder_a');
    expect(objectFolderPlacements(manager.document).get(result)).toBeNull();
  });

  it('never changes the geometry key, and replays to the same folders', () => {
    const { manager, base } = threeBoxes();
    const key = geometryContentKey(manager.document);
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_a',
        name: 'Frame',
        parentId: null,
        bodyIds: [base]
      })
    );
    manager.execute(
      commandFactories.renameObjectFolder({
        folderId: 'folder_a',
        name: 'Frames'
      })
    );
    expect(geometryContentKey(manager.document)).toBe(key);
    const replayed = replayCommands(
      createProjectDocument('Folders', owner),
      manager.document.commandLog
    );
    expect(replayed.objectFolders).toEqual(manager.document.objectFolders);
    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(reopened.objectFolders).toEqual(manager.document.objectFolders);
  });

  it('shares the folders with a share-link visitor, without their history', () => {
    const { manager, base } = threeBoxes();
    expect(
      'objectFolders' in sharedProjectSnapshotDocument(manager.document)
    ).toBe(false);
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_a',
        name: 'Frame',
        parentId: null,
        bodyIds: [base]
      })
    );
    const shared = sharedProjectSnapshotDocument(manager.document);
    expect(shared.objectFolders).toEqual(manager.document.objectFolders);
    // The folder commands and their undo entries stay with the owner.
    expect(shared.commandLog).toEqual([]);
    expect(shared.editHistory).toBeUndefined();
    const opened = normalizeDocument(
      JSON.parse(JSON.stringify(shared)) as ProjectDocument
    );
    expect(folderOf(opened, base)).toBe('folder_a');
  });

  it('refuses malformed sections by name, on load and at the account edge', () => {
    const { manager, base } = threeBoxes();
    const cases: [unknown, RegExp][] = [
      [{ folders: 'nope', placements: {} }, /not a folder list/],
      [
        { folders: [{ id: '', name: 'A', parentId: null }], placements: {} },
        /no id/
      ],
      [
        { folders: [{ id: 'f', name: '  ', parentId: null }], placements: {} },
        /no usable name/
      ],
      [
        {
          folders: [
            { id: 'f', name: 'A', parentId: null },
            { id: 'f', name: 'B', parentId: null }
          ],
          placements: {}
        },
        /twice/
      ],
      [
        { folders: [{ id: 'f', name: 'A', parentId: 'g' }], placements: {} },
        /does not exist/
      ],
      [
        {
          folders: [
            { id: 'f', name: 'A', parentId: 'g' },
            { id: 'g', name: 'B', parentId: 'f' }
          ],
          placements: {}
        },
        /inside itself/
      ],
      [{ folders: [], placements: { [base]: 'missing' } }, /does not exist/]
    ];
    for (const [section, message] of cases) {
      expect(objectFolderSetError(section)).toMatch(message);
      const wire = {
        ...JSON.parse(JSON.stringify(manager.document)),
        objectFolders: section
      } as ProjectDocument;
      expect(() => normalizeDocument(wire)).toThrow(message);
      expect(() =>
        parseSaveProjectDocumentRequest(
          {
            projectId: wire.projectId,
            expectedVersion: 0,
            document: wire
          },
          wire.projectId
        )
      ).toThrow(/objectFolders/);
    }
  });

  it('decides folder-only undo from the recorded changes, not the kind label', () => {
    const { manager } = threeBoxes();
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_a',
        name: 'A',
        parentId: null
      })
    );
    expect(manager.undoIsObjectFolderOnly).toBe(true);
    const forged = structuredClone(manager.document.editHistory!);
    forged.entries.at(-1)!.changes.push({
      kind: 'value',
      field: 'name',
      before: 'Folders',
      after: 'Renamed'
    });
    const tampered = new CommandManager({
      ...manager.document,
      editHistory: forged
    });
    expect(tampered.undoIsObjectFolderOnly).toBe(false);
    manager.undo();
    expect(manager.redoIsObjectFolderOnly).toBe(true);
  });

  it('numbers new folders per parent, lists the commands for analytics, and keeps names out of diagnostics', () => {
    const { manager } = threeBoxes();
    expect(nextObjectFolderName(manager.document)).toBe('Folder 1');
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_a',
        name: 'Folder 1',
        parentId: null
      })
    );
    expect(nextObjectFolderName(manager.document)).toBe('Folder 2');
    expect(nextObjectFolderName(manager.document, 'folder_a')).toBe('Folder 1');
    const kinds = [
      'objectFolder.create',
      'objectFolder.rename',
      'objectFolder.delete',
      'objectFolder.move'
    ];
    for (const contract of [webGlimpse, workerGlimpse])
      expect(contract.EXPANDED.feature_operation).toEqual(
        expect.arrayContaining(kinds)
      );
    manager.execute(
      commandFactories.renameObjectFolder({
        folderId: 'folder_a',
        name: 'Client Secret Parts'
      })
    );
    const bundle = createProjectDiagnosticBundle(
      manager.document,
      { remusVersion: '0', remusCommit: '0' },
      '2026-10-20T00:00:00.000Z'
    );
    expect('objectFolders' in bundle.document).toBe(false);
    expect(JSON.stringify(bundle)).not.toContain('Client Secret Parts');
  });
});
