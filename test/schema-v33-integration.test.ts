import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  normalizeDocument
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type DrawingSheet,
  type ProjectDocument,
  type ReferenceImage
} from '@openzcad/shared';

const sheet: DrawingSheet = {
  sheetId: 'dsht_preserved' as DrawingSheet['sheetId'],
  name: 'Existing drawing',
  paper: { size: 'A4', orientation: 'landscape' },
  scale: { numerator: 1, denominator: 1 },
  projectionAngle: 'third',
  titleBlock: {},
  source: { fingerprint: 'v1:preserved' },
  views: [],
  annotations: [
    {
      annotationId: 'dann_preserved' as NonNullable<
        DrawingSheet['annotations']
      >[number]['annotationId'],
      kind: 'note',
      text: 'Preserve the original annotation',
      placementMm: { x: 20, y: 20 }
    }
  ]
};
const picture: ReferenceImage = {
  imageId: 'rimg_preserved' as ReferenceImage['imageId'],
  name: 'Existing reference',
  contentType: 'image/png',
  source: {
    marker: 'openzcad-source-ref',
    version: 1,
    hashAlgorithm: 'sha256',
    checksumSha256: 'a'.repeat(64),
    logicalBytes: 1234
  },
  artifactId: 'artifact_preserved' as ReferenceImage['artifactId'],
  pixelWidth: 400,
  pixelHeight: 200,
  plane: { type: 'canonical', plane: 'XY', offset: 0 },
  center: { u: 3, v: 4 },
  rotationDeg: 15,
  width: 100,
  opacity: 0.6
};

const saved = (document: ProjectDocument): ProjectDocument =>
  JSON.parse(JSON.stringify(document)) as ProjectDocument;

describe('serial v31/v32/v33 to v34 integration', () => {
  it.each([31, 32, 33])(
    'preserves v%s content, undo, redo and replay while adding a projection',
    (version) => {
      const initial = createProjectDocument(
        'Existing document',
        toUserId('schema_test')
      );
      const older = new CommandManager(initial);
      older.execute(commandFactories.addDrawingSheet({ sheet }));
      if (version >= 32)
        older.execute(commandFactories.addReferenceImage({ image: picture }));
      const legacy = {
        ...saved(older.document),
        schemaVersion: version
      } as ProjectDocument;
      const opened = normalizeDocument(saved(legacy));
      expect(opened.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
      expect({ ...opened, schemaVersion: version }).toEqual(legacy);
      const manager = new CommandManager(opened);
      manager.execute(
        commandFactories.addSketch({
          name: 'Independent projection',
          planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
          objects: [
            {
              objectKind: 'line',
              x1: 0,
              y1: 0,
              x2: 10,
              y2: 0,
              projection: { mode: 'unlinked' }
            }
          ]
        })
      );
      const withProjection = saved(manager.document);
      expect(withProjection.drawings).toEqual(legacy.drawings);
      expect(withProjection.referenceImages).toEqual(legacy.referenceImages);
      const filing = new CommandManager(withProjection);
      filing.execute(
        commandFactories.createObjectFolder({
          folderId: 'folder_references',
          name: 'References',
          parentId: null
        })
      );
      const withFolder = saved(filing.document);
      expect(withFolder.schemaVersion).toBe(34);
      expect(withFolder.objectFolders?.folders[0]?.name).toBe('References');
      expect(withFolder.nodes).toEqual(withProjection.nodes);
      expect(withFolder.drawings).toEqual(withProjection.drawings);
      expect(withFolder.referenceImages).toEqual(
        withProjection.referenceImages
      );
      const restoredFolders = new CommandManager(normalizeDocument(withFolder));
      restoredFolders.undo();
      expect(restoredFolders.document.objectFolders).toEqual(
        withProjection.objectFolders
      );
      expect(restoredFolders.document.nodes).toEqual(withProjection.nodes);
      expect(restoredFolders.document.drawings).toEqual(
        withProjection.drawings
      );
      expect(restoredFolders.document.referenceImages).toEqual(
        withProjection.referenceImages
      );
      restoredFolders.redo();
      expect(restoredFolders.document.objectFolders).toEqual(
        withFolder.objectFolders
      );
      const replayedFolders = replayCommands(initial, withFolder.commandLog);
      expect(replayedFolders.objectFolders).toEqual(withFolder.objectFolders);
      expect(replayedFolders.nodes).toEqual(withFolder.nodes);
      expect(replayedFolders.drawings).toEqual(withFolder.drawings);
      expect(replayedFolders.referenceImages).toEqual(
        withFolder.referenceImages
      );
      if (version >= 32) {
        const combined = new CommandManager(withFolder);
        combined.runTransaction('Organize picture and folder', [
          commandFactories.renameObjectFolder({
            folderId: 'folder_references',
            name: 'Tracing'
          }),
          commandFactories.updateReferenceImage({
            imageId: picture.imageId,
            center: { u: 11, v: 12 }
          })
        ]);
        const edited = saved(combined.document);
        const history = new CommandManager(normalizeDocument(edited));
        expect(history.document.objectFolders?.folders[0]?.name).toBe(
          'Tracing'
        );
        expect(history.document.referenceImages?.images[0]?.center).toEqual({
          u: 11,
          v: 12
        });
        history.undo();
        expect(history.document.objectFolders).toEqual(
          withFolder.objectFolders
        );
        expect(history.document.referenceImages).toEqual(
          withFolder.referenceImages
        );
        expect(history.document.nodes).toEqual(withFolder.nodes);
        expect(history.document.drawings).toEqual(withFolder.drawings);
        history.redo();
        expect(history.document.objectFolders).toEqual(edited.objectFolders);
        expect(history.document.referenceImages).toEqual(
          edited.referenceImages
        );
        const replayed = replayCommands(initial, edited.commandLog);
        expect(replayed.objectFolders).toEqual(edited.objectFolders);
        expect(replayed.referenceImages).toEqual(edited.referenceImages);
        expect(replayed.nodes).toEqual(edited.nodes);
        expect(replayed.drawings).toEqual(edited.drawings);
      }
      const reloaded = new CommandManager(normalizeDocument(withProjection));
      reloaded.undo();
      expect(reloaded.document.nodes).toEqual(opened.nodes);
      expect(reloaded.document.drawings).toEqual(legacy.drawings);
      expect(reloaded.document.referenceImages).toEqual(legacy.referenceImages);
      reloaded.redo();
      expect(reloaded.document.nodes).toEqual(withProjection.nodes);
      const replayed = replayCommands(initial, withProjection.commandLog);
      expect(replayed.nodes).toEqual(withProjection.nodes);
      expect(replayed.drawings).toEqual(legacy.drawings);
      expect(replayed.referenceImages).toEqual(legacy.referenceImages);
      // Walking farther back after a save must retain the old image and
      // annotation history too, not only the new sketch's undo step.
      reloaded.undo();
      if (version >= 32) {
        reloaded.undo();
        expect(reloaded.document.referenceImages).toBeUndefined();
        reloaded.redo();
        expect(reloaded.document.referenceImages?.images).toEqual([picture]);
      }
      reloaded.undo();
      if (version >= 32) reloaded.undo();
      expect(reloaded.document.drawings).toBeUndefined();
      expect(() =>
        normalizeDocument({
          ...withProjection,
          schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION + 1
        } as unknown as ProjectDocument)
      ).toThrow(/Unsupported project schema/);
    }
  );
});
