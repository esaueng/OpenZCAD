import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  createProjectDocument,
  findBodyNode,
  findSketch,
  normalizeDocument,
  objectFolderOfBody
} from '@openzcad/document-core';
import { frameForPlaneRef } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toArtifactId,
  toAssetId,
  toUserId,
  type BodyId,
  type DerivedState,
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
  projectionFromPick,
  projectionWriteBackCommand
} from '../apps/web/src/lib/sketch/projection';
import {
  backupFileBytes,
  checksum,
  packBackupFile,
  parseProjectBackup
} from '../apps/web/src/lib/projectBackup';
import {
  ExactRebuildCache,
  geometryContentKey
} from '../apps/web/src/worker/exactRebuildCache';

const owner = toUserId('user_schema_retention');
const sheetId = 'dsht_retained_folders' as DrawingSheetId;
const noteId = 'dann_retained_folders' as DrawingAnnotationId;
const imageId = 'rimg_retained_folders' as ReferenceImageId;
const artifactId = toArtifactId('artifact_retained_folders_png');
const assetId = toAssetId('asset_retained_folders_thumbnail');
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVxoAAAAASUVORK5CYII='
  ),
  (character) => character.charCodeAt(0)
);
const above = { type: 'canonical', plane: 'XY', offset: 8 } as const;

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);
afterAll(() => adapter.dispose());

async function authoredFixture(schema: 31 | 32 | 33) {
  const sum = await checksum(png);
  const initial = createProjectDocument('Retained schema content', owner);
  initial.assets[assetId] = {
    assetId,
    artifactId,
    kind: 'thumbnail',
    name: 'Retained thumbnail.png',
    contentType: 'image/png',
    bytes: png.length,
    checksum: sum,
    storage: 'remote',
    createdAt: new Date(0).toISOString()
  };
  const manager = new CommandManager(initial);
  manager.execute(
    commandFactories.setParameter({ name: 'w', expression: '20' })
  );
  const source = commandFactories.addPrimitive({
    name: 'Reference block',
    primitiveKind: 'box',
    dimensions: { width: 'w', height: 10, depth: 5 }
  });
  manager.execute(source);
  const sourceId = source.payload.ids!.bodyId;
  const sheet: DrawingSheet = {
    sheetId,
    name: 'Retained drawing',
    paper: { size: 'A4', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 2 },
    projectionAngle: 'third',
    titleBlock: { title: 'Reference block' },
    source: { fingerprint: 'v1:retained-folders-fixture' },
    views: [
      {
        viewId: 'dvw_retained_folders_top' as DrawingViewId,
        orientation: 'top',
        bodyIds: [sourceId],
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
  if (schema >= 32) {
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
        checksumSha256: sum,
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
  let projection:
    { sketchId: SketchId; plateId: BodyId; objectIds: string[] } | undefined;
  if (schema >= 33) {
    const measured = await adapter.syncDocument(manager.document);
    expect(measured.warnings).toEqual([]);
    const top = measured.bodyRepresentations[sourceId]!.topology!.faces.find(
      (face) => (face.geometry?.normal?.z ?? 0) > 0.99
    )!;
    const picked = projectionFromPick({
      document: { ...manager.document, derived: measured },
      sketch: null,
      selection: { kind: 'face', bodyId: sourceId, hash: top.hash },
      basis: frameForPlaneRef(above, Number),
      mode: 'linked',
      construction: false
    });
    expect(picked.skipped).toEqual([]);
    expect(picked.objects).toHaveLength(4);
    const outline = commandFactories.addSketch({
      name: 'Linked outline',
      planeRef: above,
      objects: picked.objects
    });
    manager.execute(outline);
    const sketchId = outline.payload.ids!.sketchId;
    const objectIds = [...findSketch(manager.document, sketchId)!.objectIds];
    const plate = commandFactories.extrudeSketch({
      name: 'Linked plate',
      sketchId,
      distance: 3,
      profiles: [{ all: true, sourceEntityIds: objectIds }]
    });
    manager.execute(plate);
    projection = { sketchId, plateId: plate.payload.ids!.bodyId, objectIds };
  }
  const saved = structuredClone(manager.document);
  saved.schemaVersion = schema as ProjectDocument['schemaVersion'];
  return { initial, saved, sourceId, projection, sum };
}

async function backup(document: ProjectDocument, sum: string) {
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
            objectKey: 'retained/folders.png',
            contentType: 'image/png',
            createdAt: new Date(0).toISOString(),
            metadata: {}
          },
          new Uint8Array(png).buffer
        )
      ],
      sources: [
        {
          sha256: sum,
          logicalBytes: png.length,
          base64: btoa(String.fromCharCode(...png))
        }
      ]
    })
  );
}

