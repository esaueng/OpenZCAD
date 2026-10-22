import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  normalizeDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  resolveSketchReferenceDimension,
  toArtifactId,
  toAssetId,
  toUserId,
  type DrawingAnnotationId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingViewId,
  type ProjectDocument,
  type ReferenceImage,
  type ReferenceImageId,
  type SketchId
} from '@openzcad/shared';
import {
  backupFileBytes,
  checksum,
  packBackupFile,
  parseProjectBackup
} from '../apps/web/src/lib/projectBackup';

const sheetId = 'dsht_retained' as DrawingSheetId;
const noteId = 'dann_retained' as DrawingAnnotationId;
const imageId = 'rimg_retained' as ReferenceImageId;
const artifactId = toArtifactId('artifact_retained_picture');
const assetId = toAssetId('asset_retained_thumbnail');
// A real one-pixel PNG: the native backup must retain its bytes, not merely
// an artifact identifier that would reopen without its picture.
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVxoAAAAASUVORK5CYII='
  ),
  (character) => character.charCodeAt(0)
);

async function authoredFixture(schema: 31 | 32) {
  const created = addSketchFeature(
    createProjectDocument('Retained references', toUserId('user_test')),
    {
      name: 'Circle and measured diagonal',
      plane: 'XY',
      objects: [
        { objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 },
        {
          objectKind: 'line',
          x1: 0,
          y1: 0,
          x2: 3,
          y2: 4,
          construction: true
        }
      ]
    }
  );
  const body = extrudeSketch(created.document, {
    name: 'Unchanged pad',
    sketchId: created.sketchId,
    distance: 2
  });
  const pictureChecksum = await checksum(png);
  const base = structuredClone(body.document);
  base.assets[assetId] = {
    assetId,
    artifactId,
    kind: 'thumbnail',
    name: 'Retained thumbnail.png',
    contentType: 'image/png',
    bytes: png.length,
    checksum: pictureChecksum,
    storage: 'remote',
    createdAt: new Date(0).toISOString()
  };
  const manager = new CommandManager(base);
  const sheet: DrawingSheet = {
    sheetId,
    name: 'Manufacturing sheet',
    paper: { size: 'A4', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 2 },
    projectionAngle: 'third',
    titleBlock: { title: 'Retained drawing' },
    source: { fingerprint: 'v1:retained-reference-fixture' },
    views: [
      {
        viewId: 'dvw_retained_top' as DrawingViewId,
        orientation: 'top',
        bodyIds: [body.bodyId],
        centerMm: { x: 120, y: 90 },
        hiddenLines: false
      }
    ],
    annotations: [
      {
        annotationId: noteId,
        kind: 'note',
        text: 'BREAK EDGES',
        placementMm: { x: 10, y: 15 }
      }
    ]
  };
  manager.execute(commandFactories.addDrawingSheet({ sheet }));
  manager.execute(
    commandFactories.updateDrawingAnnotation({
      sheetId,
      annotation: {
        annotationId: noteId,
        kind: 'note',
        text: 'BREAK ALL SHARP EDGES',
        placementMm: { x: 14, y: 18 }
      }
    })
  );
  const diagonalId = findSketch(base, created.sketchId)!.objectIds[1]!;
  const absolute = commandFactories.addSketchReferenceDimension({
    sketchId: created.sketchId,
    data: {
      dimensionKind: 'distance',
      a: { objectId: diagonalId, point: 'start' },
      b: { objectId: diagonalId, point: 'end' }
    }
  });
  manager.execute(absolute);
  manager.execute(
    commandFactories.setSketchReferenceLabelPosition({
      sketchId: created.sketchId,
      annotationId: absolute.payload.ids!.annotationId,
      position: { x: -3, y: 7 }
    })
  );
  if (schema === 32) {
    const image: ReferenceImage = {
      imageId,
      artifactId,
      name: 'Retained picture',
      contentType: 'image/png',
      pixelWidth: 1,
      pixelHeight: 1,
      source: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: pictureChecksum,
        logicalBytes: png.length
      },
      plane: { type: 'canonical', plane: 'XZ', offset: 7, basisRevision: 2 },
      center: { u: 11, v: -13 },
      rotationDeg: -90,
      width: 42,
      opacity: 0.35
    };
    manager.execute(commandFactories.addReferenceImage({ image }));
    manager.execute(
      commandFactories.updateReferenceImage({
        imageId,
        center: { u: 17, v: -19 },
        width: 54
      })
    );
  }
  const saved = structuredClone(manager.document);
  saved.schemaVersion = schema as ProjectDocument['schemaVersion'];
  return {
    saved,
    replayBase: base,
    sketchId: created.sketchId,
    diagonalId,
    bodyId: body.bodyId,
    pictureChecksum
  };
}

async function backup(document: ProjectDocument, pictureChecksum: string) {
  return parseProjectBackup(
    JSON.stringify({
      format: 'openzcad-project',
      version: 1,
      document,
      files: [
        await packBackupFile(
          {
            artifactId,
            projectId: document.projectId,
            kind: 'reference-image',
            name: 'Retained picture.png',
            objectKey: 'retained/picture.png',
            contentType: 'image/png',
            createdAt: new Date(0).toISOString(),
            metadata: {}
          },
          new Uint8Array(png).buffer
        )
      ],
      sources: [
        {
          sha256: pictureChecksum,
          logicalBytes: png.length,
          base64: btoa(String.fromCharCode(...png))
        }
      ]
    })
  );
}

