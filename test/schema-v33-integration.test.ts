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

describe('serial v31/v32 to v33 integration', () => {
  it.each([31, 32])(
    'preserves v%s content, undo, redo and replay while adding a projection',
    (version) => {
      const initial = createProjectDocument(
        'Existing document',
        toUserId('schema_test')
      );
      const older = new CommandManager(initial);
      older.execute(commandFactories.addDrawingSheet({ sheet }));
      if (version === 32)
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
      if (version === 32) {
        reloaded.undo();
        expect(reloaded.document.referenceImages).toBeUndefined();
        reloaded.redo();
        expect(reloaded.document.referenceImages?.images).toEqual([picture]);
      }
      reloaded.undo();
      if (version === 32) reloaded.undo();
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