function projectionSources(document: ProjectDocument, sketchId: SketchId) {
  return findSketch(document, sketchId)!.objectIds.map((id) => {
    const node = document.nodes[id]!;
    if (node.kind !== 'sketch-object' || !node.data.projection)
      throw new Error('Missing authored projection');
    return node.data.projection;
  });
}

describe('folder schema retains previously shipped document content', () => {
  it.each([31, 32, 33] as const)(
    'opens real v%s content and retains its durable redo and native source bytes',
    async (schema) => {
      const f = await authoredFixture(schema);
      const original = structuredClone(f.saved);
      const opened = normalizeDocument(structuredClone(f.saved));
      expect(opened).toEqual({
        ...original,
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION
      });
      expect(f.saved).toEqual(original);
      expect(opened).not.toHaveProperty('objectFolders');
      if (schema === 31) expect(opened).not.toHaveProperty('referenceImages');
      if (f.projection) {
        expect(projectionSources(opened, f.projection.sketchId)).toHaveLength(
          4
        );
      } else {
        expect(
          Object.values(opened.nodes).some((node) => node.kind === 'sketch')
        ).toBe(false);
      }
      const manager = new CommandManager(opened);
      manager.undo();
      expect(manager.canRedo).toBe(true);
      const restored = await backup(manager.document, f.sum);
      expect(restored.document).toEqual(
        JSON.parse(JSON.stringify(manager.document))
      );
      expect(backupFileBytes(restored.files[0]!)).toEqual(png);
      const resumed = new CommandManager(normalizeDocument(restored.document));
      expect(resumed.canRedo).toBe(true);
      resumed.redo();
      expect(resumed.document.nodes).toEqual(opened.nodes);
      expect(resumed.document.drawings).toEqual(opened.drawings);
      expect(resumed.document.referenceImages).toEqual(opened.referenceImages);
      expect(resumed.document.assets).toEqual(opened.assets);
    }
  );

  it('files linked geometry without rebuilding, and retains inherited placements and authored sources through resize, undo, replay and backup', async () => {
    const f = await authoredFixture(33);
    if (!f.projection) throw new Error('Missing linked outline fixture');
    const { plateId, sketchId } = f.projection;
    const opened = normalizeDocument(structuredClone(f.saved));
    const manager = new CommandManager(opened);
    const sources = structuredClone(projectionSources(opened, sketchId));
    const cache = new ExactRebuildCache<DerivedState>({
      maxEntries: 4,
      maxBytes: 32_000_000,
      maxInFlight: 1
    });
    try {
      let builds = 0;
      const load = async () => {
        builds++;
        return adapter.syncDocument(manager.document);
      };
      const key = geometryContentKey(manager.document);
      const ready = await cache.get(key, load);
      expect(ready.warnings).toEqual([]);
      expect(ready.bodyRepresentations[plateId]!.volume).toBeCloseTo(600, 8);
      manager.commitDerivedState(ready);
      const published = manager.document.derived;
      const folderEdit = async (command: AnyCommand) => {
        manager.execute(command);
        expect(manager.undoIsObjectFolderOnly).toBe(true);
        expect(geometryContentKey(manager.document)).toBe(key);
        expect(manager.document.derived).toBe(published);
        await cache.get(geometryContentKey(manager.document), load);
        manager.undo();
        expect(manager.redoIsObjectFolderOnly).toBe(true);
        expect(geometryContentKey(manager.document)).toBe(key);
        expect(manager.document.derived).toBe(published);
        await cache.get(geometryContentKey(manager.document), load);
        manager.redo();
        expect(geometryContentKey(manager.document)).toBe(key);
        expect(manager.document.derived).toBe(published);
        await cache.get(geometryContentKey(manager.document), load);
        expect(builds).toBe(1);
      };
      await folderEdit(
        commandFactories.createObjectFolder({
          folderId: 'folder_frame',
          name: 'Frame',
          parentId: null,
          bodyIds: [f.sourceId, plateId]
        })
      );
      await folderEdit(
        commandFactories.createObjectFolder({
          folderId: 'folder_detail',
          name: 'Details',
          parentId: 'folder_frame'
        })
      );
      await folderEdit(
        commandFactories.renameObjectFolder({
          folderId: 'folder_frame',
          name: 'Retained assembly'
        })
      );
      await folderEdit(
        commandFactories.moveToObjectFolder({
          parentId: 'folder_detail',
          bodyIds: [plateId]
        })
      );
      expect(objectFolderOfBody(manager.document, plateId)).toBe(
        'folder_detail'
      );
      await folderEdit(
        commandFactories.moveToObjectFolder({
          parentId: null,
          folderIds: ['folder_detail']
        })
      );
      await folderEdit(
        commandFactories.moveToObjectFolder({
          parentId: 'folder_frame',
          folderIds: ['folder_detail']
        })
      );
      await folderEdit(
        commandFactories.deleteObjectFolder({ folderId: 'folder_detail' })
      );
      expect(objectFolderOfBody(manager.document, plateId)).toBe(
        'folder_frame'
      );
      expect(manager.document.objectFolders!.folders).toEqual([
        { id: 'folder_frame', name: 'Retained assembly', parentId: null }
      ]);

      const sourceBody = findBodyNode(manager.document, f.sourceId)!;
      manager.execute(
        commandFactories.renameNode({
          nodeId: sourceBody.id,
          name: 'Renamed reference source'
        })
      );
      expect(findBodyNode(manager.document, f.sourceId)!.name).toBe(
        'Renamed reference source'
      );
      expect(projectionSources(manager.document, sketchId)).toEqual(sources);
      expect(objectFolderOfBody(manager.document, f.sourceId)).toBe(
        'folder_frame'
      );
      const copied = commandFactories.transformBody({
        name: 'Linked plate copy',
        targetBodyId: plateId,
        translation: { x: 50, y: 0, z: 0 },
        copy: true
      });
      manager.execute(copied);
      const copyId = manager.document.bodyOrder.at(-1)!;
      expect(copyId).not.toBe(plateId);
      expect(objectFolderOfBody(manager.document, copyId)).toBe('folder_frame');
      expect(
        Object.hasOwn(manager.document.objectFolders!.placements, copyId)
      ).toBe(false);
      const support = commandFactories.addPrimitive({
        name: 'Support',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      });
      manager.execute(support);
      const union = commandFactories.booleanBodies({
        name: 'Union reference and support',
        operation: 'union',
        targetBodyIds: [f.sourceId, support.payload.ids!.bodyId]
      });
      manager.execute(union);
      const unionId = union.payload.ids!.bodyId;
      expect(objectFolderOfBody(manager.document, unionId)).toBe(
        'folder_frame'
      );
      expect(
        Object.hasOwn(manager.document.objectFolders!.placements, unionId)
      ).toBe(false);
      expect(findBodyNode(manager.document, unionId)!.name).toBe(
        'Renamed reference source'
      );
      const before = await adapter.syncDocument(manager.document);
      expect(before.warnings).toEqual([]);
      expect(before.bodyRepresentations[plateId]!.volume).toBeCloseTo(600, 8);
      expect(before.bodyRepresentations[copyId]!.volume).toBeCloseTo(600, 8);
      expect(before.bodyRepresentations[unionId]!.volume).toBeCloseTo(1500, 8);
      const folders = structuredClone(manager.document.objectFolders);
      const priorEntries = structuredClone(
        manager.document.editHistory!.entries
      );
      manager.execute(
        commandFactories.setParameter({ name: 'w', expression: '32' })
      );
      const resized = await adapter.syncDocument(manager.document);
      expect(resized.warnings).toEqual([]);
      expect(resized.bodyRepresentations[plateId]!.volume).toBeCloseTo(960, 8);
      expect(resized.bodyRepresentations[copyId]!.volume).toBeCloseTo(960, 8);
      expect(resized.bodyRepresentations[unionId]!.volume).toBeCloseTo(2100, 8);
      const states = Object.values(resized.sketchProjections ?? {});
      expect(states.filter((state) => state.status === 'moved')).toHaveLength(
        3
      );
      expect(states.filter((state) => state.status === 'current')).toHaveLength(
        1
      );
      const writeBack = projectionWriteBackCommand(manager.document, resized);
      expect(writeBack).not.toBeNull();
      manager.normalize(writeBack!);
      expect(manager.document.editHistory!.entries.slice(0, -1)).toEqual(
        priorEntries
      );
      expect(manager.document.objectFolders).toEqual(folders);
      expect(projectionSources(manager.document, sketchId)).toEqual(sources);
      expect(manager.document.drawings).toEqual(opened.drawings);
      expect(manager.document.referenceImages).toEqual(opened.referenceImages);
      expect(manager.document.assets).toEqual(opened.assets);
      const settled = await adapter.syncDocument(manager.document);
      expect(settled.warnings).toEqual([]);
      expect(
        Object.values(settled.sketchProjections ?? {}).every(
          (state) => state.status === 'current'
        )
      ).toBe(true);
      manager.undo();
      expect(manager.document.objectFolders).toEqual(folders);
      const undone = await adapter.syncDocument(manager.document);
      expect(undone.warnings).toEqual([]);
      expect(undone.bodyRepresentations[plateId]!.volume).toBeCloseTo(600, 8);
      expect(undone.bodyRepresentations[copyId]!.volume).toBeCloseTo(600, 8);
      expect(undone.bodyRepresentations[unionId]!.volume).toBeCloseTo(1500, 8);
      const archived = await backup(manager.document, f.sum);
      expect(backupFileBytes(archived.files[0]!)).toEqual(png);
      const resumed = new CommandManager(normalizeDocument(archived.document));
      expect(resumed.canRedo).toBe(true);
      resumed.redo();
      expect(resumed.document.objectFolders).toEqual(folders);
      expect(projectionSources(resumed.document, sketchId)).toEqual(sources);
      const replayed = replayCommands(f.initial, resumed.document.commandLog);
      expect(replayed.nodes).toEqual(resumed.document.nodes);
      expect(replayed.objectFolders).toEqual(folders);
      expect(replayed.drawings).toEqual(opened.drawings);
      expect(replayed.referenceImages).toEqual(opened.referenceImages);
      expect(replayed.assets).toEqual(opened.assets);
      const rebuilt = await adapter.syncDocument(resumed.document);
      expect(rebuilt.warnings).toEqual([]);
      expect(rebuilt.bodyRepresentations[plateId]!.volume).toBeCloseTo(960, 8);
      expect(rebuilt.bodyRepresentations[copyId]!.volume).toBeCloseTo(960, 8);
      expect(rebuilt.bodyRepresentations[unionId]!.volume).toBeCloseTo(2100, 8);
      expect(rebuilt.bodyRepresentations[copyId]!.bbox.min.x).toBeCloseTo(
        50,
        8
      );
      expect(rebuilt.bodyRepresentations[copyId]!.bbox.max.x).toBeCloseTo(
        82,
        8
      );
      expect(objectFolderOfBody(resumed.document, unionId)).toBe(
        'folder_frame'
      );
    } finally {
      cache.terminate();
    }
  });
});