function distances(document: ProjectDocument, sketchId: SketchId) {
  const sketch = findSketch(document, sketchId)!;
  const objects = new Map(
    sketch.objectIds.map((id) => {
      const node = document.nodes[id]!;
      if (node.kind !== 'sketch-object')
        throw new Error('Missing sketch object');
      return [id, node.data] as const;
    })
  );
  return sketch.referenceDimensions!.map((reference) =>
    resolveSketchReferenceDimension(objects, reference, (value) =>
      typeof value === 'number' ? value : undefined
    )
  );
}

describe('serial schema retention for sketch reference distances', () => {
  // Add real v33 projection and v34 folder fixtures here when those owners'
  // implementations land. They must use their commands, not guessed fields.
  it.each([31, 32] as const)(
    'opens an authored v%s document without rewriting its drawing, picture, assets or history',
    async (schema) => {
      const f = await authoredFixture(schema);
      const untouched = structuredClone(f.saved);
      const opened = normalizeDocument(structuredClone(f.saved));
      expect(opened).toEqual({
        ...untouched,
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION
      });
      expect(f.saved).toEqual(untouched);
      expect(distances(opened, f.sketchId)).toMatchObject([
        { status: 'current', value: 5 }
      ]);
      expect(
        findSketch(opened, f.sketchId)!.referenceDimensions![0]!.data
      ).not.toHaveProperty('distanceMode');
      expect(opened).not.toHaveProperty('objectFolders');
      expect(findSketch(opened, f.sketchId)).not.toHaveProperty('promotions');
      if (schema === 31) expect(opened).not.toHaveProperty('referenceImages');

      // Retain the durable redo branch too, not just the current snapshot.
      const manager = new CommandManager(opened);
      manager.undo();
      expect(manager.canRedo).toBe(true);
      const undone = structuredClone(manager.document);
      const restored = await backup(undone, f.pictureChecksum);
      expect(restored.document).toEqual(undone);
      expect(backupFileBytes(restored.files[0]!)).toEqual(png);
      const resumed = new CommandManager(normalizeDocument(restored.document));
      expect(resumed.canRedo).toBe(true);
      resumed.redo();
      expect(resumed.document.drawings).toEqual(opened.drawings);
      expect(resumed.document.referenceImages).toEqual(opened.referenceImages);
      expect(resumed.document.assets).toEqual(opened.assets);
      expect(findSketch(resumed.document, f.sketchId)).toEqual(
        findSketch(opened, f.sketchId)
      );
    }
  );

  it('adds projected distances beside retained v32 content with one undo, replay, backup and unchanged exact geometry', async () => {
    const f = await authoredFixture(32);
    const opened = normalizeDocument(structuredClone(f.saved));
    const manager = new CommandManager(opened);
    const commands = (['horizontal', 'vertical'] as const).map((distanceMode) =>
      commandFactories.addSketchReferenceDimension({
        sketchId: f.sketchId,
        data: {
          dimensionKind: 'distance',
          distanceMode,
          a: { objectId: f.diagonalId, point: 'start' },
          b: { objectId: f.diagonalId, point: 'end' }
        }
      })
    );
    manager.runTransaction('Add projected references', [
      ...commands,
      ...commands.map((command, index) =>
        commandFactories.setSketchReferenceLabelPosition({
          sketchId: f.sketchId,
          annotationId: command.payload.ids!.annotationId,
          position: { x: 8 + index, y: -6 - index }
        })
      )
    ]);
    const annotated = structuredClone(manager.document);
    const references = findSketch(annotated, f.sketchId)!.referenceDimensions!;
    expect(distances(annotated, f.sketchId)).toMatchObject([
      { status: 'current', value: 5 },
      { status: 'current', value: 3 },
      { status: 'current', value: 4 }
    ]);
    expect(references[0]).toEqual(
      findSketch(opened, f.sketchId)!.referenceDimensions![0]
    );
    expect(Object.keys(annotated.nodes)).toEqual(Object.keys(opened.nodes));
    expect(annotated.nodes[f.diagonalId]).toEqual(opened.nodes[f.diagonalId]);
    expect(annotated.drawings).toEqual(opened.drawings);
    expect(annotated.referenceImages).toEqual(opened.referenceImages);
    expect(annotated.assets).toEqual(opened.assets);
    expect(annotated.editHistory!.entries.slice(0, -1)).toEqual(
      opened.editHistory!.entries
    );
    manager.undo();
    expect(findSketch(manager.document, f.sketchId)).toEqual(
      findSketch(opened, f.sketchId)
    );
    manager.redo();
    expect(
      findSketch(manager.document, f.sketchId)!.referenceDimensions
    ).toEqual(references);

    const replayed = replayCommands(f.replayBase, annotated.commandLog);
    expect(findSketch(replayed, f.sketchId)).toEqual(
      findSketch(annotated, f.sketchId)
    );
    expect(replayed.drawings).toEqual(opened.drawings);
    expect(replayed.referenceImages).toEqual(opened.referenceImages);
    expect(replayed.assets).toEqual(opened.assets);
    const restored = await backup(annotated, f.pictureChecksum);
    expect(restored.document).toEqual(annotated);
    expect(backupFileBytes(restored.files[0]!)).toEqual(png);
    const adapter = await createExactKernelAdapter();
    try {
      const before = await adapter.syncDocument(opened);
      const after = await adapter.syncDocument(restored.document);
      expect(before.warnings).toEqual([]);
      expect(after.warnings).toEqual([]);
      expect(after.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
        Math.PI * 50,
        8
      );
      expect(after.bodyRepresentations[f.bodyId]!.volume).toBe(
        before.bodyRepresentations[f.bodyId]!.volume
      );
      expect(after.bodyRepresentations[f.bodyId]!.bbox).toEqual(
        before.bodyRepresentations[f.bodyId]!.bbox
      );
    } finally {
      adapter.dispose();
    }
  });
});
